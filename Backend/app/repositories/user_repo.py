"""
DocFlow Backend — Repository: Users & Sessions
Data access layer for User and Session models.
All methods are async; session is injected via FastAPI DI.
No business logic here — pure DB read/write.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import and_, delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import Session, User
from app.config import settings


class UserRepository:
    """Data access for the users table."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def get_by_id(self, user_id: UUID) -> User | None:
        result = await self.db.execute(
            select(User).where(User.id == user_id, User.deleted_at.is_(None))
        )
        return result.scalar_one_or_none()

    async def get_by_email(self, email: str) -> User | None:
        result = await self.db.execute(
            select(User).where(User.email == email.lower(), User.deleted_at.is_(None))
        )
        return result.scalar_one_or_none()

    async def get_by_firebase_uid(self, uid: str) -> User | None:
        result = await self.db.execute(
            select(User).where(User.firebase_uid == uid, User.deleted_at.is_(None))
        )
        return result.scalar_one_or_none()

    async def create(
        self,
        email: str,
        name: str | None = None,
        firebase_uid: str | None = None,
        password_hash: str | None = None,
        avatar_url: str | None = None,
    ) -> User:
        user = User(
            email=email.lower(),
            name=name,
            firebase_uid=firebase_uid,
            password_hash=password_hash,
            avatar_url=avatar_url,
            status="active",
        )
        self.db.add(user)
        await self.db.flush()   # get ID without committing
        return user

    async def update_profile(
        self,
        user_id: UUID,
        *,
        name: str | None = None,
        avatar_url: str | None = None,
        notification_prefs: dict | None = None,
    ) -> User | None:
        user = await self.get_by_id(user_id)
        if not user:
            return None
        if name is not None:
            user.name = name
        if avatar_url is not None:
            user.avatar_url = avatar_url
        if notification_prefs is not None:
            user.notification_prefs = notification_prefs
        await self.db.flush()
        return user

    async def update_password(self, user_id: UUID, password_hash: str) -> None:
        await self.db.execute(
            update(User)
            .where(User.id == user_id)
            .values(password_hash=password_hash)
        )
        await self.db.flush()

    async def update_last_seen(self, user_id: UUID) -> None:
        await self.db.execute(
            update(User)
            .where(User.id == user_id)
            .values(last_seen_at=datetime.now(timezone.utc))
        )


