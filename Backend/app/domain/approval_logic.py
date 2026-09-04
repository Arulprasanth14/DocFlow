"""
DocFlow Backend — Domain: Approval Logic
Pure approval gate evaluation — no I/O.
Handles sequential, parallel, and conditional routing logic.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from app.domain.enums import ApprovalDecision, WorkflowStepType


@dataclass
class StepDecisionSummary:
    """Summary of decisions made on a parallel step group."""
    total: int
    approved: int
    rejected: int
    pending: int
    returned: int


def evaluate_parallel_gate(
    step_decisions: list[dict[str, Any]],
    requires: str = "all",   # "all" | "majority" | "any"
) -> str | None:
    """
    Evaluate the gate condition for a parallel approval step.

    Args:
        step_decisions: List of {decision: str} dicts for each parallel approver.
        requires: Gate requirement ("all", "majority", "any").

    Returns:
        "approved"  — gate passed
        "rejected"  — gate failed
        None        — still waiting (more decisions needed)
    """
    summary = _summarise_decisions(step_decisions)

    # Any rejection → immediately fail (regardless of mode)
    if summary.rejected > 0:
        return ApprovalDecision.REJECTED

    if requires == "all":
        if summary.pending > 0 or summary.returned > 0:
            return None   # still waiting
        if summary.approved == summary.total:
            return ApprovalDecision.APPROVED

    elif requires == "majority":
        majority = (summary.total // 2) + 1
        if summary.approved >= majority:
            return ApprovalDecision.APPROVED
        if summary.pending == 0 and summary.returned == 0:
            # Everyone decided and majority not reached
            return ApprovalDecision.REJECTED
        return None  # still collecting

    elif requires == "any":
        if summary.approved >= 1:
            return ApprovalDecision.APPROVED
        if summary.pending == 0:
            return ApprovalDecision.REJECTED
        return None  # still waiting

    return None


def evaluate_conditional_edge(
    condition: dict[str, Any],
    document_form_data: dict[str, Any],
    document_metadata: dict[str, Any],
) -> bool:
    """
    Evaluate a conditional edge in the workflow DAG.

    Condition format:
        {"field": "amount", "op": ">", "value": 10000}
        {"field": "dept_code", "op": "==", "value": "FINANCE"}
        {"field": "doc_type", "op": "in", "value": ["PO", "INVOICE"]}

    Args:
        condition: The condition definition dict.
        document_form_data: The document's filled form data.
        document_metadata: The document's metadata (AI-extracted or user-provided).

    Returns:
        True if condition passes (edge should be followed).
    """
    if not condition:
        return True   # no condition = unconditional edge

    field = condition.get("field", "")
    op = condition.get("op", "==")
    expected = condition.get("value")

    # Resolve field value from form data or metadata
    actual = document_form_data.get(field) or document_metadata.get(field)

    if actual is None:
        return False  # field not present → condition fails

    return _apply_operator(actual, op, expected)


def resolve_next_steps(
    workflow_definition: dict[str, Any],
    current_step_id: str,
    decision: str,
    document_form_data: dict[str, Any],
    document_metadata: dict[str, Any],
) -> list[str]:
    """
    Given a workflow DAG definition and the current step's decision,
    resolve which step IDs should be activated next.

    Args:
        workflow_definition: {"steps": [...], "edges": [...]}
        current_step_id: The step that just completed.
        decision: The decision made on the step ("approved", "rejected", "returned").
        document_form_data: Document form data for conditional evaluation.
        document_metadata: Document metadata for conditional evaluation.

    Returns:
        List of next step IDs to activate. Empty list = workflow complete.
    """
    edges = workflow_definition.get("edges", [])
    next_step_ids: list[str] = []

    for edge in edges:
        if edge.get("from") != current_step_id:
            continue

        # Edge condition on decision (e.g., only follow "approved" edges)
        edge_condition = edge.get("condition")
        if edge_condition and edge_condition != decision:
            continue

        # Evaluate dynamic condition on document fields
        field_condition = edge.get("field_condition")
        if field_condition and not evaluate_conditional_edge(
            field_condition, document_form_data, document_metadata
        ):
            continue

        to_step = edge.get("to")
        if to_step:
            next_step_ids.append(to_step)

    return next_step_ids


def is_workflow_complete(
    step_statuses: list[dict[str, Any]],
) -> bool:
    """
    Check if all steps in a workflow instance have reached a terminal state.
    A terminal state is any non-pending/non-active state.
    """
    non_terminal = {"pending", "active"}
    return all(
        step.get("status") not in non_terminal for step in step_statuses
    )


def get_workflow_terminal_status(
    step_statuses: list[dict[str, Any]],
) -> str:
    """
    Determine the overall workflow outcome from all step statuses.
    Returns "completed" | "rejected" | "cancelled".
    """
    statuses = [s.get("status") for s in step_statuses]

    if any(s == "rejected" for s in statuses):
        return "rejected"
    if any(s == "cancelled" for s in statuses):
        return "cancelled"
    return "completed"


# ── Private Helpers ────────────────────────────────────────────────────────────

def _summarise_decisions(step_decisions: list[dict[str, Any]]) -> StepDecisionSummary:
    approved = sum(1 for s in step_decisions if s.get("decision") == ApprovalDecision.APPROVED)
    rejected = sum(1 for s in step_decisions if s.get("decision") == ApprovalDecision.REJECTED)
    returned = sum(1 for s in step_decisions if s.get("decision") == ApprovalDecision.RETURNED)
    pending = sum(1 for s in step_decisions if not s.get("decision"))
    return StepDecisionSummary(
        total=len(step_decisions),
        approved=approved,
        rejected=rejected,
        pending=pending,
        returned=returned,
    )


def _apply_operator(actual: Any, op: str, expected: Any) -> bool:
    """Apply a comparison operator to evaluate a condition."""
    try:
        match op:
            case "==" | "eq":
                return actual == expected
            case "!=" | "ne":
                return actual != expected
            case ">" | "gt":
                return float(actual) > float(expected)
            case ">=" | "gte":
                return float(actual) >= float(expected)
            case "<" | "lt":
                return float(actual) < float(expected)
            case "<=" | "lte":
                return float(actual) <= float(expected)
            case "in":
                return actual in (expected or [])
            case "not_in":
                return actual not in (expected or [])
            case "contains":
                return str(expected) in str(actual)
            case "starts_with":
                return str(actual).startswith(str(expected))
            case _:
                return False
    except (TypeError, ValueError):
        return False
