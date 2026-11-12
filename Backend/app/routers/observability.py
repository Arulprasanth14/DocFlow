"""
DocFlow — Router: workflow operational health

Workflow module section 11 (Observability), task P4-9.

One endpoint an external monitor can poll and alert on. Deliberately not a
Prometheus exporter: that would mean a new dependency and a scrape endpoint
to secure, and the thing actually needed here is a small set of numbers that
say whether the module's background work is keeping up.

Every number is a count of work that is STUCK, not of work done. Throughput
is interesting; a backlog is what pages someone. Each one has a plain-English
`alert_if` so whoever wires this up does not have to guess the threshold.

Admin-only, because the counts are organization-wide and a backlog is
operational information.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ForbiddenException
from app.database import get_db
from app.dependencies import CurrentUser

router = APIRouter(tags=["Operations"])


@router.get(
    "/ops/workflow-health",
    status_code=status.HTTP_200_OK,
    summary="Backlogs in the workflow module's background work (Org Admin)",
)
async def workflow_health(
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Section 11 Observability — the numbers worth alerting on.

    Scoped to the caller's organization, so one tenant's backlog is not
    visible to another (BR-12).
    """
    if not current_user.is_org_admin():
        raise ForbiddenException(
            "Only an organization admin can read operational health."
        )
    if not current_user.org_id:
        raise ForbiddenException("No organization context")

    from app.models.annotation import Annotation
    from app.models.document import DocumentVersion
    from app.models.outbox import OutboxEvent
    from app.models.summary import DocumentSummary
    from app.models.workflow import ApprovalStep, StageInstance, WorkflowInstance

    org_id = current_user.org_id
    now = datetime.now(timezone.utc)
    stale = now - timedelta(minutes=10)

    async def count(query) -> int:
        return (await db.execute(query)).scalar() or 0

    base = lambda model: select(func.count()).select_from(model)  # noqa: E731

    # The outbox is the one that matters most: an undelivered row means
    # somebody was never told about a decision (X-NOT-01).
    outbox_pending = await count(
        base(OutboxEvent).where(
            OutboxEvent.org_id == org_id,
            OutboxEvent.delivered_at.is_(None),
        )
    )
    outbox_stuck = await count(
        base(OutboxEvent).where(
            OutboxEvent.org_id == org_id,
            OutboxEvent.delivered_at.is_(None),
            OutboxEvent.created_at < stale,
        )
    )
    # Exhausted its retries: nobody will deliver this without a human.
    outbox_abandoned = await count(
        base(OutboxEvent).where(
            OutboxEvent.org_id == org_id,
            OutboxEvent.delivered_at.is_(None),
            OutboxEvent.attempts >= 8,
        )
    )

    blocked_stages = await count(
        base(StageInstance).where(
            StageInstance.org_id == org_id,
            StageInstance.status == "blocked",
            StageInstance.deleted_at.is_(None),
        )
    )
    overdue_approvals = await count(
        base(ApprovalStep)
        .join(WorkflowInstance, WorkflowInstance.id == ApprovalStep.instance_id)
        .where(
            WorkflowInstance.org_id == org_id,
            ApprovalStep.decision == "pending",
            ApprovalStep.superseded_at.is_(None),
            ApprovalStep.due_at.isnot(None),
            ApprovalStep.due_at < now,
        )
    )
    renditions_stuck = await count(
        base(DocumentVersion).where(
            DocumentVersion.rendition_status == "pending",
            DocumentVersion.created_at < stale,
            DocumentVersion.deleted_at.is_(None),
        )
    )
    renditions_failed = await count(
        base(DocumentVersion).where(
            DocumentVersion.rendition_status == "failed",
            DocumentVersion.deleted_at.is_(None),
        )
    )
    summaries_stuck = await count(
        base(DocumentSummary).where(
            DocumentSummary.org_id == org_id,
            DocumentSummary.status == "pending",
            DocumentSummary.created_at < stale,
            DocumentSummary.deleted_at.is_(None),
        )
    )
    # An approver's unpublished work: not a fault, but a large number means
    # reviews are being abandoned half-done.
    open_drafts = await count(
        base(Annotation).where(
            Annotation.org_id == org_id,
            Annotation.status == "draft",
            Annotation.deleted_at.is_(None),
        )
    )

    return {
        "checked_at": now.isoformat(),
        "stale_after_minutes": 10,
        "counts": {
            "outbox_pending": outbox_pending,
            "outbox_stuck": outbox_stuck,
            "outbox_abandoned": outbox_abandoned,
            "blocked_stages": blocked_stages,
            "overdue_approvals": overdue_approvals,
            "renditions_stuck": renditions_stuck,
            "renditions_failed": renditions_failed,
            "summaries_stuck": summaries_stuck,
            "open_drafts": open_drafts,
        },
        # Written here rather than left to whoever wires up the monitor,
        # because the right threshold depends on what each number means and
        # that knowledge lives in this module.
        "alert_if": {
            "outbox_stuck": (
                "greater than 0 for more than 10 minutes - the drain is not "
                "running, so decisions are being made and nobody is told"
            ),
            "outbox_abandoned": (
                "greater than 0 at all - these need a human; retries are "
                "exhausted"
            ),
            "renditions_stuck": (
                "greater than 0 for more than 15 minutes - the ai queue is "
                "not consuming, or LibreOffice is missing on the worker"
            ),
            "blocked_stages": (
                "greater than 0 for more than a working day - a run is "
                "waiting on an admin to reassign it and will not move itself"
            ),
            "summaries_stuck": "greater than 0 for more than 10 minutes",
            "overdue_approvals": (
                "rising steadily - a people problem rather than a system "
                "one, but worth a weekly look"
            ),
        },
    }
