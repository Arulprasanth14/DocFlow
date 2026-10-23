"""
Covers ApprovalService._enforce_approval_authority (trainee hard-block +
default-deny self-approval) and the Trainee-exclusion filters in
WorkflowService._apply_rule / TemplateService._reject_trainee_approvers.
"""
from __future__ import annotations

import uuid

import pytest

from app.domain.enums import ApprovalDecision
from app.models.document import Document, DocumentType, DocumentVersion
from app.models.workflow import ApprovalStep, WorkflowInstance, WorkflowStage, WorkflowTemplate
from app.schemas.workflow_instances import DecisionRequest
from app.services.approval_service import ApprovalService


async def _make_pending_step(db_session, org, submitter_id, approver_id):
    """Minimal Document + 1-stage WorkflowInstance + pending ApprovalStep,
    constructed directly via the ORM (bypassing the full submit HTTP flow,
    which has preconditions — doc-type form schemas, file uploads — not
    relevant to authorization logic under test here)."""
    doc_type = DocumentType(org_id=org.id, name="General", code=f"general-{uuid.uuid4().hex[:6]}")
    db_session.add(doc_type)
    await db_session.flush()

    doc = Document(
        org_id=org.id,
        doc_type_id=doc_type.id,
        public_id=f"DOC-{uuid.uuid4().hex[:8]}",
        title="Test Document",
        submitted_by=submitter_id,
    )
    db_session.add(doc)
    await db_session.flush()

    version = DocumentVersion(
        document_id=doc.id, version_num=1, title=doc.title, uploaded_by=submitter_id
    )
    db_session.add(version)
    await db_session.flush()

    template = WorkflowTemplate(org_id=org.id, name="Test Template")
    db_session.add(template)
    await db_session.flush()

    stage = WorkflowStage(template_id=template.id, sequence_order=1, name="Review")
    db_session.add(stage)
    await db_session.flush()

    instance = WorkflowInstance(
        org_id=org.id,
        document_id=doc.id,
        template_id=template.id,
        template_version_snapshot={},
        current_stage_id=stage.id,
    )
    db_session.add(instance)
    await db_session.flush()

    step = ApprovalStep(
        instance_id=instance.id,
        stage_id=stage.id,
        document_version_id=version.id,
        approver_id=approver_id,
    )
    db_session.add(step)
    await db_session.flush()

    return doc, instance, step


async def test_trainee_cannot_approve_even_if_assigned_as_approver(db_session, org, trainee, worker):
    """Hard gate: a trainee must never be able to record a decision, even if
    (by misconfiguration or direct manipulation) they ended up as the
    step's approver_id."""
    trainee_user, _ = trainee
    worker_user, _ = worker  # someone else entirely — just the submitter
    doc, instance, step = await _make_pending_step(
        db_session, org, submitter_id=worker_user.id, approver_id=trainee_user.id
    )

    svc = ApprovalService(db_session)
    with pytest.raises(Exception) as exc_info:
        await svc.decide(
            step_id=step.id,
            actor_id=trainee_user.id,
            org_id=org.id,
            req=DecisionRequest(decision=ApprovalDecision.APPROVED),
        )
    assert "Trainees" in str(exc_info.value) or "trainee" in str(exc_info.value).lower()


async def test_self_approval_blocked_by_default(db_session, org, worker):
    worker_user, _ = worker
    doc, instance, step = await _make_pending_step(
        db_session, org, submitter_id=worker_user.id, approver_id=worker_user.id
    )

    svc = ApprovalService(db_session)
    with pytest.raises(Exception) as exc_info:
        await svc.decide(
            step_id=step.id,
            actor_id=worker_user.id,
            org_id=org.id,
            req=DecisionRequest(decision=ApprovalDecision.APPROVED),
        )
    assert "own document" in str(exc_info.value).lower()


async def test_self_approval_allowed_when_org_opts_in(db_session, org, worker):
    worker_user, _ = worker
    org.settings = {**(org.settings or {}), "allow_self_approval": True}
    await db_session.flush()

    doc, instance, step = await _make_pending_step(
        db_session, org, submitter_id=worker_user.id, approver_id=worker_user.id
    )

    svc = ApprovalService(db_session)
    result = await svc.decide(
        step_id=step.id,
        actor_id=worker_user.id,
        org_id=org.id,
        req=DecisionRequest(decision=ApprovalDecision.APPROVED),
    )
    assert result.decision == ApprovalDecision.APPROVED


async def test_role_in_department_never_resolves_a_trainee(db_session, org, roles, trainee):
    from app.services.workflow_service import WorkflowService

    trainee_user, _ = trainee
    svc = WorkflowService(db_session)
    rule = type("Rule", (), {"rule_type": "role_in_department", "rule_value": {"role_name": "trainee"}})()
    resolved = await svc._apply_rule(rule, requester_id=uuid.uuid4(), org_id=org.id)
    # The rule itself matches (trainee IS the role name queried) — the
    # trainee exclusion happens one level up, in _resolve_approvers via
    # _exclude_trainees, so call that explicitly too.
    excluded = await svc._exclude_trainees(resolved, org.id)
    assert trainee_user.id not in excluded


async def test_template_rejects_specific_user_trainee_approver(db_session, org, roles, trainee):
    from app.schemas.workflow_instances import (
        StageApproverRuleCreate,
        WorkflowStageCreate,
        WorkflowTemplateCreate,
    )
    from app.services.template_service import TemplateService

    trainee_user, _ = trainee
    svc = TemplateService(db_session)
    req = WorkflowTemplateCreate(
        name="Bad Template",
        stages=[
            WorkflowStageCreate(
                name="Stage 1",
                sequence_order=1,
                approver_rules=[
                    StageApproverRuleCreate(
                        rule_type="specific_user",
                        rule_value={"user_id": str(trainee_user.id)},
                    ),
                ],
            ),
        ],
    )
    with pytest.raises(Exception) as exc_info:
        await svc.create(org_id=org.id, req=req)
    assert "trainee" in str(exc_info.value).lower()
