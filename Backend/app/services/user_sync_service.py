"""
DocFlow Backend — Service: User Sync (POST /users/me/sync)

Thin wrapper over AccountService. This endpoint exists for ONE purpose now:
creating an organization for a signed-in user who has none (the onboarding
"Create a new organization" action). Plain sign-in goes through
/auth/firebase-login, which needs no second call.

All real logic (race-safe user resolution, state calculation, ATOMIC
organization creation, unique names) lives in AccountService so this endpoint
and /auth/firebase-login cannot disagree.
"""
from __future__ import annotations

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.organization import Organization, OrganizationMember, Role
from app.models.user import User
from app.repositories.org_repo import OrgMemberRepository, OrganizationRepository
from app.repositories.user_repo import UserRepository
from app.schemas.auth import (
    OrgMembershipResponse,
    OrganizationResponse,
    PendingRequestInfo,
    UserResponse,
)
from app.schemas.users import SyncUserResponse
from app.services.account_service import (
    HAS_ORG,
    PENDING_REQUEST,
    AccountService,
    AccountState,
)

logger = structlog.get_logger(__name__)


class UserSyncService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.user_repo = UserRepository(db)
        self.org_repo = OrganizationRepository(db)
        self.member_repo = OrgMemberRepository(db)
        self.accounts = AccountService(db)

    async def sync(
        self,
        firebase_uid: str,
        email: str,
        name: str | None,
        avatar_url: str | None,
        org_name: str | None,
        email_verified: bool = False,
    ) -> SyncUserResponse:
        """
        Find-or-create the user; if `org_name` is given and the user has no
        organization, create one atomically with the user as ADMIN.

        Idempotent: a user who already has an organization gets that
        organization back and nothing new is created.
        """
        user = await self.accounts.resolve_user(
            firebase_uid=firebase_uid,
            email=email,
            name=name,
            avatar_url=avatar_url,
            email_verified=email_verified,
        )

        if org_name:
            account = await self.accounts.create_organization(user, org_name)
        else:
            account = await self.accounts.get_account_state(user)

        await self.user_repo.update_last_seen(user.id)
        await self.db.commit()

        # Confirmation email only for an organization created by THIS call
        # (not when the user already had one), after the commit, best-effort.
        if org_name and account.state == HAS_ORG and account.membership:
            org = account.membership[3]
            if await self._created_just_now(org, user):
                await self.accounts.notify_org_created(user, org)

        return SyncUserResponse(
            user=UserResponse.model_validate(user),
            org_membership=self._build_membership_response(account.membership),
            state=account.state,
            pending_request=(
                PendingRequestInfo(
                    org_name=account.pending_org_name,
                    requested_at=account.pending_requested_at,
                )
                if account.state == PENDING_REQUEST and account.pending_org_name
                else None
            ),
        )

    async def _created_just_now(self, org: Organization, user: User) -> bool:
        """True when `org` was created in this request (its only member is the
        user and it is seconds old) - guards the 'you created X' email against
        firing on an idempotent re-call."""
        from datetime import datetime, timedelta, timezone

        created = org.created_at
        if created is None:
            return False
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) - created < timedelta(seconds=30)

    @staticmethod
    def _build_membership_response(
        membership_data: tuple | None,
    ) -> OrgMembershipResponse | None:
        if not membership_data:
            return None
        member, role, permissions, org = membership_data
        return OrgMembershipResponse(
            org_id=member.org_id,
            user_id=member.user_id,
            role_id=member.role_id,
            role_name=role.name,
            dept_id=member.dept_id,
            status=member.status,
            joined_at=member.joined_at,
            organization=OrganizationResponse.model_validate(org),
            permissions=permissions,
        )
