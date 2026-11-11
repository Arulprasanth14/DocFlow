"""
DocFlow — Workflow notification catalogue (section 7.1, N1-N15)

Every notification the workflow module sends is built here and nowhere else.
Two reasons it is a module of its own rather than string literals at the call
sites:

  * **Dedupe keys have to agree.** Section 7.1 gives each event a key shape
    (run + stage + round + kind). A key built slightly differently in two
    places is not a dedupe key at all - the retry simply notifies twice. Here
    the shape is written once and the two cannot drift.

  * **X-NOT-02: only the currently actionable approver gets an actionable
    notification.** Keeping the recipient list next to the text makes that
    reviewable; scattered `notify_many(user_ids=...)` calls do not.

The builders address a notification, they do not send it. Sending is the
outbox's job (`services/outbox_service.py`), because a notification must not
escape a transaction that later rolls back (X-NOT-01).
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from app.domain.enums import NotificationType

# The topic the outbox dispatches on. One topic for the whole catalogue: the
# payload already names the code, and a second topic would only duplicate the
# routing table.
TOPIC_NOTIFICATION = "notification"


@dataclass(frozen=True)
class NotificationEnvelope:
    """One catalogue event, addressed but not yet delivered."""

    code: str                       # "N1" ... "N15", for audit and logs
    user_ids: list[uuid.UUID]
    type: str                       # NotificationType - what the bell renders
    title: str
    # `scope` identifies the EVENT, not the recipient: run + stage + round +
    # kind. The outbox row is deduped on it, each recipient's notification on
    # scope + their own id. So a re-run sweep cannot re-notify, but two
    # different people are still both notified for the same event.
    scope: str
    body: str | None = None
    deep_link: str | None = None
    instance_id: uuid.UUID | None = None
    metadata: dict = field(default_factory=dict)
    email_kind: str = "generic"

    @property
    def dedupe_key(self) -> str:
        return f"{self.code}:{self.scope}"

    def recipient_key(self, user_id: uuid.UUID) -> str:
        return f"{self.code}:{self.scope}:{user_id}"

    def to_payload(self) -> dict:
        """JSON-safe form for `outbox_events.payload` (JSONB)."""
        return {
            "code": self.code,
            "user_ids": [str(u) for u in self.user_ids],
            "type": str(self.type),
            "title": self.title,
            "body": self.body,
            "deep_link": self.deep_link,
            "instance_id": str(self.instance_id) if self.instance_id else None,
            "scope": self.scope,
            "metadata": self.metadata,
            "email_kind": self.email_kind,
        }

    @classmethod
    def from_payload(cls, payload: dict) -> "NotificationEnvelope":
        instance_id = payload.get("instance_id")
        return cls(
            code=payload["code"],
            user_ids=[uuid.UUID(u) for u in payload.get("user_ids", [])],
            type=payload["type"],
            title=payload["title"],
            scope=payload["scope"],
            body=payload.get("body"),
            deep_link=payload.get("deep_link"),
            instance_id=uuid.UUID(instance_id) if instance_id else None,
            metadata=payload.get("metadata") or {},
            email_kind=payload.get("email_kind", "generic"),
        )


def _run_scope(instance_id: uuid.UUID, *parts: object) -> str:
    return ":".join(["run", str(instance_id), *[str(p) for p in parts]])


# -- N1  Submitted -> the first stage's approver(s) --------------------------
def n1_approval_requested(
    *, instance_id: uuid.UUID, approver_ids: list[uuid.UUID], doc_title: str,
    stage_name: str, stage_instance_id: uuid.UUID | None = None,
    cycle: int = 1, round_number: int = 1, document_id: uuid.UUID | None = None,
) -> NotificationEnvelope:
    """AP-NOT-01. Only the stage that is actually active (X-NOT-02) - a later
    stage's approver is not told their turn is coming."""
    return NotificationEnvelope(
        code="N1",
        user_ids=approver_ids,
        type=NotificationType.ASSIGNED,
        title=f"Approval requested: {doc_title}",
        body=f"Stage '{stage_name}' requires your approval.",
        deep_link=(
            f"/approvals/{stage_instance_id}" if stage_instance_id else "/approvals"
        ),
        instance_id=instance_id,
        scope=_run_scope(instance_id, "c", cycle, "r", round_number, "activated"),
        metadata={
            "stage_name": stage_name,
            "document_id": str(document_id) if document_id else None,
        },
        email_kind="approval_requested",
    )


