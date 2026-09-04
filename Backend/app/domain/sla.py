"""
DocFlow Backend — Domain: SLA
Pure SLA calculation and breach detection logic — no I/O.
SLA is defined in business hours or calendar hours per workflow step config.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import StrEnum
from typing import Any


class SLAStatus(StrEnum):
    ON_TIME = "on_time"
    WARNING = "warning"      # <20% of SLA remaining
    BREACHED = "breached"    # due_at has passed


@dataclass(frozen=True)
class SLAResult:
    status: SLAStatus
    due_at: datetime
    remaining_hours: float       # negative if breached
    breach_hours: float          # 0 if not breached, else hours since breach
    warning_threshold_pct: float = 0.20  # warn when < 20% remaining


def calculate_due_at(
    started_at: datetime,
    sla_hours: int,
    *,
    business_hours_only: bool = False,
    business_start_hour: int = 9,
    business_end_hour: int = 18,
    tz: timezone = timezone.utc,
) -> datetime:
    """
    Calculate the SLA due datetime from a start time and SLA hours.
    Supports calendar hours (default) and business hours (optional).

    Args:
        started_at: When the SLA clock started.
        sla_hours: Number of SLA hours allowed.
        business_hours_only: If True, count only 9am–6pm Mon–Fri.
        business_start_hour: Business day start (default 9).
        business_end_hour: Business day end (default 18).
        tz: Timezone for business hours calculation.
    """
    if not business_hours_only:
        return started_at + timedelta(hours=sla_hours)

    # Business hours calculation
    current = started_at.astimezone(tz)
    remaining = sla_hours

    while remaining > 0:
        # Skip weekends
        if current.weekday() >= 5:  # Saturday=5, Sunday=6
            current += timedelta(days=1)
            current = current.replace(hour=business_start_hour, minute=0, second=0, microsecond=0)
            continue

        # Move to business start if before hours
        if current.hour < business_start_hour:
            current = current.replace(hour=business_start_hour, minute=0, second=0, microsecond=0)

        # Past business hours — jump to next day
        if current.hour >= business_end_hour:
            current += timedelta(days=1)
            current = current.replace(hour=business_start_hour, minute=0, second=0, microsecond=0)
            continue

        # Hours left in today
        hours_today = business_end_hour - current.hour - (current.minute / 60)

        if remaining <= hours_today:
            # SLA expires today
            minutes_to_add = int(remaining * 60)
            current += timedelta(minutes=minutes_to_add)
            remaining = 0
        else:
            # SLA spans to next day
            remaining -= hours_today
            current += timedelta(days=1)
            current = current.replace(hour=business_start_hour, minute=0, second=0, microsecond=0)

    return current.astimezone(timezone.utc)


def evaluate_sla(
    due_at: datetime,
    sla_hours: int,
    started_at: datetime,
    now: datetime | None = None,
) -> SLAResult:
    """
    Evaluate the current SLA status of a workflow step.

    Args:
        due_at: The calculated due datetime.
        sla_hours: Total SLA hours (used to calculate warning threshold).
        started_at: When the SLA clock started.
        now: Current time (injectable for testing; defaults to UTC now).
    """
    if now is None:
        now = datetime.now(timezone.utc)

    total_duration = timedelta(hours=sla_hours)
    elapsed = now - started_at
    remaining_td = due_at - now
    remaining_hours = remaining_td.total_seconds() / 3600

    if now >= due_at:
        breach_hours = abs(remaining_hours)
        return SLAResult(
            status=SLAStatus.BREACHED,
            due_at=due_at,
            remaining_hours=remaining_hours,
            breach_hours=breach_hours,
        )

    # Warning if less than 20% of total SLA time remains
    pct_remaining = remaining_td / total_duration if total_duration.total_seconds() > 0 else 1.0
    if pct_remaining < 0.20:
        return SLAResult(
            status=SLAStatus.WARNING,
            due_at=due_at,
            remaining_hours=remaining_hours,
            breach_hours=0.0,
        )

    return SLAResult(
        status=SLAStatus.ON_TIME,
        due_at=due_at,
        remaining_hours=remaining_hours,
        breach_hours=0.0,
    )


def get_steps_needing_escalation(
    steps: list[dict[str, Any]],
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """
    Filter a list of active step dicts to find those that have breached SLA.
    Used by Celery Beat SLA checker task.

    Each step dict must have: due_at (datetime), status (str)
    """
    if now is None:
        now = datetime.now(timezone.utc)

    breached = []
    for step in steps:
        due_at = step.get("due_at")
        status = step.get("status")
        if due_at and status in ("pending", "active") and now >= due_at:
            breached.append(step)
    return breached


def format_duration(hours: float) -> str:
    """Human-readable duration for notifications (e.g. '2h 30m', '1d 4h')."""
    if hours < 0:
        prefix = "-"
        hours = abs(hours)
    else:
        prefix = ""

    days = int(hours // 24)
    remaining_hours = int(hours % 24)
    minutes = int((hours % 1) * 60)

    parts = []
    if days:
        parts.append(f"{days}d")
    if remaining_hours:
        parts.append(f"{remaining_hours}h")
    if minutes and not days:
        parts.append(f"{minutes}m")

    return prefix + " ".join(parts) if parts else "0m"
