"""
DocFlow — Worker: database sessions for Celery tasks

A Celery task here is a sync function that calls `asyncio.run(...)`, and
every `asyncio.run` creates a NEW event loop. The application's shared engine
(`app.database.engine`) keeps a connection pool, and an asyncpg connection is
bound to the loop it was opened on. So the second task a worker process runs
checks out a pooled connection that belongs to a loop which has already been
closed, and fails with "attached to a different loop" / "Event loop is
closed".

That is survivable for a task that runs once a day. It is not for the outbox
sweep and the SLA sweep, which run every minute: observed in the dev worker,
the outbox drain failed on most ticks - and that sweep is what makes
notification delivery durable.

`task_session()` gives each task run its own engine with no pool, opened and
disposed inside the task's own loop, so no connection ever outlives the loop
it belongs to. The cost is one connection setup per task run, which is
nothing next to a per-minute schedule.
"""
from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool

from app.config import settings


@asynccontextmanager
async def task_session() -> AsyncIterator[AsyncSession]:
    """A session whose engine lives and dies with the current event loop."""
    engine = create_async_engine(
        settings.DATABASE_URL,
        poolclass=NullPool,
        connect_args={"server_settings": {"application_name": "docflow-worker"}},
    )
    factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False,
        autocommit=False, autoflush=False,
    )
    try:
        async with factory() as session:
            yield session
    finally:
        await engine.dispose()
