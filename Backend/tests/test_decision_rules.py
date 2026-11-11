"""
Workflow module §6.9 (AP-REJ-02, E23, T15) and §6.3 / §6.8 (WF-STG-21,
AP-APR-05, E25, T21, T30). Tasks P2-9 and P2-11.

Two rules that the code did not enforce before:

  * A rejection had no reason requirement at all. `DecisionRequest.note` is
    optional and nothing validated it, so a document could be rejected
    terminally with no explanation (defect 5) — leaving the owner, who cannot
    resubmit into the same run (BR-07), nothing to act on.

  * Signature enforcement read only the stage DEFINITION. WF-STG-21 also
    requires a signature when the RESOLVED approver's department requires
    one, which is decided at activation and recorded on the stage instance.
    That is the case a "submitter's manager" rule resolving into Finance
    creates, and it was being approved unsigned.
"""
from __future__ import annotations

import uuid

import pytest

from app.core.exceptions import UnprocessableEntityException
from app.domain.decision_rules import (
    RejectionReasonError,
    validate_rejection_reason,
)
from app.domain.enums import ApprovalDecision
from app.models.organization import Department
from app.models.workflow import StageInstance
from app.schemas.workflow_instances import DecisionRequest
from app.services.approval_service import ApprovalService
from test_signatures_and_revocation import _make_instance


# ── AP-REJ-02 as a unit: the rule itself ───────────────────────────────────

@pytest.mark.parametrize(
    "bad",
    [
        None,              # no reason supplied at all
        "",                # empty
        "   ",             # whitespace only (E23)
        "\t\n  \n",        # other whitespace
        "too short",       # under 10 meaningful characters
        "aaaaaaaaaa",      # a single character repeated (E23)
        "----------",      # punctuation only, no meaningful characters
        "a. a. a. a. a.",  # padded to length but still one letter
    ],
)
def test_rejection_reason_is_refused(bad):
    with pytest.raises(RejectionReasonError):
        validate_rejection_reason(bad)


@pytest.mark.parametrize(
    "good",
    [
        "Wrong total on page 2",
        "The signature block is missing entirely.",
        "  Budget figures do not match the attached invoice.  ",
    ],
)
def test_rejection_reason_is_accepted_and_trimmed(good):
    assert validate_rejection_reason(good) == good.strip()


def test_rejection_reason_length_cap():
    with pytest.raises(RejectionReasonError):
        validate_rejection_reason("Valid reason text. " * 200)


# ── AP-REJ-02 through the service, independent of the client ───────────────

async def test_reject_without_a_reason_is_refused_by_the_service(
    db_session, org, worker, trainee
):
    """The check is server-side: a client that skips its own validation still
    cannot reject without an explanation (§9.4)."""
    approver, _ = worker
    submitter, _ = trainee
    _doc, _version, _instance, _stages, step = await _make_instance(
        db_session, org, submitter_id=submitter.id, approver_id=approver.id
    )

    svc = ApprovalService(db_session)
    with pytest.raises(UnprocessableEntityException):
        await svc.decide(
            step_id=step.id,
            actor_id=approver.id,
            org_id=org.id,
            req=DecisionRequest(decision=ApprovalDecision.REJECTED),
        )


async def test_reject_with_a_real_reason_succeeds(db_session, org, worker, trainee):
    approver, _ = worker
    submitter, _ = trainee
    _doc, _version, _instance, _stages, step = await _make_instance(
        db_session, org, submitter_id=submitter.id, approver_id=approver.id
    )

    svc = ApprovalService(db_session)
    await svc.decide(
        step_id=step.id,
        actor_id=approver.id,
        org_id=org.id,
        req=DecisionRequest(
            decision=ApprovalDecision.REJECTED,
            note="The budget figures do not match the attached invoice.",
        ),
    )
    await db_session.refresh(step)
    assert step.decision == ApprovalDecision.REJECTED
    assert step.decision_note.startswith("The budget figures")


# ── WF-STG-21: signing forced by the RESOLVED approver's department ────────

async def test_stage_instance_signing_requirement_blocks_an_unsigned_approval(
    db_session, org, worker, trainee
):
    """T21 / T30 / E25.

    The stage DEFINITION does not require a signature here — the stage
    instance does, because that is what activation decided. Approving without
    one must still be refused, whatever the client sends.
    """
    approver, _ = worker
    submitter, _ = trainee
    _doc, _version, instance, stages, step = await _make_instance(
        db_session, org, submitter_id=submitter.id, approver_id=approver.id
    )
    assert not stages[0].requires_signature, (
        "the definition must NOT require signing, or this proves nothing"
    )

    dept = Department(
        org_id=org.id,
        name=f"Finance-{uuid.uuid4().hex[:6]}",
        code=f"fin-{uuid.uuid4().hex[:6]}",
        requires_signature=True,
    )
    db_session.add(dept)
    await db_session.flush()

    db_session.add(
        StageInstance(
            org_id=org.id,
            instance_id=instance.id,
            legacy_stage_id=stages[0].id,
            cycle=instance.current_cycle,
            position=1,
            stage_name=stages[0].name,
            approver_type="submitter_manager",
            resolved_approver_id=approver.id,
            department_id=dept.id,
            signing_required=True,
            signing_reason="The approver's department requires a signature",
            status="active",
        )
    )
    await db_session.flush()

    svc = ApprovalService(db_session)
    with pytest.raises(UnprocessableEntityException) as exc:
        await svc.decide(
            step_id=step.id,
            actor_id=approver.id,
            org_id=org.id,
            req=DecisionRequest(decision=ApprovalDecision.APPROVED),
        )
    assert "signature" in str(exc.value).lower()
