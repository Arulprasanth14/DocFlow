"""
DocFlow — Middleware: security headers and rate limiting

Workflow module section 11 (Security), task P4-8.

Both were specified and neither existed: the app had no security headers at
all, and `RATE_LIMIT_GLOBAL`, `RATE_LIMIT_AUTH` and `RATE_LIMIT_UPLOADS` sat
in config with nothing reading them.

**Headers.** A deny-by-default CSP, and the usual set around it. The policy
is deliberately strict about where scripts may come from and completely
forbids framing, because the review screen renders attacker-supplied
documents and shows model output about them.

`'unsafe-inline'` is permitted for STYLES only, and that is a real
concession: this codebase styles almost everything with inline `style=`
props, so forbidding it would break every page. Scripts get no such
exemption, which is the half that matters for XSS.

**Rate limiting.** Redis-backed, because a per-process counter in a
multi-worker deployment lets through one bucket's worth of traffic per
worker. A fixed window per (identity, bucket), which is coarser than a
sliding window but cheap and predictable; the point here is to stop
hammering, not to meter precisely.

Rate limiting **fails open**: if Redis is unreachable the request proceeds.
Closing would turn a cache outage into a total outage, and this limiter
protects against abuse, not against data loss.
"""
from __future__ import annotations

import time

import structlog
from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.config import settings

logger = structlog.get_logger(__name__)


def _parse_limit(value: str) -> tuple[int, int]:
    """"120/minute" -> (120, 60). Falls back to a permissive default rather
    than crashing the app over a malformed setting."""
    units = {"second": 1, "minute": 60, "hour": 3600, "day": 86400}
    try:
        count, unit = value.split("/", 1)
        return int(count), units[unit.strip().lower()]
    except (ValueError, KeyError):
        logger.warning("rate_limit_setting_unparseable", value=value)
        return 1000, 60


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Section 11 Security — headers on every response."""

    def _csp(self) -> str:
        # Vite's dev server needs inline and eval for hot reload; production
        # gets neither. Keeping them out of production is the whole point of
        # branching here rather than shipping one permissive policy.
        script = "'self'"
        connect = "'self'"
        if not settings.is_production:
            script = "'self' 'unsafe-inline' 'unsafe-eval'"
            connect = "'self' ws: wss: http://127.0.0.1:* http://localhost:*"
        return "; ".join([
            "default-src 'self'",
            f"script-src {script}",
            # Inline styles only. See the module docstring: this codebase
            # styles with inline props, and scripts get no exemption.
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com data:",
            # blob: for the PDF the viewer renders, data: for avatars.
            "img-src 'self' data: blob:",
            # The viewer fetches the presigned object URL, so storage has to
            # be reachable; https: rather than a wildcard.
            f"connect-src {connect} https:",
            # pdf.js runs its parser in a worker from our own origin.
            "worker-src 'self' blob:",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ])

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        headers = response.headers
        headers.setdefault("Content-Security-Policy", self._csp())
        headers.setdefault("X-Content-Type-Options", "nosniff")
        headers.setdefault("X-Frame-Options", "DENY")
        headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        headers.setdefault(
            "Permissions-Policy", "camera=(), microphone=(), geolocation=()"
        )
        # Only over HTTPS: sending HSTS over plain HTTP is meaningless, and in
        # development it would pin localhost to https in the browser and make
        # the dev server unreachable until the user cleared it by hand.
        if settings.is_production and request.url.scheme == "https":
            headers.setdefault(
                "Strict-Transport-Security",
                "max-age=31536000; includeSubDomains",
            )
        return response


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Section 11 Security — a fixed-window limiter per identity and bucket."""

    #: Path prefixes that get their own, tighter bucket.
    #
    # /api/v1/auth is deliberately NOT here any more. One coarse bucket for
    # the whole prefix meant /auth/me and /auth/refresh spent the same
    # allowance as /auth/login, so an office behind one NAT could lock itself
    # out by doing nothing wrong, while /auth/login still got a far more
    # generous budget than password guessing warrants. The auth routes now
    # carry per-route sliding windows (core/rate_limit.py); what is left here
    # is the global bucket, which still applies to them.
    BUCKETS: tuple[tuple[str, str], ...] = (
        ("/api/v1/files", "uploads"),
        ("/api/v1/ai", "ai"),
    )

    # /auth/me is read on every page load and carries no abuse value, so it
    # is exempt entirely rather than sharing an allowance with sign-in.
    SKIP_PREFIXES = (
        "/health", "/metrics", "/docs", "/openapi", "/redoc",
        "/api/v1/auth/me",
    )

    def _bucket(self, path: str) -> str:
        for prefix, name in self.BUCKETS:
            if path.startswith(prefix):
                return name
        return "global"

    def _limit_for(self, bucket: str) -> tuple[int, int]:
        raw = {
            "uploads": settings.RATE_LIMIT_UPLOADS,
            "ai": settings.RATE_LIMIT_AI_CHAT,
        }.get(bucket, settings.RATE_LIMIT_GLOBAL)
        return _parse_limit(raw)

    def _identity(self, request: Request) -> str:
        """Who is being limited.

        **In practice this is the peer address.** The authenticated user is
        resolved by the `CurrentUser` dependency, which runs per route, after
        every middleware - so no middleware can know who is calling without
        re-doing the token work itself, which would be a second, divergent
        copy of authentication. The `user_id` branch is kept because it costs
        nothing and starts working the moment something upstream sets it.

        The consequence worth knowing: a shared office NAT shares one
        allowance. That is why the global bucket is generous and only the
        sensitive prefixes are tight.

        `X-Forwarded-For` is deliberately NOT trusted - anyone can set it,
        and trusting it would hand out an unlimited allowance per forged
        value. Behind a real proxy, configure the ASGI server's
        `--forwarded-allow-ips` so `request.client` is the true peer.
        """
        user_id = getattr(request.state, "user_id", None)
        if user_id:
            return f"u:{user_id}"
        client = request.client
        return f"ip:{client.host if client else 'unknown'}"

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if (
            not settings.RATE_LIMIT_ENABLED
            or request.method == "OPTIONS"
            or path.startswith(self.SKIP_PREFIXES)
        ):
            return await call_next(request)

        bucket = self._bucket(path)
        count, window = self._limit_for(bucket)
        slot = int(time.time()) // window
        key = f"rl:{bucket}:{self._identity(request)}:{slot}"

        try:
            from app.core.redis import get_redis

            redis = await get_redis()
            used = await redis.incr(key)
            if used == 1:
                # Only on creation, so the window does not slide forward with
                # every request inside it.
                await redis.expire(key, window + 1)
        except Exception as exc:  # noqa: BLE001
            # Fails OPEN: a cache outage must not become a total outage.
            logger.debug("rate_limit_unavailable", error=str(exc))
            return await call_next(request)

        if used > count:
            retry_after = window - (int(time.time()) % window)
            logger.info(
                "rate_limited", bucket=bucket, path=path,
                identity=self._identity(request), used=used, limit=count,
            )
            return JSONResponse(
                status_code=429,
                content={
                    "detail": (
                        "Too many requests. Please wait a moment and try again."
                    )
                },
                headers={
                    "Retry-After": str(retry_after),
                    "X-RateLimit-Limit": str(count),
                    "X-RateLimit-Remaining": "0",
                },
            )

        response = await call_next(request)
        response.headers.setdefault("X-RateLimit-Limit", str(count))
        response.headers.setdefault(
            "X-RateLimit-Remaining", str(max(0, count - used))
        )
        return response
