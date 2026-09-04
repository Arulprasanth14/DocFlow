"""
DocFlow Backend — Auth Pydantic Schemas
Request/response contracts for all authentication endpoints.
Input contracts are defined first (request), then output (response).
"""
from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field, field_validator


# ── Shared Sub-schemas ────────────────────────────────────────────────────────

class DeviceInfo(BaseModel):
    """Optional device fingerprint — stored on Session for audit."""
    user_agent: str | None = None
    platform: str | None = None
    browser: str | None = None

    model_config = {"extra": "ignore"}


# ── Request Schemas ───────────────────────────────────────────────────────────

class FirebaseLoginRequest(BaseModel):
    """POST /auth/firebase-login — exchange Firebase ID token for DocFlow JWT."""
    id_token: str = Field(..., min_length=10, description="Firebase ID token from client SDK")
    device_info: DeviceInfo | None = None


class EmailLoginRequest(BaseModel):
    """POST /auth/login — email + password login."""
    email: EmailStr
    password: str = Field(..., min_length=1)
    device_info: DeviceInfo | None = None


class RegisterRequest(BaseModel):
    """POST /auth/register — create a new user account."""
    email: EmailStr
    name: str = Field(..., min_length=1, max_length=255)
    password: str = Field(..., min_length=8, max_length=128)
    org_name: str | None = Field(
        default=None,
        min_length=2,
        max_length=255,
        description="If provided, creates a new organization and assigns user as admin"
    )
    device_info: DeviceInfo | None = None

    @field_validator("password")
    @classmethod
    def password_strength(cls, v: str) -> str:
        if not any(c.isupper() for c in v):
            raise ValueError("Password must contain at least one uppercase letter")
        if not any(c.isdigit() for c in v):
            raise ValueError("Password must contain at least one digit")
        return v


class UpdateProfileRequest(BaseModel):
    """PATCH /auth/me — update own profile fields."""
    name: str | None = Field(default=None, min_length=1, max_length=255)
    avatar_url: str | None = None
    notification_prefs: dict | None = None

    model_config = {"extra": "ignore"}


class ChangePasswordRequest(BaseModel):
    """PUT /auth/password — change own password."""
    current_password: str = Field(..., min_length=1)
    new_password: str = Field(..., min_length=8, max_length=128)

    @field_validator("new_password")
    @classmethod
    def new_password_strength(cls, v: str) -> str:
        if not any(c.isupper() for c in v):
            raise ValueError("Password must contain at least one uppercase letter")
        if not any(c.isdigit() for c in v):
            raise ValueError("Password must contain at least one digit")
        return v


# ── Response Schemas ──────────────────────────────────────────────────────────

class UserResponse(BaseModel):
    """User data returned in auth responses and /auth/me."""
    id: UUID
    email: str
    name: str | None
    avatar_url: str | None
    is_superadmin: bool
    status: str
    last_seen_at: datetime | None
    notification_prefs: dict
    created_at: datetime

    model_config = {"from_attributes": True}


class OrganizationResponse(BaseModel):
    id: UUID
    name: str
    slug: str
    logo_url: str | None
    plan: str
    status: str
    created_at: datetime

    model_config = {"from_attributes": True}


class OrgMembershipResponse(BaseModel):
    """User's membership in an organization, including resolved role + permissions."""
    org_id: UUID
    user_id: UUID
    role_id: UUID
    role_name: str
    dept_id: UUID | None
    status: str
    joined_at: datetime
    organization: OrganizationResponse
    permissions: list[str]

    model_config = {"from_attributes": True}


class SessionInfo(BaseModel):
    """A single active session — returned in /auth/sessions and /auth/me."""
    id: UUID
    device_info: dict | None
    ip_address: str | None
    created_at: datetime
    expires_at: datetime
    is_current: bool = False

    model_config = {"from_attributes": True}


class LoginResponse(BaseModel):
    """Response for successful login / register — contains access token + user context."""
    access_token: str
    token_type: str = "bearer"
    user: UserResponse
    org_membership: OrgMembershipResponse | None


class TokenRefreshResponse(BaseModel):
    """Response for POST /auth/refresh — new short-lived access token."""
    access_token: str
    token_type: str = "bearer"


class MeResponse(BaseModel):
    """Response for GET /auth/me — full current user context."""
    user: UserResponse
    org_membership: OrgMembershipResponse | None
    sessions: list[SessionInfo]


class MessageResponse(BaseModel):
    """Generic success message response."""
    message: str
