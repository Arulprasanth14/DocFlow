"""
DocFlow Backend — Service: Unified Search

Implements the requirements report §8: "one consistent entry point for
finding organization resources that the signed-in user is permitted to
access."

The governing rule is the third bullet: "Apply organization isolation and
role-based access filters BEFORE returning results. Search must not reveal
the existence, title, snippets, or metadata of inaccessible records."
Every query below therefore filters by org_id AND by the caller's own
visibility rules at the SQL level — nothing is fetched broadly and filtered
afterwards, and no result carries a snippet from a record the caller could
not already open directly.

Entities covered:
  documents  — title / public_id / extracted content, scoped by the same
               role+ownership+department rules as the Documents module
  workflows  — workflow templates by name/description, respecting §7's
               private-workflow rule
  members    — coworkers by name/email/department (§2.5 Search: all roles)
  messages   — chat messages, restricted to conversations the caller
               actually participates in

A note on document CONTENT search: §8 says "content where indexed and
authorized". `documents.content_text` is searched when it has been
populated (text extraction/OCR fills it); `documents.search_vector` exists
with a GIN index but is not currently maintained by any writer, so this
service deliberately uses trigram/ILIKE matching on title (which does have
a trigram GIN index) plus content_text, rather than issuing a tsquery
against a vector that is always NULL and would silently match nothing.
"""
from __future__ import annotations

import uuid
from typing import Any, Literal

import structlog
from sqlalchemy import String, cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.permissions import AuthUser
from app.models.chat import ChatMessage, Conversation, ConversationParticipant
from app.models.document import Document, DocumentType
from app.models.organization import Department, OrganizationMember, Role
from app.models.user import User
from app.models.workflow import WorkflowTemplate

logger = structlog.get_logger(__name__)

EntityType = Literal["documents", "workflows", "members", "messages"]
ALL_ENTITIES: tuple[EntityType, ...] = ("documents", "workflows", "members", "messages")


