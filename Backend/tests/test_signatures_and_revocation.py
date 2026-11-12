"""
Covers the §6.4 cryptographic digital signatures, §6.5 revocation/recall,
§6.2/6.6 explicit finalization + chain of custody, and §7 workflow
definition validation.
"""
from __future__ import annotations

import uuid

import pytest

from app.domain.enums import ApprovalDecision, WorkflowInstanceStatus
from app.models.document import Document, DocumentStatus, DocumentType, DocumentVersion
from app.models.workflow import ApprovalStep, WorkflowInstance, WorkflowStage, WorkflowTemplate
from app.schemas.workflow_instances import DecisionRequest
from app.services.approval_service import ApprovalService


async def _make_instance(db_session, org, submitter_id, approver_id, *, stages=1, checksum="abc123"):
    """Document + N-stage instance + a pending step at stage 1."""
    doc_type = DocumentType(org_id=org.id, name="General", code=f"general-{uuid.uuid4().hex[:6]}")
    db_session.add(doc_type)
    await db_session.flush()

    doc = Document(
        org_id=org.id,
        doc_type_id=doc_type.id,
        public_id=f"DOC-{uuid.uuid4().hex[:8]}",
        title="Signed Document",
        submitted_by=submitter_id,
    )
    db_session.add(doc)
    await db_session.flush()

    version = DocumentVersion(
        document_id=doc.id,
        version_num=1,
        title=doc.title,
        uploaded_by=submitter_id,
        checksum=checksum,
    )
    db_session.add(version)
    await db_session.flush()

    template = WorkflowTemplate(org_id=org.id, name="T", created_by=submitter_id)
    db_session.add(template)
    await db_session.flush()

    stage_rows = []
    for i in range(1, stages + 1):
        st = WorkflowStage(template_id=template.id, sequence_order=i, name=f"Stage {i}")
        db_session.add(st)
        stage_rows.append(st)
    await db_session.flush()

    instance = WorkflowInstance(
        org_id=org.id,
        document_id=doc.id,
        template_id=template.id,
        # The frozen definition this run is pinned to (DM-02). Real runs
        # always carry it — start_workflow() writes it via
        # _freeze_template() — and since P2-2 the engine routes by it rather
        # than by re-reading the live template, so a run built here with an
        # empty snapshot has no route and is correctly refused.
        template_version_snapshot={
            "id": str(template.id),
            "stages": [
                {
                    "id": str(st.id),
                    "name": st.name,
                    "sequence_order": st.sequence_order,
                    "approver_rules": [],
                }
                for st in stage_rows
            ],
        },
        current_stage_id=stage_rows[0].id,
        status=WorkflowInstanceStatus.IN_PROGRESS,
    )
    db_session.add(instance)
    await db_session.flush()

    step = ApprovalStep(
        instance_id=instance.id,
        stage_id=stage_rows[0].id,
        document_version_id=version.id,
        approver_id=approver_id,
    )
    db_session.add(step)
    await db_session.flush()

    return doc, version, instance, stage_rows, step


# ── §6.4 Digital signatures ────────────────────────────────────────────────

async def test_approval_is_cryptographically_signed_and_verifies(db_session, org, worker, trainee):
    """Every decision gets a real RSA-PSS signature that verifies, binding
    approver + document version + decision + step."""
    worker_user, _ = worker
    submitter, _ = trainee  # someone other than the approver
    doc, version, instance, _stages, step = await _make_instance(
        db_session, org, submitter_id=submitter.id, approver_id=worker_user.id
    )

    svc = ApprovalService(db_session)
    await svc.decide(
        step_id=step.id,
        actor_id=worker_user.id,
        org_id=org.id,
        req=DecisionRequest(decision=ApprovalDecision.APPROVED),
    )

    sig = await svc.step_repo.get_esignature(step.id)
    assert sig is not None
    assert sig.algorithm == "RSA-PSS-SHA256"
    assert sig.signature_b64 and sig.key_id and sig.payload_hash
    # Bound to the right facts
    assert sig.signed_payload["approver_id"] == str(worker_user.id)
    assert sig.signed_payload["decision"] == ApprovalDecision.APPROVED
    assert sig.signed_payload["document_version_id"] == str(version.id)
    assert sig.signed_payload["document_version_checksum"] == "abc123"

    result = await svc.verify_step_signature(step.id, org.id, worker_user.id)
    assert result["signed"] is True
    assert result["valid"] is True
    assert result["payload_intact"] is True
    assert result["signature_valid"] is True
    assert result["document_intact"] is True


