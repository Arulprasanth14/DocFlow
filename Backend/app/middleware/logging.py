"""
DocFlow Backend — Middleware: Structured Logging
Per-request: request_id, user_id, org_id, duration_ms, status_code.
Uses structlog for JSON output in production, pretty in development.
"""
from __future__ import annotations

import time
import uuid
from typing import Callable

import structlog
from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

from app.config import settings

# ── Structlog Configuration ────────────────────────────────────────────────────

def configure_logging() -> None:
    """Configure structlog for the application. Call once on startup."""
    processors = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]

    if settings.is_production:
        processors.append(structlog.processors.JSONRenderer())
    else:
        processors.append(structlog.dev.ConsoleRenderer(colors=True))

    import logging
    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, settings.LOG_LEVEL, logging.INFO)
        ),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


# ── Request Logging Middleware ─────────────────────────────────────────────────

class RequestLoggingMiddleware(BaseHTTPMiddleware):
    """
    Middleware: assigns request_id, logs every request with:
    - method, path, status_code, duration_ms
    - request_id (UUID, injected into response header)
    - user_id, org_id (if authenticated, parsed from JWT claims)
    """

    SKIP_PATHS = {"/health", "/health/live", "/metrics"}

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        # Skip health check noise
        if request.url.path in self.SKIP_PATHS:
            return await call_next(request)

        request_id = str(uuid.uuid4())
        start_time = time.perf_counter()

        # Inject request_id into structlog context for this request
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(request_id=request_id)

        # Store request_id in request state for downstream use
        request.state.request_id = request_id

        logger = structlog.get_logger()

        try:
            response = await call_next(request)
            duration_ms = round((time.perf_counter() - start_time) * 1000, 2)

            log_method = logger.info if response.status_code < 400 else logger.warning
            if response.status_code >= 500:
                log_method = logger.error

            log_method(
                "request",
                method=request.method,
                path=request.url.path,
                status_code=response.status_code,
                duration_ms=duration_ms,
                user_agent=request.headers.get("user-agent", ""),
            )

            response.headers["X-Request-ID"] = request_id
            return response

        except Exception as exc:
            duration_ms = round((time.perf_counter() - start_time) * 1000, 2)
            logger.exception(
                "request_error",
                method=request.method,
                path=request.url.path,
                duration_ms=duration_ms,
                error=str(exc),
            )
            raise


logger = structlog.get_logger(__name__)