# -- N2  Stage approved -> the next stage's approver(s) ----------------------
def n2_next_stage_activated(
    *, instance_id: uuid.UUID, approver_ids: list[uuid.UUID], doc_title: str,
    stage_name: str, position: int, stage_instance_id: uuid.UUID | None = None,
    cycle: int = 1, round_number: int = 1,
) -> NotificationEnvelope:
    return NotificationEnvelope(
        code="N2",
        user_ids=approver_ids,
        type=NotificationType.ASSIGNED,
        title=f"Approval requested: {doc_title}",
        body=f"Step {position} ('{stage_name}') is now with you for approval.",
        deep_link=(
            f"/approvals/{stage_instance_id}" if stage_instance_id else "/approvals"
        ),
        instance_id=instance_id,
        scope=_run_scope(
            instance_id, "c", cycle, "p", position, "r", round_number, "activated"
        ),
        metadata={"stage_name": stage_name, "position": position},
        email_kind="approval_requested",
    )


# -- N3  Stage approved -> the document owner (progress) --------------------
def n3_stage_approved_owner(
    *, instance_id: uuid.UUID, owner_id: uuid.UUID, doc_title: str,
    stage_name: str, position: int, document_id: uuid.UUID,
    cycle: int = 1, round_number: int = 1,
) -> NotificationEnvelope:
    """AP-APR-07 - progress, not an action. The owner has nothing to do."""
    return NotificationEnvelope(
        code="N3",
        user_ids=[owner_id],
        type=NotificationType.APPROVED,
        title=f"Step {position} approved: {doc_title}",
        body=f"'{stage_name}' approved your document. It has moved to the next step.",
        deep_link=f"/documents/{document_id}",
        instance_id=instance_id,
        scope=_run_scope(
            instance_id, "c", cycle, "p", position, "r", round_number, "stage_approved"
        ),
        metadata={"stage_name": stage_name, "position": position},
    )


# -- N4  Changes requested -> the document owner ----------------------------
def n4_changes_requested(
    *, instance_id: uuid.UUID, owner_id: uuid.UUID, doc_title: str,
    document_id: uuid.UUID, stage_name: str, note: str | None = None,
    conversation_id: uuid.UUID | None = None, cycle: int = 1,
    round_number: int = 1,
) -> NotificationEnvelope:
    """AP-CHG-07 - distinct from a rejection. The document comes BACK and can
    be resubmitted to the same stage (BR-06), so the wording must not read
    like a refusal.

    The deep link goes to the document, not the chat thread: the owner needs
    the feedback against the document they are about to revise. The
    conversation is carried in the metadata for the UI to offer alongside.
    """
    return NotificationEnvelope(
        code="N4",
        user_ids=[owner_id],
        type=NotificationType.CHANGES_REQUESTED,
        title=f"Changes requested: {doc_title}",
        body=(
            f"'{stage_name}' has asked for changes before approving."
            + (f" {note}" if note else "")
        ),
        deep_link=f"/documents/{document_id}",
        instance_id=instance_id,
        scope=_run_scope(
            instance_id, "c", cycle, "r", round_number, "changes_requested"
        ),
        metadata={
            "stage_name": stage_name,
            "conversation_id": str(conversation_id) if conversation_id else None,
        },
        email_kind="changes_requested",
    )


# -- N5  Revision resubmitted -> the approver who asked for changes ---------
def n5_revision_submitted(
    *, instance_id: uuid.UUID, approver_ids: list[uuid.UUID], doc_title: str,
    stage_name: str, stage_instance_id: uuid.UUID | None = None,
    cycle: int = 1, round_number: int = 1,
) -> NotificationEnvelope:
    """WF-REV-14, BR-06 - back to the SAME stored approver (WF-STG-23), not
    to stage 1 and not to the whole chain."""
    return NotificationEnvelope(
        code="N5",
        user_ids=approver_ids,
        type=NotificationType.ASSIGNED,
        title=f"Revised and ready for review: {doc_title}",
        body=(
            f"A new version has been submitted to '{stage_name}' in answer to "
            f"your requested changes."
        ),
        deep_link=(
            f"/approvals/{stage_instance_id}" if stage_instance_id else "/approvals"
        ),
        instance_id=instance_id,
        scope=_run_scope(instance_id, "c", cycle, "r", round_number, "resubmitted"),
        metadata={"stage_name": stage_name, "round": round_number},
        email_kind="approval_requested",
    )


# -- N6  Final stage approved -> the document owner -------------------------
def n6_run_approved(
    *, instance_id: uuid.UUID, owner_id: uuid.UUID, doc_title: str,
    document_id: uuid.UUID,
) -> NotificationEnvelope:
    return NotificationEnvelope(
        code="N6",
        user_ids=[owner_id],
        type=NotificationType.APPROVED,
        title=f"Approved: {doc_title}",
        body="Every approval step is complete. The document is fully approved.",
        deep_link=f"/documents/{document_id}",
        instance_id=instance_id,
        scope=_run_scope(instance_id, "approved"),
        email_kind="document_approved",
    )


