"""
Workflow module DM-01..04 / BR-02 / E6 / T22 — a run is pinned to the
definition it was submitted against.

These are the tests for the plan's single highest-blast-radius change
(task P2-2). Before it, `WorkflowService.advance_stage()` asked the TEMPLATE
for its current stages, so editing a workflow changed the route of every run
already in flight. Two consequences, both covered below:

  * a run advanced into whatever now occupied the next position, and
  * an edit that left FEWER stages than the run had already passed made
    `next_stage` None, which is the branch that marks the run approved and
    the document approved — so editing a workflow could approve someone
    else's in-flight document with the remaining approvals never collected.

The run is driven through `WorkflowService` directly rather than over HTTP:
the submit endpoint has preconditions (doc-type form schemas, file uploads)
that are not what is under test, and the same pattern is already used by
test_approval_authorization.py. Template creation and editing DO go through
the API, because the edit path is exactly what used to corrupt the run.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from app.domain.enums import DocumentStatus, WorkflowInstanceStatus
from app.models.document import Document, DocumentType, DocumentVersion
from app.models.workflow import WorkflowInstance, WorkflowStage
from app.services.workflow_service import WorkflowService
from conftest import auth_headers


def _stage(user_id, name, order):
    return {
        "name": name,
        "sequence_order": order,
        "min_approvals_required": 1,
        "approver_rules": [
            {"rule_type": "specific_user", "rule_value": {"user_id": str(user_id)}}
        ],
    }


async def _create_template(client, token, approver_id, names):
    resp = await client.post(
        "/api/v1/workflow-templates",
        headers=auth_headers(token),
        params={"visibility": "private"},
        json={
            "name": f"WF-{uuid.uuid4().hex[:6]}",
            "stages": [
                _stage(approver_id, n, i) for i, n in enumerate(names, start=1)
            ],
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _document(db_session, org, submitter_id):
    doc_type = DocumentType(
        org_id=org.id, name="General", code=f"general-{uuid.uuid4().hex[:6]}"
    )
    db_session.add(doc_type)
    await db_session.flush()

    doc = Document(
        org_id=org.id,
        doc_type_id=doc_type.id,
        public_id=f"DOC-{uuid.uuid4().hex[:8]}",
        title="Pinned Run Doc",
        submitted_by=submitter_id,
    )
    db_session.add(doc)
    await db_session.flush()

    version = DocumentVersion(
        document_id=doc.id, version_num=1, title=doc.title, uploaded_by=submitter_id
    )
    db_session.add(version)
    await db_session.flush()
    return doc, version


async def _start_run(db_session, org, template_id, submitter_id, doc, version):
    svc = WorkflowService(db_session)
    await svc.start_workflow(
        org_id=org.id,
        document_id=doc.id,
        template_id=template_id,
        requester_id=submitter_id,
        current_version_id=version.id,
        doc_title=doc.title,
    )
    await db_session.commit()
    result = await db_session.execute(
        select(WorkflowInstance).where(WorkflowInstance.document_id == doc.id)
    )
    return result.scalar_one()


async def _stage_ids_in_order(db_session, template_id):
    rows = await db_session.execute(
        select(WorkflowStage.id, WorkflowStage.name, WorkflowStage.sequence_order)
        .where(
            WorkflowStage.template_id == template_id,
            WorkflowStage.deleted_at.is_(None),
        )
        .order_by(WorkflowStage.sequence_order)
    )
    return rows.all()


# ── T22: the in-flight run is untouched by an edit ──────────────────────────

async def test_inflight_run_follows_its_pinned_definition_after_an_edit(
    client, db_session, org, admin, worker
):
    """T22 / DM-02 / E6.

    A run started on a 3-stage workflow keeps routing through those three
    stages after the owner replaces the definition with a different one.
    """
    approver, _ = admin
    submitter, worker_token = worker

    tmpl = await _create_template(
        client, worker_token, approver.id, ["First", "Second", "Third"]
    )
    original = await _stage_ids_in_order(db_session, uuid.UUID(tmpl["id"]))
    assert [r.name for r in original] == ["First", "Second", "Third"]
    original_ids = [r.id for r in original]

    doc, version = await _document(db_session, org, submitter.id)
    instance = await _start_run(
        db_session, org, uuid.UUID(tmpl["id"]), submitter.id, doc, version
    )
    assert instance.current_stage_id == original_ids[0]

    # The owner now REPLACES the definition with a single, differently-named
    # stage. This is the edit that used to reroute the run.
    resp = await client.patch(
        f"/api/v1/workflow-templates/{tmpl['id']}",
        headers=auth_headers(worker_token),
        json={"stages": [_stage(approver.id, "Totally Different", 1)]},
    )
    assert resp.status_code == 200, resp.text

    live = await _stage_ids_in_order(db_session, uuid.UUID(tmpl["id"]))
    assert [r.name for r in live] == ["Totally Different"], (
        "the live definition should be exactly what was just saved"
    )

    # Advance the run. It must move to the SECOND stage of its own pinned
    # definition, which no longer exists in the live template.
    svc = WorkflowService(db_session)
    await svc.advance_stage(
        instance=instance,
        org_id=org.id,
        requester_id=submitter.id,
        current_version_id=version.id,
    )
    await db_session.commit()
    await db_session.refresh(instance)

    assert instance.current_stage_id == original_ids[1], (
        "the run must follow the definition it was submitted against, not the "
        "edited template"
    )
    assert instance.status == WorkflowInstanceStatus.IN_PROGRESS


async def test_shortening_a_workflow_cannot_approve_an_inflight_document(
    client, db_session, org, admin, worker
):
    """The dangerous case: the edit must not complete someone else's run.

    With the old live-template read, a run sitting at stage 3 of 3 whose
    template was edited down to one stage found no "next" stage and took the
    completion branch — marking the run approved and the DOCUMENT approved.
    """
    approver, _ = admin
    submitter, worker_token = worker

    tmpl = await _create_template(
        client, worker_token, approver.id, ["One Stage", "Two Stage", "Three Stage"]
    )
    original_ids = [r.id for r in await _stage_ids_in_order(
        db_session, uuid.UUID(tmpl["id"])
    )]

    doc, version = await _document(db_session, org, submitter.id)
    instance = await _start_run(
        db_session, org, uuid.UUID(tmpl["id"]), submitter.id, doc, version
    )

    # Walk the run to its SECOND stage legitimately.
    svc = WorkflowService(db_session)
    await svc.advance_stage(
        instance=instance, org_id=org.id,
        requester_id=submitter.id, current_version_id=version.id,
    )
    await db_session.commit()
    await db_session.refresh(instance)
    assert instance.current_stage_id == original_ids[1]

    # Shrink the definition to a single stage.
    resp = await client.patch(
        f"/api/v1/workflow-templates/{tmpl['id']}",
        headers=auth_headers(worker_token),
        json={"stages": [_stage(approver.id, "Only Stage", 1)]},
    )
    assert resp.status_code == 200, resp.text

    # Advancing must reach the pinned third stage — NOT completion.
    await svc.advance_stage(
        instance=instance, org_id=org.id,
        requester_id=submitter.id, current_version_id=version.id,
    )
    await db_session.commit()
    await db_session.refresh(instance)
    await db_session.refresh(doc)

    assert instance.current_stage_id == original_ids[2]
    assert instance.status != WorkflowInstanceStatus.APPROVED, (
        "shortening the template must never approve a run that still has "
        "pinned stages left"
    )
    assert doc.status != DocumentStatus.APPROVED, (
        "shortening the template must never approve the document"
    )


async def test_run_completes_only_when_its_pinned_definition_is_exhausted(
    client, db_session, org, admin, worker
):
    """The completion branch still works — it is now driven by the pinned
    definition rather than by whatever the template happens to say."""
    approver, _ = admin
    submitter, worker_token = worker

    tmpl = await _create_template(client, worker_token, approver.id, ["Solo"])
    doc, version = await _document(db_session, org, submitter.id)
    instance = await _start_run(
        db_session, org, uuid.UUID(tmpl["id"]), submitter.id, doc, version
    )

    svc = WorkflowService(db_session)
    await svc.advance_stage(
        instance=instance, org_id=org.id,
        requester_id=submitter.id, current_version_id=version.id,
    )
    await db_session.commit()
    await db_session.refresh(instance)
    await db_session.refresh(doc)

    assert instance.status == WorkflowInstanceStatus.APPROVED
    assert doc.status == DocumentStatus.APPROVED
    assert instance.completed_at is not None


async def test_a_run_with_no_pinned_definition_is_refused_not_guessed(
    db_session, org, admin, worker
):
    """A run with neither a pinned version nor a usable snapshot must not be
    routed by guesswork. Refusing is the safe outcome: the alternative is
    picking a stage, which is how the original defect approved documents."""
    from app.core.exceptions import ConflictException

    approver, _ = admin
    submitter, _ = worker
    doc, version = await _document(db_session, org, submitter.id)

    # A hand-made run with an empty snapshot and no version — the shape the
    # P2-1 migration deliberately refuses to backfill.
    instance = WorkflowInstance(
        org_id=org.id,
        document_id=doc.id,
        template_id=None,
        template_version_snapshot={},
        status=WorkflowInstanceStatus.IN_PROGRESS,
    )
    db_session.add(instance)
    await db_session.flush()

    svc = WorkflowService(db_session)
    with pytest.raises(ConflictException):
        await svc.advance_stage(
            instance=instance, org_id=org.id,
            requester_id=submitter.id, current_version_id=version.id,
        )


# ── The soft-delete leak found while re-reading the Phase 1 code ────────────

async def test_editing_a_workflow_with_an_inflight_run_does_not_duplicate_stages(
    client, db_session, org, admin, worker
):
    """There is no global soft-delete filter in this codebase.

    `_replace_legacy_stages()` soft-deletes a stage row an in-flight run
    still references, because it cannot be deleted (`approval_steps.stage_id`
    and `workflow_instances.current_stage_id` reference it with no
    ON DELETE). Neither `list_for_template()` nor the `WorkflowTemplate.stages`
    eager load filtered `deleted_at`, so the retired rows came back ALONGSIDE
    their replacements and the owner saw a definition with duplicated stages.
    """
    approver, _ = admin
    submitter, worker_token = worker

    tmpl = await _create_template(client, worker_token, approver.id, ["Alpha", "Beta"])

    # An in-flight run forces the retire-instead-of-delete path.
    doc, version = await _document(db_session, org, submitter.id)
    await _start_run(
        db_session, org, uuid.UUID(tmpl["id"]), submitter.id, doc, version
    )

    resp = await client.patch(
        f"/api/v1/workflow-templates/{tmpl['id']}",
        headers=auth_headers(worker_token),
        json={
            "stages": [
                _stage(approver.id, "Alpha2", 1),
                _stage(approver.id, "Beta2", 2),
            ]
        },
    )
    assert resp.status_code == 200, resp.text

    detail = await client.get(
        f"/api/v1/workflow-templates/{tmpl['id']}",
        headers=auth_headers(worker_token),
    )
    assert detail.status_code == 200, detail.text
    names = [s["name"] for s in detail.json()["stages"]]
    assert names == ["Alpha2", "Beta2"], (
        f"the saved definition should have exactly two stages, got {names}"
    )
