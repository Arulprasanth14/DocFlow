"""
DocFlow Backend — User Sync Schemas
Request/response contracts for POST /users/me/sync.
This endpoint is called by the frontend immediately after a successful
Firebase sign-in to create/update the backend user profile.
"""
from __future__ import annotations

from pydantic import BaseModel, Field

from app.schemas.auth import OrgMembershipResponse, UserResponse


class SyncUserRequest(BaseModel):
    """POST /users/me/sync — sync Firebase user to DocFlow backend profile."""
    name: str | None = Field(default=None, min_length=1, max_length=255)
    org_name: str | None = Field(
        default=None,
        min_length=2,
        max_length=255,
        description="If provided and user has no org, creates a new organisation and assigns user as admin.",
    )
    avatar_url: str | None = Field(default=None, description="Profile picture URL from Firebase (Google/Microsoft).")

    model_config = {"extra": "ignore"}


class SyncUserResponse(BaseModel):
    """Response from POST /users/me/sync."""
    user: UserResponse
    org_membership: OrgMembershipResponse | None