class SearchService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    @staticmethod
    def _is_org_admin(user: AuthUser) -> bool:
        return bool(user.is_superadmin or ({"admin", "hr"} & set(user.roles)))

    async def search(
        self,
        user: AuthUser,
        q: str,
        entities: tuple[EntityType, ...] = ALL_ENTITIES,
        limit: int = 10,
        offset: int = 0,
        status: str | None = None,
        doc_type_id: uuid.UUID | None = None,
        dept_id: uuid.UUID | None = None,
        owner_id: uuid.UUID | None = None,
        date_from: Any = None,
        date_to: Any = None,
        sort: Literal["relevance", "newest", "oldest", "title"] = "relevance",
    ) -> dict:
        """
        Run the search across the requested entity types.

        Returns per-entity result lists with their own `total` counts so the
        UI can show "12 documents, 3 workflows" and paginate each group
        independently. An empty query returns empty groups rather than
        everything — "show me the whole org" is the listing endpoints' job,
        not search's.
        """
        term = (q or "").strip()
        results: dict[str, Any] = {
            "query": term,
            "entities": list(entities),
            "limit": limit,
            "offset": offset,
            "groups": {},
            "total": 0,
        }
        if not term:
            for e in entities:
                results["groups"][e] = {"items": [], "total": 0}
            return results

        if "documents" in entities:
            results["groups"]["documents"] = await self._search_documents(
                user, term, limit, offset,
                status=status, doc_type_id=doc_type_id, dept_id=dept_id,
                owner_id=owner_id, date_from=date_from, date_to=date_to, sort=sort,
            )
        if "workflows" in entities:
            results["groups"]["workflows"] = await self._search_workflows(
                user, term, limit, offset, sort=sort
            )
        if "members" in entities:
            results["groups"]["members"] = await self._search_members(
                user, term, limit, offset, dept_id=dept_id
            )
        if "messages" in entities:
            results["groups"]["messages"] = await self._search_messages(
                user, term, limit, offset
            )

        results["total"] = sum(g["total"] for g in results["groups"].values())
        return results

    # ── Documents ───────────────────────────────────────────────────────────

    async def _search_documents(
        self,
        user: AuthUser,
        term: str,
        limit: int,
        offset: int,
        *,
        status: str | None = None,
        doc_type_id: uuid.UUID | None = None,
        dept_id: uuid.UUID | None = None,
        owner_id: uuid.UUID | None = None,
        date_from: Any = None,
        date_to: Any = None,
        sort: str = "relevance",
    ) -> dict:
        like = f"%{term}%"
        q = select(Document).where(
            Document.org_id == user.org_id,
            Document.deleted_at.is_(None),
            or_(
                Document.title.ilike(like),
                Document.public_id.ilike(like),
                Document.content_text.ilike(like),
                cast(Document.tags, String).ilike(like),
            ),
        )

        # ── Access scoping (BEFORE results are produced) ───────────────────
        if not self._is_org_admin(user):
            from app.services.document_service import get_user_departments

            dept_ids = await get_user_departments(self.db, user.id, user.org_id)
            if "worker" in user.roles:
                q = q.where(
                    or_(
                        Document.submitted_by == user.id,
                        Document.dept_id.in_(dept_ids) if dept_ids else False,
                        Document.dept_id.is_(None),
                    )
                )
            else:
                # Trainee and anyone else: only their own documents. Without
                # this they could discover titles of documents they cannot open.
                q = q.where(Document.submitted_by == user.id)

        if status:
            q = q.where(Document.status == status)
        if doc_type_id:
            q = q.where(Document.doc_type_id == doc_type_id)
        if dept_id:
            q = q.where(Document.dept_id == dept_id)
        if owner_id:
            q = q.where(Document.submitted_by == owner_id)
        if date_from:
            q = q.where(Document.created_at >= date_from)
        if date_to:
            q = q.where(Document.created_at <= date_to)

        total = (
            await self.db.execute(select(func.count()).select_from(q.subquery()))
        ).scalar_one()

        if sort == "newest":
            q = q.order_by(Document.created_at.desc())
        elif sort == "oldest":
            q = q.order_by(Document.created_at.asc())
        elif sort == "title":
            q = q.order_by(Document.title.asc())
        else:
            # "relevance": exact-ish title matches first, then recency.
            q = q.order_by(
                func.similarity(Document.title, term).desc(),
                Document.created_at.desc(),
            )

        rows = (await self.db.execute(q.offset(offset).limit(limit))).scalars().all()

        type_ids = {d.doc_type_id for d in rows if d.doc_type_id}
        type_names = {}
        if type_ids:
            type_names = {
                t.id: t.name
                for t in (
                    await self.db.execute(
                        select(DocumentType).where(DocumentType.id.in_(type_ids))
                    )
                ).scalars().all()
            }
        owner_ids = {d.submitted_by for d in rows}
        owners = {}
        if owner_ids:
            owners = {
                u.id: u
                for u in (
                    await self.db.execute(select(User).where(User.id.in_(owner_ids)))
                ).scalars().all()
            }

        return {
            "total": int(total),
            "items": [
                {
                    "id": str(d.id),
                    "type": "document",
                    "title": d.title,
                    "public_id": d.public_id,
                    "status": d.status.value if hasattr(d.status, "value") else d.status,
                    "document_type": type_names.get(d.doc_type_id),
                    "owner_id": str(d.submitted_by),
                    "owner_name": (
                        owners[d.submitted_by].name or owners[d.submitted_by].email
                        if d.submitted_by in owners
                        else None
                    ),
                    "dept_id": str(d.dept_id) if d.dept_id else None,
                    "created_at": d.created_at.isoformat() if d.created_at else None,
                    "updated_at": d.updated_at.isoformat() if d.updated_at else None,
                    "deep_link": f"/documents/{d.id}",
                }
                for d in rows
            ],
        }

    # ── Workflows (templates) ───────────────────────────────────────────────

    async def _search_workflows(
        self, user: AuthUser, term: str, limit: int, offset: int, *, sort: str = "relevance"
    ) -> dict:
        like = f"%{term}%"
        q = select(WorkflowTemplate).where(
            WorkflowTemplate.org_id == user.org_id,
            WorkflowTemplate.deleted_at.is_(None),
            or_(
                WorkflowTemplate.name.ilike(like),
                WorkflowTemplate.description.ilike(like),
                WorkflowTemplate.document_type_scope.ilike(like),
            ),
        )
        # §7: a private workflow is invisible to everyone but its owner
        # (admins manage all of them).
        if not self._is_org_admin(user):
            q = q.where(
                or_(
                    WorkflowTemplate.visibility != "private",
                    WorkflowTemplate.created_by == user.id,
                )
            )

        total = (
            await self.db.execute(select(func.count()).select_from(q.subquery()))
        ).scalar_one()

        if sort == "title":
            q = q.order_by(WorkflowTemplate.name.asc())
        elif sort == "oldest":
            q = q.order_by(WorkflowTemplate.created_at.asc())
        else:
            q = q.order_by(WorkflowTemplate.created_at.desc())

        rows = (await self.db.execute(q.offset(offset).limit(limit))).scalars().all()
        return {
            "total": int(total),
            "items": [
                {
                    "id": str(t.id),
                    "type": "workflow",
                    "title": t.name,
                    "description": t.description,
                    "is_active": t.is_active,
                    "visibility": t.visibility,
                    "owned_by_me": t.created_by == user.id,
                    "version": t.version,
                    "created_at": t.created_at.isoformat() if t.created_at else None,
                    "deep_link": f"/workflows?template={t.id}",
                }
                for t in rows
            ],
        }

    # ── Members ─────────────────────────────────────────────────────────────

    async def _search_members(
        self,
        user: AuthUser,
        term: str,
        limit: int,
        offset: int,
        *,
        dept_id: uuid.UUID | None = None,
    ) -> dict:
        like = f"%{term}%"
        q = (
            select(OrganizationMember, User, Role, Department)
            .join(User, User.id == OrganizationMember.user_id)
            .outerjoin(Role, Role.id == OrganizationMember.role_id)
            .outerjoin(Department, Department.id == OrganizationMember.dept_id)
            .where(
                # Tenant isolation: "Users must not be able to message or
                # discover members of another organization" (§10).
                OrganizationMember.org_id == user.org_id,
                OrganizationMember.deleted_at.is_(None),
                OrganizationMember.status == "active",
                or_(User.name.ilike(like), User.email.ilike(like)),
            )
        )
        if dept_id:
            q = q.where(OrganizationMember.dept_id == dept_id)

        total = (
            await self.db.execute(select(func.count()).select_from(q.subquery()))
        ).scalar_one()

        rows = (
            await self.db.execute(q.order_by(User.name.asc()).offset(offset).limit(limit))
        ).all()
        return {
            "total": int(total),
            "items": [
                {
                    "id": str(member.user_id),
                    "type": "member",
                    "title": u.name or u.email,
                    "email": u.email,
                    "role": role.name if role else None,
                    "department": dept.name if dept else None,
                    "avatar_url": u.avatar_url,
                    "deep_link": f"/chat?user={member.user_id}",
                }
                for member, u, role, dept in rows
            ],
        }

    # ── Messages ────────────────────────────────────────────────────────────

    async def _search_messages(
        self, user: AuthUser, term: str, limit: int, offset: int
    ) -> dict:
        like = f"%{term}%"
        # Only conversations the caller participates in — never a global
        # message scan.
        my_conversation_ids = (
            select(ConversationParticipant.conversation_id)
            .where(ConversationParticipant.user_id == user.id)
            .scalar_subquery()
        )
        # NOTE: Conversation has no org_id column — participation IS the
        # access boundary for chat in this schema, and it's the stronger
        # filter anyway (a conversation the caller is not in is invisible
        # regardless of org). Do not add an org filter here expecting a
        # column that doesn't exist.
        q = (
            select(ChatMessage, Conversation)
            .join(Conversation, Conversation.id == ChatMessage.conversation_id)
            .where(
                ChatMessage.conversation_id.in_(my_conversation_ids),
                ChatMessage.body.ilike(like),
                ChatMessage.deleted_at.is_(None),
            )
        )

        total = (
            await self.db.execute(select(func.count()).select_from(q.subquery()))
        ).scalar_one()

        rows = (
            await self.db.execute(
                q.order_by(ChatMessage.created_at.desc()).offset(offset).limit(limit)
            )
        ).all()

        sender_ids = {m.sender_id for m, _ in rows}
        senders = {}
        if sender_ids:
            senders = {
                u.id: u
                for u in (
                    await self.db.execute(select(User).where(User.id.in_(sender_ids)))
                ).scalars().all()
            }

        return {
            "total": int(total),
            "items": [
                {
                    "id": str(m.id),
                    "type": "message",
                    "title": (m.body[:120] + "…") if len(m.body or "") > 120 else m.body,
                    "conversation_id": str(m.conversation_id),
                    "conversation_title": conv.title,
                    "sender_id": str(m.sender_id),
                    "sender_name": (
                        senders[m.sender_id].name or senders[m.sender_id].email
                        if m.sender_id in senders
                        else None
                    ),
                    "created_at": m.created_at.isoformat() if m.created_at else None,
                    "deep_link": f"/chat/{m.conversation_id}",
                }
                for m, conv in rows
            ],
        }
