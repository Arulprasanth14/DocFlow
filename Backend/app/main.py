"""
DocFlow Backend — FastAPI Application Factory
This is the root of the application. Registers all middleware, routers, and lifecycle hooks.
"""
from __future__ import annotations

from contextlib import asynccontextmanager

import sentry_sdk
import structlog
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.core.exceptions import DocFlowException
from app.core.firebase import initialize_firebase
from app.core.redis import close_redis
from app.core.websocket import ws_manager
from app.middleware.logging import RequestLoggingMiddleware, configure_logging
from app.middleware.security import (
    RateLimitMiddleware,
    SecurityHeadersMiddleware,
)
from app.routers import (
    admin,
    agent,
    ai_assist,
    analytics,
    approvals,
    auth,
    chat,
    documents,
    files,
    health,
    imports,
    notifications,
    organizations,
    search,
    templates,
    users,
    workflow_templates_public,
    workflows,
    ws_chat,
    ws_notifications,
    observability,
)

logger = structlog.get_logger(__name__)


# ── Lifespan (startup + shutdown) ─────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: startup tasks → yield → shutdown tasks."""

    # ── STARTUP ──
    logger.info("DocFlow starting up...", version=settings.APP_VERSION, env=settings.APP_ENV)

    # Validate production configuration
    settings.validate_production()

    # Configure structured logging
    configure_logging()

    # Use the OS certificate store for outbound TLS so a private/corporate
    # root CA is honoured (see app/core/trust.py). Must run before any
    # outbound HTTPS client is created.
    from app.core.trust import ensure_os_trust_store
    ensure_os_trust_store()

    # Initialize Firebase (non-fatal if not configured)
    firebase_ok = initialize_firebase()
    logger.info("Firebase status", enabled=firebase_ok)

    # FR-9.9 — report, rather than assume, whether uploaded files are
    # encrypted at rest. Objects go to storage straight from the browser,
    # so the bucket's own default encryption is what covers them; this
    # line is how its absence becomes visible instead of silent.
    try:
        from app.core.storage import describe_bucket_encryption

        enc = describe_bucket_encryption(settings.S3_BUCKET_DOCUMENTS)
        logger.info(
            "Storage encryption at rest",
            bucket_default_encryption=enc["enabled"],
            detail=enc["detail"],
            server_side_writes=(settings.S3_SSE or "off"),
        )
        if not enc["enabled"] and settings.is_production:
            logger.warning(
                "Uploaded files are NOT encrypted at rest (FR-9.9). Enable "
                "default bucket encryption; see the deployment checklist.",
                bucket=settings.S3_BUCKET_DOCUMENTS,
            )
    except Exception:  # noqa: BLE001 — a storage that is down must not block boot
        logger.warning("Storage encryption state could not be determined")

    # Initialize Sentry (non-fatal)
    if settings.SENTRY_DSN:
        sentry_sdk.init(
            dsn=settings.SENTRY_DSN,
            environment=settings.APP_ENV,
            release=f"docflow@{settings.APP_VERSION}",
            traces_sample_rate=0.1,
        )
        logger.info("Sentry initialized")

    # Start WebSocket Redis subscriber
    await ws_manager.start_redis_subscriber()
    logger.info("WebSocket Redis subscriber started")

    # Register EventBus subscribers (must run after startup so the process is live)
    import app.subscribers  # noqa: F401 — side-effect import registers all handlers
    logger.info("EventBus subscribers registered")

    logger.info("DocFlow ready")

    yield   # ── APPLICATION RUNNING ──

    # ── SHUTDOWN ──
    logger.info("DocFlow shutting down...")
    await ws_manager.stop_redis_subscriber()
    await close_redis()
    logger.info("DocFlow shutdown complete")


