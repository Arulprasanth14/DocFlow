"""
DocFlow Backend — Service: Organization join requests.

Flow:
  user (no org)  --request-->  PENDING membership row
  all admins + HR are notified (in-app + email)
  ANY ONE of them accepts (choosing the role) or rejects
  first decision wins; the request is then closed for everyone else
  the requester is emailed the outcome

Concurrency: "first decision wins" is enforced by a single conditional UPDATE
(`... WHERE status = 'pending' ... RETURNING`). Two admins clicking Accept at
the same instant cannot both succeed - the database serialises them and the
loser's UPDATE matches zero rows. No application-level locking required.

A request is stored as an OrganizationMember row with status 'pending'
(role_id is NOT NULL, so it holds the least-privileged placeholder role until
a reviewer assigns the real one). A pending row grants NOTHING: every access
check requires status == 'active'.
"""
from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

import structlog
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    ConflictException,
    ForbiddenException,
    NotFoundException,
)
from app.domain.enums import NotificationType
from app.models.organization import Organization, OrganizationMember, Role
from app.domain.permissions import roles_include_org_admin
from app.models.user import User
from app.services.account_service import normalize_org_name

logger = structlog.get_logger(__name__)

# Roles a reviewer may assign. Never "admin": the Main Administrator role is
# only ever held by an organization's creator. "hr" may only be granted by a
# Main Administrator (an HR user can add Workers and Trainees only).
ASSIGNABLE_BY_ANYONE = {"worker", "trainee"}
ASSIGNABLE_BY_ADMIN_ONLY = {"hr"}


def _is_main_admin(roles: list[str], is_superadmin: bool) -> bool:
    return roles_include_org_admin(roles, is_superadmin)


def _is_reviewer(roles: list[str], is_superadmin: bool) -> bool:
    return is_superadmin or bool({"admin", "hr"} & set(roles))


