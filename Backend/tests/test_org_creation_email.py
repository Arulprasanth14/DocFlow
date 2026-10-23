"""
Covers UserSyncService.sync() now notifying the org creator (it previously
created the org and seeded defaults but never sent any notification/email).

Mocks at the NotificationService.notify boundary rather than all the way
down to Celery's send_email.delay: NotificationService's own email dispatch
(fire-and-forget asyncio task against the *production* session factory) is
pre-existing, separately-tested-by-construction infrastructure — what this
phase actually changed is that org creation now calls it at all.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock

from app.domain.enums import NotificationType
from app.services.user_sync_service import UserSyncService


async def test_org_creation_notifies_the_creator(db_session, monkeypatch):
    mock_notify = AsyncMock(return_value=None)
    monkeypatch.setattr(
        "app.services.notification_service.NotificationService.notify", mock_notify
    )

    svc = UserSyncService(db_session)
    org_name = f"Acme {uuid.uuid4().hex[:6]}"
    result = await svc.sync(
        firebase_uid=f"fb-{uuid.uuid4().hex[:10]}",
        email="founder@example.com",
        name="Founder",
        avatar_url=None,
        org_name=org_name,
    )

    assert result.org_membership is not None
    assert result.org_membership.role_name == "admin"

    mock_notify.assert_awaited_once()
    _, kwargs = mock_notify.call_args
    assert kwargs["user_id"] == result.user.id
    assert kwargs["org_id"] == result.org_membership.org_id
    assert kwargs["type"] == NotificationType.SYSTEM
    assert org_name in kwargs["title"]


async def test_org_creation_still_succeeds_if_notification_fails(db_session, monkeypatch):
    """Best-effort: a notification failure must never break org creation."""
    monkeypatch.setattr(
        "app.services.notification_service.NotificationService.notify",
        AsyncMock(side_effect=RuntimeError("boom")),
    )

    svc = UserSyncService(db_session)
    result = await svc.sync(
        firebase_uid=f"fb-{uuid.uuid4().hex[:10]}",
        email="founder2@example.com",
        name="Founder Two",
        avatar_url=None,
        org_name=f"Beta {uuid.uuid4().hex[:6]}",
    )
    assert result.org_membership is not None
    assert result.org_membership.role_name == "admin"
