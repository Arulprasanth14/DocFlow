"""
DocFlow Backend — Base ORM Model
All models inherit from this. Provides: UUID PK, timestamps, soft-delete,
created_by/updated_by tracking, and a clean dict representation.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import DateTime, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class BaseModel(Base):
    """
    Abstract base model with common columns for all DocFlow tables.
    Provides:
        - id: UUID v4 primary key
        - created_at: auto-set on INSERT
        - updated_at: auto-updated on UPDATE
        - deleted_at: soft-delete (None = not deleted)
    """
    __abstract__ = True

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=func.gen_random_uuid(),
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
        server_default=func.now(),
        nullable=False,
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
        onupdate=utcnow,
        server_default=func.now(),
        nullable=False,
    )

    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        default=None,
    )

    @property
    def is_deleted(self) -> bool:
        return self.deleted_at is not None

    def soft_delete(self) -> None:
        """Mark this record as deleted (sets deleted_at to now)."""
        self.deleted_at = utcnow()

    def to_dict(self, exclude: set[str] | None = None) -> dict[str, Any]:
        """Serialize model to dict, excluding specified columns."""
        exclude = exclude or set()
        result = {}
        for col in self.__table__.columns:
            if col.name in exclude:
                continue
            value = getattr(self, col.name)
            if isinstance(value, datetime):
                value = value.isoformat()
            elif isinstance(value, uuid.UUID):
                value = str(value)
            result[col.name] = value
        return result

    def __repr__(self) -> str:
        return f"<{self.__class__.__name__} id={self.id}>"
