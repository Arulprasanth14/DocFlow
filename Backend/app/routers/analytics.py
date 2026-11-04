"""
DocFlow Backend — Router: Analytics
Endpoints:
  GET /api/v1/analytics/dashboard — summary stats for the AnalyticsPage dashboard
  GET /api/v1/analytics/report    — full §9 report (monthly/yearly, breakdowns,
                                    bottlenecks, server-side aggregation)

Both are role-scoped: Main Admin/HR get organization-wide figures, Worker
gets own + department, Trainee gets own only (§2.5 Analytics row). The scope
actually applied is returned in the payload so the UI can label it honestly
instead of implying org-wide numbers.

The previously-stubbed avg_approval_time_hours / sla_breach_rate /
trend_data fields are now real aggregates from AnalyticsService (they used
to return honest zeros because no aggregation existed).
"""
from __future__ import annotations

from typing import Annotated, Literal, Optional
import uuid

from fastapi import APIRouter, Query
from pydantic import BaseModel

from app.dependencies import CurrentUser, DatabaseDep
from app.services.analytics_service import AnalyticsService

router = APIRouter(prefix="/analytics", tags=["Analytics"])


class DashboardStatsResponse(BaseModel):
    documents_submitted: int
    documents_approved: int
    documents_rejected: int
    avg_approval_time_hours: float
    sla_breach_rate: float
    pending_approvals: int
    trend_data: list[dict]


@router.get(
    "/dashboard",
    response_model=DashboardStatsResponse,
    summary="Summary stats for the analytics dashboard",
)
async def get_dashboard_stats(
    current_user: CurrentUser,
    db: DatabaseDep,
    period: Annotated[Literal["monthly", "yearly"], Query()] = "monthly",
    year: Annotated[Optional[int], Query(ge=2000, le=2100)] = None,
    month: Annotated[Optional[int], Query(ge=1, le=12)] = None,
) -> DashboardStatsResponse:
    if not current_user.org_id:
        return DashboardStatsResponse(
            documents_submitted=0,
            documents_approved=0,
            documents_rejected=0,
            avg_approval_time_hours=0.0,
            sla_breach_rate=0.0,
            pending_approvals=0,
            trend_data=[],
        )

    svc = AnalyticsService(db)
    report = await svc.get_report(current_user, period=period, year=year, month=month)

    created = report["documents"]["created_in_period"]
    approvals = report["approvals"]
    pending = approvals["pending_now"]
    overdue = approvals["overdue_now"]

    return DashboardStatsResponse(
        documents_submitted=report["documents"]["created_total"],
        documents_approved=created.get("approved", 0) + created.get("finalized", 0),
        documents_rejected=created.get("rejected", 0),
        avg_approval_time_hours=approvals["avg_time_to_decision_hours"] or 0.0,
        # Share of still-open approval steps that are past their due date.
        # Steps with no due date can't breach, so they're excluded from the
        # denominator rather than diluting the rate.
        sla_breach_rate=round(overdue / pending, 4) if pending else 0.0,
        pending_approvals=pending,
        trend_data=report["breakdowns"]["by_month"],
    )


@router.get(
    "/report",
    summary="Full analytics report (§9): monthly/yearly, breakdowns, bottlenecks",
)
async def get_analytics_report(
    current_user: CurrentUser,
    db: DatabaseDep,
    period: Annotated[Literal["monthly", "yearly"], Query()] = "monthly",
    year: Annotated[Optional[int], Query(ge=2000, le=2100)] = None,
    month: Annotated[Optional[int], Query(ge=1, le=12)] = None,
    dept_id: Annotated[Optional[uuid.UUID], Query()] = None,
    doc_type_id: Annotated[Optional[uuid.UUID], Query()] = None,
) -> dict:
    """
    Defaults to the current month; pass period=yearly (optionally with
    `year`) to switch to yearly reporting. Every figure is a server-side SQL
    aggregate over the whole period — never a count of one page of rows.
    `has_data` is false when the period genuinely has no activity, so the UI
    can show a real no-data state instead of a wall of zeros.
    """
    if not current_user.org_id:
        return {
            "period": period,
            "has_data": False,
            "scope": "none",
            "documents": {"created_in_period": {}, "created_total": 0},
        }
    svc = AnalyticsService(db)
    return await svc.get_report(
        current_user,
        period=period,
        year=year,
        month=month,
        dept_id=dept_id,
        doc_type_id=doc_type_id,
    )
