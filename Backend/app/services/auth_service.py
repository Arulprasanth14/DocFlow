"""
DocFlow Backend — Service: Authentication
Full business logic for auth: Firebase login, email login, register,
refresh, logout, session management, password change.

Firebase is MANDATORY — Google, Microsoft, and Email/Password auth
all flow through Firebase identity verification.

Architecture:
  Firebase ID token → verify_firebase_token() → find/create user → issue DocFlow JWT
  Email/Password → Firebase cannot verify email auth server-side without custom flow
    → We support email/password directly (passlib bcrypt) as an alternative path,
      but the primary flows are Google + Microsoft + Firebase Email/Password.
"""
from __future__ import annotations

import structlog
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    ConflictException,
    ForbiddenException,
    NotFoundException,
    UnauthorizedException,
)
from app.core.firebase import FirebaseUnavailableError, verify_firebase_token
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    generate_session_id,
    hash_password,
    verify_password,
)
from app.models.organization import Organization, OrganizationMember, Role
from app.models.user import Session, User
from app.repositories.org_repo import OrgMemberRepository, OrganizationRepository
from app.repositories.user_repo import SessionRepository, UserRepository
from app.services.account_service import (
    HAS_ORG,
    NO_ORG,
    PENDING_REQUEST,
    AccountService,
    AccountState,
)
from app.schemas.auth import (
    LoginResponse,
    MeResponse,
    OrgMembershipResponse,
    OrganizationResponse,
    PendingRequestInfo,
    SessionInfo,
    TokenRefreshResponse,
    UserResponse,
)

logger = structlog.get_logger(__name__)


