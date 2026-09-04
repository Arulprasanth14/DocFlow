"""
DocFlow Backend — Service: User Sync
Handles the "find-or-create user on first Firebase sign-in" flow.
Extracted from AuthService.firebase_login() so it can be used by the
new POST /users/me/sync endpoint without issuing DocFlow JWTs.

Flow:
  1. Find user by firebase_uid.
  2. If not found, try to match by email (link existing account).
  3. If still not found, create new user.
  4. Optionally create an organisation if org_name provided and user has none.
  5. Update last_seen_at.
  6. Commit and return (user, membership_data).
"""
from __future__ import annotations

import structlog
from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ForbiddenException
from app.models.organization import Organization, OrganizationMember, Role
from app.models.user import User
from app.repositories.org_repo import OrgMemberRepository, OrganizationRepository
from app.repositories.user_repo import UserRepository
from app.schemas.auth import (
    OrgMembershipResponse,
    OrganizationResponse,
    UserResponse,
)
from app.schemas.users import SyncUserResponse

logger = structlog.get_logger(__name__)


class UserSyncService:
    """
    Synchronises a Firebase-authenticated identity to the DocFlow user database.
    Does NOT issue JWT tokens — the caller (frontend) uses its Firebase ID token
    directly for subsequent API requests.
    """

    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.user_repo = UserRepository(db)
        self.org_repo = OrganizationRepository(db)
        self.member_repo = OrgMemberRepository(db)

    async def sync(
        self,
        firebase_uid: str,
        email: str,
        name: str | None,
        avatar_url: str | None,
        org_name: str | None,
    ) -> SyncUserResponse:
        """
        Find or create the DocFlow user for the given Firebase identity.
        If org_name is provided and the user has no organisation, create one.
        Returns SyncUserResponse with user profile and org membership.
        """
        # 1. Find by Firebase UID
        user = await self.user_repo.get_by_firebase_uid(firebase_uid)

        if not user:
            # 2. Try to match by email (user previously registered with password)
            user = await self.user_repo.get_by_email(email)
            if user:
                # Link Firebase UID to existing account
                user.firebase_uid = firebase_uid
                if avatar_url and not user.avatar_url:
                    user.avatar_url = avatar_url
                if name and not user.name:
                    user.name = name
                await self.db.flush()
                logger.info("firebase_uid_linked", user_id=str(user.id), email=email)
            else:
                # 3. Brand new user — create record
                user = await self.user_repo.create(
                    email=email,
                    name=name,
                    firebase_uid=firebase_uid,
                    avatar_url=avatar_url,
                )
                logger.info("user_created_via_firebase", user_id=str(user.id), email=email)
        else:
            # Existing user — update profile fields if they changed (e.g. new Google avatar)
            if name and user.name != name:
                user.name = name
            if avatar_url and user.avatar_url != avatar_url:
                user.avatar_url = avatar_url
            await self.db.flush()

        # Guard: suspended accounts
        if user.status == "suspended":
            raise ForbiddenException("Your account has been suspended. Contact your administrator.")

        # 4. Optionally create organisation
        membership_data = await self._resolve_membership(user)

        if org_name and membership_data is None:
            org = await self.org_repo.create(name=org_name)
            roles = await self.org_repo.create_default_roles(org.id)
            admin_role = roles.get("org_admin") or roles.get("super_admin")
            if admin_role:
                member = await self.member_repo.add_member(
                    org_id=org.id,
                    user_id=user.id,
                    role_id=admin_role.id,
                )
                perms = await self.member_repo.resolve_permissions(admin_role.id)
                membership_data = (member, admin_role, perms, org)
                logger.info(
                    "organisation_created",
                    user_id=str(user.id),
                    org_id=str(org.id),
                    org_name=org_name,
                )

        # 5. Touch last_seen_at
        await self.user_repo.update_last_seen(user.id)
        await self.db.commit()

        return SyncUserResponse(
            user=UserResponse.model_validate(user),
            org_membership=self._build_membership_response(membership_data),
        )

    # ── Private helpers ────────────────────────────────────────────────────────

    async def _resolve_membership(
        self, user: User
    ) -> tuple[OrganizationMember, Role, list[str], Organization] | None:
        """Load the user's primary org membership + role + permissions."""
        primary = await self.member_repo.get_first_org_for_user(user.id)
        if not primary:
            return None
        result = await self.member_repo.get_membership_with_details(user.id, primary.org_id)
        if not result:
            return None
        member, org, role, permissions = result
        return member, role, permissions, org

    def _build_membership_response(
        self, membership_data: tuple | None
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
