"""
DocFlow Backend — Domain: Workflow Engine
Pure graph traversal and step resolution logic — no I/O.
This is the core orchestration brain of DocFlow.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from app.domain.approval_logic import (
    evaluate_conditional_edge,
    evaluate_parallel_gate,
    get_workflow_terminal_status,
    is_workflow_complete,
    resolve_next_steps,
)
from app.domain.enums import (
    ApprovalDecision,
    AssigneeType,
    WorkflowStepStatus,
    WorkflowStepType,
)
from app.domain.sla import calculate_due_at

from datetime import datetime, timezone


@dataclass
class StepActivation:
    """Instructions for activating a workflow step."""
    step_id: str
    step_type: WorkflowStepType
    step_definition: dict[str, Any]
    step_order: int
    assignee_type: AssigneeType
    assigned_role_id: UUID | None
    assigned_user_id: UUID | None
    sla_hours: int | None
    due_at: datetime | None
    requires: str = "all"   # for parallel steps: "all" | "majority" | "any"


@dataclass
class WorkflowAdvanceResult:
    """
    Result of advancing a workflow after an approval decision.
    Used by the service layer to persist state changes and send notifications.
    """
    completed_step_id: str
    next_steps: list[StepActivation] = field(default_factory=list)
    workflow_complete: bool = False
    workflow_outcome: str | None = None  # "completed" | "rejected" | "cancelled"
    document_status_update: str | None = None  # new document status if workflow terminal


class WorkflowValidationError(Exception):
    """Raised when a workflow definition is invalid."""
    pass


class WorkflowEngine:
    """
    Stateless workflow engine.
    Takes workflow definitions and step state as input; returns instructions.
    No database access — all persistence is handled by WorkflowService.
    """

    def validate_definition(self, definition: dict[str, Any]) -> None:
        """
        Validate a workflow template definition.
        Checks: required fields, valid step types, no cycles in DAG.

        Raises WorkflowValidationError on invalid definition.
        """
        steps = definition.get("steps", [])
        edges = definition.get("edges", [])

        if not steps:
            raise WorkflowValidationError("Workflow must have at least one step")

        step_ids = {s["id"] for s in steps}

        # Validate each step
        for step in steps:
            if not step.get("id"):
                raise WorkflowValidationError("Each step must have an 'id'")
            if not step.get("type"):
                raise WorkflowValidationError(f"Step '{step['id']}' missing 'type'")
            if step["type"] not in [t.value for t in WorkflowStepType]:
                raise WorkflowValidationError(
                    f"Step '{step['id']}' has invalid type '{step['type']}'"
                )

        # Validate edges reference existing steps
        for edge in edges:
            frm = edge.get("from")
            to = edge.get("to")
            if frm and frm not in step_ids:
                raise WorkflowValidationError(f"Edge references unknown step '{frm}'")
            if to and to not in step_ids:
                raise WorkflowValidationError(f"Edge references unknown step '{to}'")

        # Detect cycles using DFS
        if self._has_cycle(step_ids, edges):
            raise WorkflowValidationError("Workflow definition contains a cycle")

    def get_initial_steps(
        self,
        definition: dict[str, Any],
        started_at: datetime | None = None,
    ) -> list[StepActivation]:
        """
        Get the first steps to activate when a workflow instance starts.
        Initial steps are those with no incoming edges.
        """
        if started_at is None:
            started_at = datetime.now(timezone.utc)

        steps = definition.get("steps", [])
        edges = definition.get("edges", [])

        # Find steps that have no incoming edges
        steps_with_incoming = {e["to"] for e in edges if e.get("to")}
        initial_steps = [s for s in steps if s["id"] not in steps_with_incoming]

        return [
            self._build_step_activation(step, i, started_at)
            for i, step in enumerate(initial_steps)
        ]

    def advance(
        self,
        definition: dict[str, Any],
        completed_step_id: str,
        decision: str,
        all_step_statuses: list[dict[str, Any]],
        document_form_data: dict[str, Any],
        document_metadata: dict[str, Any],
        now: datetime | None = None,
    ) -> WorkflowAdvanceResult:
        """
        Core workflow advancement logic.

        Args:
            definition: Frozen workflow template definition.
            completed_step_id: The step that just received a decision.
            decision: The decision made ("approved", "rejected", "returned").
            all_step_statuses: Current status of all steps in the workflow instance.
            document_form_data: Document form data (for conditional evaluation).
            document_metadata: Document metadata.
            now: Current time (injectable for testing).

        Returns:
            WorkflowAdvanceResult with next steps to activate and outcome.
        """
        if now is None:
            now = datetime.now(timezone.utc)

        # 1. If rejected, cancel all pending steps
        if decision == ApprovalDecision.REJECTED:
            return WorkflowAdvanceResult(
                completed_step_id=completed_step_id,
                next_steps=[],
                workflow_complete=True,
                workflow_outcome="rejected",
                document_status_update="rejected",
            )

        # 2. If returned, workflow pauses (document goes back to submitter)
        if decision == ApprovalDecision.RETURNED:
            return WorkflowAdvanceResult(
                completed_step_id=completed_step_id,
                next_steps=[],
                workflow_complete=False,
                document_status_update="revision_requested",
            )

        # 3. Resolve next steps via graph traversal
        next_step_ids = resolve_next_steps(
            definition,
            completed_step_id,
            decision,
            document_form_data,
            document_metadata,
        )

        # 4. Check if workflow is now complete
        # Update the completed step in our status list for the check
        updated_statuses = [
            {**s, "status": "approved"} if s["step_id"] == completed_step_id else s
            for s in all_step_statuses
        ]

        if not next_step_ids:
            # No outgoing edges from this step
            if is_workflow_complete(updated_statuses):
                outcome = get_workflow_terminal_status(updated_statuses)
                return WorkflowAdvanceResult(
                    completed_step_id=completed_step_id,
                    next_steps=[],
                    workflow_complete=True,
                    workflow_outcome=outcome,
                    document_status_update="approved" if outcome == "completed" else outcome,
                )
            # May still have other active parallel branches
            return WorkflowAdvanceResult(
                completed_step_id=completed_step_id,
                next_steps=[],
                workflow_complete=False,
            )

        # 5. Build activation objects for next steps
        steps_map = {s["id"]: s for s in definition.get("steps", [])}
        next_activations = []
        for i, step_id in enumerate(next_step_ids):
            step_def = steps_map.get(step_id)
            if step_def:
                activation = self._build_step_activation(step_def, i, now)
                next_activations.append(activation)

        return WorkflowAdvanceResult(
            completed_step_id=completed_step_id,
            next_steps=next_activations,
            workflow_complete=False,
        )

    # ── Private Helpers ─────────────────────────────────────────────────────────

    def _build_step_activation(
        self,
        step: dict[str, Any],
        order: int,
        started_at: datetime,
    ) -> StepActivation:
        """Build a StepActivation from a step definition dict."""
        sla_hours = step.get("sla_hours")
        due_at = None
        if sla_hours:
            due_at = calculate_due_at(started_at, sla_hours)

        return StepActivation(
            step_id=step["id"],
            step_type=WorkflowStepType(step.get("type", WorkflowStepType.APPROVAL)),
            step_definition=step,
            step_order=order,
            assignee_type=AssigneeType(step.get("assignee_type", AssigneeType.USER)),
            assigned_role_id=_parse_uuid(step.get("role_id")),
            assigned_user_id=_parse_uuid(step.get("user_id")),
            sla_hours=sla_hours,
            due_at=due_at,
            requires=step.get("requires", "all"),
        )

    def _has_cycle(self, step_ids: set[str], edges: list[dict]) -> bool:
        """DFS cycle detection on the workflow DAG."""
        adjacency: dict[str, list[str]] = {sid: [] for sid in step_ids}
        for edge in edges:
            frm = edge.get("from")
            to = edge.get("to")
            if frm and to and frm in adjacency:
                adjacency[frm].append(to)

        visited: set[str] = set()
        rec_stack: set[str] = set()

        def dfs(node: str) -> bool:
            visited.add(node)
            rec_stack.add(node)
            for neighbor in adjacency.get(node, []):
                if neighbor not in visited:
                    if dfs(neighbor):
                        return True
                elif neighbor in rec_stack:
                    return True
            rec_stack.discard(node)
            return False

        for step_id in step_ids:
            if step_id not in visited:
                if dfs(step_id):
                    return True
        return False


def _parse_uuid(value: str | None) -> UUID | None:
    if not value:
        return None
    try:
        return UUID(value)
    except (ValueError, AttributeError):
        return None


# ── Module-level singleton ─────────────────────────────────────────────────────
workflow_engine = WorkflowEngine()