# ── App Factory ───────────────────────────────────────────────────────────────
def create_app() -> FastAPI:
    app = FastAPI(
        title="DocFlow API",
        description="Enterprise Document Workflow & Approval Platform",
        version=settings.APP_VERSION,
        docs_url="/api/docs" if not settings.is_production else None,
        redoc_url="/api/redoc" if not settings.is_production else None,
        openapi_url="/api/openapi.json" if not settings.is_production else None,
        lifespan=lifespan,
    )

    # ── CORS ─────────────────────────────────────────────────────────────────
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Request-ID", "X-Total-Count"],
    )

    # ── Custom Middleware ─────────────────────────────────────────────────────
    #
    # Starlette runs these in REVERSE registration order, so the last one
    # added is the outermost. Registered so that the order on the way in is:
    # security headers, then rate limit, then logging. The limiter sits
    # inside the header middleware so a 429 still carries them, and outside
    # logging so a rejected request is still logged.
    app.add_middleware(RequestLoggingMiddleware)
    app.add_middleware(RateLimitMiddleware)
    app.add_middleware(SecurityHeadersMiddleware)

    # ── Exception Handlers ─────────────────────────────────────────────────────
    @app.exception_handler(DocFlowException)
    async def docflow_exception_handler(request: Request, exc: DocFlowException):
        body = {
            "error": exc.detail,
            "status_code": exc.status_code,
            "request_id": getattr(request.state, "request_id", None),
        }
        # A per-field breakdown, when the raiser supplied one, so the UI can
        # show the message beside the field instead of as one opaque banner.
        fields = getattr(exc, "fields", None)
        if fields:
            body["fields"] = [f.as_dict() for f in fields]
        return JSONResponse(status_code=exc.status_code, content=body)

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        logger.exception("Unhandled exception", path=request.url.path, error=str(exc))
        return JSONResponse(
            status_code=500,
            content={
                "error": "Internal server error",
                "status_code": 500,
                "request_id": getattr(request.state, "request_id", None),
            },
        )

    # ── Routers ───────────────────────────────────────────────────────────────
    API_PREFIX = "/api/v1"

    app.include_router(health.router)   # /health, /health/live (no prefix)

    # Core identity & organization
    app.include_router(auth.router, prefix=f"{API_PREFIX}/auth")
    app.include_router(users.router, prefix=f"{API_PREFIX}")   # POST /users/me/sync
    app.include_router(organizations.router, prefix=f"{API_PREFIX}/orgs")

    # Document management & file uploads
    app.include_router(documents.types_router, prefix=f"{API_PREFIX}/document-types")
    app.include_router(documents.documents_router, prefix=f"{API_PREFIX}/documents")
    # Template Studio (versioned, form-driven templates — Documents module §10)
    app.include_router(templates.router, prefix=f"{API_PREFIX}/templates")
    app.include_router(imports.router, prefix=f"{API_PREFIX}/imports")
    app.include_router(files.router, prefix=f"{API_PREFIX}")
    # AI assistance for the Documents module (Phase 3 — §23 governance applies
    # inside the service: server-side key, quota, off-switches, audit).
    app.include_router(ai_assist.router, prefix=f"{API_PREFIX}")

    # Workflows, Approvals, and Templates
    app.include_router(workflows.router, prefix=f"{API_PREFIX}")
    app.include_router(approvals.router, prefix=f"{API_PREFIX}")
    # Public (non-admin) template read — GET /api/v1/workflow-templates
    app.include_router(workflow_templates_public.router, prefix=f"{API_PREFIX}")

    # Chat & Notifications
    app.include_router(chat.router, prefix=f"{API_PREFIX}")
    app.include_router(ws_chat.router)          # /ws/chat/{conversation_id} WebSocket
    app.include_router(ws_notifications.router) # /ws/notifications WebSocket
    app.include_router(notifications.router, prefix=f"{API_PREFIX}")

    # Analytics
    app.include_router(analytics.router, prefix=f"{API_PREFIX}")

    # Unified search (documents / workflows / members / messages)
    app.include_router(search.router, prefix=f"{API_PREFIX}")

    # AI Agent (organization-scoped RAG) + knowledge administration
    app.include_router(agent.router, prefix=f"{API_PREFIX}")

    # Admin Management & Audit Logs
    app.include_router(admin.router, prefix=f"{API_PREFIX}")
    # Section 11 Observability (task P4-9): backlog counts an external
    # monitor can poll and alert on.
    app.include_router(observability.router, prefix=f"{API_PREFIX}")

    return app


# ── ASGI App Instance ─────────────────────────────────────────────────────────
app = create_app()
