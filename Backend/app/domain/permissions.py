"""
DocFlow Backend — Domain: Permissions

Pure authority logic: no I/O, no DB calls. Holds

  * `AuthUser`, the authenticated caller injected into every request;
  * the account-authentication rule (`assert_can_authenticate`), shared by
    every sign-in path and by every authenticated request;
  * the definition of "is org admin" / "is admin or HR".

The header used to claim that *all* permission checks go through this module.
They did not: four functions here had no callers at all while the real
decisions were made with role-string comparisons scattered across the
services. The dead functions are gone, and the checks that can share one
definition now do.

Route-level enforcement still lives in app/dependencies.py
(`require_permission`, `require_role`, `require_main_admin`,
`require_admin_or_hr`), which is where FastAPI needs it.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from app.core.exceptions import ForbiddenException
from app.domain.enums import Permission

# ── Account authentication rule ───────────────────────────────────────────────
# ONE rule, used by every path that either turns an identity into a session or
# trusts an existing one: /auth/firebase-login and /users/me/sync (through
# AccountService.resolve_user), the legacy /auth/login, /auth/refresh and
# get_current_user.
#
# Fails CLOSED: only an explicitly allowed status passes, so a typo or a status
# value introduced elsewhere in the codebase denies access instead of granting
# it. `pending_invite` is deliberately allowed - an invited user has to be able
# to sign in to accept the invitation. `inactive` (what deactivation writes)
# and `suspended` block.

#: Statuses on `users.status` that may authenticate.
ACCOUNT_STATUS_ALLOWED: frozenset[str] = frozenset({"active", "pending_invite"})
ACCOUNT_STATUS_SUSPENDED = "suspended"

ACCOUNT_DEACTIVATED = "ACCOUNT_DEACTIVATED"
ACCOUNT_SUSPENDED = "ACCOUNT_SUSPENDED"

_BLOCK_MESSAGES = {
    ACCOUNT_SUSPENDED: "Your account has been suspended. Contact your administrator.",
    ACCOUNT_DEACTIVATED: "Your account has been deactivated. Contact your administrator.",
}


def roles_include_org_admin(roles: list[str] | None, is_superadmin: bool) -> bool:
    """Same rule as `AuthUser.is_org_admin`, for callers that hold only the
    primitives (service methods that take `actor_roles` + a flag rather than
    the AuthUser itself). Kept beside the method so the two cannot drift."""
    return is_superadmin or "admin" in (roles or [])


def account_block_code(*, is_active: bool | None, status: str | None) -> str | None:
    """None when this account may authenticate, else the error code to return."""
    normalized = (status or "").strip().lower()
    if normalized == ACCOUNT_STATUS_SUSPENDED:
        return ACCOUNT_SUSPENDED
    if is_active is not True or normalized not in ACCOUNT_STATUS_ALLOWED:
        return ACCOUNT_DEACTIVATED
    return None


def assert_can_authenticate(*, is_active: bool | None, status: str | None) -> None:
    """Raise 403 with ACCOUNT_SUSPENDED / ACCOUNT_DEACTIVATED, or return."""
    code = account_block_code(is_active=is_active, status=status)
    if code is not None:
        raise ForbiddenException(_BLOCK_MESSAGES[code], code=code)


@dataclass(frozen=True)
class AuthUser:
    """
    Authenticated user injected into every request via DI.
    Contains resolved permissions for the current org context.
    """
    id: UUID
    org_id: UUID | None
    roles: list[str]
    permissions: list[str]           # resolved permission codes
    is_superadmin: bool = False
    # Populated only by callers that already hold the membership row (chat
    # fan-out, import workers). For a request-scoped AuthUser this is None,
    # because the token carries no dept claim - template_studio_service reads
    # it, so its team-scope branch cannot match for an HTTP caller. Either
    # add the claim or change those three call sites; not decided yet.
    dept_id: UUID | None = None
    session_id: str = ""

    def has_permission(self, permission: Permission | str) -> bool:
        """Check if user has a specific permission code."""
        if self.is_superadmin:
            return True
        return str(permission) in self.permissions

    def has_any_permission(self, *permissions: Permission | str) -> bool:
        """Check if user has at least one of the given permissions."""
        return any(self.has_permission(p) for p in permissions)

    def has_all_permissions(self, *permissions: Permission | str) -> bool:
        """Check if user has ALL of the given permissions."""
        return all(self.has_permission(p) for p in permissions)

    def is_in_org(self, org_id: UUID) -> bool:
        """Check if user belongs to a specific organisation."""
        if self.is_superadmin:
            return True
        return self.org_id == org_id

    def is_org_admin(self) -> bool:
        """Main Administrator of the active organization (or a superadmin).

        THE definition. It used to be written out by hand in roughly twenty
        places, which is how "admin only" and "admin or HR" drifted apart in
        the first place. Superadmin is folded in here so the bypass is decided
        once.
        """
        return self.is_superadmin or "admin" in self.roles

    def is_admin_or_hr(self) -> bool:
        """Day-to-day org administration: Main Administrator or HR.

        Deliberately distinct from is_org_admin(): HR must NOT pass where the
        rule is "admin only, HR not allowed".
        """
        return self.is_superadmin or bool({"admin", "hr"} & set(self.roles))

    def owns(self, submitted_by: UUID) -> bool:
        """Check if user is the owner/submitter of a resource."""
        return self.id == submitted_by
