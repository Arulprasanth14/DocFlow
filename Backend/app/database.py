"""
DocFlow Backend — Database
SQLAlchemy 2.0 async engine + session factory.
Uses asyncpg driver; connections routed through PgBouncer in production.
"""
from __future__ import annotations

from collections.abc import AsyncGenerator
from typing import Any

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.config import settings


# ── Engine ────────────────────────────────────────────────────────────────────
engine = create_async_engine(
    settings.DATABASE_URL,
    echo=settings.DATABASE_ECHO,
    pool_size=settings.DATABASE_POOL_SIZE,
    max_overflow=settings.DATABASE_MAX_OVERFLOW,
    pool_pre_ping=True,           # verify connection health before use
    pool_recycle=3600,            # recycle connections every hour
    connect_args={
        "server_settings": {
            "application_name": "docflow-backend",
        }
    },
)

# ── Session Factory ───────────────────────────────────────────────────────────
AsyncSessionFactory = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,       # avoid lazy-load issues after commit
    autocommit=False,
    autoflush=False,
)
async_session_factory = AsyncSessionFactory


# ── Declarative Base ──────────────────────────────────────────────────────────
class Base(DeclarativeBase):
    """SQLAlchemy declarative base for all ORM models."""
    pass


# ── Dependency ────────────────────────────────────────────────────────────────
async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """
    FastAPI dependency that provides an async DB session per request.
    Rolls back on exception; commits on success.
    """
    async with AsyncSessionFactory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


# ── Lifecycle Helpers ─────────────────────────────────────────────────────────
async def create_all_tables() -> None:
    """Create all tables (for testing only; use Alembic in production)."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def drop_all_tables() -> None:
    """Drop all tables (for testing only)."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


async def check_db_connection() -> dict[str, Any]:
    """Health check — verify DB is reachable and return server version."""
    from sqlalchemy import text
    async with engine.connect() as conn:
        result = await conn.execute(text("SELECT version()"))
        version = result.scalar()
    return {"status": "ok", "postgres_version": version}
