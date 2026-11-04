"""
DocFlow Backend — Service: submission validation (spec FR-13, §25.4).

One place decides whether a draft may move forward, so the wizard's "Continue"
buttons, the editor's "Continue", and the final submit all agree. The client
mirrors the cheap checks for instant feedback, but the answer that counts is
this one: the browser can be skipped entirely, and a draft can go stale
between the check and the submit.

Every problem comes back as a `FieldError` naming the form control it belongs
to, so the UI can put the message beside the field instead of showing one
opaque banner. Codes are stable; wording is not.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import FieldError
from app.models.document import Document, DocumentAttachment, DocumentContent, FileAsset
from app.models.workflow import StageApproverRule, WorkflowStage, WorkflowTemplate
from app.services.antivirus import BLOCKING, ScanStatus

#: A body shorter than this is a stray keystroke, not a document. Picked so
#: that a one-line sentence passes and an accidental "a" does not.
MIN_BODY_CHARS = 20
MIN_TITLE_CHARS = 3
MAX_TAGS = 15
MAX_TAG_CHARS = 40

#: Titles the app itself generated. Submitting one means the author never got
#: round to naming the document, which is exactly what this blocks.
PLACEHOLDER_TITLES = {"untitled document", "untitled", "untitled template"}

CONFIDENTIALITY_VALUES = {"public", "internal", "confidential"}
PRIORITY_VALUES = {"low", "normal", "high", "urgent"}

#: Stages a caller may ask about. Each one includes the stages before it, so
#: "confirm" is the whole thing.
STAGES = ("write", "workflow", "details", "confirm")

_BLOCKING_VALUES = {s.value for s in BLOCKING}


def _text_of(content: object) -> str:
    """Visible text of a TipTap document, for emptiness tests only."""
    out: list[str] = []

    def walk(node: object) -> None:
        if not isinstance(node, dict):
            return
        if node.get("type") == "text":
            out.append(str(node.get("text") or ""))
        elif node.get("type") == "placeholder":
            # A blank is content: a body that is only blanks is still a
            # document someone has to fill in.
            out.append("____")
        for child in node.get("content") or []:
            walk(child)
        if node.get("type") in ("paragraph", "heading", "listItem", "tableRow"):
            out.append("\n")

    walk(content)
    return "".join(out)


def _as_date(value: datetime | date | None) -> date | None:
    if value is None:
        return None
    return value.date() if isinstance(value, datetime) else value


def _today() -> date:
    return datetime.now(timezone.utc).date()


# ── individual checks ────────────────────────────────────────────────────────

def check_title(title: str | None) -> list[FieldError]:
    text = (title or "").strip()
    if not text:
        return [FieldError("title", "title_required", "Give this document a title.")]
    if text.lower() in PLACEHOLDER_TITLES:
        return [FieldError(
            "title", "title_placeholder",
            "Replace the default title with one that says what this document is.",
        )]
    if len(text) < MIN_TITLE_CHARS:
        return [FieldError(
            "title", "title_too_short",
            f"The title needs at least {MIN_TITLE_CHARS} characters.",
        )]
    return []


def check_body(content: object) -> list[FieldError]:
    text = _text_of(content).strip()
    if not text:
        return [FieldError("body", "body_empty", "Write something before you continue.")]
    if len(text) < MIN_BODY_CHARS:
        return [FieldError(
            "body", "body_too_short",
            f"This document is nearly empty — write at least {MIN_BODY_CHARS} characters.",
        )]
    return []


def check_details(
    *,
    title: str | None,
    due_at: datetime | None,
    effective_from: datetime | None,
    expires_at: datetime | None,
    reminder_days_before: int | None,
    tags: list[str] | None,
    confidentiality: str | None,
    priority: str | None = None,
) -> list[FieldError]:
    """The Details step. Mirrored field-for-field by the wizard."""
    errors = check_title(title)

    due = _as_date(due_at)
    if due and due < _today():
        errors.append(FieldError("due_at", "due_in_past", "The due date cannot be in the past."))

    eff, exp = _as_date(effective_from), _as_date(expires_at)
    if eff and exp and exp <= eff:
        errors.append(FieldError(
            "expires_at", "date_range_invalid",
            "The expiry date must be after the date it takes effect.",
        ))

    if reminder_days_before is not None:
        if exp is None:
            errors.append(FieldError(
                "reminder_days_before", "reminder_without_expiry",
                "Set an expiry date before choosing when to be reminded.",
            ))
        elif reminder_days_before < 1:
            errors.append(FieldError(
                "reminder_days_before", "reminder_invalid",
                "The reminder must be at least one day before expiry.",
            ))
        elif eff and (exp - eff).days < reminder_days_before:
            errors.append(FieldError(
                "reminder_days_before", "reminder_before_start",
                "That reminder would fall before the document takes effect.",
            ))

    clean_tags = [t for t in (tags or []) if t.strip()]
    if len(clean_tags) > MAX_TAGS:
        errors.append(FieldError("tags", "tags_too_many", f"Use at most {MAX_TAGS} tags."))
    over = next((t for t in clean_tags if len(t) > MAX_TAG_CHARS), None)
    if over is not None:
        errors.append(FieldError(
            "tags", "tag_too_long",
            f"Tags must be {MAX_TAG_CHARS} characters or fewer — "
            f"“{over[:30]}…” is longer.",
        ))

    if confidentiality and confidentiality.lower() not in CONFIDENTIALITY_VALUES:
        errors.append(FieldError(
            "confidentiality", "confidentiality_invalid", "Choose a confidentiality level.",
        ))
    if priority and priority.lower() not in PRIORITY_VALUES:
        errors.append(FieldError("priority", "priority_invalid", "Choose a priority."))

    return errors


# ── database-backed checks ───────────────────────────────────────────────────

async def check_workflow(
    db: AsyncSession, *, org_id: UUID, submitter_id: UUID, template_id: UUID | None,
) -> tuple[list[FieldError], list[FieldError]]:
    """(blocking, warnings) for the chosen approval workflow."""
    if template_id is None:
        return [FieldError(
            "workflow_template_id", "workflow_required", "Choose an approval workflow.",
        )], []

    tpl = (await db.execute(
        select(WorkflowTemplate).where(
            WorkflowTemplate.id == template_id,
            WorkflowTemplate.org_id == org_id,
        )
    )).scalar_one_or_none()
    if tpl is None:
        return [FieldError(
            "workflow_template_id", "workflow_not_found",
            "That approval workflow no longer exists. Choose another.",
        )], []
    if not tpl.is_active:
        return [FieldError(
            "workflow_template_id", "workflow_inactive",
            f"“{tpl.name}” has been deactivated. Choose another workflow.",
        )], []

    stages = (await db.execute(
        select(WorkflowStage).where(WorkflowStage.template_id == tpl.id)
        .order_by(WorkflowStage.sequence_order)
    )).scalars().all()
    if not stages:
        return [FieldError(
            "workflow_template_id", "workflow_no_stages",
            f"“{tpl.name}” has no approval stages. Ask an admin to finish it.",
        )], []

    rules = (await db.execute(
        select(StageApproverRule).where(
            StageApproverRule.stage_id.in_([s.id for s in stages])
        )
    )).scalars().all()
    by_stage: dict[UUID, list[StageApproverRule]] = {s.id: [] for s in stages}
    for rule in rules:
        by_stage[rule.stage_id].append(rule)

    empty = [s for s in stages if not by_stage[s.id]]
    if empty:
        names = ", ".join(f"“{s.name}”" for s in empty[:3])
        return [FieldError(
            "workflow_template_id", "workflow_no_approver",
            f"No one is set to approve {names}. Ask an admin to add an approver.",
        )], []

    # FR-13.3 — a workflow whose only approver is the person submitting means
    # nobody independent ever looks at the document. Allowed (some teams really
    # do self-certify) but never silent.
    warnings: list[FieldError] = []
    specific = [r for r in rules if r.rule_type == "specific_user"]
    if specific and len(specific) == len(rules):
        approver_ids = {str((r.rule_value or {}).get("user_id")) for r in specific}
        if approver_ids == {str(submitter_id)}:
            warnings.append(FieldError(
                "workflow_template_id", "workflow_self_approval",
                "You are the only approver on this workflow, so no one else will review it.",
            ))
    return [], warnings


async def check_attachments(
    db: AsyncSession, *, doc: Document, require_one: bool,
) -> list[FieldError]:
    """FR-3.7 — an uploaded document IS its file, so the file must be there and usable."""
    rows = (await db.execute(
        select(FileAsset)
        .join(DocumentAttachment, DocumentAttachment.file_asset_id == FileAsset.id)
        .where(DocumentAttachment.document_id == doc.id)
    )).scalars().all()

    if require_one and not rows:
        return [FieldError(
            "attachments", "attachment_required",
            "This document was created from a file, but no file is attached. Attach one.",
        )]

    errors: list[FieldError] = []
    for asset in rows:
        av = (asset.metadata_ or {}).get("av") or {}
        status = str(av.get("status") or "")
        if asset.is_malware_clean is False or status in _BLOCKING_VALUES:
            errors.append(FieldError(
                "attachments", "attachment_blocked",
                f"“{asset.filename}” was blocked by the file check. Remove it.",
            ))
        elif not status:
            # Uploads are checked inline, so an asset carrying no verdict at
            # all has not finished being processed.
            errors.append(FieldError(
                "attachments", "attachment_pending",
                f"“{asset.filename}” has not finished being checked. Try again shortly.",
            ))
        elif status == ScanStatus.ERROR.value:
            errors.append(FieldError(
                "attachments", "attachment_uncheckable",
                f"“{asset.filename}” could not be checked. Remove it or upload it again.",
            ))
    return errors


def evaluate_visible_when(rule: dict, answers: dict) -> bool:
    """Evaluate a conditional visibility rule {field, op, value} (FR-7.10)."""
    target = rule.get("field")
    if not target:
        return True
    op = rule.get("op", "eq")
    target_val = rule.get("value")
    actual_val = answers.get(target)

    if op in ("eq", "=="):
        return actual_val == target_val or str(actual_val) == str(target_val)
    elif op in ("neq", "!="):
        return actual_val != target_val and str(actual_val) != str(target_val)
    elif op == "in":
        return actual_val in target_val if isinstance(target_val, (list, tuple)) else False
    elif op == "not_in":
        return actual_val not in target_val if isinstance(target_val, (list, tuple)) else True
    elif op == "truthy":
        return bool(actual_val) and actual_val != "false"
    elif op == "falsy":
        return not bool(actual_val) or actual_val == "false"
    return True

async def check_answers(db: AsyncSession, *, doc: Document) -> list[FieldError]:
    """Every required question on the pinned template version has an answer."""
    if not doc.template_version_id:
        return []
    from app.services.template_studio_service import TemplateStudioService

    _, version, fields = await TemplateStudioService(db).pinned_fill_data(
        doc.template_version_id
    )
    if version is None:
        return [FieldError(
            "template_version", "template_version_missing",
            "The template version this document was built from is no longer available.",
        )]

    errors: list[FieldError] = []
    if version.published_at is None:
        errors.append(FieldError(
            "template_version", "template_version_unpublished",
            "The template version behind this document is not published. Ask its owner "
            "to publish it, or start again from a published template.",
        ))

    row = (await db.execute(
        select(DocumentContent).where(DocumentContent.document_id == doc.id)
    )).scalar_one_or_none()
    answers = (row.answers if row else None) or {}

    for f in fields:
        val_dict = getattr(f, "validation", None) or {}
        if not isinstance(val_dict, dict):
            val_dict = {}

        # FR-7.10 — conditional fields: hidden fields are not required and ignored
        rule = getattr(f, "visible_when", None) or val_dict.get("visible_when")
        if rule and isinstance(rule, dict) and not evaluate_visible_when(rule, answers):
            continue

        # FR-7.10 — repeating sections validation
        repeat_group = val_dict.get("repeat_group") or getattr(f, "section", None)
        is_repeatable = val_dict.get("repeatable") or bool(val_dict.get("repeat_group"))
        if is_repeatable and repeat_group and isinstance(answers.get(repeat_group), list):
            items = answers[repeat_group]
            if f.required:
                for idx, item in enumerate(items):
                    if not isinstance(item, dict):
                        continue
                    v = item.get(f.key)
                    empty = v is None or (isinstance(v, str) and not v.strip())
                    if empty:
                        errors.append(FieldError(
                            f"answer:{repeat_group}:{idx}:{f.key}", "answer_required",
                            f"“{f.label or f.key}” (entry {idx + 1}) is required.",
                        ))
            continue

        if not f.required:
            continue
        value = answers.get(f.key)
        empty = (
            value is None
            or (isinstance(value, str) and not value.strip())
            or (isinstance(value, (list, dict)) and not value)
        )
        if empty:
            errors.append(FieldError(
                f"answer:{f.key}", "answer_required",
                f"“{f.label or f.key}” is required.",
            ))
    return errors


async def validate_document(
    db: AsyncSession,
    *,
    doc: Document,
    submitter_id: UUID,
    stage: str = "confirm",
    workflow_template_id: UUID | None = None,
) -> tuple[list[FieldError], list[FieldError]]:
    """
    Check a draft up to and including `stage`.

    Returns (errors, warnings). Errors block; warnings are shown and may be
    accepted. Everything reads the stored document, never anything the client
    claims about it.
    """
    if stage not in STAGES:
        stage = "confirm"
    reached = STAGES.index(stage)

    errors: list[FieldError] = []
    warnings: list[FieldError] = []
    source = (doc.source or "template").lower()

    # ── the document itself has something in it ──
    row = (await db.execute(
        select(DocumentContent).where(DocumentContent.document_id == doc.id)
    )).scalar_one_or_none()
    content = (row.content if row else None) or {}

    if source == "blank":
        errors += check_title(doc.title)
        errors += check_body(content)
    elif source == "upload":
        errors += await check_attachments(db, doc=doc, require_one=True)
    else:
        errors += await check_answers(db, doc=doc)

    if reached >= STAGES.index("workflow"):
        wf_errors, wf_warnings = await check_workflow(
            db, org_id=doc.org_id, submitter_id=submitter_id,
            template_id=workflow_template_id,
        )
        errors += wf_errors
        warnings += wf_warnings

    if reached >= STAGES.index("details"):
        errors += check_details(
            title=doc.title,
            due_at=doc.due_at,
            effective_from=doc.effective_from,
            expires_at=doc.expires_at,
            reminder_days_before=doc.reminder_days_before,
            tags=doc.tags,
            confidentiality=doc.confidentiality,
            priority=(
                doc.priority.value if hasattr(doc.priority, "value") else doc.priority
            ),
        )

    if reached >= STAGES.index("confirm") and source != "upload":
        # Attachments of any source are re-checked at the last moment: one
        # could have been added after the Details step.
        errors += await check_attachments(db, doc=doc, require_one=False)

    # The same problem can be reported by two stages (the title, for one).
    seen: set[tuple[str, str]] = set()
    deduped: list[FieldError] = []
    for err in errors:
        key = (err.field, err.code)
        if key not in seen:
            seen.add(key)
            deduped.append(err)
    return deduped, warnings
