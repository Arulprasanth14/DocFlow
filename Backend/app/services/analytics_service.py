"""
DocFlow Backend — Service: Analytics

Implements the requirements report §9:
  - Default reporting period is MONTHLY, switchable to YEARLY.
  - Documents submitted / approved / rejected / returned for changes /
    revoked / finalized within the selected period.
  - Workflow volume, completion rate, average completion time, pending
    approvals, overdue steps, and stage bottlenecks.
  - Breakdowns by month, department, document type, workflow, and status.
  - "Use server-side aggregation and real database records; do not calculate
    organization-wide figures from only the current page of client-side
    data" — every number here is a SQL aggregate over the whole period, not
    a count of a page of rows.
  - "Define metrics consistently. For example, distinguish documents created
    during a period from documents completed during that period." — the
    response separates `created_in_period` from `completed_in_period`, and
    says which timestamp each metric is bucketed on.
  - Role-based visibility (§2.5 Analytics row): Main Admin/HR see
    organization-wide figures; Worker sees own + department documents;
    Trainee sees only their own. The scope actually applied is reported back
    in `scope` so the UI can label the figures honestly.

All timestamps are treated as UTC. Period boundaries are half-open
[start, end) so a document created at exactly the boundary is counted in
exactly one period.
"""
from __future__ import annotations

import calendar
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

import structlog
from sqlalchemy import Integer, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.enums import ApprovalDecision, WorkflowInstanceStatus
from app.domain.permissions import AuthUser
from app.models.document import Document, DocumentStatus, DocumentType
from app.models.organization import Department
from app.models.workflow import (
    ApprovalStep,
    WorkflowInstance,
    WorkflowStage,
    WorkflowTemplate,
)

logger = structlog.get_logger(__name__)

Period = Literal["monthly", "yearly"]


def resolve_period(
    period: Period = "monthly",
    year: int | None = None,
    month: int | None = None,
) -> tuple[datetime, datetime, str]:
    """
    Resolve (start, end, label) for the requested reporting period.

    Defaults to the CURRENT month (monthly) or the current year (yearly),
    per §9 "The default reporting period should be monthly, with an option
    to switch to yearly reporting". Boundaries are half-open [start, end).
    """
    now = datetime.now(timezone.utc)
    year = year or now.year

    if period == "yearly":
        start = datetime(year, 1, 1, tzinfo=timezone.utc)
        end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
        return start, end, str(year)

    month = month or now.month
    if not 1 <= month <= 12:
        raise ValueError("month must be between 1 and 12")
    start = datetime(year, month, 1, tzinfo=timezone.utc)
    last_day = calendar.monthrange(year, month)[1]
    end = datetime(year, month, last_day, tzinfo=timezone.utc) + timedelta(days=1)
    return start, end, f"{year}-{month:02d}"


