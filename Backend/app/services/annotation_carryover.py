"""
DocFlow — Service: carrying comments onto a revision (AP-ANN-22), task P3-13

At resubmission, every comment from the replaced version that is still open
or addressed is copied onto the new version, so the approver reviewing round
two sees what they asked for next to what came back.

A COPY, never a move. The original stays anchored to the version it was
written on (versions and their review record are immutable, WF-REV-12); the
copy carries `carried_from_id` and `relocated`:

    True   the quoted text was found again; the viewer highlights it there
    False  it was not; shown as "Location changed" (a specified outcome)
    None   nothing to match on (an area comment); kept at its old position

Resolved comments are not carried: they are finished business, and carrying
them would bury the open ones.
"""
from __future__ import annotations

import uuid

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.reanchor import relocate
from app.models.annotation import Annotation
from app.models.document import DocumentVersion

logger = structlog.get_logger(__name__)

CARRIED_STATUSES = ("open", "addressed")


async def carry_over(
    db: AsyncSession,
    *,
    from_version_id: uuid.UUID,
    to_version_id: uuid.UUID,
    pages: dict[int, str] | None,
) -> dict:
    """Copy outstanding comments onto the new version. Idempotent.

    `pages` is the new version's text by 1-based page number, or None when
    it could not be extracted (a scan with no text layer). With no text,
    nothing can be matched, so every text comment is carried as "Location
    changed" rather than dropped.
    """
    target = await db.get(DocumentVersion, to_version_id)
    if target is None:
        return {"carried": 0, "reason": "target version missing"}

    sources = (
        await db.execute(
            select(Annotation).where(
                Annotation.document_version_id == from_version_id,
                Annotation.status.in_(CARRIED_STATUSES),
                Annotation.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    if not sources:
        return {"carried": 0}

    already = set(
        (
            await db.execute(
                select(Annotation.carried_from_id).where(
                    Annotation.document_version_id == to_version_id,
                    Annotation.carried_from_id.isnot(None),
                )
            )
        ).scalars().all()
    )

    carried = found = 0
    for src in sources:
        if src.id in already:
            continue  # a retried task must not duplicate the thread

        page_number, relocated = src.page_number, None
        if src.anchor_type == "text" and src.selected_text:
            hit = relocate(
                selected_text=src.selected_text,
                text_prefix=src.text_prefix,
                text_suffix=src.text_suffix,
                original_page=src.page_number,
                pages=pages or {},
            )
            relocated = hit.found
            if hit.found and hit.page_number is not None:
                page_number = hit.page_number
                found += 1

        db.add(
            Annotation(
                org_id=src.org_id,
                review_round_id=src.review_round_id,
                document_version_id=to_version_id,
                author_id=src.author_id,
                anchor_type=src.anchor_type,
                page_number=page_number,
                # The old rectangles are kept only when the text was found on
                # the SAME page, as a starting point the viewer refines from
                # the text layer. On another page they would point at
                # unrelated text, so they are dropped.
                rects=(
                    src.rects if (relocated is None or page_number == src.page_number)
                    else []
                ),
                selected_text=src.selected_text,
                text_prefix=src.text_prefix,
                text_suffix=src.text_suffix,
                color=src.color,
                category=src.category,
                status=src.status,
                comment_text=src.comment_text,
                published_at=src.published_at,
                carried_from_id=src.id,
                relocated=relocated,
            )
        )
        carried += 1

    await db.flush()
    logger.info(
        "annotations_carried_over", to_version=str(to_version_id),
        carried=carried, relocated=found,
    )
    return {"carried": carried, "relocated": found}


async def extract_pages(db: AsyncSession, version: DocumentVersion) -> dict[int, str] | None:
    """The viewable file's text by page, or None if it cannot be had yet."""
    import asyncio

    from app.ai.ingestion import ExtractionError, extract_text
    from app.config import settings
    from app.core.storage import download_object
    from app.services.rendition_service import RenditionService

    asset, state, _msg = await RenditionService(db).viewable_file(version)
    if state not in ("ready", "ready_raw"):
        return None
    key = asset.storage_key if asset is not None else version.storage_key
    bucket = asset.bucket if asset is not None else settings.S3_BUCKET_DOCUMENTS
    if not key:
        return None
    try:
        data = await asyncio.to_thread(download_object, bucket, key)
        extracted = extract_text(data, mime_type="application/pdf", filename="v.pdf")
    except ExtractionError:
        return {}  # readable file, no text layer: carry as "Location changed"
    return {
        (p.page_number or i): p.text
        for i, p in enumerate(extracted, start=1)
    }


async def queue_carry_over(from_version_id: uuid.UUID, to_version_id: uuid.UUID) -> None:
    """Best-effort enqueue; a broker that is down must not block resubmission."""
    try:
        from app.workers.rendition_tasks import carry_over_annotations

        carry_over_annotations.apply_async(
            args=[str(from_version_id), str(to_version_id)], retry=False,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("carry_over_enqueue_failed", error=str(exc))
