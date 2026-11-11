"""
DocFlow — Worker: review renditions (section 6.4.1), task P3-3

Converting an office file to PDF spawns a whole office suite and takes
seconds to minutes, so it never happens inside a request. Two entry points:

  `build_rendition`   one version, enqueued when it is uploaded or submitted.
  `sweep_renditions`  anything still 'pending', for the case where the
                      enqueue never reached the broker or the worker died
                      mid-convert. This is what stops a document sitting in
                      "preparing your review copy" for ever.

Conversion failures are **not** retried by the queue. A password-protected
file, a corrupt one, or a format soffice cannot read will fail identically
every time; retrying it just burns an office-suite launch per attempt and
delays the one thing that helps, which is telling the owner what is wrong
(WF-REV-09, E15). Those are recorded as `rendition_status = 'failed'` with a
message, and the sweep leaves them alone.
"""
from __future__ import annotations

import asyncio

import structlog
from sqlalchemy import select

from app.core.celery_app import celery_app

logger = structlog.get_logger(__name__)

#: How many stuck versions one sweep will pick up. Each is an office-suite
#: launch, so this is deliberately small: the sweep is a safety net, not the
#: normal path.
SWEEP_BATCH = 5


@celery_app.task(name="app.workers.rendition_tasks.build_rendition")
def build_rendition(version_id: str) -> dict:
    """Produce the review PDF for one document version."""
    return asyncio.run(_build(version_id))


async def _build(version_id: str) -> dict:
    import uuid as _uuid

    from app.workers._db import task_session
    from app.services.rendition_service import RenditionService

    async with task_session() as db:
        try:
            result = await RenditionService(db).build(_uuid.UUID(version_id))
            await db.commit()
        except Exception as exc:  # noqa: BLE001
            # `build()` records its own expected failures and does not raise;
            # reaching here means something outside it broke, so the row is
            # left 'pending' for the sweep rather than being marked failed on
            # evidence we do not have.
            await db.rollback()
            logger.error(
                "rendition_task_failed", version_id=version_id, error=str(exc)
            )
            return {"status": "error", "error": str(exc)}
    return result


@celery_app.task(name="app.workers.rendition_tasks.sweep_renditions")
def sweep_renditions() -> dict:
    """Pick up versions whose rendition never got built."""
    return asyncio.run(_sweep())


async def _sweep() -> dict:
    from app.workers._db import task_session
    from app.models.document import DocumentVersion
    from app.services.rendition_service import RenditionService

    built = 0
    async with task_session() as db:
        rows = (
            await db.execute(
                select(DocumentVersion.id)
                .where(
                    DocumentVersion.rendition_status == "pending",
                    DocumentVersion.deleted_at.is_(None),
                )
                # Oldest first: somebody has been waiting on it the longest.
                .order_by(DocumentVersion.created_at.asc())
                .limit(SWEEP_BATCH)
            )
        ).scalars().all()

        svc = RenditionService(db)
        for version_id in rows:
            try:
                await svc.build(version_id)
                await db.commit()
                built += 1
            except Exception as exc:  # noqa: BLE001
                # One bad version must not stop the sweep.
                await db.rollback()
                logger.error(
                    "rendition_sweep_item_failed",
                    version_id=str(version_id), error=str(exc),
                )

    if built:
        logger.info("rendition_sweep_completed", built=built)
    return {"status": "ok", "built": built}


@celery_app.task(
    name="app.workers.rendition_tasks.carry_over_annotations",
    bind=True, max_retries=10,
)
def carry_over_annotations(self, from_version_id: str, to_version_id: str) -> dict:
    """Carry outstanding comments onto a revision (AP-ANN-22, task P3-13).

    Needs the new version's text, which for an office file only exists once
    its review copy has been rendered - so this retries while that is still
    pending rather than carrying everything over as "Location changed".
    """
    result = asyncio.run(_carry(from_version_id, to_version_id))
    if result.get("status") == "waiting":
        raise self.retry(countdown=30)
    return result


async def _carry(from_version_id: str, to_version_id: str) -> dict:
    import uuid as _uuid

    from app.workers._db import task_session
    from app.models.document import DocumentVersion
    from app.services.annotation_carryover import carry_over, extract_pages

    async with task_session() as db:
        target = await db.get(DocumentVersion, _uuid.UUID(to_version_id))
        if target is None:
            return {"status": "missing"}
        if target.rendition_status == "pending":
            return {"status": "waiting"}
        pages = await extract_pages(db, target)
        result = await carry_over(
            db,
            from_version_id=_uuid.UUID(from_version_id),
            to_version_id=target.id,
            pages=pages,
        )
        await db.commit()
    return {"status": "ok", **result}

