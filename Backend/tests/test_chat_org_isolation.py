"""
Covers §10/§15 organization isolation for Messages, and the
document/workflow-linked conversation flow from Approvals.
"""
from __future__ import annotations

import uuid

import pytest

from app.domain.enums import ConversationKind
from app.schemas.chat import StartConversationRequest
from app.services.chat_service import ChatService


async def _other_org_with_member(db_session):
    """A fully separate organization with one active member."""
    from conftest import _make_member
    from app.repositories.org_repo import OrganizationRepository

    repo = OrganizationRepository(db_session)
    other_org = await repo.create(name=f"Other {uuid.uuid4().hex[:6]}")
    roles = await repo.create_default_roles(other_org.id)
    await db_session.flush()
    user, token = await _make_member(db_session, other_org, roles["worker"])
    await db_session.commit()
    return other_org, user, token


async def test_direct_conversation_within_org_succeeds(db_session, org, admin, worker):
    admin_user, _ = admin
    worker_user, _ = worker
    svc = ChatService(db_session)

    conv = await svc.start_conversation(
        creator_id=admin_user.id,
        org_id=org.id,
        req=StartConversationRequest(
            kind=ConversationKind.DIRECT,
            participant_user_id=worker_user.id,
            initial_message="Hello",
        ),
    )
    assert conv.id is not None

    from sqlalchemy import select
    from app.models.chat import Conversation

    row = (
        await db_session.execute(select(Conversation).where(Conversation.id == conv.id))
    ).scalar_one()
    # The tenant boundary is now recorded on the row itself, not implied.
    assert row.org_id == org.id


async def test_cannot_start_a_dm_with_a_member_of_another_org(db_session, org, admin):
    """§10: "Users must not be able to message or discover members of
    another organization." """
    admin_user, _ = admin
    _other_org, outsider, _ = await _other_org_with_member(db_session)

    svc = ChatService(db_session)
    with pytest.raises(Exception) as exc:
        await svc.start_conversation(
            creator_id=admin_user.id,
            org_id=org.id,
            req=StartConversationRequest(
                kind=ConversationKind.DIRECT,
                participant_user_id=outsider.id,
            ),
        )
    assert "not a member of your organization" in str(exc.value).lower()


async def test_cannot_dm_a_nonexistent_user(db_session, org, admin):
    admin_user, _ = admin
    svc = ChatService(db_session)
    with pytest.raises(Exception) as exc:
        await svc.start_conversation(
            creator_id=admin_user.id,
            org_id=org.id,
            req=StartConversationRequest(
                kind=ConversationKind.DIRECT,
                participant_user_id=uuid.uuid4(),
            ),
        )
    assert "not a member of your organization" in str(exc.value).lower()


async def test_conversation_list_is_org_scoped(db_session, org, admin, worker):
    admin_user, _ = admin
    worker_user, _ = worker
    svc = ChatService(db_session)

    await svc.start_conversation(
        creator_id=admin_user.id,
        org_id=org.id,
        req=StartConversationRequest(
            kind=ConversationKind.DIRECT, participant_user_id=worker_user.id
        ),
    )

    mine, total = await svc.list_conversations(user_id=admin_user.id, org_id=org.id)
    assert total == 1

    # Same user id, but asking in the context of a different org must not
    # surface the conversation.
    other_org, _outsider, _ = await _other_org_with_member(db_session)
    none_here, zero = await svc.list_conversations(
        user_id=admin_user.id, org_id=other_org.id
    )
    assert zero == 0
    assert none_here == []


async def test_cannot_open_a_conversation_from_another_org_context(
    db_session, org, admin, worker
):
    admin_user, _ = admin
    worker_user, _ = worker
    svc = ChatService(db_session)

    conv = await svc.start_conversation(
        creator_id=admin_user.id,
        org_id=org.id,
        req=StartConversationRequest(
            kind=ConversationKind.DIRECT, participant_user_id=worker_user.id
        ),
    )

    other_org, _outsider, _ = await _other_org_with_member(db_session)
    with pytest.raises(Exception) as exc:
        await svc.get_conversation(conv.id, admin_user.id, org_id=other_org.id)
    assert "not found" in str(exc.value).lower()


async def test_workflow_linked_conversation_from_an_approval_step(
    db_session, org, admin, worker, trainee
):
    """
    §10/§6.3: an approver can open a conversation tied to a specific
    approval step, and it is idempotent (one conversation per step).
    """
    from tests.test_signatures_and_revocation import _make_instance

    worker_user, _ = worker
    submitter, _ = trainee
    doc, _version, instance, _stages, step = await _make_instance(
        db_session, org, submitter_id=submitter.id, approver_id=worker_user.id
    )

    svc = ChatService(db_session)
    conv = await svc.start_conversation(
        creator_id=worker_user.id,
        org_id=org.id,
        req=StartConversationRequest(
            kind=ConversationKind.WORKFLOW_CONTEXT,
            approval_step_id=step.id,
            initial_message="Please clarify section 2.",
        ),
    )
    assert conv.id is not None

    from sqlalchemy import select
    from app.models.chat import Conversation

    row = (
        await db_session.execute(select(Conversation).where(Conversation.id == conv.id))
    ).scalar_one()
    assert row.org_id == org.id
    assert row.approval_step_id == step.id
    assert row.workflow_instance_id == instance.id

    # Idempotent: asking again returns the same thread, not a duplicate.
    again = await svc.start_conversation(
        creator_id=worker_user.id,
        org_id=org.id,
        req=StartConversationRequest(
            kind=ConversationKind.WORKFLOW_CONTEXT, approval_step_id=step.id
        ),
    )
    assert again.id == conv.id
