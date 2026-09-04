"""
DocFlow Backend — Domain: Permissions
Pure permission evaluation logic — no I/O, no DB calls.
All permission checks ultimately call functions in this module.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from app.domain.enums import Permission


@dataclass(frozen=True)
class AuthUser:
    """
    Authenticated user injected into every request via DI.
    Contains resolved permissions for the current org context.
    """
    id: UUID
    email: str
    org_id: UUID | None
    roles: list[str]
    permissions: list[str]           # resolved permission codes
    is_superadmin: bool = False
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

    def is_in_dept(self, dept_id: UUID) -> bool:
        """Check if user belongs to a specific department."""
        return self.dept_id == dept_id

    def owns(self, submitted_by: UUID) -> bool:
        """Check if user is the owner/submitter of a resource."""
        return self.id == submitted_by


def evaluate_permission(
    user: AuthUser,
    permission: Permission | str,
    *,
    resource_org_id: UUID | None = None,
    resource_owner_id: UUID | None = None,
    resource_dept_id: UUID | None = None,
) -> bool:
    """
    Full permission evaluation:
    1. Superadmin bypasses all checks
    2. Org scope: user must belong to same org as resource
    3. Permission check: user must have the permission code
    4. Optional ownership check (caller decides if needed)

    Returns True if access is granted.
    """
    # Superadmin bypass
    if user.is_superadmin:
        return True

    # Org scope check
    if resource_org_id and not user.is_in_org(resource_org_id):
        return False

    # Permission check
    if not user.has_permission(permission):
        return False

    return True


def can_access_document(
    user: AuthUser,
    doc_org_id: UUID,
    doc_submitted_by: UUID,
    doc_dept_id: UUID | None = None,
) -> bool:
    """
    Check if a user can READ a specific document.
    Rules:
    - Superadmin: always
    - Same org + documents:read permission: yes
    - Submitter can always see their own docs
    """
    if user.is_superadmin:
        return True
    if not user.is_in_org(doc_org_id):
        return False
    if user.owns(doc_submitted_by):
        return True
    return user.has_permission(Permission.DOCUMENTS_READ)


def can_approve_step(
    user: AuthUser,
    assigned_user_id: UUID | None,
    assigned_role_id: UUID | None,
    user_role_ids: list[UUID],
    delegated_to: UUID | None = None,
) -> bool:
    """
    Check if a user is authorised to decide on a workflow step.
    Rules:
    - Directly assigned user
    - User has the assigned role
    - Step was delegated to this user
    """
    if user.is_superadmin:
        return True
    if assigned_user_id and user.id == assigned_user_id:
        return True
    if assigned_role_id and assigned_role_id in user_role_ids:
        return True
    if delegated_to and user.id == delegated_to:
        return True
    return False


def resolve_permissions_for_roles(role_permissions: dict[str, list[str]]) -> list[str]:
    """
    Merge all permissions from a list of roles into a flat deduplicated list.
    role_permissions: {role_name: [permission_code, ...]}
    """
    merged: set[str] = set()
    for perms in role_permissions.values():
        merged.update(perms)
    return sorted(merged)
