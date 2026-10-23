"""
DocFlow Backend — Service: Account resolution & organization bootstrap.

The single place that answers, for a signed-in identity:
  1. WHO is this?      -> resolve_user()          (idempotent get-or-create)
  2. WHERE do they go? -> get_account_state()     (HAS_ORG / PENDING_REQUEST / NO_ORG)
  3. Create their org  -> create_organization()   (atomic, unique name)

Used by BOTH /auth/firebase-login and /users/me/sync so the two can never
disagree. Design goals (and the bugs each one removes):

  * Idempotent. Retries, double-clicks, React StrictMode double-invocation and
    multiple tabs all call login concurrently. users.email and
    users.firebase_uid are UNIQUE, so two simultaneous first-logins used to
    make the second one raise IntegrityError -> HTTP 500. Creation now runs in
    a SAVEPOINT; on a unique violation we re-read the row the other request
    just created and carry on.

  * Never a 500 for an expected state. "No organization" and "request
    pending" are normal outcomes, returned as `state`, not errors.

  * Safe account linking. Linking an existing email-based account to a
    Firebase identity is only done when Firebase reports the email as
    VERIFIED. Without that check anyone could register a victim's address in
    Firebase (unverified) and be handed the victim's DocFlow account.

  * Atomic organization creation. Organization + 4 system roles + the
    creator's ADMIN membership are one transaction: a failure leaves nothing
    behind (previously TemplateService.create() COMMITTED part-way through,
    so a failed seed could leave a half-built organization).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from uuid import UUID

import structlog
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    ConflictException,
    ForbiddenException,
    UnprocessableEntityException,
)
from app.models.organization import Organization, OrganizationMember, Role
from app.models.user import User
from app.repositories.org_repo import OrgMemberRepository, OrganizationRepository
from app.repositories.user_repo import UserRepository

logger = structlog.get_logger(__name__)

HAS_ORG = "HAS_ORG"
PENDING_REQUEST = "PENDING_REQUEST"
NO_ORG = "NO_ORG"

ORG_NAME_MIN = 2
ORG_NAME_MAX = 100


@dataclass
class AccountState:
    state: str
    # (member, role, permissions, org) when state == HAS_ORG
    membership: tuple | None = None
    pending_org_name: str | None = None
    pending_requested_at: object | None = None


def normalize_org_name(raw: str) -> str:
    """Trim and collapse internal whitespace so 'Acme  Inc ' == 'Acme Inc'."""
    return re.sub(r"\s+", " ", (raw or "").strip())


def validate_org_name(raw: str) -> str:
    name = normalize_org_name(raw)
    if len(name) < ORG_NAME_MIN:
        raise UnprocessableEntityException(
            f"Organization name must be at least {ORG_NAME_MIN} characters."
        )
    if len(name) > ORG_NAME_MAX:
        raise UnprocessableEntityException(
            f"Organization name must be at most {ORG_NAME_MAX} characters."
        )
    return name


class AccountService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.user_repo = UserRepository(db)
        self.org_repo = OrganizationRepository(db)
        self.member_repo = OrgMemberRepository(db)

    # ── 1. Identity ─────────────────────────────────────────────────────────

    async def resolve_user(
        self,
        *,
        firebase_uid: str,
        email: str,
        name: str | None,
        avatar_url: str | None,
        email_verified: bool,
    ) -> User:
        email = (email or "").strip().lower()
        if not email:
            # An SSO account that exposes no email can't be mapped to a
            # DocFlow user. A clear 4xx beats the 500 a NOT NULL violation
            # would have produced.
            raise UnprocessableEntityException(
                "Your sign-in provider did not share an email address, so "
                "DocFlow can't create your account. Use a provider or account "
                "that has an email."
            )

        user = await self.user_repo.get_by_firebase_uid(firebase_uid)
        if user is None:
            user = await self._link_or_create(
                firebase_uid, email, name, avatar_url, email_verified
            )
        else:
            self._refresh_profile(user, name, avatar_url)

        if user.status == "suspended":
            raise ForbiddenException("Your account has been suspended. Contact your administrator.")
        await self.db.flush()
        return user

    @staticmethod
    def _refresh_profile(user: User, name: str | None, avatar_url: str | None) -> None:
        if name and not user.name:
            user.name = name
        if avatar_url and user.avatar_url != avatar_url:
            user.avatar_url = avatar_url

    async def _link_or_create(
        self,
        firebase_uid: str,
        email: str,
        name: str | None,
        avatar_url: str | None,
        email_verified: bool,
    ) -> User:
        existing = await self.user_repo.get_by_email(email)
        if existing is not None:
            return await self._link_existing(existing, firebase_uid, name, avatar_url, email_verified)

        # Brand-new user. SAVEPOINT so a concurrent first-login that wins the
        # race only rolls back THIS insert, not the whole request.
        try:
            async with self.db.begin_nested():
                user = await self.user_repo.create(
                    email=email, name=name, firebase_uid=firebase_uid, avatar_url=avatar_url
                )
            logger.info("user_created", user_id=str(user.id))
            return user
        except IntegrityError:
            logger.info("user_create_race_resolved", email=email)
            winner = (
                await self.user_repo.get_by_firebase_uid(firebase_uid)
                or await self.user_repo.get_by_email(email)
            )
            if winner is None:
                raise
            if winner.firebase_uid and winner.firebase_uid != firebase_uid:
                return await self._link_existing(winner, firebase_uid, name, avatar_url, email_verified)
            return winner

    async def _link_existing(
        self,
        existing: User,
        firebase_uid: str,
        name: str | None,
        avatar_url: str | None,
        email_verified: bool,
    ) -> User:
        if existing.firebase_uid == firebase_uid:
            self._refresh_profile(existing, name, avatar_url)
            return existing

        if not email_verified:
            logger.warning("account_link_refused_unverified_email", user_id=str(existing.id))
            raise ForbiddenException(
                "An account with this email already exists. Verify your email "
                "address with your sign-in provider, then try again."
            )

        existing.firebase_uid = firebase_uid
        self._refresh_profile(existing, name, avatar_url)
        logger.info("firebase_uid_linked", user_id=str(existing.id))
        return existing

    # ── 2. State ────────────────────────────────────────────────────────────

    async def get_account_state(self, user: User) -> AccountState:
        membership = await self.member_repo.get_primary_membership_details(user.id)
        if membership is not None:
            member, org, role, permissions = membership
            return AccountState(HAS_ORG, membership=(member, role, permissions, org))

        pending = (
            await self.db.execute(
                select(OrganizationMember, Organization)
                .join(Organization, Organization.id == OrganizationMember.org_id)
                .where(
                    OrganizationMember.user_id == user.id,
                    OrganizationMember.status == "pending",
                    OrganizationMember.deleted_at.is_(None),
                    Organization.deleted_at.is_(None),
                )
                .order_by(OrganizationMember.joined_at.desc())
                .limit(1)
            )
        ).first()
        if pending is not None:
            member, org = pending
            return AccountState(
                PENDING_REQUEST,
                pending_org_name=org.name,
                pending_requested_at=member.joined_at,
            )
        return AccountState(NO_ORG)

    # ── 3. Organization bootstrap ───────────────────────────────────────────

    async def is_org_name_available(self, raw_name: str) -> tuple[bool, str]:
        """Case-insensitive, whitespace-normalised availability check."""
        name = normalize_org_name(raw_name)
        if len(name) < ORG_NAME_MIN:
            return False, f"Organization name must be at least {ORG_NAME_MIN} characters."
        if len(name) > ORG_NAME_MAX:
            return False, f"Organization name must be at most {ORG_NAME_MAX} characters."
        taken = (
            await self.db.execute(
                select(func.count())
                .select_from(Organization)
                .where(
                    func.lower(Organization.name) == name.lower(),
                    Organization.deleted_at.is_(None),
                )
            )
        ).scalar_one()
        if taken:
            return False, "An organization with this name already exists."
        return True, ""

    async def create_organization(self, user: User, raw_name: str) -> AccountState:
        """
        Create an organization with `user` as its ADMIN — atomically.

        Idempotent: if the user already belongs to an organization that
        organization is returned and NOTHING new is created, so a retry or a
        second tab can never produce a second organization.
        """
        name = validate_org_name(raw_name)

        current = await self.get_account_state(user)
        if current.state == HAS_ORG:
            return current
        if current.state == PENDING_REQUEST:
            raise ConflictException(
                f"You already have a pending request to join "
                f"'{current.pending_org_name}'. Wait for a decision before "
                "creating an organization."
            )

        available, reason = await self.is_org_name_available(name)
        if not available:
            raise ConflictException(reason)

        try:
            async with self.db.begin_nested():
                org = await self.org_repo.create(name=name)
                roles = await self.org_repo.create_default_roles(org.id)
                admin_role: Role = roles["admin"]
                member = await self.member_repo.add_member(
                    org_id=org.id, user_id=user.id, role_id=admin_role.id
                )
                await self._seed_default_setup(org.id, user.id)
        except IntegrityError as exc:
            # Lost a race on the unique org name/slug (or a second tab won).
            logger.info("organization_create_conflict", org_name=name, error=str(exc.orig)[:120])
            again = await self.get_account_state(user)
            if again.state == HAS_ORG:
                return again
            raise ConflictException("An organization with this name already exists.") from exc

        permissions = await self.member_repo.resolve_permissions(admin_role.id)
        logger.info("organisation_created", user_id=str(user.id), org_id=str(org.id), org_name=name)
        return AccountState(HAS_ORG, membership=(member, admin_role, permissions, org))

    async def _seed_default_setup(self, org_id: UUID, admin_user_id: UUID) -> None:
        """
        Minimal usable defaults (one document type + one workflow).

        Runs in its OWN savepoint inside the organization transaction: if
        seeding fails the organization, roles and ADMIN membership are
        unaffected (defaults are a convenience, not required for correctness),
        and nothing is committed part-way — TemplateService.create(commit=
        False) leaves the commit to the caller.
        """
        from app.repositories.document_repo import DocumentTypeRepository
        from app.schemas.workflow_instances import (
            StageApproverRuleCreate,
            WorkflowStageCreate,
            WorkflowTemplateCreate,
        )
        from app.services.template_service import TemplateService

        try:
            async with self.db.begin_nested():
                await DocumentTypeRepository(self.db).create(
                    org_id=org_id,
                    name="General Document",
                    code="general_document",
                    description="A general-purpose document type. Add more specific types anytime in Doc Types settings.",
                    category="General",
                    icon="file",
                    color="blue",
                    form_schema=[],
                )
                await TemplateService(self.db).create(
                    org_id=org_id,
                    req=WorkflowTemplateCreate(
                        name="Standard Approval",
                        description="A single-stage approval routed to you by default. Edit it in Workflows settings to add real approvers.",
                        stages=[
                            WorkflowStageCreate(
                                name="Review & Approve",
                                sequence_order=1,
                                approver_rules=[
                                    StageApproverRuleCreate(
                                        rule_type="specific_user",
                                        rule_value={"user_id": str(admin_user_id)},
                                    )
                                ],
                            )
                        ],
                    ),
                    created_by=admin_user_id,
                    commit=False,
                )
        except Exception as exc:
            logger.warning("default_setup_seed_failed", org_id=str(org_id), error=str(exc))

    async def notify_org_created(self, user: User, org: Organization) -> None:
        """
        Email + in-app confirmation. Strictly best-effort: a mail/queue
        failure is logged and swallowed — it must never fail org creation,
        which has already been committed by the time this runs.
        """
        try:
            from app.domain.enums import NotificationType
            from app.services.notification_service import NotificationService

            await NotificationService(self.db).notify(
                org_id=org.id,
                user_id=user.id,
                type=NotificationType.SYSTEM,
                title=f"You created the organization '{org.name}'",
                body=(
                    f"You created the organization '{org.name}'. You are the "
                    "admin of this organization. Thank you for choosing DocFlow."
                ),
                deep_link="/admin/organization",
                email_kind="org_created",
                email_context={"org_name": org.name, "cta_url": "/dashboard"},
            )
            await self.db.commit()
        except Exception as exc:
            await self.db.rollback()
            logger.warning("org_created_notification_failed", org_id=str(org.id), error=str(exc))
