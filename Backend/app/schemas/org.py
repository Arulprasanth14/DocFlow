"""
DocFlow Backend — Org Pydantic Schemas
Request/response contracts for Organization, Department, Team, Role, and Member endpoints.
"""
from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field


# ── Organization ──────────────────────────────────────────────────────────────

class OrgUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=255)
    logo_url: str | None = None
    settings: dict | None = None

    model_config = {"extra": "ignore"}


class OrgResponse(BaseModel):
    id: UUID
    name: str
    slug: str
    logo_url: str | None
    plan: str
    status: str
    settings: dict
    created_at: datetime

    model_config = {"from_attributes": True}


class OrgStatsResponse(BaseModel):
    member_count: int
    department_count: int
    team_count: int
    role_count: int
    active_member_count: int


# ── Department ────────────────────────────────────────────────────────────────

class DepartmentCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    code: str | None = Field(default=None, max_length=50)
    parent_id: UUID | None = None
    head_user_id: UUID | None = None

    model_config = {"extra": "ignore"}


class DepartmentUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    code: str | None = Field(default=None, max_length=50)
    parent_id: UUID | None = None
    head_user_id: UUID | None = None

    model_config = {"extra": "ignore"}


class DepartmentResponse(BaseModel):
    id: UUID
    org_id: UUID
    parent_id: UUID | None
    name: str
    code: str | None
    head_user_id: UUID | None
    created_at: datetime
    # Children populated for tree responses
    children: list["DepartmentResponse"] = []

    model_config = {"from_attributes": True}


DepartmentResponse.model_rebuild()


# ── Team ──────────────────────────────────────────────────────────────────────

class TeamCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    dept_id: UUID | None = None

    model_config = {"extra": "ignore"}


class TeamUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    dept_id: UUID | None = None

    model_config = {"extra": "ignore"}


class TeamResponse(BaseModel):
    id: UUID
    org_id: UUID
    dept_id: UUID | None
    name: str
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Role ──────────────────────────────────────────────────────────────────────

class RoleCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=500)
    permissions: list[str] = Field(default=[])

    model_config = {"extra": "ignore"}


class RoleUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None

    model_config = {"extra": "ignore"}


class RolePermissionsRequest(BaseModel):
    """PUT /roles/{id}/permissions — replace full permission set."""
    permissions: list[str] = Field(..., description="List of permission codes to assign")


class RoleResponse(BaseModel):
    id: UUID
    org_id: UUID
    name: str
    description: str | None
    is_system: bool
    permissions: list[str]
    member_count: int = 0
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Permission Catalog ────────────────────────────────────────────────────────

class PermissionEntry(BaseModel):
    code: str
    category: str
    description: str | None = None


class PermissionCatalogResponse(BaseModel):
    permissions: list[PermissionEntry]
    by_category: dict[str, list[str]]


# ── Member / Invite ───────────────────────────────────────────────────────────

class MemberInviteRequest(BaseModel):
    email: EmailStr
    name: str | None = Field(default=None, min_length=1, max_length=255)
    role_id: UUID
    dept_id: UUID | None = None

    model_config = {"extra": "ignore"}


class MemberUpdateRequest(BaseModel):
    role_id: UUID | None = None
    dept_id: UUID | None = None
    team_id: UUID | None = None
    status: str | None = None

    model_config = {"extra": "ignore"}


class MemberUserInfo(BaseModel):
    id: UUID
    email: str
    name: str | None
    avatar_url: str | None
    status: str

    model_config = {"from_attributes": True}


class MemberRoleInfo(BaseModel):
    id: UUID
    name: str
    is_system: bool

    model_config = {"from_attributes": True}


class MemberResponse(BaseModel):
    id: UUID
    org_id: UUID
    user_id: UUID
    role_id: UUID
    dept_id: UUID | None
    team_id: UUID | None
    status: str
    joined_at: datetime
    user: MemberUserInfo | None = None
    role: MemberRoleInfo | None = None

    model_config = {"from_attributes": True}


class PaginatedMembersResponse(BaseModel):
    items: list[MemberResponse]
    total: int
    page: int
    limit: int
    pages: int


# ── Generic ───────────────────────────────────────────────────────────────────

class MessageResponse(BaseModel):
    message: str
