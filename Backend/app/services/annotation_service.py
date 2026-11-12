"""
DocFlow — Service: review feedback, the owner's side (section 5.10)

WF-REV-03..06, N15. Task P3-10.

This is what the document's owner does with an approver's comments: read them
grouped by page, reply, and mark each one addressed before resubmitting. The
approver's side — creating and publishing annotations — is P3-6 and P3-9.

Three rules do most of the work here:

**A draft is invisible to everyone but its author** (AP-ANN-05). An approver
annotates while deciding and publishes the set when they request changes. A
draft leaking to the owner would show them half-formed criticism that the
approver had not chosen to send, and might never have sent.

**A published annotation is never edited** (AP-ANN-09, BR-09). After
publication the only things that may happen to it are replies and status
changes. That is what makes a review trail worth keeping: nobody can go back
and soften what they said once the other party has answered it.

**The owner marks "addressed"; only the approver marks "resolved".** They are
different claims — "I have dealt with this" versus "I accept that you have" —
and letting the owner make the second one would let them close their own
feedback and approve their own corrections by the back door.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import structlog
from sqlalchemy import func, or_, select
from sqlalchemy.orm import selectinload

from app.core.exceptions import (
    ConflictException,
    ForbiddenException,
    NotFoundException,
    UnprocessableEntityException,
)
from app.domain import notifications as notif_catalogue
from app.domain.anchors import AnchorError, validate_anchor
from app.domain.enums import AuditAction
from app.domain.permissions import AuthUser
from app.models.annotation import (
    MAX_COMMENT,
    Annotation,
    AnnotationReply,
)
from app.models.document import Document, DocumentVersion
from app.models.user import User
from app.models.workflow import WorkflowInstance
from app.schemas.annotations import (
    AnnotationCreate,
    AnnotationReplyResponse,
    AnnotationThread,
    AnnotationUpdate,
    DocumentFeedbackResponse,
    FeedbackPageGroup,
    FeedbackVersionGroup,
    VersionAnnotationsResponse,
)
from app.services.outbox_service import OutboxService

logger = structlog.get_logger(__name__)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)

#: Status transitions and who may make them (section 6.11).
#:
#: The owner can say they have dealt with a comment, and take that back. The
#: approver accepts it, or reopens it if the fix did not land. Nobody can
#: move a comment back to 'draft': publication is one-way.
OWNER_TRANSITIONS = {"open": "addressed", "addressed": "open"}
APPROVER_TRANSITIONS = {
    "open": "resolved", "addressed": "resolved", "resolved": "open",
}


class AnnotationService:
    def __init__(self, db) -> None:
        self.db = db
        self.outbox = OutboxService(db)

    # -- CRUD, which is also the autosave (AP-ANN-01..09, AP-ANN-20) ---------

    async def list_for_version(
        self, version_id: uuid.UUID, actor: AuthUser
    ) -> VersionAnnotationsResponse:
        """Everything the review screen draws on one version.

        The published set, plus the caller's OWN drafts. Somebody else's
        drafts are absent and there is no count of them either: their
        existence is not the caller's business (AP-ANN-05), and a "3 hidden
        drafts" badge would leak exactly what the rule protects.
        """
        version = await self.db.get(DocumentVersion, version_id)
        if version is None or version.deleted_at is not None:
            raise NotFoundException("Document version not found")
        doc, _instance = await self._load_document(version.document_id, actor)

        rows = (
            await self.db.execute(
                select(Annotation)
                .where(
                    Annotation.document_version_id == version_id,
                    Annotation.deleted_at.is_(None),
                    or_(
                        Annotation.status != "draft",
                        Annotation.author_id == actor.id,
                    ),
                )
                .options(selectinload(Annotation.replies))
                .order_by(
                    Annotation.page_number.asc(), Annotation.created_at.asc()
                )
            )
        ).scalars().all()

        authors = await self._names(
            {a.author_id for a in rows}
            | {r.author_id for a in rows for r in a.replies}
        )
        threads = [self._thread(a, authors, doc) for a in rows]
        return VersionAnnotationsResponse(
            document_version_id=version_id,
            annotations=threads,
            draft_count=sum(1 for t in threads if t.status == "draft"),
            open_count=sum(1 for t in threads if t.is_open),
        )

    async def create_draft(
        self, req: AnnotationCreate, actor: AuthUser
    ) -> AnnotationThread:
        """Anchor a new comment. Always a draft (AP-ANN-01).

        There is no way to create one already published: a single mis-click
        would otherwise send criticism the approver was still drafting.
        """
        version = await self.db.get(DocumentVersion, req.document_version_id)
        if version is None or version.deleted_at is not None:
            raise NotFoundException("Document version not found")
        doc, instance = await self._load_document(version.document_id, actor)
        await self._assert_may_annotate(doc, actor)

        try:
            rects = validate_anchor(
                anchor_type=req.anchor_type,
                page_number=req.page_number,
                rects=[r.model_dump() for r in req.rects],
            )
        except AnchorError as exc:
            raise UnprocessableEntityException(str(exc)) from exc

        ann = Annotation(
            org_id=doc.org_id,
            review_round_id=req.review_round_id,
            document_version_id=version.id,
            author_id=actor.id,
            anchor_type=req.anchor_type,
            page_number=req.page_number,
            rects=rects,
            selected_text=req.selected_text,
            text_prefix=req.text_prefix,
            text_suffix=req.text_suffix,
            color=req.color,
            category=req.category,
            comment_text=(req.comment_text or None),
            status="draft",
        )
        self.db.add(ann)
        await self.db.flush()
        await self._audit(
            doc=doc, instance=instance, actor_id=actor.id,
            action=AuditAction.ANNOTATION_DRAFTED,
            resource_id=ann.id,
            after={"page_number": ann.page_number, "status": "draft"},
        )
        return self._thread(ann, {actor.id: await self._name_of(actor.id)}, doc)

    async def update_draft(
        self, annotation_id: uuid.UUID, req: AnnotationUpdate, actor: AuthUser
    ) -> AnnotationThread:
        """Edit a draft. This is the autosave endpoint (AP-ANN-20).

        A published annotation is immutable (AP-ANN-09, BR-09), so this
        refuses anything that is not still a draft - and refuses with 409
        rather than 403, because the caller had every right to edit it right
        up until they published it themselves.

        Only the author may edit, even for an admin: nobody edits somebody
        else's words.
        """
        ann, doc, instance = await self._load_annotation(annotation_id, actor)
        if ann.author_id != actor.id:
            raise ForbiddenException(
                "Only the person who wrote a comment can edit it."
            )
        if ann.status != "draft":
            raise ConflictException(
                "This comment has already been shared and can no longer be "
                "edited. Add a reply instead."
            )

        fields = req.model_dump(exclude_unset=True)
        if not fields:
            # An empty autosave is not an error - a debounce can fire with
            # nothing changed - but there is nothing to do either.
            return await self._thread_fresh(ann.id, doc)

        if any(k in fields for k in ("rects", "page_number", "anchor_type")):
            try:
                rects = validate_anchor(
                    anchor_type=fields.get("anchor_type", ann.anchor_type),
                    page_number=fields.get("page_number", ann.page_number),
                    rects=(
                        fields["rects"] if "rects" in fields
                        else (ann.rects or [])
                    ),
                )
            except AnchorError as exc:
                raise UnprocessableEntityException(str(exc)) from exc
            fields["rects"] = rects

        for key, value in fields.items():
            if key == "comment_text":
                value = value or None
            setattr(ann, key, value)
        await self.db.flush()
        return await self._thread_fresh(ann.id, doc)

    async def delete_draft(
        self, annotation_id: uuid.UUID, actor: AuthUser
    ) -> None:
        """Discard a draft.

        Soft-deleted, not removed: an approver who deletes a draft by
        accident during a review has lost work that AP-ANN-20 says must not
        be losable, and a row with `deleted_at` set can still be recovered by
        an operator. It stops appearing immediately either way.
        """
        ann, doc, instance = await self._load_annotation(annotation_id, actor)
        if ann.author_id != actor.id:
            raise ForbiddenException(
                "Only the person who wrote a comment can discard it."
            )
        if ann.status != "draft":
            # Published comments are part of the record (BR-09). Withdrawing
            # one is a status change the approver makes by resolving it, not
            # a deletion.
            raise ConflictException(
                "This comment has already been shared, so it cannot be "
                "discarded. Resolve it instead."
            )
        ann.deleted_at = _utcnow()
        await self.db.flush()
        await self._audit(
            doc=doc, instance=instance, actor_id=actor.id,
            action=AuditAction.ANNOTATION_DISCARDED,
            resource_id=ann.id,
            before={"status": "draft"},
        )

    async def _assert_may_annotate(self, doc: Document, actor: AuthUser) -> None:
        """Only an approver on this document's run may comment on it.

        Annotations are the approver's instrument (section 6.5): the owner
        answers them with replies, and a bystander who can merely READ the
        document has no business leaving review comments on it. Admins are
        included because section 7.3 gives them the approver's view.
        """
        from app.services.document_service import _is_run_participant

        if actor.is_org_admin():
            return
        if await _is_run_participant(self.db, doc.id, actor.id):
            return
        raise ForbiddenException(
            "Only an approver on this document can leave review comments."
        )

    async def _name_of(self, user_id: uuid.UUID) -> str | None:
        return (await self._names({user_id})).get(user_id)

    async def _thread_fresh(
        self, annotation_id: uuid.UUID, doc: Document
    ) -> AnnotationThread:
        fresh = (
            await self.db.execute(
                select(Annotation)
                .where(Annotation.id == annotation_id)
                .options(selectinload(Annotation.replies))
            )
        ).scalars().one()
        authors = await self._names(
            {fresh.author_id} | {r.author_id for r in fresh.replies}
        )
        return self._thread(fresh, authors, doc)

    # -- Publishing (AP-CHG-01, task P3-9) -----------------------------------

    async def publish_drafts(
        self,
        *,
        document_version_id: uuid.UUID,
        author_id: uuid.UUID,
        org_id: uuid.UUID,
        review_round_id: uuid.UUID | None = None,
    ) -> list[uuid.UUID]:
        """Turn this approver's drafts on this version into open comments.

        Called from inside the Request Changes transaction, never on its own:
        a published comment with no decision behind it would appear to the
        owner with nothing explaining why it had arrived.

        Scoped to ONE author's drafts. Two approvers can be looking at the
        same version at once on a parallel stage, and publishing someone
        else's unfinished notes because they happened to share a document
        would be the worst possible failure of AP-ANN-05.

        Returns the ids published, so the caller can audit a count without
        re-querying.
        """
        drafts = (
            await self.db.execute(
                select(Annotation).where(
                    Annotation.document_version_id == document_version_id,
                    Annotation.author_id == author_id,
                    Annotation.status == "draft",
                    Annotation.deleted_at.is_(None),
                )
            )
        ).scalars().all()

        now = _utcnow()
        published: list[uuid.UUID] = []
        for ann in drafts:
            # A draft with no text is an anchor the approver drew and never
            # wrote on. AP-CHG-02 requires every published comment to say
            # something, and the database CHECK enforces it, so these are
            # dropped rather than published empty - they are scaffolding, not
            # feedback.
            if not (ann.comment_text or "").strip():
                ann.deleted_at = now
                continue
            ann.status = "open"
            ann.published_at = now
            if review_round_id is not None and ann.review_round_id is None:
                ann.review_round_id = review_round_id
            published.append(ann.id)
        await self.db.flush()
        return published

    async def count_written_drafts(
        self, *, document_version_id: uuid.UUID, author_id: uuid.UUID
    ) -> int:
        rows = (
            await self.db.execute(
                select(func.count())
                .select_from(Annotation)
                .where(
                    Annotation.document_version_id == document_version_id,
                    Annotation.author_id == author_id,
                    Annotation.status == "draft",
                    Annotation.deleted_at.is_(None),
                    Annotation.comment_text.isnot(None),
                    func.btrim(Annotation.comment_text) != "",
                )
            )
        ).scalar()
        return rows or 0

    # -- Reading (WF-REV-03, WF-REV-04) --------------------------------------

    async def document_feedback(
        self, document_id: uuid.UUID, actor: AuthUser
    ) -> DocumentFeedbackResponse:
        """Every published comment on a document, newest version first.

        Grouped by version and then by page (WF-REV-04), because that is how
        the owner works through them: open the page, fix the things on it,
        move on. A flat list by timestamp would make them jump between pages.

        Earlier versions are included and marked read-only: the owner needs
        to see what was asked on v1 while they revise v2, and WF-REV-12 keeps
        earlier rounds intact rather than carrying them forward.
        """
        doc, _instance = await self._load_document(document_id, actor)

        versions = (
            await self.db.execute(
                select(DocumentVersion)
                .where(
                    DocumentVersion.document_id == doc.id,
                    DocumentVersion.deleted_at.is_(None),
                )
                .order_by(DocumentVersion.version_num.desc())
            )
        ).scalars().all()
        if not versions:
            return DocumentFeedbackResponse(
                document_id=doc.id, document_title=doc.title, versions=[],
                open_count=0, total_count=0,
            )

        latest_version_id = versions[0].id
        version_ids = [v.id for v in versions]

        rows = (
            await self.db.execute(
                select(Annotation)
                .where(
                    Annotation.document_version_id.in_(version_ids),
                    Annotation.deleted_at.is_(None),
                    # The whole point: drafts never leave their author
                    # (AP-ANN-05). Filtered in the query rather than after,
                    # so there is no path by which one reaches a response.
                    Annotation.status != "draft",
                )
                .options(selectinload(Annotation.replies))
                .order_by(
                    Annotation.page_number.asc(), Annotation.created_at.asc()
                )
            )
        ).scalars().all()

        authors = await self._names(
            {a.author_id for a in rows}
            | {r.author_id for a in rows for r in a.replies}
        )

        by_version: dict[uuid.UUID, dict[int, list[Annotation]]] = {}
        for ann in rows:
            by_version.setdefault(ann.document_version_id, {}).setdefault(
                ann.page_number, []
            ).append(ann)

        groups: list[FeedbackVersionGroup] = []
        open_count = 0
        for version in versions:
            pages = by_version.get(version.id, {})
            if not pages:
                continue
            page_groups: list[FeedbackPageGroup] = []
            for page_number in sorted(pages):
                threads = [
                    self._thread(a, authors, doc) for a in pages[page_number]
                ]
                open_count += sum(1 for t in threads if t.is_open)
                page_groups.append(
                    FeedbackPageGroup(page_number=page_number, comments=threads)
                )
            groups.append(
                FeedbackVersionGroup(
                    document_version_id=version.id,
                    version_num=version.version_num,
                    # Only the current version's comments are actionable.
                    # Earlier ones are history: replying to a comment about
                    # text that has since been rewritten helps nobody, and
                    # WF-REV-12 keeps those rounds as they were.
                    is_current=version.id == latest_version_id,
                    pages=page_groups,
                )
            )

        return DocumentFeedbackResponse(
            document_id=doc.id,
            document_title=doc.title,
            versions=groups,
            open_count=open_count,
            total_count=len(rows),
        )

    def _thread(
        self, ann: Annotation, authors: dict[uuid.UUID, str], doc: Document
    ) -> AnnotationThread:
        return AnnotationThread(
            id=ann.id,
            document_version_id=ann.document_version_id,
            page_number=ann.page_number,
            anchor_type=ann.anchor_type,
            rects=ann.rects or [],
            selected_text=ann.selected_text,
            comment_text=ann.comment_text,
            category=ann.category,
            color=ann.color,
            status=ann.status,
            is_open=ann.is_open,
            author_id=ann.author_id,
            author_name=authors.get(ann.author_id),
            published_at=ann.published_at,
            created_at=ann.created_at,
            # AP-ANN-22: a carried-over comment says so, and says whether its
            # anchor could be found on the new version. `relocated is False`
            # is what the UI renders as "Location changed".
            carried_from_id=ann.carried_from_id,
            relocated=ann.relocated,
            replies=[
                AnnotationReplyResponse(
                    id=r.id,
                    annotation_id=r.annotation_id,
                    author_id=r.author_id,
                    author_name=authors.get(r.author_id),
                    body=r.body,
                    created_at=r.created_at,
                )
                for r in sorted(ann.replies, key=lambda r: r.created_at)
                if r.deleted_at is None
            ],
        )

    async def _names(self, user_ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
        if not user_ids:
            return {}
        rows = (
            await self.db.execute(select(User).where(User.id.in_(user_ids)))
        ).scalars().all()
        return {u.id: (u.name or u.email) for u in rows}

    # -- Replying (WF-REV-05, N15) -------------------------------------------

    async def add_reply(
        self, annotation_id: uuid.UUID, actor: AuthUser, body: str
    ) -> AnnotationReplyResponse:
        """Append a reply. Append-only: there is no edit and no delete."""
        body = (body or "").strip()
        if not body:
            raise UnprocessableEntityException("A reply cannot be empty.")
        if len(body) > MAX_COMMENT:
            raise UnprocessableEntityException(
                f"A reply can be at most {MAX_COMMENT} characters."
            )

        ann, doc, instance = await self._load_annotation(annotation_id, actor)
        if ann.status == "draft":
            # Unreachable through _load_annotation for anyone but the author,
            # and meaningless even for them: a draft has no counterparty yet.
            raise ConflictException(
                "This comment has not been shared yet, so it cannot be "
                "replied to."
            )

        reply = AnnotationReply(
            org_id=doc.org_id,
            annotation_id=ann.id,
            author_id=actor.id,
            body=body,
        )
        self.db.add(reply)
        await self.db.flush()

        await self._audit(
            doc=doc, instance=instance, actor_id=actor.id,
            action=AuditAction.ANNOTATION_REPLIED,
            resource_id=ann.id,
            after={"reply_id": str(reply.id), "annotation_id": str(ann.id)},
        )

        # N15 to the other party — whoever is in the thread and is not the
        # person who just typed. The owner and the comment's author are the
        # two sides; earlier repliers are included so a three-way thread does
        # not silently drop one of them.
        names = await self._names({actor.id})
        recipients: list[uuid.UUID] = []
        for candidate in [ann.author_id, doc.submitted_by] + [
            r.author_id for r in await self._replies_of(ann.id)
        ]:
            if candidate != actor.id and candidate not in recipients:
                recipients.append(candidate)

        await self.outbox.enqueue_notification(
            notif_catalogue.n15_comment_replied(
                instance_id=instance.id if instance else None,
                user_ids=recipients,
                doc_title=doc.title,
                document_id=doc.id,
                author_name=names.get(actor.id, "Someone"),
                annotation_id=ann.id,
                reply_id=reply.id,
                page_number=ann.page_number,
                excerpt=body[:140],
            ),
            org_id=doc.org_id,
        )

        return AnnotationReplyResponse(
            id=reply.id,
            annotation_id=ann.id,
            author_id=actor.id,
            author_name=names.get(actor.id),
            body=reply.body,
            created_at=reply.created_at,
        )

    async def _replies_of(self, annotation_id: uuid.UUID):
        return (
            await self.db.execute(
                select(AnnotationReply).where(
                    AnnotationReply.annotation_id == annotation_id,
                    AnnotationReply.deleted_at.is_(None),
                )
            )
        ).scalars().all()

    # -- Status (WF-REV-06) --------------------------------------------------

    async def set_status(
        self, annotation_id: uuid.UUID, actor: AuthUser, status: str
    ) -> AnnotationThread:
        """Mark a comment addressed, resolved, or reopened.

        Who may do what is the point of this method. The owner says "I have
        dealt with this" (addressed) and can take it back. The approver says
        "I accept that" (resolved), or reopens it. The owner must not be able
        to resolve: that would let them close their own feedback, which is
        approving their own corrections by the back door.
        """
        ann, doc, instance = await self._load_annotation(annotation_id, actor)
        if ann.status == "draft":
            raise ConflictException(
                "This comment has not been shared yet."
            )

        is_owner = doc.submitted_by == actor.id
        is_author = ann.author_id == actor.id
        is_admin = actor.is_org_admin()

        allowed: dict[str, str] = {}
        if is_author or is_admin:
            allowed.update(APPROVER_TRANSITIONS)
        if is_owner:
            allowed.update(OWNER_TRANSITIONS)
        if not allowed:
            raise ForbiddenException(
                "Only the document's owner or the comment's author can change "
                "this comment's state."
            )

        expected = allowed.get(ann.status)
        if expected != status:
            # The message says what they CAN do from here, because a bare
            # refusal leaves the UI nothing to explain (UX-INT-01).
            options = sorted({v for v in allowed.values()})
            raise ConflictException(
                f"A comment that is '{ann.status}' cannot be set to "
                f"'{status}'. From here you can set: {', '.join(options)}."
            )

        before = ann.status
        ann.status = status
        await self.db.flush()

        await self._audit(
            doc=doc, instance=instance, actor_id=actor.id,
            action=AuditAction.ANNOTATION_STATUS_CHANGED,
            resource_id=ann.id,
            before={"status": before},
            after={"status": status},
        )

        fresh = (
            await self.db.execute(
                select(Annotation)
                .where(Annotation.id == ann.id)
                .options(selectinload(Annotation.replies))
            )
        ).scalars().one()
        authors = await self._names(
            {fresh.author_id} | {r.author_id for r in fresh.replies}
        )
        return self._thread(fresh, authors, doc)

    # -- Loading and access --------------------------------------------------

    async def _load_document(
        self, document_id: uuid.UUID, actor: AuthUser
    ) -> tuple[Document, WorkflowInstance | None]:
        from app.repositories.workflow_repo import WorkflowInstanceRepository
        from app.services.document_service import can_user_access_document

        not_found = NotFoundException("Document not found")
        doc = await self.db.get(Document, document_id)
        if (
            doc is None
            or doc.deleted_at is not None
            or not actor.org_id
            or doc.org_id != actor.org_id
        ):
            raise not_found
        # 404 and not 403, as everywhere else in this module: the difference
        # between "no such document" and "not yours" is itself information
        # about another department's work (section 9.4, E28).
        if not await can_user_access_document(self.db, actor, doc):
            raise not_found
        instance = await WorkflowInstanceRepository(self.db).get_by_document(
            doc.id
        )
        return doc, instance

    async def _load_annotation(
        self, annotation_id: uuid.UUID, actor: AuthUser
    ) -> tuple[Annotation, Document, WorkflowInstance | None]:
        not_found = NotFoundException("Comment not found")
        ann = await self.db.get(Annotation, annotation_id)
        if ann is None or ann.deleted_at is not None:
            raise not_found
        version = await self.db.get(DocumentVersion, ann.document_version_id)
        if version is None:
            raise not_found
        doc, instance = await self._load_document(version.document_id, actor)
        # A draft is its author's alone, and that holds even for someone who
        # can otherwise read the document.
        if ann.status == "draft" and ann.author_id != actor.id:
            raise not_found
        return ann, doc, instance

    async def _audit(
        self,
        *,
        doc: Document,
        instance: WorkflowInstance | None,
        actor_id: uuid.UUID,
        action: str,
        resource_id: uuid.UUID,
        before: dict | None = None,
        after: dict | None = None,
    ) -> None:
        from app.models.audit import AuditLog

        self.db.add(
            AuditLog(
                org_id=doc.org_id,
                actor_id=actor_id,
                action=action,
                resource_type="Annotation",
                resource_id=resource_id,
                instance_id=instance.id if instance else None,
                before=before,
                after=after,
                created_at=datetime.now(timezone.utc),
            )
        )
        await self.db.flush()