async def test_tampering_with_document_after_signing_is_detected(db_session, org, worker, trainee):
    """§6.4: 'Any document change after signing must be detectable.'"""
    worker_user, _ = worker
    submitter, _ = trainee
    doc, version, instance, _stages, step = await _make_instance(
        db_session, org, submitter_id=submitter.id, approver_id=worker_user.id
    )

    svc = ApprovalService(db_session)
    await svc.decide(
        step_id=step.id,
        actor_id=worker_user.id,
        org_id=org.id,
        req=DecisionRequest(decision=ApprovalDecision.APPROVED),
    )

    # Simulate the document bytes changing after it was signed.
    version.checksum = "tampered-checksum"
    await db_session.flush()

    result = await svc.verify_step_signature(step.id, org.id, worker_user.id)
    assert result["signature_valid"] is True   # signature itself is untouched
    assert result["document_intact"] is False  # but the document changed
    assert result["valid"] is False


async def test_tampering_with_the_signature_row_is_detected(db_session, org, worker, trainee):
    worker_user, _ = worker
    submitter, _ = trainee
    doc, version, instance, _stages, step = await _make_instance(
        db_session, org, submitter_id=submitter.id, approver_id=worker_user.id
    )
    svc = ApprovalService(db_session)
    await svc.decide(
        step_id=step.id,
        actor_id=worker_user.id,
        org_id=org.id,
        req=DecisionRequest(decision=ApprovalDecision.APPROVED),
    )

    sig = await svc.step_repo.get_esignature(step.id)
    # Rewrite the stored payload as if someone edited the DB row directly.
    sig.signed_payload = {**sig.signed_payload, "decision": "rejected"}
    await db_session.flush()

    result = await svc.verify_step_signature(step.id, org.id, worker_user.id)
    assert result["payload_intact"] is False
    assert result["valid"] is False


# ── §6.5 Revocation / recall ───────────────────────────────────────────────

async def test_revoke_applies_immediately_when_nothing_downstream(db_session, org, worker, trainee):
    worker_user, _ = worker
    submitter, _ = trainee
    doc, version, instance, _stages, step = await _make_instance(
        db_session, org, submitter_id=submitter.id, approver_id=worker_user.id
    )
    svc = ApprovalService(db_session)
    await svc.decide(
        step_id=step.id,
        actor_id=worker_user.id,
        org_id=org.id,
        req=DecisionRequest(decision=ApprovalDecision.APPROVED),
    )

    out = await svc.revoke_decision(
        step_id=step.id, actor_id=worker_user.id, org_id=org.id, reason="Wrong version approved"
    )
    assert out["status"] == "applied"

    # Refresh the PARENTS first and the child step LAST:
    # WorkflowInstance.approval_steps is cascade="all, delete-orphan", and
    # "all" includes refresh-expire — so refreshing the instance expires its
    # child ApprovalStep rows. Reading an expired attribute synchronously
    # under asyncio then raises MissingGreenlet.
    await db_session.refresh(doc)
    await db_session.refresh(instance)
    await db_session.refresh(step)
    # Original decision preserved, marked revoked, no longer counted.
    assert step.decision == ApprovalDecision.APPROVED
    assert step.revoked_at is not None
    assert step.revocation_reason == "Wrong version approved"
    assert step.is_counted is False
    # Workflow stays OPEN and goes back for correction — never closed.
    assert instance.status == WorkflowInstanceStatus.CHANGES_REQUESTED
    assert instance.completed_at is None
    assert doc.status == DocumentStatus.REVOKED