class SessionRepository:
    """Data access for the sessions table."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def create(
        self,
        user_id: UUID,
        session_token: str,
        device_info: dict | None,
        ip_address: str | None,
        *,
        org_id: UUID | None = None,
        user_agent: str | None = None,
        family_id: UUID | None = None,
        expires_at: datetime | None = None,
    ) -> Session:
        """A new session row.

        `family_id=None` means this is a login, so the row starts its own
        family (set to its own id once flushed). `expires_at` is passed only
        by rotation, which carries the family's original expiry forward so the
        family cannot outlive the 30-day cap by rotating.
        """
        if expires_at is None:
            expires_at = datetime.now(timezone.utc) + timedelta(
                days=settings.REFRESH_TOKEN_EXPIRE_DAYS
            )
        session = Session(
            user_id=user_id,
            session_token=session_token,
            device_info=device_info,
            ip_address=ip_address,
            user_agent=user_agent,
            org_id=org_id,
            family_id=family_id,
            expires_at=expires_at,
        )
        self.db.add(session)
        await self.db.flush()
        if session.family_id is None:
            session.family_id = session.id
            await self.db.flush()
        return session

    async def rotate(
        self, session: Session, *, new_token: str, ip_address: str | None = None
    ) -> Session | None:
        """Mark `session` rotated and insert its successor. Atomic.

        The UPDATE carries `rotated_at IS NULL` so two concurrent refreshes
        cannot both rotate the same row: the loser gets no row back and is
        handled as a reuse (grace window or theft), never as a second
        successor.
        """
        now = datetime.now(timezone.utc)
        claimed = await self.db.execute(
            update(Session)
            .where(Session.id == session.id, Session.rotated_at.is_(None))
            .values(rotated_at=now, last_used_at=now)
            .returning(Session.id)
        )
        if claimed.scalar_one_or_none() is None:
            return None

        successor = await self.create(
            user_id=session.user_id,
            session_token=new_token,
            device_info=session.device_info,
            ip_address=ip_address or (str(session.ip_address) if session.ip_address else None),
            org_id=session.org_id,
            user_agent=session.user_agent,
            family_id=session.family_id or session.id,
            # The family's original expiry: rotation must not extend it.
            expires_at=session.expires_at,
        )
        await self.db.execute(
            update(Session)
            .where(Session.id == session.id)
            .values(replaced_by=successor.id)
        )
        await self.db.flush()
        return successor

    async def get_any_by_token(self, session_token: str) -> Session | None:
        """By token, ignoring revocation and rotation - for reuse detection,
        which has to see the rows the normal lookup hides."""
        result = await self.db.execute(
            select(Session).where(Session.session_token == session_token)
        )
        return result.scalar_one_or_none()

    async def revoke_family(self, family_id: UUID, *, reason: str) -> int:
        """Kill every session in a family. Used when a refresh token is
        replayed: the holder of the original is not trustworthy either."""
        result = await self.db.execute(
            update(Session)
            .where(Session.family_id == family_id, Session.revoked_at.is_(None))
            .values(revoked_at=datetime.now(timezone.utc), revoked_reason=reason)
        )
        await self.db.flush()
        return result.rowcount or 0

    async def delete_expired_before(self, cutoff: datetime) -> int:
        """Hard-delete sessions that expired before `cutoff` (nightly job)."""
        result = await self.db.execute(
            delete(Session).where(Session.expires_at < cutoff)
        )
        await self.db.flush()
        return result.rowcount or 0

    async def get_by_token(
        self, session_token: str, user_id: UUID | None = None
    ) -> Session | None:
        """Look up a live session by its token.

        `user_id` binds the session to the user the token claims to be
        (`sub`). Callers that hold a user id should always pass it: a lookup
        by token alone accepts any live session id for any user.
        """
        conditions = [
            Session.session_token == session_token,
            Session.revoked_at.is_(None),
        ]
        if user_id is not None:
            conditions.append(Session.user_id == user_id)
        result = await self.db.execute(select(Session).where(*conditions))
        return result.scalar_one_or_none()

    async def get_by_id(self, session_id: UUID) -> Session | None:
        result = await self.db.execute(
            select(Session).where(Session.id == session_id)
        )
        return result.scalar_one_or_none()

    async def list_active(self, user_id: UUID) -> list[Session]:
        result = await self.db.execute(
            select(Session).where(
                Session.user_id == user_id,
                Session.revoked_at.is_(None),
                Session.expires_at > datetime.now(timezone.utc),
            )
        )
        return list(result.scalars().all())

    async def revoke(self, session_token: str, *, reason: str = "logout") -> None:
        await self.db.execute(
            update(Session)
            .where(Session.session_token == session_token)
            .values(revoked_at=datetime.now(timezone.utc), revoked_reason=reason)
        )
        await self.db.flush()

    async def revoke_by_id(self, session_id: UUID) -> None:
        await self.db.execute(
            update(Session)
            .where(Session.id == session_id)
            .values(revoked_at=datetime.now(timezone.utc))
        )
        await self.db.flush()

    async def revoke_all(self, user_id: UUID, *, reason: str = "admin") -> None:
        """Revoke every active session for a user (sign out all devices)."""
        await self.db.execute(
            update(Session)
            .where(
                Session.user_id == user_id,
                Session.revoked_at.is_(None),
            )
            .values(revoked_at=datetime.now(timezone.utc), revoked_reason=reason)
        )
        await self.db.flush()

    async def extend_expiry(self, session_token: str) -> None:
        """Extend session TTL on token refresh."""
        new_expiry = datetime.now(timezone.utc) + timedelta(
            days=settings.REFRESH_TOKEN_EXPIRE_DAYS
        )
        await self.db.execute(
            update(Session)
            .where(Session.session_token == session_token)
            .values(expires_at=new_expiry)
        )
        await self.db.flush()