class AuthService:
    """
    Authentication service — coordinates repositories to implement all auth flows.
    All methods accept db: AsyncSession and commit at the end.
    """

    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.user_repo = UserRepository(db)
        self.session_repo = SessionRepository(db)
        self.org_repo = OrganizationRepository(db)
        self.member_repo = OrgMemberRepository(db)

    # ── Firebase Login (Google / Microsoft / Firebase Email) ──────────────────

    async def firebase_login(
        self,
        id_token: str,
        device_info: dict | None,
        ip_address: str | None,
    ) -> LoginResponse:
        """
        Verify a Firebase ID token (Google, Microsoft, or Firebase
        Email/Password), find-or-create the DocFlow user, and issue tokens.

        Idempotent and safe to call concurrently (retries, double-clicks,
        StrictMode, several tabs): user creation is race-safe (see
        AccountService.resolve_user) and "no organization" / "request
        pending" are returned as `state`, never raised as errors.
        """
        # 1. Verify Firebase token
        try:
            firebase_claims = await verify_firebase_token(id_token)
        except ValueError as exc:
            raise UnauthorizedException(f"Firebase token invalid: {exc}") from exc
        except FirebaseUnavailableError as exc:
            from app.core.exceptions import ServiceUnavailableException

            raise ServiceUnavailableException("Sign-in") from exc

        # 2. Resolve the user (race-safe get-or-create; verified-email linking)
        accounts = AccountService(self.db)
        user = await accounts.resolve_user(
            firebase_uid=firebase_claims["uid"],
            email=firebase_claims.get("email", ""),
            name=firebase_claims.get("name"),
            avatar_url=firebase_claims.get("picture"),
            email_verified=bool(firebase_claims.get("email_verified", False)),
        )

        # 3. HAS_ORG / PENDING_REQUEST / NO_ORG
        account = await accounts.get_account_state(user)

        # 4. Session + tokens
        response = await self._issue_session(user, account, device_info, ip_address)
        logger.info(
            "firebase_login_success",
            user_id=str(user.id),
            state=account.state,
            provider=firebase_claims.get("sign_in_provider"),
        )
        return response

    async def _issue_session(
        self,
        user: User,
        account: "AccountState",
        device_info: dict | None,
        ip_address: str | None,
    ) -> LoginResponse:
        membership_data = account.membership
        session_id = generate_session_id()
        await self.session_repo.create(
            user_id=user.id,
            session_token=session_id,
            device_info=device_info,
            ip_address=ip_address,
        )
        access_token = create_access_token(
            user_id=user.id,
            org_id=membership_data[0].org_id if membership_data else None,
            roles=[membership_data[1].name] if membership_data else [],
            permissions=membership_data[2] if membership_data else [],
            session_id=session_id,
            is_superadmin=user.is_superadmin,
        )
        await self.user_repo.update_last_seen(user.id)
        await self.db.commit()
        return self._build_login_response(
            access_token=access_token,
            user=user,
            membership_data=membership_data,
            account=account,
        )

    # ── Email / Password Login (direct bcrypt — no Firebase for this path) ────

    async def email_login(
        self,
        email: str,
        password: str,
        device_info: dict | None,
        ip_address: str | None,
    ) -> LoginResponse:
        """
        Authenticate with email + password using bcrypt verification.
        Note: For Google/Microsoft sign-in, use firebase_login instead.
        """
        user = await self.user_repo.get_by_email(email.strip().lower())

        if not user:
            # Run bcrypt verify to prevent timing attacks
            verify_password("dummy", "$2b$12$dummyhashfortimingprotection12345678")
            raise UnauthorizedException("No account found with this email. Please sign up first.")

        if not user.password_hash:
            verify_password("dummy", "$2b$12$dummyhashfortimingprotection12345678")
            raise UnauthorizedException("This account uses social login (Google/Microsoft). Please sign in with that provider.")

        if not verify_password(password, user.password_hash):
            raise UnauthorizedException("Incorrect password. Please try again or use forgot password.")

        if user.status == "suspended":
            raise ForbiddenException("Your account has been suspended")

        accounts = AccountService(self.db)
        account = await accounts.get_account_state(user)
        response = await self._issue_session(user, account, device_info, ip_address)
        logger.info("email_login_success", user_id=str(user.id), state=account.state)
        return response

    # ── Register ──────────────────────────────────────────────────────────────

    async def register(
        self,
        email: str,
        name: str,
        password: str,
        org_name: str | None,
        device_info: dict | None,
        ip_address: str | None,
    ) -> LoginResponse:
        """
        Create a new user account with email/password.
        Optionally creates an organization and assigns the user as admin.
        """
        email = email.strip().lower()
        existing = await self.user_repo.get_by_email(email)
        if existing:
            raise ConflictException("An account with this email already exists")

        accounts = AccountService(self.db)
        user = await self.user_repo.create(
            email=email,
            name=name,
            password_hash=hash_password(password),
        )

        account = AccountState(NO_ORG)
        if org_name:
            # Atomic: org + roles + ADMIN membership, or nothing (and the
            # unique-name rule applies here too).
            account = await accounts.create_organization(user, org_name)

        response = await self._issue_session(user, account, device_info, ip_address)
        if org_name and account.membership:
            await accounts.notify_org_created(user, account.membership[3])
        logger.info("register_success", user_id=str(user.id), state=account.state)
        return response

    # ── Token Refresh ─────────────────────────────────────────────────────────

    async def refresh_token(self, refresh_token: str) -> TokenRefreshResponse:
        """
        Validate refresh token from HttpOnly cookie, extend session, issue new access token.
        """
        try:
            payload = decode_token(refresh_token)
        except UnauthorizedException as exc:
            raise UnauthorizedException(f"Invalid refresh token: {exc}") from exc

        if payload.get("type") != "refresh":
            raise UnauthorizedException("Not a refresh token")

        session_token: str = payload.get("jti", "")
        session = await self.session_repo.get_by_token(session_token)
        if not session or not session.is_valid:
            raise UnauthorizedException("Session expired or revoked")

        user_id = UUID(payload["sub"])
        user = await self.user_repo.get_by_id(user_id)
        if not user or user.status == "suspended":
            raise UnauthorizedException("User not found or suspended")

        # Reload membership + permissions for fresh access token
        membership_data = await self._resolve_membership(user)
        org_id = membership_data[0].org_id if membership_data else None
        roles = [membership_data[1].name] if membership_data else []
        permissions = membership_data[2] if membership_data else []

        # Extend session TTL
        await self.session_repo.extend_expiry(session_token)

        access_token = create_access_token(
            user_id=user.id,
            org_id=org_id,
            roles=roles,
            permissions=permissions,
            session_id=session_token,
            is_superadmin=user.is_superadmin,
        )

        await self.db.commit()
        return TokenRefreshResponse(access_token=access_token)

    # ── Logout ────────────────────────────────────────────────────────────────

    async def logout(self, session_id: str) -> None:
        """Revoke the current session."""
        await self.session_repo.revoke(session_id)
        await self.db.commit()
        logger.info("logout", session_id=session_id)

    async def logout_all(self, user_id: UUID) -> None:
        """Revoke all sessions for a user (sign out all devices)."""
        await self.session_repo.revoke_all(user_id)
        await self.db.commit()
        logger.info("logout_all", user_id=str(user_id))

    # ── Profile ───────────────────────────────────────────────────────────────

    async def get_me(self, user_id: UUID, current_session_token: str) -> MeResponse:
        """Return full user context: user profile + membership + active sessions."""
        user = await self.user_repo.get_by_id(user_id)
        if not user:
            raise NotFoundException("User not found")

        membership_data = await self._resolve_membership(user)
        sessions = await self.session_repo.list_active(user_id)

        session_infos = [
            SessionInfo(
                id=s.id,
                device_info=s.device_info,
                ip_address=str(s.ip_address) if s.ip_address else None,
                created_at=s.created_at,
                expires_at=s.expires_at,
                is_current=(s.session_token == current_session_token),
            )
            for s in sessions
        ]

        return MeResponse(
            user=UserResponse.model_validate(user),
            org_membership=self._build_membership_response(membership_data),
            sessions=session_infos,
        )

    async def update_profile(
        self,
        user_id: UUID,
        name: str | None,
        avatar_url: str | None,
        notification_prefs: dict | None,
    ) -> UserResponse:
        user = await self.user_repo.update_profile(
            user_id,
            name=name,
            avatar_url=avatar_url,
            notification_prefs=notification_prefs,
        )
        if not user:
            raise NotFoundException("User not found")
        await self.db.commit()
        return UserResponse.model_validate(user)

    async def change_password(
        self,
        user_id: UUID,
        current_password: str,
        new_password: str,
    ) -> None:
        """
        Verify current password, set new hash, revoke all sessions.
        User must re-login after password change.
        """
        user = await self.user_repo.get_by_id(user_id)
        if not user:
            raise NotFoundException("User not found")

        if not user.password_hash:
            raise ForbiddenException(
                "Account uses social login — password change not available"
            )

        if not verify_password(current_password, user.password_hash):
            raise UnauthorizedException("Current password is incorrect")

        new_hash = hash_password(new_password)
        await self.user_repo.update_password(user_id, new_hash)
        await self.session_repo.revoke_all(user_id)
        await self.db.commit()
        logger.info("password_changed", user_id=str(user_id))

    async def revoke_session(self, session_id: UUID, requesting_user_id: UUID) -> None:
        """Revoke a specific session — only allowed by the session owner."""
        session = await self.session_repo.get_by_id(session_id)
        if not session:
            raise NotFoundException("Session not found")
        if session.user_id != requesting_user_id:
            raise ForbiddenException("Cannot revoke another user's session")
        await self.session_repo.revoke_by_id(session_id)
        await self.db.commit()

    # ── Private Helpers ───────────────────────────────────────────────────────

    async def _resolve_membership(
        self, user: User
    ) -> tuple[OrganizationMember, Role, list[str], Organization] | None:
        """The user's primary ACTIVE membership + role + permissions."""
        result = await self.member_repo.get_primary_membership_details(user.id)
        if not result:
            return None
        member, org, role, permissions = result
        return member, role, permissions, org

    def _build_login_response(
        self,
        access_token: str,
        user: User,
        membership_data: tuple | None,
        account: "AccountState | None" = None,
    ) -> LoginResponse:
        state = account.state if account else (HAS_ORG if membership_data else NO_ORG)
        pending = (
            PendingRequestInfo(
                org_name=account.pending_org_name,
                requested_at=account.pending_requested_at,
            )
            if account and account.state == PENDING_REQUEST and account.pending_org_name
            else None
        )
        return LoginResponse(
            access_token=access_token,
            user=UserResponse.model_validate(user),
            org_membership=self._build_membership_response(membership_data),
            state=state,
            pending_request=pending,
        )

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
