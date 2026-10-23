"""
DocFlow Backend — Routers Module
Exports all API routers for app registration.
"""
from app.routers import (
    admin,
    agent,
    approvals,
    auth,
    chat,
    documents,
    files,
    health,
    notifications,
    organizations,
    search,
    users,
    workflows,
    ws_chat,
)

__all__ = [
    "admin",
    "agent",
    "approvals",
    "auth",
    "chat",
    "documents",
    "files",
    "health",
    "notifications",
    "organizations",
    "search",
    "users",
    "workflows",
    "ws_chat",
]