class AnalyticsService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # ── Role-based scoping ──────────────────────────────────────────────────

    async def _scope_documents(self, q, user: AuthUser) -> tuple[Any, str]:
        """
        Apply §2.5's per-role analytics visibility to a Document query.
        Returns (query, scope_label) so the caller can report which scope
        produced the numbers rather than implying they're org-wide.
        """
        if user.is_superadmin or ({"admin", "hr"} & set(user.roles)):
            return q, "organization"

        from app.services.document_service import get_user_departments

        dept_ids = await get_user_departments(self.db, user.id, user.org_id)
        if "worker" in user.roles:
            return (
                q.where(
                    or_(
                        Document.submitted_by == user.id,
                        Document.dept_id.in_(dept_ids) if dept_ids else False,
                        Document.dept_id.is_(None),
                    )
                ),
                "own_and_department",
            )
        # Trainee (and any role without broader analytics rights): own only.
        return q.where(Document.submitted_by == user.id), "own"

    # ── Main report ─────────────────────────────────────────────────────────

    async def get_report(
        self,
        user: AuthUser,
        period: Period = "monthly",
        year: int | None = None,
        month: int | None = None,
        dept_id: uuid.UUID | None = None,
        doc_type_id: uuid.UUID | None = None,
    ) -> dict:
        """Build the full analytics report for the period and caller."""
        start, end, label = resolve_period(period, year, month)
        org_id = user.org_id

        base = select(Document).where(
            Document.org_id == org_id,
            Document.deleted_at.is_(None),
        )
        if dept_id:
            base = base.where(Document.dept_id == dept_id)
        if doc_type_id:
            base = base.where(Document.doc_type_id == doc_type_id)
        base, scope = await self._scope_documents(base, user)
        scoped_doc_ids = base.with_only_columns(Document.id).subquery()

        created = await self._document_counts(base, start, end, by="created_at")
        completed = await self._document_counts(base, start, end, by="updated_at")
        workflow = await self._workflow_metrics(org_id, scoped_doc_ids, start, end)
        approvals = await self._approval_metrics(org_id, scoped_doc_ids, start, end)
        breakdowns = {
            "by_status": await self._by_status(base, start, end),
            "by_department": await self._by_department(base, org_id, start, end),
            "by_document_type": await self._by_document_type(base, org_id, start, end),
            "by_workflow": await self._by_workflow(org_id, scoped_doc_ids, start, end),
            "by_month": await self._by_month(base, start, end),
        }
        bottlenecks = await self._bottlenecks(org_id, scoped_doc_ids, start, end)

        total_created = sum(created.values())
        has_data = bool(total_created or workflow["instances_started"] or approvals["decisions_made"])

        return {
            "period": period,
            "period_label": label,
            "period_start": start.isoformat(),
            "period_end": end.isoformat(),
            "timezone": "UTC",
            "scope": scope,
            "has_data": has_data,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            # §9: created-in-period vs completed-in-period are different
            # metrics and are reported separately, each labelled with the
            # timestamp it buckets on.
            "documents": {
                "created_in_period": created,
                "created_total": total_created,
                "completed_in_period": {
                    k: v
                    for k, v in completed.items()
                    if k
                    in (
                        DocumentStatus.APPROVED.value,
                        DocumentStatus.REJECTED.value,
                        DocumentStatus.FINALIZED.value,
                        DocumentStatus.SENT_BACK.value,
                        DocumentStatus.REVOKED.value,
                    )
                },
                "created_bucketed_on": "documents.created_at",
                "completed_bucketed_on": "documents.updated_at",
            },
            "workflows": workflow,
            "approvals": approvals,
            "breakdowns": breakdowns,
            "bottlenecks": bottlenecks,
        }

    # ── Component aggregates ────────────────────────────────────────────────

    async def _document_counts(
        self, base, start: datetime, end: datetime, by: str
    ) -> dict[str, int]:
        col = getattr(Document, by)
        q = (
            base.with_only_columns(Document.status, func.count())
            .where(col >= start, col < end)
            .group_by(Document.status)
        )
        rows = (await self.db.execute(q)).all()
        counts = {
            (s.value if hasattr(s, "value") else str(s)): int(c) for s, c in rows
        }
        # Always present, so the UI never has to special-case a missing key.
        for st in DocumentStatus:
            counts.setdefault(st.value, 0)
        return counts

    async def _workflow_metrics(
        self, org_id: uuid.UUID, scoped_doc_ids, start: datetime, end: datetime
    ) -> dict:
        started = (
            await self.db.execute(
                select(func.count())
                .select_from(WorkflowInstance)
                .where(
                    WorkflowInstance.org_id == org_id,
                    WorkflowInstance.document_id.in_(select(scoped_doc_ids.c.id)),
                    WorkflowInstance.submitted_at >= start,
                    WorkflowInstance.submitted_at < end,
                )
            )
        ).scalar_one()

        terminal = (
            WorkflowInstanceStatus.APPROVED,
            WorkflowInstanceStatus.FINALIZED,
            WorkflowInstanceStatus.REJECTED,
        )
        completed_q = select(
            func.count(),
            func.avg(
                func.extract("epoch", WorkflowInstance.completed_at - WorkflowInstance.submitted_at)
            ),
        ).where(
            WorkflowInstance.org_id == org_id,
            WorkflowInstance.document_id.in_(select(scoped_doc_ids.c.id)),
            WorkflowInstance.completed_at.is_not(None),
            WorkflowInstance.completed_at >= start,
            WorkflowInstance.completed_at < end,
            WorkflowInstance.status.in_(terminal),
        )
        completed_count, avg_seconds = (await self.db.execute(completed_q)).one()
        completed_count = int(completed_count or 0)

        # Status mix of every instance touching this period (not just ones
        # that started in it) — this is what "workflow volume" means for a
        # dashboard: what's live right now plus what closed.
        status_rows = (
            await self.db.execute(
                select(WorkflowInstance.status, func.count())
                .where(
                    WorkflowInstance.org_id == org_id,
                    WorkflowInstance.document_id.in_(select(scoped_doc_ids.c.id)),
                )
                .group_by(WorkflowInstance.status)
            )
        ).all()

        open_statuses = (
            WorkflowInstanceStatus.PENDING,
            WorkflowInstanceStatus.IN_PROGRESS,
            WorkflowInstanceStatus.CHANGES_REQUESTED,
            WorkflowInstanceStatus.ESCALATED,
            WorkflowInstanceStatus.RECALL_REQUESTED,
        )
        by_status = {str(s): int(c) for s, c in status_rows}

        return {
            "instances_started": int(started or 0),
            "instances_completed": completed_count,
            # Completion rate over the period's starts — reported as None
            # rather than 0 when nothing started, so the UI can show "no
            # data" instead of a misleading 0%.
            "completion_rate": (
                round(completed_count / started, 4) if started else None
            ),
            "avg_completion_hours": (
                round(float(avg_seconds) / 3600, 2) if avg_seconds is not None else None
            ),
            "currently_open": sum(
                v for k, v in by_status.items() if k in {str(s) for s in open_statuses}
            ),
            "by_status": by_status,
        }

    async def _approval_metrics(
        self, org_id: uuid.UUID, scoped_doc_ids, start: datetime, end: datetime
    ) -> dict:
        instance_ids = (
            select(WorkflowInstance.id)
            .where(
                WorkflowInstance.org_id == org_id,
                WorkflowInstance.document_id.in_(select(scoped_doc_ids.c.id)),
            )
            .scalar_subquery()
        )

        decision_rows = (
            await self.db.execute(
                select(ApprovalStep.decision, func.count())
                .where(
                    ApprovalStep.instance_id.in_(instance_ids),
                    ApprovalStep.decided_at >= start,
                    ApprovalStep.decided_at < end,
                )
                .group_by(ApprovalStep.decision)
            )
        ).all()
        by_decision = {str(d): int(c) for d, c in decision_rows}

        pending = (
            await self.db.execute(
                select(func.count())
                .select_from(ApprovalStep)
                .where(
                    ApprovalStep.instance_id.in_(instance_ids),
                    ApprovalStep.decision == ApprovalDecision.PENDING,
                )
            )
        ).scalar_one()

        now = datetime.now(timezone.utc)
        overdue = (
            await self.db.execute(
                select(func.count())
                .select_from(ApprovalStep)
                .where(
                    ApprovalStep.instance_id.in_(instance_ids),
                    ApprovalStep.decision == ApprovalDecision.PENDING,
                    ApprovalStep.due_at.is_not(None),
                    ApprovalStep.due_at < now,
                )
            )
        ).scalar_one()

        avg_decision_seconds = (
            await self.db.execute(
                select(
                    func.avg(
                        func.extract("epoch", ApprovalStep.decided_at - ApprovalStep.created_at)
                    )
                ).where(
                    ApprovalStep.instance_id.in_(instance_ids),
                    ApprovalStep.decided_at.is_not(None),
                    ApprovalStep.decided_at >= start,
                    ApprovalStep.decided_at < end,
                )
            )
        ).scalar_one()

        revoked = (
            await self.db.execute(
                select(func.count())
                .select_from(ApprovalStep)
                .where(
                    ApprovalStep.instance_id.in_(instance_ids),
                    ApprovalStep.revoked_at.is_not(None),
                    ApprovalStep.revoked_at >= start,
                    ApprovalStep.revoked_at < end,
                )
            )
        ).scalar_one()

        return {
            "decisions_made": sum(by_decision.values()),
            "by_decision": by_decision,
            "pending_now": int(pending or 0),
            "overdue_now": int(overdue or 0),
            "revoked_in_period": int(revoked or 0),
            "avg_time_to_decision_hours": (
                round(float(avg_decision_seconds) / 3600, 2)
                if avg_decision_seconds is not None
                else None
            ),
        }

    async def _by_status(self, base, start: datetime, end: datetime) -> list[dict]:
        q = (
            base.with_only_columns(Document.status, func.count())
            .where(Document.created_at >= start, Document.created_at < end)
            .group_by(Document.status)
        )
        rows = (await self.db.execute(q)).all()
        return [
            {"key": (s.value if hasattr(s, "value") else str(s)), "count": int(c)}
            for s, c in rows
        ]

    async def _by_department(
        self, base, org_id: uuid.UUID, start: datetime, end: datetime
    ) -> list[dict]:
        q = (
            base.with_only_columns(Document.dept_id, func.count())
            .where(Document.created_at >= start, Document.created_at < end)
            .group_by(Document.dept_id)
        )
        rows = (await self.db.execute(q)).all()
        dept_ids = [d for d, _ in rows if d]
        names = {}
        if dept_ids:
            names = {
                d.id: d.name
                for d in (
                    await self.db.execute(
                        select(Department).where(Department.id.in_(dept_ids))
                    )
                ).scalars().all()
            }
        return [
            {
                "key": str(d) if d else None,
                "label": names.get(d, "Unassigned") if d else "Unassigned",
                "count": int(c),
            }
            for d, c in rows
        ]

    async def _by_document_type(
        self, base, org_id: uuid.UUID, start: datetime, end: datetime
    ) -> list[dict]:
        q = (
            base.with_only_columns(Document.doc_type_id, func.count())
            .where(Document.created_at >= start, Document.created_at < end)
            .group_by(Document.doc_type_id)
        )
        rows = (await self.db.execute(q)).all()
        type_ids = [t for t, _ in rows if t]
        names = {}
        if type_ids:
            names = {
                t.id: t.name
                for t in (
                    await self.db.execute(
                        select(DocumentType).where(DocumentType.id.in_(type_ids))
                    )
                ).scalars().all()
            }
        return [
            {"key": str(t) if t else None, "label": names.get(t, "Unknown"), "count": int(c)}
            for t, c in rows
        ]

    async def _by_workflow(
        self, org_id: uuid.UUID, scoped_doc_ids, start: datetime, end: datetime
    ) -> list[dict]:
        rows = (
            await self.db.execute(
                select(WorkflowInstance.template_id, func.count())
                .where(
                    WorkflowInstance.org_id == org_id,
                    WorkflowInstance.document_id.in_(select(scoped_doc_ids.c.id)),
                    WorkflowInstance.submitted_at >= start,
                    WorkflowInstance.submitted_at < end,
                )
                .group_by(WorkflowInstance.template_id)
            )
        ).all()
        tmpl_ids = [t for t, _ in rows if t]
        names = {}
        if tmpl_ids:
            names = {
                t.id: t.name
                for t in (
                    await self.db.execute(
                        select(WorkflowTemplate).where(WorkflowTemplate.id.in_(tmpl_ids))
                    )
                ).scalars().all()
            }
        return [
            {
                "key": str(t) if t else None,
                "label": names.get(t, "Ad-hoc / deleted workflow"),
                "count": int(c),
            }
            for t, c in rows
        ]

    async def _by_month(self, base, start: datetime, end: datetime) -> list[dict]:
        """
        Month-by-month buckets across the selected range (§9 "Provide
        breakdowns by month"). For a monthly period this is a single bucket;
        for a yearly period it is up to twelve.
        """
        month_col = func.date_trunc("month", Document.created_at)
        q = (
            base.with_only_columns(month_col.label("bucket"), func.count())
            .where(Document.created_at >= start, Document.created_at < end)
            .group_by("bucket")
            .order_by("bucket")
        )
        rows = (await self.db.execute(q)).all()
        counted = {
            (b.strftime("%Y-%m") if hasattr(b, "strftime") else str(b)): int(c)
            for b, c in rows
        }

        # Emit every month in range, including empty ones, so a chart doesn't
        # silently skip months with no activity.
        buckets: list[dict] = []
        cursor = start.replace(day=1)
        while cursor < end:
            key = cursor.strftime("%Y-%m")
            buckets.append({"key": key, "count": counted.get(key, 0)})
            cursor = (cursor.replace(day=28) + timedelta(days=4)).replace(day=1)
        return buckets

    async def _bottlenecks(
        self, org_id: uuid.UUID, scoped_doc_ids, start: datetime, end: datetime, limit: int = 5
    ) -> list[dict]:
        """
        Slowest stages by average time-to-decision, plus how many steps are
        still pending there (§9 "pending approvals, overdue steps where due
        dates exist, and bottlenecks").
        """
        instance_ids = (
            select(WorkflowInstance.id)
            .where(
                WorkflowInstance.org_id == org_id,
                WorkflowInstance.document_id.in_(select(scoped_doc_ids.c.id)),
            )
            .scalar_subquery()
        )
        now = datetime.now(timezone.utc)

        rows = (
            await self.db.execute(
                select(
                    WorkflowStage.id,
                    WorkflowStage.name,
                    func.avg(
                        func.extract("epoch", ApprovalStep.decided_at - ApprovalStep.created_at)
                    ).label("avg_seconds"),
                    func.count(ApprovalStep.id).label("decided_count"),
                )
                .join(ApprovalStep, ApprovalStep.stage_id == WorkflowStage.id)
                .where(
                    ApprovalStep.instance_id.in_(instance_ids),
                    ApprovalStep.decided_at.is_not(None),
                    ApprovalStep.decided_at >= start,
                    ApprovalStep.decided_at < end,
                )
                .group_by(WorkflowStage.id, WorkflowStage.name)
                .order_by(func.avg(
                    func.extract("epoch", ApprovalStep.decided_at - ApprovalStep.created_at)
                ).desc())
                .limit(limit)
            )
        ).all()

        pending_rows = (
            await self.db.execute(
                select(
                    ApprovalStep.stage_id,
                    func.count(),
                    func.sum(
                        func.cast(
                            (ApprovalStep.due_at.is_not(None)) & (ApprovalStep.due_at < now),
                            Integer,
                        )
                    ),
                )
                .where(
                    ApprovalStep.instance_id.in_(instance_ids),
                    ApprovalStep.decision == ApprovalDecision.PENDING,
                )
                .group_by(ApprovalStep.stage_id)
            )
        ).all()
        pending_by_stage = {s: (int(c), int(o or 0)) for s, c, o in pending_rows}

        out = []
        for stage_id, name, avg_seconds, decided_count in rows:
            pending_count, overdue_count = pending_by_stage.get(stage_id, (0, 0))
            out.append({
                "stage_id": str(stage_id),
                "stage_name": name,
                "avg_time_to_decision_hours": (
                    round(float(avg_seconds) / 3600, 2) if avg_seconds is not None else None
                ),
                "decisions_in_period": int(decided_count or 0),
                "pending_now": pending_count,
                "overdue_now": overdue_count,
            })
        return out
