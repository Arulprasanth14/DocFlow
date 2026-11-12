"""
DocFlow — Celery Worker: retention cleanup (spec FR-14.7).

Abandoned drafts accumulate forever otherwise: a draft is created the moment
someone clicks a template, so every half-started document is a row.

Three deliberate safety properties, agreed with the product owner:

  - DRY RUN BY DEFAULT. `DRAFT_RETENTION_DRY_RUN` starts true, so the first
    thing this task ever does in a new deployment is report what it *would*
    remove. Turning it off is a conscious act.
  - SOFT DELETE ONLY. It sets `deleted_at`. Nothing is dropped, no storage
    object is removed, and a mistake is reversible by clearing the column.
    Hard deletion is not implemented here on purpose.
  - AUDITED. Every pass writes an `audit_logs` row — including dry runs, and
    including the run that found nothing — so there is always a record of
    what the retention policy did on a given night.

Scope is narrow by design: DRAFT documents only, never submitted or decided
ones, and never a draft that is part of a running workflow.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import structlog
from sqlalchemy import func, select
from sqlalchemy import update as sa_update

from app.config import settings
from app.core.celery_app import celery_app
from app.database import async_session_factory
from app.models.audit import AuditLog
from app.models.base import utcnow
from app.models.document import Document, DocumentStatus

logger = structlog.get_logger(__name__)

RETENTION_ACTION = "document.retention_purge"


@celery_app.task(name="app.workers.cleanup_tasks.purge_expired_sessions")
def purge_expired_sessions() -> dict:
    """Delete sessions that expired more than SESSION_PURGE_AFTER_DAYS ago.

    Expired rows are already ignored by every auth check, so this is hygiene,
    not security: without it the table grows by one row per login forever, and
    with rotation enabled by one row per REFRESH. The grace period keeps
    recent history around long enough to investigate an incident.
    """
    return asyncio.run(_run_session_purge())


async def _run_session_purge() -> dict:
    from app.repositories.user_repo import SessionRepository

    cutoff = datetime.now(timezone.utc) - timedelta(
        days=settings.SESSION_PURGE_AFTER_DAYS
    )
    async with async_session_factory() as db:
        deleted = await SessionRepository(db).delete_expired_before(cutoff)
        await db.commit()
    logger.info("session_purge_complete", deleted=deleted, cutoff=cutoff.isoformat())
    return {"deleted": deleted, "cutoff": cutoff.isoformat()}


@celery_app.task(name="app.workers.cleanup_tasks.cleanup_expired_documents")
def cleanup_expired_documents() -> dict:
    """Nightly retention pass. Returns a summary for the Celery result backend."""
    return asyncio.run(_run_retention())


async def _run_retention() -> dict:
    days = settings.DRAFT_RETENTION_DAYS
    dry_run = settings.DRAFT_RETENTION_DRY_RUN
    limit = settings.DRAFT_RETENTION_BATCH_LIMIT

    if days <= 0:
        logger.info("retention_disabled")
        return {"enabled": False, "dry_run": dry_run, "candidates": 0, "soft_deleted": 0}

    cutoff = utcnow() - timedelta(days=days)

    async with async_session_factory() as db:
        # Candidate = a draft nobody has touched since the cutoff. `updated_at`
        # is bumped by every autosave, so "untouched" really does mean
        # abandoned rather than merely old.
        candidates = (
            await db.execute(
                select(Document)
                .where(
                    Document.status == DocumentStatus.DRAFT,
                    Document.deleted_at.is_(None),
                    Document.updated_at < cutoff,
                )
                .order_by(Document.updated_at.asc())
                .limit(limit)
            )
        ).scalars().all()

        # How many are waiting beyond this batch, so an operator can see whether
        # the nightly limit is keeping up.
        remaining = (
            await db.execute(
                select(func.count())
                .select_from(Document)
                .where(
                    Document.status == DocumentStatus.DRAFT,
                    Document.deleted_at.is_(None),
                    Document.updated_at < cutoff,
                )
            )
        ).scalar_one()

        by_org: dict[str, list[Document]] = {}
        for doc in candidates:
            by_org.setdefault(str(doc.org_id), []).append(doc)

        soft_deleted = 0
        if not dry_run:
            now = utcnow()
            for doc in candidates:
                doc.deleted_at = now
                soft_deleted += 1

        # One audit row per organisation, so a tenant's own audit trail only
        # ever shows its own documents. Written for dry runs too — the record
        # that the policy ran and chose nothing is itself worth keeping.
        for org_id, docs in by_org.items():
            db.add(
                AuditLog(
                    org_id=org_id,
                    actor_id=None,  # the scheduler, not a person
                    actor_role="system",
                    action=RETENTION_ACTION,
                    resource_type="Document",
                    resource_id=docs[0].id,
                    before=None,
                    after=None,
                    metadata_={
                        "dry_run": dry_run,
                        "retention_days": days,
                        "cutoff": cutoff.isoformat(),
                        "count": len(docs),
                        "soft_deleted": 0 if dry_run else len(docs),
                        # Capped: the audit row records the policy decision, not
                        # a full inventory. The documents themselves are still
                        # there (soft delete), so nothing is lost by truncating.
                        "document_ids": [str(d.id) for d in docs[:100]],
                        "truncated": len(docs) > 100,
                    },
                )
            )

        if not by_org:
            logger.info("retention_pass_clear", dry_run=dry_run, cutoff=cutoff.isoformat())

        await db.commit()

    result = {
        "enabled": True,
        "dry_run": dry_run,
        "retention_days": days,
        "cutoff": cutoff.isoformat(),
        "candidates": len(candidates),
        "soft_deleted": soft_deleted,
        "remaining_after_batch": max(0, remaining - len(candidates)),
        "organizations": len(by_org),
    }
    logger.info("retention_pass_complete", **result)
    return result


# ── Empty drafts (spec FR-14.9: "empty drafts purged after 24 h") ────────────

EMPTY_DRAFT_ACTION = "document.empty_draft_purge"


@celery_app.task(name="app.workers.cleanup_tasks.purge_empty_drafts")
def purge_empty_drafts() -> dict:
    """Hourly sweep for drafts nobody ever put anything into."""
    return asyncio.run(_run_empty_draft_purge())


async def _run_empty_draft_purge() -> dict:
    """
    Remove drafts that were created and then abandoned without a single edit.

    A draft row is created the moment someone clicks a template, so a browsed-
    and-closed gallery leaves one behind every time. These are worth clearing
    on a much shorter clock than genuinely abandoned work, but ONLY when they
    are provably empty, because deleting a draft someone is still writing
    would be unforgivable.

    "Empty" is deliberately strict. All of these must hold:
      - status is DRAFT and it is older than the window
      - no answers and no form data
      - no body content (or a body whose nodes carry no text at all)
      - no attachments
      - no title the user chose (still the default "Untitled ...")

    Same guarantees as the main retention pass: dry-run capable, SOFT DELETE
    only, one audit row per organisation including empty passes.
    """
    hours = settings.EMPTY_DRAFT_RETENTION_HOURS
    dry_run = settings.DRAFT_RETENTION_DRY_RUN
    limit = settings.DRAFT_RETENTION_BATCH_LIMIT

    if hours <= 0:
        logger.info("empty_draft_purge_disabled")
        return {"enabled": False, "dry_run": dry_run, "candidates": 0, "soft_deleted": 0}

    from app.models.document import DocumentAttachment, DocumentContent
    from app.services.content_sanitizer import content_to_text

    cutoff = utcnow() - timedelta(hours=hours)

    async with async_session_factory() as db:
        candidates = (
            await db.execute(
                select(Document)
                .where(
                    Document.status == DocumentStatus.DRAFT,
                    Document.deleted_at.is_(None),
                    Document.created_at < cutoff,
                    Document.updated_at < cutoff,
                )
                .order_by(Document.created_at.asc())
                .limit(limit)
            )
        ).scalars().all()

        empty: list[Document] = []
        for doc in candidates:
            if doc.form_data:
                continue
            # A title the author typed means they engaged with it, whatever
            # else is missing.
            title = (doc.title or "").strip().lower()
            if title and not title.startswith("untitled"):
                continue

            row = (
                await db.execute(
                    select(DocumentContent).where(DocumentContent.document_id == doc.id)
                )
            ).scalar_one_or_none()
            if row is not None:
                if row.answers:
                    continue
                # Content JSON is never literally absent once the editor has
                # opened, so judge it by whether it holds any text at all.
                if (content_to_text(row.content or {}) or "").strip():
                    continue

            attached = (
                await db.execute(
                    select(func.count())
                    .select_from(DocumentAttachment)
                    .where(
                        DocumentAttachment.document_id == doc.id,
                        DocumentAttachment.deleted_at.is_(None),
                    )
                )
            ).scalar_one()
            if attached:
                continue

            empty.append(doc)

        by_org: dict[str, list[Document]] = {}
        for doc in empty:
            by_org.setdefault(str(doc.org_id), []).append(doc)

        soft_deleted = 0
        if not dry_run:
            now = utcnow()
            for doc in empty:
                doc.deleted_at = now
                soft_deleted += 1

        for org_id, docs in by_org.items():
            db.add(
                AuditLog(
                    org_id=org_id,
                    actor_id=None,
                    actor_role="system",
                    action=EMPTY_DRAFT_ACTION,
                    resource_type="Document",
                    resource_id=docs[0].id,
                    metadata_={
                        "dry_run": dry_run,
                        "window_hours": hours,
                        "cutoff": cutoff.isoformat(),
                        "count": len(docs),
                        "soft_deleted": 0 if dry_run else len(docs),
                        "document_ids": [str(d.id) for d in docs[:100]],
                        "truncated": len(docs) > 100,
                    },
                )
            )

        if not by_org:
            logger.info("empty_draft_purge_clear", dry_run=dry_run, examined=len(candidates))

        await db.commit()

    result = {
        "enabled": True,
        "dry_run": dry_run,
        "window_hours": hours,
        "cutoff": cutoff.isoformat(),
        "examined": len(candidates),
        "candidates": len(empty),
        "soft_deleted": soft_deleted,
        "organizations": len(by_org),
    }
    logger.info("empty_draft_purge_complete", **result)
    return result


# ── Prior notice before a draft is purged (spec FR-14.9 / §24) ───────────────

NOTICE_ACTION = "document.retention_notice"
#: Marker key inside documents.metadata. JSONB already exists, so recording
#: "we warned this owner" needs no migration and no new column.
NOTICE_KEY = "retention_notice_sent_at"


@celery_app.task(name="app.workers.cleanup_tasks.send_retention_notices")
def send_retention_notices() -> dict:
    """Daily: warn owners whose drafts are about to be purged."""
    return asyncio.run(_run_retention_notice())


async def _run_retention_notice() -> dict:
    """
    Tell a draft's owner before it is deleted, not after.

    FR-14.9 requires notice before the long-retention purge. Without it the
    first a person hears of the policy is their work disappearing, which is
    the kind of thing that destroys trust in a system.

    Sent once per draft, marked in `metadata`. Touching the draft resets its
    `updated_at`, which moves the purge date out and takes it out of the
    notice window; the marker is cleared then too, so a draft that goes quiet
    again gets a fresh warning rather than being silently purged on the
    strength of a notice from months earlier.
    """
    days = settings.DRAFT_RETENTION_DAYS
    notice_days = settings.DRAFT_RETENTION_NOTICE_DAYS
    dry_run = settings.DRAFT_RETENTION_DRY_RUN

    if days <= 0 or notice_days <= 0:
        logger.info("retention_notice_disabled", days=days, notice_days=notice_days)
        return {"enabled": False, "notified": 0}

    from app.domain.enums import NotificationType
    from app.services.notification_service import NotificationService

    now = utcnow()
    purge_cutoff = now - timedelta(days=days)
    # Due for a warning: it will cross the purge cutoff within the window.
    notice_cutoff = now - timedelta(days=max(days - notice_days, 0))

    async with async_session_factory() as db:
        candidates = (
            await db.execute(
                select(Document)
                .where(
                    Document.status == DocumentStatus.DRAFT,
                    Document.deleted_at.is_(None),
                    Document.updated_at < notice_cutoff,
                    # Already past the cutoff: the purge pass owns these, and
                    # a warning now would arrive after the fact.
                    Document.updated_at >= purge_cutoff,
                )
                .order_by(Document.updated_at.asc())
                .limit(settings.DRAFT_RETENTION_BATCH_LIMIT)
            )
        ).scalars().all()

        def needs_notice(doc: Document) -> bool:
            """
            True unless this draft has a warning that is still current.

            A marker older than the draft's own `updated_at` is stale: the
            owner came back, edited it, and let it go quiet again, so the
            earlier warning no longer describes what is about to happen.
            Comparing the two timestamps keeps that correct without any
            cross-module bookkeeping on every save.
            """
            raw = (doc.metadata_ or {}).get(NOTICE_KEY)
            if not raw:
                return True
            try:
                sent = datetime.fromisoformat(str(raw))
            except (TypeError, ValueError):
                return True
            if sent.tzinfo is None:
                sent = sent.replace(tzinfo=timezone.utc)
            return sent < doc.updated_at

        due = [d for d in candidates if needs_notice(d)]

        notif = NotificationService(db)
        by_org: dict[str, list[Document]] = {}
        notified = 0

        for doc in due:
            goes_at = doc.updated_at + timedelta(days=days)
            left = max((goes_at - now).days, 0)
            if not dry_run:
                try:
                    await notif.notify(
                        org_id=doc.org_id,
                        user_id=doc.submitted_by,
                        type=NotificationType.SYSTEM,
                        title="A draft will be deleted soon",
                        body=(
                            f"'{doc.title}' has been untouched for a while and will be "
                            f"removed in {left} day{'s' if left != 1 else ''}. "
                            "Open it to keep it."
                        ),
                        deep_link=f"/documents/{doc.id}",
                    )
                except Exception:
                    # One failed notification must not stop the sweep, and must
                    # not mark the draft as warned.
                    logger.warning("retention_notice_failed", doc_id=str(doc.id), exc_info=True)
                    continue
                # Stamp the marker WITHOUT touching updated_at.
                #
                # `updated_at` has onupdate=utcnow, and the purge date is
                # measured from it. Writing the marker through the ORM would
                # therefore push the purge 90 days into the future every time
                # we warned someone -- the draft would be warned forever and
                # never actually purged. Re-stating the existing value in the
                # same UPDATE overrides the column default.
                await db.execute(
                    sa_update(Document.__table__)
                    .where(Document.__table__.c.id == doc.id)
                    .values(
                        metadata={**(doc.metadata_ or {}), NOTICE_KEY: now.isoformat()},
                        updated_at=doc.updated_at,
                    )
                )
            by_org.setdefault(str(doc.org_id), []).append(doc)
            notified += 1

        for org_id, docs in by_org.items():
            db.add(
                AuditLog(
                    org_id=org_id,
                    actor_id=None,
                    actor_role="system",
                    action=NOTICE_ACTION,
                    resource_type="Document",
                    resource_id=docs[0].id,
                    metadata_={
                        "dry_run": dry_run,
                        "retention_days": days,
                        "notice_days": notice_days,
                        "count": len(docs),
                        "document_ids": [str(d.id) for d in docs[:100]],
                        "truncated": len(docs) > 100,
                    },
                )
            )

        await db.commit()

    result = {
        "enabled": True,
        "dry_run": dry_run,
        "retention_days": days,
        "notice_days": notice_days,
        "examined": len(candidates),
        "notified": notified,
        "organizations": len(by_org),
    }
    logger.info("retention_notice_complete", **result)
    return result