# -- N7  Rejected -> the document owner -------------------------------------
def n7_run_rejected(
    *, instance_id: uuid.UUID, owner_id: uuid.UUID, doc_title: str,
    document_id: uuid.UUID, stage_name: str, reason: str | None = None,
) -> NotificationEnvelope:
    """BR-07 - terminal. The reason travels with the notification so the owner
    does not have to open the document to learn why (AP-REJ-04)."""
    return NotificationEnvelope(
        code="N7",
        user_ids=[owner_id],
        type=NotificationType.REJECTED,
        title=f"Rejected: {doc_title}",
        body=(
            f"'{stage_name}' rejected this document."
            + (f" Reason: {reason}" if reason else "")
        ),
        deep_link=f"/documents/{document_id}",
        instance_id=instance_id,
        scope=_run_scope(instance_id, "rejected"),
        metadata={"stage_name": stage_name},
        email_kind="document_rejected",
    )


# -- N8  Withdrawn by the owner -> the approver who was mid-review ----------
def n8_run_withdrawn(
    *, instance_id: uuid.UUID, approver_ids: list[uuid.UUID], doc_title: str,
    document_id: uuid.UUID,
) -> NotificationEnvelope:
    """WF-WD-02. Without this the approver keeps a document in their queue
    that the owner has already pulled back, and only finds out by clicking
    into a 409."""
    return NotificationEnvelope(
        code="N8",
        user_ids=approver_ids,
        type=NotificationType.DOCUMENT_CANCELLED,
        title=f"Withdrawn: {doc_title}",
        body=(
            "The owner withdrew this document. It has been removed from your "
            "approval queue and no decision is needed."
        ),
        deep_link=f"/documents/{document_id}",
        instance_id=instance_id,
        scope=_run_scope(instance_id, "withdrawn"),
    )


# -- N9  75% of the window elapsed -> the approver ---------------------------
def n9_due_soon(
    *, instance_id: uuid.UUID, approver_ids: list[uuid.UUID], doc_title: str,
    stage_name: str, position: int, hours_left: float,
    stage_instance_id: uuid.UUID | None = None, cycle: int = 1,
    round_number: int = 1,
) -> NotificationEnvelope:
    """AP-SLA-02a. Without this the first an approver heard about a deadline
    was after they had already missed it."""
    left = (
        f"{round(hours_left)} hours" if hours_left >= 1
        else f"{max(1, round(hours_left * 60))} minutes"
    )
    return NotificationEnvelope(
        code="N9",
        user_ids=approver_ids,
        type=NotificationType.SLA_BREACH_WARNING,
        title=f"Due soon: {doc_title}",
        body=f"Step {position} ('{stage_name}') is due in about {left}.",
        deep_link=(
            f"/approvals/{stage_instance_id}" if stage_instance_id else "/approvals"
        ),
        instance_id=instance_id,
        scope=_run_scope(
            instance_id, "c", cycle, "p", position, "r", round_number, "due75"
        ),
        metadata={"stage_name": stage_name, "position": position},
    )


# -- N10  The deadline passed -> approver, and the submitter once ------------
def n10_overdue(
    *, instance_id: uuid.UUID, user_ids: list[uuid.UUID], doc_title: str,
    stage_name: str, position: int, for_submitter: bool = False,
    stage_instance_id: uuid.UUID | None = None, cycle: int = 1,
    round_number: int = 1,
) -> NotificationEnvelope:
    """AP-SLA-03. Overdue is a FLAG, not an escalation: it never
    auto-approves or auto-rejects anything, and the manager is not told yet.

    The submitter's copy is a separate event with its own scope, because
    "your document is late" and "your approval is late" are different
    messages and each must be sent exactly once.
    """
    return NotificationEnvelope(
        code="N10",
        user_ids=user_ids,
        type=NotificationType.SLA_BREACH_WARNING,
        title=f"Overdue: {doc_title}",
        body=(
            f"Step {position} ('{stage_name}') has passed its deadline and is "
            "still waiting."
            if not for_submitter else
            f"Your document is waiting at step {position} ('{stage_name}'), "
            "which has passed its deadline."
        ),
        deep_link=(
            f"/approvals/{stage_instance_id}"
            if (stage_instance_id and not for_submitter) else "/approvals"
        ),
        instance_id=instance_id,
        scope=_run_scope(
            instance_id, "c", cycle, "p", position, "r", round_number,
            "overdue_submitter" if for_submitter else "overdue",
        ),
        metadata={"stage_name": stage_name, "position": position},
    )


