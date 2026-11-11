"""
DocFlow — Worker: AI document summaries (section 6.4.4), task P4-1

Generation is a model call over a whole document: seconds at best, and it
needs the review copy to have been rendered first. So it never runs inside a
request.

`soft_time_limit` matches the 90 seconds the UI polls for (AP-SUM-05), so the
client and the worker give up at the same moment rather than the page waiting
on work that is still running.
"""
from __future__ import annotations

import asyncio

import structlog
from celery.exceptions import SoftTimeLimitExceeded

from app.core.celery_app import celery_app
from app.services.summary_service import POLL_TIMEOUT_SECONDS

logger = structlog.get_logger(__name__)


@celery_app.task(
    name="app.workers.summary_tasks.build_summary",
    bind=True,
    max_retries=5,
    soft_time_limit=POLL_TIMEOUT_SECONDS,
    time_limit=POLL_TIMEOUT_SECONDS + 30,
)
def build_summary(self, version_id: str) -> dict:
    """Summarize one document version."""
    try:
        result = asyncio.run(_build(version_id))
    except SoftTimeLimitExceeded:
        asyncio.run(_mark_timeout(version_id))
        return {"status": "failed", "reason": "timeout"}

    # The review copy is still rendering: wait for it rather than summarizing
    # nothing and recording a failure the approver would have to retry.
    if result.get("status") == "waiting":
        raise self.retry(countdown=20)
    return result


async def _build(version_id: str) -> dict:
    import uuid as _uuid

    from app.models.document import DocumentVersion
    from app.services.summary_service import SummaryService
    from app.workers._db import task_session

    async with task_session() as db:
        target = await db.get(DocumentVersion, _uuid.UUID(version_id))
        if target is None:
            return {"status": "missing"}
        if target.rendition_status == "pending":
            return {"status": "waiting"}
        result = await SummaryService(db).generate(target.id)
        await db.commit()
    return result


async def _mark_timeout(version_id: str) -> None:
    """Record the timeout so the panel stops polling and says what happened."""
    import uuid as _uuid

    from sqlalchemy import select

    from app.models.summary import DocumentSummary
    from app.workers._db import task_session

    try:
        async with task_session() as db:
            row = (
                await db.execute(
                    select(DocumentSummary)
                    .where(
                        DocumentSummary.document_version_id
                        == _uuid.UUID(version_id),
                        DocumentSummary.deleted_at.is_(None),
                    )
                    .order_by(DocumentSummary.created_at.desc())
                    .limit(1)
                )
            ).scalars().first()
            if row is not None:
                row.status = "failed"
                row.error_code = "timeout"
                row.error_message = (
                    "The summary took too long to generate. You can try again."
                )
                await db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("summary_timeout_record_failed", error=str(exc))
