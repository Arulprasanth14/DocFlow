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

    # Initialize Firebase (non-fatal if not configured)
    firebase_ok = initialize_firebase()
    logger.info("Firebase status", enabled=firebase_ok)

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

    logger.info("DocFlow ready ✓")

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
    app.add_middleware(RequestLoggingMiddleware)

    # ── Exception Handlers ─────────────────────────────────────────────────────
    @app.exception_handler(DocFlowException)
    async def docflow_exception_handler(request: Request, exc: DocFlowException):
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": exc.detail,
                "status_code": exc.status_code,
                "request_id": getattr(request.state, "request_id", None),
            },
        )

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
    app.include_router(files.router, prefix=f"{API_PREFIX}")

    # Workflows, Approvals, and Templates
    app.include_router(workflows.router, prefix=f"{API_PREFIX}")
    app.include_router(approvals.router, prefix=f"{API_PREFIX}")

    # Chat & Notifications
    app.include_router(chat.router, prefix=f"{API_PREFIX}")
    app.include_router(ws_chat.router)  # /ws/chat/{conversation_id} WebSocket
    app.include_router(notifications.router, prefix=f"{API_PREFIX}")

    # Admin Management & Audit Logs
    app.include_router(admin.router, prefix=f"{API_PREFIX}")

    return app


# ── ASGI App Instance ─────────────────────────────────────────────────────────
app = create_app()