async def test_revoke_after_downstream_progress_becomes_a_recall_request(
    db_session, org, admin, worker, trainee
):
    """§6.5: an earlier approver must not be able to silently roll back once
    the document has moved on — it becomes a controlled recall request and
    the workflow stays open."""
    worker_user, _ = worker
    admin_user, _ = admin
    submitter, _ = trainee
    doc, version, instance, stages, step1 = await _make_instance(
        db_session, org, submitter_id=submitter.id, approver_id=worker_user.id, stages=2
    )
    svc = ApprovalService(db_session)
    await svc.decide(
        step_id=step1.id,
        actor_id=worker_user.id,
        org_id=org.id,
        req=DecisionRequest(decision=ApprovalDecision.APPROVED),
    )

    # A later-stage approver has already decided.
    step2 = ApprovalStep(
        instance_id=instance.id,
        stage_id=stages[1].id,
        document_version_id=version.id,
        approver_id=admin_user.id,
        decision=ApprovalDecision.APPROVED,
    )
    from datetime import datetime, timezone
    step2.decided_at = datetime.now(timezone.utc)
    db_session.add(step2)
    await db_session.flush()

    out = await svc.revoke_decision(
        step_id=step1.id, actor_id=worker_user.id, org_id=org.id, reason="Missed a clause"
    )
    assert out["status"] == "requested"
    assert str(step2.id) in out["affected_step_ids"]

    # Parents before children — see the cascade refresh-expire note above.
    await db_session.refresh(instance)
    await db_session.refresh(step1)
    # NOT rolled back, and the workflow is still open.
    assert step1.revoked_at is None
    assert step1.decision == ApprovalDecision.APPROVED
    assert instance.status == WorkflowInstanceStatus.RECALL_REQUESTED
    assert instance.completed_at is None


async def test_recall_can_only_be_resolved_by_an_admin(db_session, org, admin, worker, trainee):
    worker_user, _ = worker
    admin_user, _ = admin
    submitter, _ = trainee
    doc, version, instance, stages, step1 = await _make_instance(
        db_session, org, submitter_id=submitter.id, approver_id=worker_user.id, stages=2
    )
    svc = ApprovalService(db_session)
    await svc.decide(
        step_id=step1.id,
        actor_id=worker_user.id,
        org_id=org.id,
        req=DecisionRequest(decision=ApprovalDecision.APPROVED),
    )
    from datetime import datetime, timezone
    step2 = ApprovalStep(
        instance_id=instance.id,
        stage_id=stages[1].id,
        document_version_id=version.id,
        approver_id=admin_user.id,
        decision=ApprovalDecision.APPROVED,
        decided_at=datetime.now(timezone.utc),
    )
    db_session.add(step2)
    await db_session.flush()

    out = await svc.revoke_decision(
        step_id=step1.id, actor_id=worker_user.id, org_id=org.id, reason="Needs review"
    )
    rev_id = uuid.UUID(out["revocation_id"])

    # A plain worker cannot resolve it.
    with pytest.raises(Exception) as exc:
        await svc.resolve_recall(
            revocation_id=rev_id,
            actor_id=worker_user.id,
            org_id=org.id,
            approve=True,
            actor_roles=["worker"],
        )
    assert "administrator" in str(exc.value).lower()

    # An admin can — and approving invalidates the affected downstream step.
    res = await svc.resolve_recall(
        revocation_id=rev_id,
        actor_id=admin_user.id,
        org_id=org.id,
        approve=True,
        note="Agreed",
        actor_roles=["admin"],
    )
    assert res["status"] == "approved"
    await db_session.refresh(step1)
    await db_session.refresh(step2)
    assert step1.revoked_at is not None
    assert step2.superseded_at is not None      # preserved, but no longer counts
    assert step2.decision == ApprovalDecision.APPROVED  # never rewritten


async def test_revoked_approval_does_not_satisfy_the_stage_gate(db_session, org, worker, trainee):
    """A revoked approval must not keep a stage looking satisfied."""
    worker_user, _ = worker
    submitter, _ = trainee
    doc, version, instance, stages, step = await _make_instance(
        db_session, org, submitter_id=submitter.id, approver_id=worker_user.id
    )
    svc = ApprovalService(db_session)
    await svc.decide(
        step_id=step.id,
        actor_id=worker_user.id,
        org_id=org.id,
        req=DecisionRequest(decision=ApprovalDecision.APPROVED),
    )
    await svc.revoke_decision(
        step_id=step.id, actor_id=worker_user.id, org_id=org.id, reason="Mistake"
    )

    current = await svc.step_repo.get_current_round_steps(instance.id, stages[0].id)
    counted = [s for s in current if s.decision == ApprovalDecision.APPROVED and s.is_counted]
    assert counted == []


# ── §6.2/6.6 Finalization + history ────────────────────────────────────────

