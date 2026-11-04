"""
DocFlow — import an existing document as a template (spec FR-9).

Pipeline, all server-side:

    upload (already AV-scanned on confirm)
      -> extract      DOCX/PDF -> editor JSON            document_importer
      -> sanitize     allow-list scrub                   content_sanitizer
      -> detect       deterministic rules (always)       blank_detector
      -> detect       LLM pass (ONLY if opted in)        ai_assist_service
      -> review       author accepts / rejects
      -> apply        spans -> placeholder nodes, then a Template is created

FR-9.4 is the load-bearing rule here: **the AI must not rewrite the document.**
Detections are never applied as "here is the new text" — each one is a pair of
character offsets, and applying it replaces exactly that span with a
placeholder node. After the replacement the text outside those spans is
re-derived and compared with what it was before. If one character moved, the
apply is refused. That turns "we asked the model not to edit it" into
something provable.
"""
from __future__ import annotations

import uuid

import structlog
from sqlalchemy import select
from sqlalchemy.exc import ProgrammingError

from app.core.exceptions import (
    ConflictException,
    NotFoundException,
    ServiceUnavailableException,
    ValidationException,
)
from app.domain.permissions import AuthUser
from app.models.import_job import ImportJob, ImportStatus
from app.services import blank_detector
from app.services.content_sanitizer import (
    ContentTooLargeError,
    sanitize_editor_content,
)
from app.services.document_importer import ImportError_, convert, kind_of

logger = structlog.get_logger(__name__)

#: How many blanks one import may produce. Past this the document is almost
#: certainly a form that should be rebuilt, not imported.
MAX_DETECTIONS = 200

STAGES = {
    ImportStatus.PENDING: ("Queued", 5),
    ImportStatus.EXTRACTING: ("Reading document", 35),
    ImportStatus.DETECTING: ("Finding blanks", 70),
    ImportStatus.READY: ("Ready for review", 100),
}


class ImportUnavailable(ServiceUnavailableException):
    """The import_jobs table is not there yet (migration not applied)."""


# ── text <-> JSON mapping ─────────────────────────────────────────────────────
#
# Detection offsets index the flattened plain text. To replace a span we have
# to find which text node it lives in. This walks the tree in EXACTLY the
# order document_importer._plain_text does, so the two always agree.

def _index_text_nodes(content: dict) -> tuple[list[dict], str]:
    """Return [{node, parent, index, start, end}] plus the flattened text."""
    spans: list[dict] = []
    parts: list[str] = []
    cursor = 0

    def walk(node: dict, parent: list | None, index: int) -> None:
        nonlocal cursor
        kind = node.get("type")
        if kind == "text":
            text = node.get("text") or ""
            spans.append({
                "node": node, "parent": parent, "index": index,
                "start": cursor, "end": cursor + len(text),
            })
            parts.append(text)
            cursor += len(text)
            return

        children = node.get("content")
        if isinstance(children, list):
            for i, child in enumerate(children):
                if isinstance(child, dict):
                    walk(child, children, i)

        if kind in ("paragraph", "heading", "listItem", "tableRow", "table", "blockquote"):
            parts.append("\n")
            cursor += 1
        elif kind in ("tableCell", "tableHeader"):
            parts.append("\t")
            cursor += 1

    walk(content, None, 0)
    return spans, "".join(parts)


def _placeholder_node(det: dict, number: int) -> dict:
    return {
        "type": "placeholder",
        "attrs": {
            "phId": uuid.uuid4().hex[:12],
            "fieldKey": det["key"],
            "label": det.get("label") or det["key"],
            "number": number,
            "value": "",
        },
    }


def apply_detections(
    content: dict, detections: list[dict]
) -> tuple[dict, list[dict], list[dict]]:
    """
    Replace each detection's span with a placeholder node.

    Returns (new_content, applied, skipped). A detection is skipped rather
    than forced when its span crosses a formatting boundary (two text nodes),
    because splitting it would silently change the document's formatting --
    exactly what FR-9.4 forbids. Those are reported back to the author.
    """
    import copy

    working = copy.deepcopy(content)
    spans, _ = _index_text_nodes(working)

    applied: list[dict] = []
    skipped: list[dict] = []

    # Back to front: every replacement changes the offsets after it.
    ordered = sorted(detections, key=lambda d: int(d["start"]), reverse=True)
    numbering = {d["key"]: 0 for d in detections}

    for det in ordered:
        start, end = int(det["start"]), int(det["end"])
        host = next(
            (s for s in spans if s["start"] <= start and end <= s["end"]), None
        )
        if host is None:
            skipped.append({
                **det,
                "skip_reason": (
                    "This blank spans a formatting change, so replacing it would "
                    "alter the document. Add it by hand in the editor."
                ),
            })
            continue

        node = host["node"]
        parent = host["parent"]
        if parent is None:
            skipped.append({**det, "skip_reason": "Unsupported position in the document."})
            continue

        text = node.get("text") or ""
        rel_start = start - host["start"]
        rel_end = end - host["start"]
        before, after = text[:rel_start], text[rel_end:]
        marks = node.get("marks")

        replacement: list[dict] = []
        if before:
            n = {"type": "text", "text": before}
            if marks:
                n["marks"] = marks
            replacement.append(n)
        replacement.append(_placeholder_node(det, 0))
        if after:
            n = {"type": "text", "text": after}
            if marks:
                n["marks"] = marks
            replacement.append(n)

        parent[host["index"]:host["index"] + 1] = replacement
        applied.append(det)

        # The index is stale after a structural edit, so rebuild it. Documents
        # here are small enough that clarity beats cleverness.
        spans, _ = _index_text_nodes(working)

    # Number the placeholders in document order (FR-7.3).
    ordered_spans, _ = _index_text_nodes(working)
    counter = 0

    def renumber(node: dict) -> None:
        nonlocal counter
        if node.get("type") == "placeholder":
            counter += 1
            node.setdefault("attrs", {})["number"] = counter
            return
        for child in node.get("content") or []:
            if isinstance(child, dict):
                renumber(child)

    renumber(working)
    del ordered_spans, numbering

    applied.reverse()           # back to document order for the caller
    return working, applied, skipped


