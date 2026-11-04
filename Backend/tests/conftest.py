"""
DocFlow Backend — pytest fixtures.

Runs against a real Postgres test database (SQLite can't model this schema —
JSONB, gin indexes, pg_trgm). Point TEST_DATABASE_URL at a disposable
database; defaults to swapping the configured DATABASE_URL's db name for
"docflow_test" (e.g. via `docker run -e POSTGRES_DB=docflow_test ... postgres:16`).

Isolation strategy: real commits + TRUNCATE between tests, NOT a
rollback-per-test transaction. A rollback-per-test design (one shared
connection/session for both fixture setup and the HTTP client) breaks here
because Starlette's BaseHTTPMiddleware (app/middleware/logging.py) runs the
downstream request in a separate anyio-spawned asyncio Task — and an
AsyncSession/AsyncConnection must never be used concurrently across tasks
(asyncpg raises "Future attached to a different loop"/task-affinity errors).
Using a fresh, independently-committing session per request (exactly like
production `get_db`) sidesteps that entirely.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.config import settings
from app.core.security import create_access_token, generate_session_id
from app.database import Base, get_db
from app.main import app
from app.models.organization import Organization, OrganizationMember, Role, RolePermission
from app.models.user import Session as UserSession
from app.models.user import User
from app.repositories.org_repo import OrganizationRepository

# Tests run against a LOCAL, disposable Postgres — never the configured
# DATABASE_URL. Deriving the test URL from DATABASE_URL (the old default)
# pointed the suite at the remote Neon dev database, where every round trip
# costs 1-5s of network latency: the same 35 tests took 16h40m there versus
# well under a minute locally, and a crashed run could leave junk in the
# real dev database.
#
# Override with TEST_DATABASE_URL to point somewhere else. The database is
# created automatically if missing (see _ensure_test_database below).
TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql+asyncpg://postgres:admin@127.0.0.1:5432/docflow_test",
)

test_engine = create_async_engine(
    TEST_DATABASE_URL,
    # pytest-asyncio gives each test function its own event loop by default,
    # and Starlette's BaseHTTPMiddleware additionally runs requests in a
    # separate anyio-spawned task. A pooled asyncpg connection is bound to
    # whichever loop/task first created it, so reusing one across either
    # boundary raises "Future attached to a different loop". NullPool opens
    # a brand-new connection per checkout and never reuses one, sidestepping
    # this entirely — test-only, not applied to the production engine.
    poolclass=NullPool,
    connect_args={"statement_cache_size": 0},
)
TestSessionFactory = async_sessionmaker(bind=test_engine, expire_on_commit=False)


# The real fire-and-forget email dispatcher, saved BEFORE the autouse fixture
# below neutralizes it, so tests/test_email_pipeline.py can opt back in.
from app.services.notification_service import NotificationService as _NotificationService  # noqa: E402

REAL_SEND_EMAILS = _NotificationService._send_emails


@pytest.fixture(autouse=True)
def _disable_background_dispatch(monkeypatch):
    """
    NotificationService._send_emails and the two EventBus handlers in
    app/subscribers.py fire-and-forget background work via
    asyncio.create_task() against a FRESH session from the *production*
    app.database.async_session_factory — pointed at the real dev
    DATABASE_URL, not this test database. Left alone, an un-awaited task
    can outlive the test that spawned it, run concurrently with a LATER
    test's TRUNCATE-based cleanup, and has produced real Postgres deadlocks
    in this suite; it also silently leaks writes into the real dev database
    during a test run. Neutralize at the asyncio.create_task boundary in
    both modules so no background DB work is ever actually scheduled —
    none of this suite's tests assert on fire-and-forget email/notification
    delivery (test_org_creation_email.py patches NotificationService.notify
    directly, one level up, so it is unaffected by this).

    Patch the two CALLERS, never `asyncio.create_task` itself: `import
    asyncio` binds the one shared module object, so
    monkeypatch.setattr(some_module.asyncio, "create_task", ...) replaces it
    process-wide — including for pytest-asyncio, anyio and httpx, which
    breaks the entire suite. (Learned the hard way.)
    """
    from app.core.events import EventBus
    from app.services.notification_service import NotificationService

    # Fire-and-forget email dispatch (spawns its own task + session).
    monkeypatch.setattr(
        NotificationService, "_send_emails", lambda self, *a, **kw: None
    )
    # EventBus.publish() synchronously invokes the subscribers in
    # app/subscribers.py, each of which spawns its own background task with a
    # production-pointed session. No test asserts on those notifications.
    monkeypatch.setattr(EventBus, "publish", staticmethod(lambda *a, **kw: None))

    # Redis isn't running in the test environment. _push_to_redis already
    # degrades gracefully (logs a warning and continues — the DB row is the
    # source of truth), but each attempt still pays a TCP connect timeout,
    # which added minutes across the suite. Skip the push entirely.
    async def _no_push(self, *a, **kw):
        return None

    monkeypatch.setattr(NotificationService, "_push_to_redis", _no_push)


async def _ensure_test_database() -> None:
    """
    Create the test database if it doesn't exist yet, so a fresh checkout can
    just run `pytest` without a manual CREATE DATABASE step.

    Must be async and awaited: it runs inside the session fixture's event
    loop, where asyncio.run() would raise "cannot be called from a running
    event loop".
    """
    import asyncpg

    url = TEST_DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://")
    base, _, dbname = url.rpartition("/")

    try:
        conn = await asyncpg.connect(f"{base}/postgres", statement_cache_size=0)
    except Exception as exc:  # pragma: no cover - config/environment problem
        raise RuntimeError(
            f"Could not reach the test Postgres at {base}/postgres ({exc}). "
            "Start a local Postgres or set TEST_DATABASE_URL."
        ) from exc
    try:
        exists = await conn.fetchval(
            "SELECT 1 FROM pg_database WHERE datname = $1", dbname
        )
        if not exists:
            await conn.execute(f'CREATE DATABASE "{dbname}"')
    finally:
        await conn.close()


@pytest_asyncio.fixture(scope="session", autouse=True, loop_scope="session")
async def _setup_schema():
    await _ensure_test_database()
    async with test_engine.begin() as conn:
        # Drop the SCHEMA, not the tables. Base.metadata.drop_all cannot sort
        # documents / file_assets / template_versions: they have mutually
        # dependent foreign keys (declared with use_alter), so SQLAlchemy
        # raises CircularDependencyError ("Can't sort tables for DROP") the
        # moment the database is NOT empty. That made the suite runnable
        # exactly once per fresh database and every later run errored at
        # setup. DROP SCHEMA sidesteps the table sort entirely.
        await conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
        await conn.execute(text("CREATE SCHEMA public"))
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
        await conn.run_sync(Base.metadata.create_all)
    yield
    await test_engine.dispose()


@pytest_asyncio.fixture(autouse=True)
async def _truncate_between_tests():
    """Runs after every test: wipe all app tables so each test starts clean.
    Cheaper/simpler than tracking FK order by hand — TRUNCATE ... CASCADE
    handles it, and this is a disposable test database."""
    yield
    async with test_engine.begin() as conn:
        table_names = ", ".join(f'"{t.name}"' for t in reversed(Base.metadata.sorted_tables))
        if table_names:
            await conn.execute(text(f"TRUNCATE {table_names} RESTART IDENTITY CASCADE"))


@pytest_asyncio.fixture
async def db_session():
    """A real, independently-committing session — same shape as production
    `get_db`, just pointed at the test database."""
    async with TestSessionFactory() as session:
        yield session
        await session.commit()


@pytest_asyncio.fixture
async def client():
    """httpx AsyncClient wired to the FastAPI app, with get_db overridden to
    hand out fresh test-DB sessions (one per request, like production).
    ASGITransport does not run lifespan by default, which is fine here —
    nothing under test needs Firebase/Redis/Celery to be live."""

    async def _override_get_db():
        async with TestSessionFactory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app.dependency_overrides[get_db] = _override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()


# ── Org + role fixtures ─────────────────────────────────────────────────────

@pytest_asyncio.fixture
async def org(db_session: AsyncSession) -> Organization:
    org_repo = OrganizationRepository(db_session)
    o = await org_repo.create(name=f"Test Org {uuid.uuid4().hex[:8]}")
    await org_repo.create_default_roles(o.id)
    await db_session.commit()
    return o


@pytest_asyncio.fixture
async def roles(db_session: AsyncSession, org: Organization) -> dict[str, Role]:
    result = await db_session.execute(select(Role).where(Role.org_id == org.id))
    return {r.name: r for r in result.scalars().all()}


async def _make_member(
    db_session: AsyncSession,
    org: Organization,
    role: Role,
    *,
    email: str | None = None,
    name: str = "Test User",
    dept_id: uuid.UUID | None = None,
) -> tuple[User, str]:
    """Create a User + OrganizationMember + Session row for `role`, and mint
    a valid DocFlow access token for it. Returns (user, bearer_token)."""
    email = email or f"{uuid.uuid4().hex[:10]}@example.com"
    user = User(email=email, name=name, is_active=True, status="active")
    db_session.add(user)
    await db_session.flush()

    member = OrganizationMember(
        org_id=org.id, user_id=user.id, role_id=role.id, status="active", dept_id=dept_id,
    )
    db_session.add(member)

    session_id = generate_session_id()
    db_session.add(
        UserSession(
            user_id=user.id,
            session_token=session_id,
            expires_at=datetime.now(timezone.utc) + timedelta(hours=2),
        )
    )
    await db_session.flush()

    perms_result = await db_session.execute(
        select(RolePermission.permission_code).where(RolePermission.role_id == role.id)
    )
    permissions = [p for (p,) in perms_result.all()]

    token = create_access_token(
        user_id=user.id,
        org_id=org.id,
        roles=[role.name],
        permissions=permissions,
        session_id=session_id,
        is_superadmin=False,
    )
    await db_session.commit()
    return user, token


@pytest_asyncio.fixture
async def admin(db_session, org, roles) -> tuple[User, str]:
    return await _make_member(db_session, org, roles["admin"], name="Admin User")


@pytest_asyncio.fixture
async def hr(db_session, org, roles) -> tuple[User, str]:
    return await _make_member(db_session, org, roles["hr"], name="HR User")


@pytest_asyncio.fixture
async def worker(db_session, org, roles) -> tuple[User, str]:
    return await _make_member(db_session, org, roles["worker"], name="Worker User")


@pytest_asyncio.fixture
async def trainee(db_session, org, roles) -> tuple[User, str]:
    return await _make_member(db_session, org, roles["trainee"], name="Trainee User")


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def make_member(db_session, org):
    """Factory for tests that need an arbitrary number of members/roles."""

    async def _factory(role: Role, **kwargs):
        return await _make_member(db_session, org, role, **kwargs)

    return _factory
