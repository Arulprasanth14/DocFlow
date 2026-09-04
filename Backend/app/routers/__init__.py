"""
DocFlow Backend — Routers Module
Exports all API routers for app registration.
"""
from app.routers import (
    admin,
    approvals,
    auth,
    chat,
    documents,
    files,
    health,
    notifications,
    organizations,
    users,
    workflows,
    ws_chat,
)

__all__ = [
    "admin",
    "approvals",
    "auth",
    "chat",
    "documents",
    "files",
    "health",
    "notifications",
    "organizations",
    "users",
    "workflows",
    "ws_chat",
]