def verify_untouched(
    original_text: str, new_content: dict, applied: list[dict]
) -> bool:
    """
    FR-9.4 — prove nothing outside the replaced spans changed.

    Takes the original text, deletes exactly the applied spans from it, and
    compares the result with the text of the rewritten document (where a
    placeholder contributes nothing). Equal means every other character
    survived untouched.
    """
    cuts = sorted(((int(d["start"]), int(d["end"])) for d in applied), reverse=True)
    expected = original_text
    for start, end in cuts:
        expected = expected[:start] + expected[end:]

    _, actual = _index_text_nodes(new_content)
    return expected == actual


# ── service ───────────────────────────────────────────────────────────────────

class ImportService:
    def __init__(self, db) -> None:
        self.db = db

    async def _job(self, job_id: uuid.UUID, user: AuthUser) -> ImportJob:
        try:
            job = (
                await self.db.execute(
                    select(ImportJob).where(
                        ImportJob.id == job_id,
                        ImportJob.org_id == user.org_id,
                        ImportJob.deleted_at.is_(None),
                    )
                )
            ).scalar_one_or_none()
        except ProgrammingError as exc:
            raise ImportUnavailable(
                "Document import isn't available yet on this server."
            ) from exc
        if job is None:
            raise NotFoundException("Import not found")
        # An import is private to whoever started it: it holds the full text
        # of a document they have not yet decided to share.
        if job.created_by != user.id:
            raise NotFoundException("Import not found")
        return job

    async def create(
        self,
        user: AuthUser,
        *,
        filename: str,
        mime_type: str | None,
        file_asset_id: uuid.UUID | None,
        use_llm: bool,
    ) -> ImportJob:
        job = ImportJob(
            org_id=user.org_id,
            created_by=user.id,
            file_asset_id=file_asset_id,
            filename=filename[:500] or "document",
            mime_type=mime_type,
            source_kind=kind_of(filename, mime_type),
            status=ImportStatus.PENDING,
            stage=STAGES[ImportStatus.PENDING][0],
            progress=STAGES[ImportStatus.PENDING][1],
            use_llm=bool(use_llm),
        )
        self.db.add(job)
        try:
            await self.db.commit()
        except ProgrammingError as exc:
            await self.db.rollback()
            raise ImportUnavailable(
                "Document import isn't available yet on this server."
            ) from exc
        return job

    async def get(self, job_id: uuid.UUID, user: AuthUser) -> ImportJob:
        return await self._job(job_id, user)

    async def cancel(self, job_id: uuid.UUID, user: AuthUser) -> ImportJob:
        job = await self._job(job_id, user)
        if job.status in (ImportStatus.APPLIED,):
            raise ConflictException("That import has already been used.")
        job.status = ImportStatus.CANCELLED
        job.stage = "Cancelled"
        await self.db.commit()
        return job

    def extract_and_detect(self, data: bytes, job: ImportJob) -> dict:
        """
        The synchronous half of the pipeline, called from the Celery task.

        Returns the fields to write onto the job. Kept free of database and
        network access so it is a pure function of the bytes -- which is what
        makes it safe to run inside the worker's own session handling.
        """
        converted = convert(data, filename=job.filename, mime_type=job.mime_type)

        # The converted tree is untrusted: it came from a file someone
        # uploaded. Scrub before it is stored or ever rendered.
        try:
            content = sanitize_editor_content(converted.content)
        except ContentTooLargeError as exc:
            raise ImportError_(str(exc)) from exc

        # Re-derive the text FROM THE SANITIZED TREE, not from the converter.
        # If sanitising dropped anything, detection offsets must index what was
        # actually kept, or every span would be off by the difference.
        _, text = _index_text_nodes(content)

        detections = blank_detector.detect(text, limit=MAX_DETECTIONS)
        return {
            "content": content,
            "text": text,
            "content_hash": __import__("hashlib").sha256(text.encode("utf-8")).hexdigest(),
            "detections": detections,
            "warnings": converted.warnings,
            "page_count": converted.page_count,
            "char_count": len(text),
        }

    async def apply(
        self,
        job_id: uuid.UUID,
        user: AuthUser,
        *,
        accepted: list[dict],
        name: str,
    ):
        # Returns TemplateDetailResponse (what TemplateStudioService hands
        # back), not the ORM Template.
        """Turn a reviewed import into a real draft template."""
        from app.services.template_studio_service import TemplateStudioService
        from app.schemas.template import TemplateCreateRequest

        job = await self._job(job_id, user)
        if job.status != ImportStatus.READY:
            raise ConflictException(
                f"This import isn't ready to use (it is {job.status})."
            )
        if not job.content:
            raise ConflictException("This import has no content.")

        content = job.content
        _, text = _index_text_nodes(content)

        # Trust the stored span, not a client-supplied one: a tampered offset
        # could otherwise be used to cut text out of the document.
        by_span = {(int(d["start"]), int(d["end"])): d for d in (job.detections or [])}
        chosen: list[dict] = []
        for raw in accepted:
            span = (int(raw.get("start", -1)), int(raw.get("end", -1)))
            stored = by_span.get(span)
            if stored is None:
                # Not one we proposed -- the author selected this text and
                # pressed "Make blank" (FR-9.5). Allowed, but only within the
                # document, and `original` is read from OUR copy of the text
                # so the client cannot claim a span says something it doesn't.
                start, end = span
                if not (0 <= start < end <= len(text)):
                    continue
                stored = {
                    "start": start,
                    "end": end,
                    "original": text[start:end],
                    "key": "",
                    "label": "",
                    "type": "text",
                    "confidence": "high",
                    "reason": "Marked by hand",
                    "source": "manual",
                }
            # Label/key/type ARE the author's to change in review; the span is not.
            fallback_key = f"field_{len(chosen) + 1}"
            chosen.append({
                **stored,
                "key": (raw.get("key") or stored["key"] or fallback_key).strip()[:64],
                "label": (
                    raw.get("label") or stored.get("label")
                    or stored["original"].strip()[:60] or fallback_key
                ).strip()[:200],
                "type": (raw.get("type") or stored.get("type") or "text"),
            })

        if not chosen:
            raise ValidationException("Select at least one blank, or start from scratch instead.")

        # Two blanks over the same text would corrupt the replacement; keep the
        # first and drop the rest rather than produce a broken template.
        chosen.sort(key=lambda d: int(d["start"]))
        deduped: list[dict] = []
        for det in chosen:
            if deduped and int(det["start"]) < int(deduped[-1]["end"]):
                continue
            deduped.append(det)
        chosen = deduped[:MAX_DETECTIONS]

        new_content, applied, skipped = apply_detections(content, chosen)

        if not verify_untouched(text, new_content, applied):
            # Refuse rather than save something we cannot vouch for.
            logger.error("import_text_integrity_failed", job_id=str(job.id))
            raise ConflictException(
                "The document text changed while blanks were being applied, so "
                "nothing was saved. Please try the import again."
            )

        studio = TemplateStudioService(self.db)
        template = await studio.create_template(
            user, TemplateCreateRequest(name=name.strip() or job.filename, scope="user")
        )

        # One field per unique key; several occurrences of the same key are one
        # question (FR-7.4).
        fields: list[dict] = []
        seen: set[str] = set()
        for i, det in enumerate(applied):
            if det["key"] in seen:
                continue
            seen.add(det["key"])
            fields.append({
                "key": det["key"],
                "label": det.get("label") or det["key"],
                "type": det.get("type") or "text",
                "required": True,
                "help_text": None,
                "example": None,
                "default_value": None,
                # Reserved for FR-7.10. Conditional visibility will live at
                # validation['visible_when'] and repetition at
                # validation['repeat_group'] -- both ignored today, so adding
                # them later needs no migration and no field-model rewrite.
                "validation": {},
                "format": None,
                "options": [],
                "if_empty_behavior": "keep_blank",
                "order_index": i,
                "section": None,
            })

        occurrences = [
            {"field_key": det["key"], "node_id": str(n), "order_no": n}
            for n, det in enumerate(applied, start=1)
        ]

        from app.schemas.template import TemplateUpdateRequest
        detail = await studio.update_template(
            uuid.UUID(str(template.id)),
            user,
            TemplateUpdateRequest.model_validate({
                "content": new_content,
                "fields": fields,
                "placeholders": occurrences,
            }),
        )

        job.template_id = uuid.UUID(str(template.id))
        job.status = ImportStatus.APPLIED
        job.stage = "Template created"
        await self.db.commit()

        logger.info(
            "import_applied",
            job_id=str(job.id), template_id=str(template.id),
            applied=len(applied), skipped=len(skipped),
        )
        return detail
