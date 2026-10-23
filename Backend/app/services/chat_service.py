"""
DocFlow Backend — Service: Chat & Messaging

Step 0 hardening applied:
  0.1: workflow_context conversation creation gated by can_user_access_document()
  0.3: per-message re-authorization in the WS handler delegates to is_participant()
       (enforced here in send(), not just at WS connect time)
  0.9: workflow_context creation is idempotent — get_by_approval_step() called
       first; returns existing conversation rather than creating a duplicate

Architecture (§5):
  PostgreSQL is the authoritative store. Messages are written to DB first.
  Redis is used ONLY for Pub/Sub fan-out and short-TTL presence/typing keys.
  If Redis is down, messages are still saved; offline participants see them on next load.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from sqlalchemy import select
from sqlalchemy.orm import joinedload

from app.core.exceptions import ForbiddenException, NotFoundException, UnprocessableEntityException
from app.domain.enums import ConversationKind, NotificationType
from app.models.chat import ChatMessage, Conversation, ConversationParticipant
from app.repositories.chat_repo import ChatMessageRepository, ConversationRepository
from app.schemas.chat import (
    ChatMessageResponse,
    ConversationParticipantResponse,
    ConversationResponse,
    SendMessageRequest,
    StartConversationRequest,
)
from app.services.notification_service import NotificationService

logger = structlog.get_logger(__name__)


class ChatService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.conv_repo = ConversationRepository(db)
        self.msg_repo = ChatMessageRepository(db)
        self.notif_svc = NotificationService(db)

    # ── Unified Start Conversation ─────────────────────────────────────────────

    async def start_conversation(
        self,
        creator_id: uuid.UUID,
        org_id: uuid.UUID,
        req: StartConversationRequest,
    ) -> ConversationResponse:
        """
        Start a direct or workflow_context conversation.

        Direct (kind='direct'):
          - participant_user_id is required
          - Creates a new DM thread

        Workflow context (kind='workflow_context'):
          - approval_step_id is required
          - IDEMPOTENT: if a conversation already exists for this step, it is
            returned rather than creating a duplicate (fixes Step 0.9)
          - The creator must have access to the underlying document
            (can_user_access_document() check — fixes Step 0.1)
        """
        if req.kind == ConversationKind.WORKFLOW_CONTEXT:
            if not req.approval_step_id:
                raise UnprocessableEntityException(
                    "approval_step_id is required for kind='workflow_context'"
                )

            # Fetch the underlying document once to avoid N+1 DB queries
            step, doc = await self._get_step_and_document(req.approval_step_id)

            # 0.1 — Gate: caller must have document access
            await self._assert_document_access(creator_id, doc)

            # Check additional requested participants (silently drop those without access)
            valid_pids = []
            if req.participant_ids:
                for pid in set(req.participant_ids):
                    if pid == creator_id:
                        continue
                    try:
                        await self._assert_document_access(pid, doc)
                        valid_pids.append(pid)
                    except ForbiddenException:
                        logger.warning("chat_participant_access_denied", user_id=str(pid), step_id=str(req.approval_step_id))
                        pass

            # 0.9 — Idempotency: return existing conversation if it already exists
            existing = await self.conv_repo.get_by_approval_step(
                req.approval_step_id, org_id=org_id
            )
            if existing:
                # Ensure creator and valid participants are added
                await self.conv_repo.add_participant(existing.id, creator_id)
                for pid in valid_pids:
                    await self.conv_repo.add_participant(existing.id, pid)
                await self.db.commit()
                conv = await self.conv_repo.get_by_id(existing.id, org_id=org_id)
                return await self._enrich_conversation(conv, creator_id)

            # Create new workflow_context conversation
            conv = await self.conv_repo.create(
                kind=ConversationKind.WORKFLOW_CONTEXT,
                created_by=creator_id,
                workflow_instance_id=step.instance_id,
                approval_step_id=req.approval_step_id,
                title=req.title,
                org_id=org_id,
            )
            await self.conv_repo.add_participant(conv.id, creator_id)
            for pid in valid_pids:
                await self.conv_repo.add_participant(conv.id, pid)

            if req.initial_message:
                await self.send(
                    conversation_id=conv.id,
                    sender_id=creator_id,
                    org_id=org_id,
                    req=SendMessageRequest(body=req.initial_message),
                )

            await self.db.commit()
            conv = await self.conv_repo.get_by_id(conv.id, org_id=org_id)
            return await self._enrich_conversation(conv, creator_id)

        else:
            # kind='direct'
            if not req.participant_user_id:
                raise UnprocessableEntityException(
                    "participant_user_id is required for kind='direct'"
                )
            return await self.start_direct(creator_id=creator_id, org_id=org_id, req=req)

    async def start_direct(
        self,
        creator_id: uuid.UUID,
        org_id: uuid.UUID,
        req: StartConversationRequest,
    ) -> ConversationResponse:
        """Start a direct (DM) conversation with another user."""
        # §10: "Respect organization membership, user status, and
        # permissions. Users must not be able to message or discover members
        # of another organization." Previously any user UUID was accepted,
        # so a crafted request could open a DM with a member of a different
        # organization.
        await self._assert_same_org_member(req.participant_user_id, org_id)

        conv = await self.conv_repo.create(
            kind=ConversationKind.DIRECT,
            created_by=creator_id,
            title=req.title,
            org_id=org_id,
        )
        await self.conv_repo.add_participant(conv.id, creator_id)
        await self.conv_repo.add_participant(conv.id, req.participant_user_id)

        if req.initial_message:
            await self.send(
                conversation_id=conv.id,
                sender_id=creator_id,
                org_id=org_id,
                req=SendMessageRequest(body=req.initial_message),
            )

        await self.db.commit()
        conv = await self.conv_repo.get_by_id(conv.id, org_id=org_id)
        return await self._enrich_conversation(conv, creator_id)

    async def _assert_same_org_member(
        self, user_id: uuid.UUID, org_id: uuid.UUID
    ) -> None:
        """
        Confirm `user_id` is an ACTIVE member of `org_id`.

        Returns a 404-style "not found" rather than a 403 so the caller
        cannot use this endpoint to probe whether a given user id exists in
        some other organization (§8's "must not reveal the existence … of
        inaccessible records", applied to the member directory).
        """
        from sqlalchemy import select

        from app.models.organization import OrganizationMember

        member = (
            await self.db.execute(
                select(OrganizationMember.id).where(
                    OrganizationMember.user_id == user_id,
                    OrganizationMember.org_id == org_id,
                    OrganizationMember.status == "active",
                    OrganizationMember.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if not member:
            raise NotFoundException("That person is not a member of your organization")

    # ── Get Conversation ───────────────────────────────────────────────────────

    async def get_conversation(
        self,
        conversation_id: uuid.UUID,
        user_id: uuid.UUID,
        org_id: uuid.UUID | None = None,
    ) -> ConversationResponse:
        """Get a single conversation. User must be a participant, and the
        conversation must belong to their organization."""
        if not await self.conv_repo.is_participant(conversation_id, user_id):
            raise ForbiddenException("You are not a participant in this conversation")
        conv = await self.conv_repo.get_by_id(conversation_id, org_id=org_id)
        if conv is None:
            raise NotFoundException("Conversation not found")
        return await self._enrich_conversation(conv, user_id)

    # ── Send Message ───────────────────────────────────────────────────────────

    async def send(
        self,
        conversation_id: uuid.UUID,
        sender_id: uuid.UUID,
        org_id: uuid.UUID,
        req: SendMessageRequest,
    ) -> ChatMessageResponse:
        """
        Send a chat message.
        Step 0.3: Participant check runs here on EVERY message, not just at WS
        connect time. This means the WS handler's per-message dispatch goes
        through this method and gets re-authorized automatically.

        1. Verify sender is a participant (re-authorization)
        2. Save ChatMessage to PostgreSQL (authoritative store)
        3. Publish to Redis Pub/Sub for WebSocket fan-out
        4. Send offline notifications to participants not currently online
        """
        is_part = await self.conv_repo.is_participant(conversation_id, sender_id)
        if not is_part:
            raise ForbiddenException("You are not a participant in this conversation")

        # Sanitize: strip any HTML — store plain text only (Step 0.7)
        import html
        clean_body = html.escape(req.body.strip(), quote=False)
        if not clean_body:
            raise UnprocessableEntityException("Message body cannot be empty")

        msg = await self.msg_repo.create(
            conversation_id=conversation_id,
            sender_id=sender_id,
            body=clean_body,
            attachment_ids=[str(a) for a in req.attachment_ids],
        )
        await self.db.commit()

        # Reload message with sender details
        msg = await self.msg_repo.get_by_id(msg.id)
        resp = ChatMessageResponse.model_validate(msg)

        # Real-time fan-out via Redis (per-conversation channel scope — Step 0.2)
        await self._publish_to_redis(conversation_id, resp)

        # Notify offline participants via EventBus (subscribers.py handles the actual notify)
        conv = await self.conv_repo.get_by_id(conversation_id)
        if conv:
            participant_ids = await self.conv_repo.get_participant_ids(conversation_id)
            other_ids = [uid for uid in participant_ids if uid != sender_id]
            if other_ids:
                # Step 0.5: Publish event for cross-module hooks
                # subscribers.py:_on_chat_message_sent() handles NotificationService.notify_many()
                # DO NOT also call notify_many() here — that would double-fire the notification.
                from app.core.events import EventBus
                EventBus.publish("chat.message_sent", {
                    "conversation_id": str(conversation_id),
                    "message_id": str(msg.id),
                    "sender_id": str(sender_id),
                    "org_id": str(org_id),
                    "offline_user_ids": [str(uid) for uid in other_ids],
                    "body_preview": f"{clean_body[:100]}{'...' if len(clean_body) > 100 else ''}",
                })

        logger.info("chat_message_sent", message_id=str(msg.id), conv_id=str(conversation_id))
        return resp

    # ── List Conversations ─────────────────────────────────────────────────────

    async def list_conversations(
        self,
        user_id: uuid.UUID,
        kind: str | None = None,
        page: int = 1,
        limit: int = 20,
        org_id: uuid.UUID | None = None,
    ) -> tuple[list[ConversationResponse], int]:
        items, total = await self.conv_repo.list_for_user(
            user_id, kind, page, limit, org_id=org_id
        )
        enriched = [await self._enrich_conversation(c, user_id) for c in items]
        return enriched, total

    # ── List Messages ──────────────────────────────────────────────────────────

    async def list_messages(
        self,
        conversation_id: uuid.UUID,
        user_id: uuid.UUID,
        before_id: uuid.UUID | None = None,
        limit: int = 50,
    ) -> list[ChatMessageResponse]:
        """Paginate messages in a conversation. User must be a participant."""
        if not await self.conv_repo.is_participant(conversation_id, user_id):
            raise ForbiddenException("You are not a participant in this conversation")

        messages = await self.msg_repo.list_for_conversation(conversation_id, before_id, limit)
        return [ChatMessageResponse.model_validate(m) for m in messages]

    # ── Mark Read ──────────────────────────────────────────────────────────────

    async def mark_read(
        self,
        conversation_id: uuid.UUID,
        user_id: uuid.UUID,
    ) -> None:
        if not await self.conv_repo.is_participant(conversation_id, user_id):
            raise ForbiddenException("You are not a participant in this conversation")
        await self.conv_repo.update_last_read(conversation_id, user_id)
        await self.db.commit()

    # ── Private Helpers ────────────────────────────────────────────────────────

    async def _get_step_and_document(
        self,
        approval_step_id: uuid.UUID,
    ):
        from app.models.workflow import ApprovalStep, WorkflowInstance
        from app.models.document import Document

        step = await self.db.get(ApprovalStep, approval_step_id)
        if not step:
            raise NotFoundException("ApprovalStep not found")

        instance = await self.db.get(WorkflowInstance, step.instance_id)
        if not instance:
            raise NotFoundException("WorkflowInstance not found")

        doc = await self.db.get(Document, instance.document_id)
        if not doc:
            raise NotFoundException("Document not found")
            
        return step, doc

    async def _assert_document_access(
        self,
        user_id: uuid.UUID,
        doc,
    ) -> None:
        """
        Gate workflow_context conversations behind document access.
        Raises ForbiddenException if the user cannot access the underlying document.

        BUG FIX: this used to pass the `User` ORM row straight into
        can_user_access_document(), which expects an AuthUser and reads
        `.roles` (a list of org role names). `User` has `.role` — a single
        coarse string — so the call raised
        `AttributeError: 'User' object has no attribute 'roles'` for every
        caller who wasn't the document's own submitter (the submitter short-
        circuits earlier in that function, which is why it went unnoticed).
        Opening the conversation for a change request therefore 500'd for
        exactly the people meant to use it.

        The roles are now resolved from the caller's live organization
        membership, which is also the correct source — the role may have
        changed since their JWT was issued.
        """
        from app.domain.permissions import AuthUser
        from app.services.document_service import can_user_access_document

        from sqlalchemy import select

        from app.models.organization import OrganizationMember, Role
        from app.models.user import User

        user = await self.db.get(User, user_id)
        if not user:
            raise ForbiddenException("User not found")

        role_rows = (
            await self.db.execute(
                select(Role.name)
                .join(OrganizationMember, OrganizationMember.role_id == Role.id)
                .where(
                    OrganizationMember.user_id == user_id,
                    OrganizationMember.org_id == doc.org_id,
                    OrganizationMember.deleted_at.is_(None),
                )
            )
        ).scalars().all()

        actor = AuthUser(
            id=user.id,
            email=user.email,
            org_id=doc.org_id,
            roles=list(role_rows),
            permissions=[],
            is_superadmin=bool(user.is_superadmin),
        )

        if not await can_user_access_document(self.db, actor, doc):
            raise ForbiddenException(
                "You do not have access to the document associated with this approval step."
            )

    async def _enrich_conversation(
        self, conv: Conversation | None, user_id: uuid.UUID
    ) -> ConversationResponse:
        """
        NOTE: Conversation.participants and .messages are both lazy="noload"
        (see models/chat.py) and the queries that fetch `conv` never eager-load
        either, so `conv.participants`/`conv.messages` are always empty here —
        this previously meant every conversation response showed zero
        participants and no last-message preview, and participant user_name/
        user_email (meant to be "populated from user join" per the schema's own
        comment) were never actually set anywhere. Fetching both explicitly here.
        """
        if not conv:
            raise NotFoundException("Conversation not found")

        unread_count = await self.msg_repo.unread_count(conv.id, user_id)

        participants_result = await self.db.execute(
            select(ConversationParticipant)
            .options(joinedload(ConversationParticipant.user))
            .where(ConversationParticipant.conversation_id == conv.id)
        )
        participant_responses = [
            ConversationParticipantResponse(
                user_id=p.user_id,
                joined_at=p.joined_at,
                last_read_at=p.last_read_at,
                user_name=p.user.name if p.user else None,
                user_email=p.user.email if p.user else None,
                user_avatar_url=p.user.avatar_url if p.user else None,
            )
            for p in participants_result.scalars().all()
        ]

        last_msg_result = await self.db.execute(
            select(ChatMessage)
            .where(ChatMessage.conversation_id == conv.id)
            .order_by(ChatMessage.created_at.desc())
            .limit(1)
        )
        last_msg = last_msg_result.scalar_one_or_none()

        resp = ConversationResponse.model_validate(conv)
        resp.participants = participant_responses
        resp.unread_count = unread_count
        if last_msg:
            resp.last_message_body = last_msg.body
            resp.last_message_at = last_msg.created_at
        return resp

    async def _publish_to_redis(
        self, conversation_id: uuid.UUID, msg_resp: ChatMessageResponse
    ) -> None:
        """
        Publish chat message to the per-conversation Redis channel.
        Channel: ws:chat:{conversation_id} — scoped per conversation (Step 0.2).
        Confirms UUID channel naming — no sequential-ID risk.
        """
        try:
            from app.core.redis import get_redis
            redis = await get_redis()
            payload = json.dumps({
                "type": "message.new",
                "payload": msg_resp.model_dump(mode="json"),
            })
            await redis.publish(f"ws:chat:{conversation_id}", payload)
        except Exception as exc:
            logger.warning("chat_redis_publish_failed", conv_id=str(conversation_id), error=str(exc))