# -- N11  24h after overdue -> the approver's manager + Org Admins -----------
def n11_escalated(
    *, instance_id: uuid.UUID, user_ids: list[uuid.UUID], doc_title: str,
    stage_name: str, position: int, approver_name: str | None = None,
    hours_overdue: float = 24, cycle: int = 1, round_number: int = 1,
) -> NotificationEnvelope:
    """AP-SLA-04 - 24 hours AFTER overdue, not at the deadline. Escalating
    the moment something is an hour late pages a manager about nothing, and
    it goes to the MANAGER line (decision D1), not the department head."""
    return NotificationEnvelope(
        code="N11",
        user_ids=user_ids,
        type=NotificationType.ESCALATED,
        title=f"Escalated: {doc_title}",
        body=(
            f"Step {position} ('{stage_name}')"
            + (f", assigned to {approver_name}," if approver_name else "")
            + f" has been overdue for about {round(hours_overdue)} hours."
        ),
        deep_link="/approvals",
        instance_id=instance_id,
        scope=_run_scope(
            instance_id, "c", cycle, "p", position, "r", round_number,
            "escalated",
        ),
        metadata={"stage_name": stage_name, "position": position},
    )


# -- N15  A reply on a review comment -> the other party --------------------
def n15_comment_replied(
    *, instance_id: uuid.UUID | None, user_ids: list[uuid.UUID],
    doc_title: str, document_id: uuid.UUID, author_name: str,
    annotation_id: uuid.UUID, reply_id: uuid.UUID,
    page_number: int | None = None, excerpt: str | None = None,
) -> NotificationEnvelope:
    """WF-REV-05 / N15.

    The scope is the ANNOTATION plus the reply, not the run: a thread can
    carry several replies and each is its own event, so keying this on the
    run would silence every reply after the first.

    `excerpt` is the reply's own text, truncated. Deliberately not the
    comment being replied to: the recipient already knows what they wrote,
    and what they need from a notification is what the other person said.
    """
    body = f"{author_name} replied"
    if page_number is not None:
        body += f" on page {page_number}"
    if excerpt:
        body += f": {excerpt}"
    return NotificationEnvelope(
        code="N15",
        user_ids=user_ids,
        type=NotificationType.DOCUMENT_COMMENT,
        title=f"New reply: {doc_title}",
        body=body,
        deep_link=f"/documents/{document_id}?comment={annotation_id}",
        instance_id=instance_id,
        # One event per REPLY, keyed on the reply's own id. Keying it on the
        # annotation or the run would dedupe every reply after the first out
        # of existence; a timestamp would make the key unreproducible on a
        # retry, which is the one thing a dedupe key must never be.
        scope=f"annotation:{annotation_id}:reply:{reply_id}",
        metadata={
            "annotation_id": str(annotation_id),
            "page_number": page_number,
        },
    )


# -- N12  Stage blocked -> submitter + Org Admins ---------------------------
def n12_stage_blocked(
    *, instance_id: uuid.UUID, user_ids: list[uuid.UUID], doc_title: str,
    document_id: uuid.UUID, stage_name: str, position: int, reason: str,
    cycle: int = 1,
) -> NotificationEnvelope:
    """AP-SLA-05 - the run cannot proceed without an admin. The timer is
    paused, so nothing will escalate on its own: somebody has to be told."""
    return NotificationEnvelope(
        code="N12",
        user_ids=user_ids,
        type=NotificationType.SYSTEM,
        title=f"Needs reassignment: {doc_title}",
        body=f"Step {position} ('{stage_name}') is blocked - {reason}",
        deep_link=f"/documents/{document_id}",
        instance_id=instance_id,
        scope=_run_scope(instance_id, "c", cycle, "p", position, "blocked"),
        metadata={"stage_name": stage_name, "position": position, "reason": reason},
    )


# -- N13  Stage reassigned -> new approver, old approver, submitter ---------
def n13_stage_reassigned(
    *, instance_id: uuid.UUID, user_ids: list[uuid.UUID], doc_title: str,
    stage_name: str, position: int, reason: str,
    stage_instance_id: uuid.UUID | None = None, cycle: int = 1,
    revision: int = 1,
) -> NotificationEnvelope:
    """AP-SLA-06. `revision` is part of the scope because a stage can be
    reassigned more than once, and each reassignment is its own event."""
    return NotificationEnvelope(
        code="N13",
        user_ids=user_ids,
        type=NotificationType.ASSIGNED,
        title=f"Approver changed: {doc_title}",
        body=f"Step {position} ('{stage_name}') was reassigned - {reason}",
        deep_link=(
            f"/approvals/{stage_instance_id}" if stage_instance_id else "/approvals"
        ),
        instance_id=instance_id,
        scope=_run_scope(
            instance_id, "c", cycle, "p", position, "reassigned", revision
        ),
        metadata={"stage_name": stage_name, "position": position, "reason": reason},
        email_kind="approval_requested",
    )