async def test_finalize_blocked_while_steps_pending(db_session, org, admin, worker, trainee):
    worker_user, _ = worker
    admin_user, _ = admin
    submitter, _ = trainee
    doc, version, instance, stages, step = await _make_instance(
        db_session, org, submitter_id=submitter.id, approver_id=worker_user.id
    )
    svc = ApprovalService(db_session)
    with pytest.raises(Exception) as exc:
        await svc.finalize_workflow(
            instance_id=instance.id,
            actor_id=admin_user.id,
            org_id=org.id,
            actor_roles=["admin"],
        )
    # Still IN_PROGRESS with a pending step — cannot be closed.
    assert "cannot be finalized" in str(exc.value).lower() or "pending" in str(exc.value).lower()


async def test_approval_history_shows_chain_of_custody(db_session, org, worker, trainee):
    worker_user, token = worker
    submitter, _ = trainee
    doc, version, instance, stages, step = await _make_instance(
        db_session, org, submitter_id=submitter.id, approver_id=worker_user.id
    )
    svc = ApprovalService(db_session)
    await svc.decide(
        step_id=step.id,
        actor_id=worker_user.id,
        org_id=org.id,
        req=DecisionRequest(decision=ApprovalDecision.APPROVED, note="Looks good"),
    )

    from app.domain.permissions import AuthUser

    user = AuthUser(
        id=worker_user.id,

        org_id=org.id,
        roles=["worker"],
        permissions=[],
    )
    history = await svc.get_approval_history(instance.id, org.id, user)
    assert history["document_id"] == str(doc.id)
    assert len(history["history"]) == 1
    entry = history["history"][0]
    assert entry["approver_id"] == str(worker_user.id)
    assert entry["decision"] == ApprovalDecision.APPROVED
    assert entry["decision_note"] == "Looks good"
    assert entry["document_version_id"] == str(version.id)
    assert entry["counts_toward_approval"] is True
    assert entry["signature"]["algorithm"] == "RSA-PSS-SHA256"


# ── §7 Workflow definition validation ──────────────────────────────────────

async def test_workflow_validation_rejects_stage_without_approvers(db_session, org):
    from app.schemas.workflow_instances import WorkflowStageCreate, WorkflowTemplateCreate
    from app.services.template_service import TemplateService

    svc = TemplateService(db_session)
    req = WorkflowTemplateCreate(
        name="No approvers",
        stages=[WorkflowStageCreate(name="Stage 1", sequence_order=1, approver_rules=[])],
    )
    with pytest.raises(Exception) as exc:
        await svc.create(org_id=org.id, req=req)
    assert "no approvers" in str(exc.value).lower()


async def test_workflow_validation_rejects_unsatisfiable_gate(db_session, org, worker):
    from app.schemas.workflow_instances import (
        StageApproverRuleCreate,
        WorkflowStageCreate,
        WorkflowTemplateCreate,
    )
    from app.services.template_service import TemplateService

    worker_user, _ = worker
    svc = TemplateService(db_session)
    req = WorkflowTemplateCreate(
        name="Impossible gate",
        stages=[
            WorkflowStageCreate(
                name="Stage 1",
                sequence_order=1,
                min_approvals_required=3,   # but only one rule
                approver_rules=[
                    StageApproverRuleCreate(
                        rule_type="specific_user",
                        rule_value={"user_id": str(worker_user.id)},
                    )
                ],
            )
        ],
    )
    with pytest.raises(Exception) as exc:
        await svc.create(org_id=org.id, req=req)
    assert "could never be met" in str(exc.value).lower()


async def test_workflow_validation_rejects_approver_outside_org(db_session, org):
    from app.schemas.workflow_instances import (
        StageApproverRuleCreate,
        WorkflowStageCreate,
        WorkflowTemplateCreate,
    )
    from app.services.template_service import TemplateService

    svc = TemplateService(db_session)
    req = WorkflowTemplateCreate(
        name="Outsider",
        stages=[
            WorkflowStageCreate(
                name="Stage 1",
                sequence_order=1,
                approver_rules=[
                    StageApproverRuleCreate(
                        rule_type="specific_user",
                        rule_value={"user_id": str(uuid.uuid4())},
                    )
                ],
            )
        ],
    )
    with pytest.raises(Exception) as exc:
        await svc.create(org_id=org.id, req=req)
    assert "not active members" in str(exc.value).lower()
