"""
DocFlow — Celery Worker: PDF rendering of the frozen submission snapshot
(spec FR-13.8).

Runs AFTER submission, never inside it. The record of what was submitted is
the snapshot JSON, which is already frozen and checksummed by the time this
task starts; the PDF is a derived artefact. So a renderer failure leaves a
valid submission with a retryable PDF, and can never reject someone's work.

The task reads ONLY `Document.submitter_snapshot`. It does not look at
DocumentContent or the template, so re-rendering next year reproduces the
document as submitted — byte for byte, because the render is deterministic.
"""
from __future__ import annotations

import asyncio
import uuid
from typing import Any

import structlog
from sqlalchemy import select, update

from app.config import settings
from app.core.celery_app import celery_app
from app.core.storage import download_object, replace_object
from app.database import async_session_factory
from app.models.base import utcnow
from app.models.document import Document, FileAsset
from app.services.pdf_renderer import PDFRenderError, render_snapshot

logger = structlog.get_logger(__name__)

PDF_MIME = "application/pdf"
#: Total bytes of embedded images this task will pull from storage per
#: document. Beyond it, remaining images render as their alt text — a big
#: document must not be able to exhaust the worker's memory.
IMAGE_BUDGET = 25 * 1024 * 1024


@celery_app.task(
    name="app.workers.pdf_tasks.render_submission_pdf",
    bind=True,
    max_retries=3,
    default_retry_delay=60,
)
def render_submission_pdf(self, document_id: str) -> dict:
    """Render and store the snapshot PDF for one document."""
    return asyncio.run(_render(document_id, attempt=self.request.retries))


def _pdf_key(org_id: uuid.UUID, doc_id: uuid.UUID) -> str:
    # Same org-namespaced shape as every other object, so the existing
    # org-isolation checks on download apply to it unchanged.
    return f"orgs/{org_id}/files/submissions/{doc_id}/submitted.pdf"


def _collect_asset_ids(node: Any, found: set[str], depth: int = 0) -> None:
    """Walk the snapshot for the asset ids its images reference."""
    if depth > 120 or not isinstance(node, dict):
        return
    if node.get("type") == "image":
        asset_id = (node.get("attrs") or {}).get("assetId")
        if isinstance(asset_id, str):
            found.add(asset_id)
    for child in node.get("content") or []:
        _collect_asset_ids(child, found, depth + 1)


async def _prefetch_images(db, org_id: uuid.UUID, content: Any) -> dict[str, bytes]:
    """
    Fetch every embedded image up front.

    reportlab builds flowables synchronously and cannot await, so the bytes
    have to be in hand before rendering starts. Each asset is re-checked
    against the document's own org: a tampered snapshot must not be able to
    pull another organisation's file into this PDF.
    """
    wanted: set[str] = set()
    _collect_asset_ids(content, wanted)
    if not wanted:
        return {}

    valid: list[uuid.UUID] = []
    for raw in wanted:
        try:
            valid.append(uuid.UUID(raw))
        except ValueError:
            continue
    if not valid:
        return {}

    assets = (
        await db.execute(
            select(FileAsset).where(
                FileAsset.id.in_(valid),
                FileAsset.org_id == org_id,
                FileAsset.deleted_at.is_(None),
            )
        )
    ).scalars().all()

    out: dict[str, bytes] = {}
    spent = 0
    for asset in assets:
        if spent >= IMAGE_BUDGET:
            logger.warning("pdf_image_budget_reached", org_id=str(org_id))
            break
        try:
            data = download_object(
                asset.bucket or settings.S3_BUCKET_DOCUMENTS,
                asset.storage_key,
                max_bytes=IMAGE_BUDGET - spent,
            )
        except Exception as exc:  # noqa: BLE001 — a missing image must not fail the PDF
            logger.warning("pdf_image_fetch_failed", asset_id=str(asset.id), error=str(exc))
            continue
        out[str(asset.id)] = data
        spent += len(data)
    return out


async def _render(document_id: str, *, attempt: int = 0) -> dict:
    doc_uuid = uuid.UUID(document_id)

    async with async_session_factory() as db:
        doc = (
            await db.execute(select(Document).where(Document.id == doc_uuid))
        ).scalar_one_or_none()

        if doc is None:
            logger.warning("pdf_render_doc_missing", document_id=document_id)
            return {"status": "skipped", "reason": "document not found"}

        snapshot = doc.submitter_snapshot
        if not isinstance(snapshot, dict) or not snapshot.get("schema"):
            await _set_state(db, doc_uuid, status="failed",
                             error="This document has no frozen snapshot to render.")
            return {"status": "failed", "reason": "no snapshot"}

        images = await _prefetch_images(db, doc.org_id, snapshot.get("content"))

        try:
            rendered = render_snapshot(
                snapshot,
                reference=doc.public_id,
                image_resolver=images.get,
            )
        except PDFRenderError as exc:
            logger.warning("pdf_render_failed", document_id=document_id,
                           attempt=attempt, error=str(exc))
            await _set_state(db, doc_uuid, status="failed", error=str(exc)[:500])
            return {"status": "failed", "reason": str(exc)}

        key = _pdf_key(doc.org_id, doc_uuid)
        try:
            replace_object(settings.S3_BUCKET_DOCUMENTS, key, rendered.data, PDF_MIME)
        except Exception as exc:  # noqa: BLE001
            logger.warning("pdf_store_failed", document_id=document_id, error=str(exc))
            await _set_state(db, doc_uuid, status="failed",
                             error="The PDF was rendered but could not be stored.")
            raise

        await _set_state(db, doc_uuid, status="ready", url=key,
                         checksum=rendered.checksum, error=None)

        logger.info(
            "pdf_render_ready",
            document_id=document_id,
            bytes=len(rendered.data),
            checksum=rendered.checksum[:16],
            **rendered.stats.as_metadata(),
        )
        return {
            "status": "ready",
            "bytes": len(rendered.data),
            "checksum": rendered.checksum,
            **rendered.stats.as_metadata(),
        }


async def _set_state(
    db, doc_id: uuid.UUID, *, status: str,
    url: str | None = None, checksum: str | None = None, error: str | None = None,
) -> None:
    """
    Write the render outcome.

    Uses a Core-level table handle rather than ORM attributes: the columns
    arrive in migration f9a0b1c2d3e4, and mapping them on DocumentContent
    before that migration is applied would break every read of the table.
    """
    from app.repositories.document_repo import (
        ensure_content_row,
        pdf_contents_table as T,
    )

    await ensure_content_row(db, doc_id)
    values: dict = {"pdf_status": status, "pdf_error": error}
    if status == "ready":
        values["pdf_rendered_at"] = utcnow()
    if url is not None:
        values["pdf_url"] = url
    if checksum is not None:
        values["pdf_checksum"] = checksum
    await db.execute(update(T).where(T.c.document_id == doc_id).values(**values))
    await db.commit()