class JoinRequestService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # ── Requester side ──────────────────────────────────────────────────────

    async def search_organizations(self, q: str, limit: int = 5) -> list[str]:
        """
        Organization NAMES matching a prefix/substring, for the join picker.
        Names only - no ids, counts or members - and capped, so this can't be
        used to enumerate organization details.
        """
        term = normalize_org_name(q)
        if len(term) < 2:
            return []
        rows = (
            await self.db.execute(
                select(Organization.name)
                .where(
                    Organization.deleted_at.is_(None),
                    Organization.name.ilike(f"%{term}%"),
                )
                .order_by(Organization.name)
                .limit(limit)
            )
        ).scalars().all()
        return list(rows)

    async def request_join(self, user: User, org_name: str) -> dict:
        name = normalize_org_name(org_name)
        org = (
            await self.db.execute(
                select(Organization).where(
                    Organization.deleted_at.is_(None),
                    # case-insensitive exact match
                    Organization.name.ilike(name.replace("%", r"\%").replace("_", r"\_"), escape="\\"),
                )
            )
        ).scalar_one_or_none()
        if org is None:
            raise NotFoundException(f"No organization named '{name}' was found")

        # A user who already belongs to an organization must never be asked
        # to join another (login routes them to their dashboard).
        active = (
            await self.db.execute(
                select(OrganizationMember.id).where(
                    OrganizationMember.user_id == user.id,
                    OrganizationMember.status == "active",
                    OrganizationMember.deleted_at.is_(None),
                )
            )
        ).first()
        if active:
            raise ConflictException("You already belong to an organization.")

        # One open request at a time (prevents duplicates to the same org and
        # keeps "waiting for approval" unambiguous).
        pending = (
            await self.db.execute(
                select(OrganizationMember, Organization)
                .join(Organization, Organization.id == OrganizationMember.org_id)
                .where(
                    OrganizationMember.user_id == user.id,
                    OrganizationMember.status == "pending",
                    OrganizationMember.deleted_at.is_(None),
                )
            )
        ).first()
        if pending:
            _m, pending_org = pending
            if pending_org.id == org.id:
                raise ConflictException(
                    f"You already have a pending request to join '{org.name}'."
                )
            raise ConflictException(
                f"You already have a pending request to join '{pending_org.name}'. "
                "Wait for a decision before requesting another organization."
            )

        placeholder = (
            await self.db.execute(
                select(Role).where(
                    Role.org_id == org.id, Role.name == "trainee", Role.deleted_at.is_(None)
                )
            )
        ).scalar_one_or_none()
        if placeholder is None:
            raise NotFoundException("This organization is not set up to accept requests yet.")

        now = datetime.now(timezone.utc)
        # A previous (rejected / removed) membership row for the same
        # (org, user) must be REUSED: uq_org_member forbids a second row, and
        # inserting one used to raise IntegrityError -> HTTP 500 for any user
        # who had been removed and asked to rejoin.
        prior = (
            await self.db.execute(
                select(OrganizationMember).where(
                    OrganizationMember.org_id == org.id,
                    OrganizationMember.user_id == user.id,
                )
            )
        ).scalar_one_or_none()
        try:
            if prior is not None:
                prior.status = "pending"
                prior.deleted_at = None
                prior.role_id = placeholder.id
                prior.joined_at = now
                prior.reviewed_by = None
                prior.reviewed_at = None
                await self.db.flush()
            else:
                async with self.db.begin_nested():
                    self.db.add(
                        OrganizationMember(
                            org_id=org.id,
                            user_id=user.id,
                            role_id=placeholder.id,
                            status="pending",
                            joined_at=now,
                        )
                    )
        except IntegrityError:
            raise ConflictException(
                f"You already have a pending request to join '{org.name}'."
            )
        await self.db.commit()
        logger.info("join_request_created", org_id=str(org.id), user_id=str(user.id))

        await self._notify_reviewers_of_request(org, user)
        return {"org_name": org.name, "status": "pending"}

    async def _notify_reviewers_of_request(self, org: Organization, user: User) -> None:
        """Tell every admin and HR user. Best-effort: never fails the request."""
        try:
            recipients = (
                await self.db.execute(
                    select(OrganizationMember.user_id)
                    .join(Role, Role.id == OrganizationMember.role_id)
                    .join(User, User.id == OrganizationMember.user_id)
                    .where(
                        OrganizationMember.org_id == org.id,
                        OrganizationMember.status == "active",
                        OrganizationMember.deleted_at.is_(None),
                        Role.name.in_(["admin", "hr"]),
                        User.is_active.is_(True),
                    )
                )
            ).scalars().all()
            if not recipients:
                logger.warning("join_request_no_reviewers", org_id=str(org.id))
                return

            from app.services.notification_service import NotificationService

            who = user.name or user.email
            await NotificationService(self.db).notify_many(
                org_id=org.id,
                user_ids=list(recipients),
                type=NotificationType.SYSTEM,
                title=f"{who} wants to join {org.name}",
                body=(
                    f"{who} ({user.email}) asked to join '{org.name}'. Open "
                    "Members > Pending requests to accept (and choose a role) or reject."
                ),
                deep_link="/admin/members",
                email_kind="join_request_received",
                email_context={"org_name": org.name, "requester_name": who,
                               "requester_email": user.email, "cta_url": "/admin/members"},
            )
            await self.db.commit()
        except Exception as exc:
            await self.db.rollback()
            logger.warning("join_request_notify_failed", org_id=str(org.id), error=str(exc))

    # ── Reviewer side ───────────────────────────────────────────────────────

    async def list_pending(self, org_id: UUID, roles: list[str], is_superadmin: bool) -> list[dict]:
        self._require_reviewer(roles, is_superadmin)
        rows = (
            await self.db.execute(
                select(OrganizationMember, User)
                .join(User, User.id == OrganizationMember.user_id)
                .where(
                    OrganizationMember.org_id == org_id,
                    OrganizationMember.status == "pending",
                    OrganizationMember.deleted_at.is_(None),
                )
                .order_by(OrganizationMember.joined_at.asc())
            )
        ).all()
        return [
            {
                "id": str(m.id),
                "user_id": str(u.id),
                "name": u.name,
                "email": u.email,
                "avatar_url": u.avatar_url,
                "requested_at": m.joined_at.isoformat() if m.joined_at else None,
            }
            for m, u in rows
        ]

    @staticmethod
    def _require_reviewer(roles: list[str], is_superadmin: bool) -> None:
        if not _is_reviewer(roles, is_superadmin):
            raise ForbiddenException("Only an organization admin or HR can review join requests.")

    async def accept(
        self,
        *,
        actor_id: UUID,
        actor_roles: list[str],
        actor_is_superadmin: bool,
        org_id: UUID,
        request_id: UUID,
        role_id: UUID,
    ) -> dict:
        self._require_reviewer(actor_roles, actor_is_superadmin)

        role = (
            await self.db.execute(
                select(Role).where(
                    Role.id == role_id, Role.org_id == org_id, Role.deleted_at.is_(None)
                )
            )
        ).scalar_one_or_none()
        if role is None:
            raise NotFoundException("Role not found")
        if role.name in ASSIGNABLE_BY_ADMIN_ONLY:
            if not _is_main_admin(actor_roles, actor_is_superadmin):
                raise ForbiddenException("Only the Main Administrator can admit someone as HR.")
        elif role.name not in ASSIGNABLE_BY_ANYONE:
            raise ForbiddenException(
                "That role can't be assigned from a join request. Choose Worker, Trainee or HR."
            )

        decided = await self._decide(
            org_id=org_id,
            request_id=request_id,
            actor_id=actor_id,
            new_status="active",
            role_id=role.id,
        )

        # No permission-cache invalidation here any more: nothing ever read
        # that cache, so deleting the key was a no-op. Admission GRANTS
        # access, so the requester's sessions are deliberately NOT revoked -
        # their next /auth/refresh picks up the new org and role, which keeps
        # the waiting-screen to app transition silent.

        approver = await self.db.get(User, actor_id)
        approver_name = (approver.name or approver.email) if approver else "an administrator"
        await self._notify_requester(
            org_id=org_id,
            user_id=decided["user_id"],
            title=f"You've been admitted to '{decided['org_name']}'",
            body=(
                f"You have been admitted to '{decided['org_name']}' by "
                f"{approver_name}, with the role {role.name}."
            ),
            deep_link="/dashboard",
            email_kind="join_accepted",
            email_context={"org_name": decided["org_name"], "approver_name": approver_name,
                           "role": role.name, "cta_url": "/dashboard"},
        )
        logger.info("join_request_accepted", org_id=str(org_id), request_id=str(request_id), role=role.name)
        return {"status": "accepted", "user_id": str(decided["user_id"]), "role": role.name}

    async def reject(
        self,
        *,
        actor_id: UUID,
        actor_roles: list[str],
        actor_is_superadmin: bool,
        org_id: UUID,
        request_id: UUID,
    ) -> dict:
        self._require_reviewer(actor_roles, actor_is_superadmin)
        decided = await self._decide(
            org_id=org_id,
            request_id=request_id,
            actor_id=actor_id,
            new_status="rejected",
            role_id=None,
        )
        approver = await self.db.get(User, actor_id)
        approver_name = (approver.name or approver.email) if approver else "an administrator"
        await self._notify_requester(
            org_id=org_id,
            user_id=decided["user_id"],
            title=f"Your request to join '{decided['org_name']}' was not approved",
            body=(
                f"Your request to join '{decided['org_name']}' was not approved "
                f"by {approver_name}. You can contact the organization's "
                "administrators or request to join a different organization."
            ),
            deep_link="/onboarding",
            email_kind="join_rejected",
            email_context={"org_name": decided["org_name"], "approver_name": approver_name,
                           "cta_url": "/onboarding"},
        )
        logger.info("join_request_rejected", org_id=str(org_id), request_id=str(request_id))
        return {"status": "rejected", "user_id": str(decided["user_id"])}

    async def _decide(
        self,
        *,
        org_id: UUID,
        request_id: UUID,
        actor_id: UUID,
        new_status: str,
        role_id: UUID | None,
    ) -> dict:
        """
        Close a PENDING request. The conditional UPDATE is the whole
        concurrency story: it matches only while status is still 'pending', so
        exactly one of any number of simultaneous decisions can succeed.
        """
        values: dict = {
            "status": new_status,
            "reviewed_by": actor_id,
            "reviewed_at": datetime.now(timezone.utc),
        }
        if role_id is not None:
            values["role_id"] = role_id
            values["joined_at"] = datetime.now(timezone.utc)

        won = (
            await self.db.execute(
                update(OrganizationMember)
                .where(
                    OrganizationMember.id == request_id,
                    OrganizationMember.org_id == org_id,
                    OrganizationMember.status == "pending",
                    OrganizationMember.deleted_at.is_(None),
                )
                .values(**values)
                .returning(OrganizationMember.user_id)
            )
        ).scalar_one_or_none()

        if won is None:
            await self.db.rollback()
            current = (
                await self.db.execute(
                    select(OrganizationMember, User)
                    .outerjoin(User, User.id == OrganizationMember.reviewed_by)
                    .where(
                        OrganizationMember.id == request_id,
                        OrganizationMember.org_id == org_id,
                    )
                )
            ).first()
            if current is None:
                raise NotFoundException("Join request not found")
            member, reviewer = current
            who = (reviewer.name or reviewer.email) if reviewer else "another reviewer"
            verb = "accepted" if member.status == "active" else member.status
            raise ConflictException(f"This request was already {verb} by {who}.")

        org = await self.db.get(Organization, org_id)
        await self.db.commit()
        return {"user_id": won, "org_name": org.name if org else ""}

    async def _notify_requester(
        self, *, org_id: UUID, user_id: UUID, title: str, body: str, deep_link: str,
        email_kind: str = "generic", email_context: dict | None = None,
    ) -> None:
        """Email + in-app to the requester. Best-effort - the decision itself
        is already committed and must not be undone by a mail problem."""
        try:
            from app.services.notification_service import NotificationService

            await NotificationService(self.db).notify(
                org_id=org_id,
                user_id=user_id,
                type=NotificationType.SYSTEM,
                title=title,
                body=body,
                deep_link=deep_link,
                email_kind=email_kind,
                email_context=email_context,
            )
            await self.db.commit()
        except Exception as exc:
            await self.db.rollback()
            logger.warning("join_request_requester_notify_failed", user_id=str(user_id), error=str(exc))
