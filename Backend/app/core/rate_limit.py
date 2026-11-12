"""
DocFlow — Core: per-route auth rate limiting (Auth/RBAC spec Gap #4).

Why this exists next to `middleware/security.py`: the middleware limiter is a
coarse fixed window keyed on the peer address, and it cannot see a request
body, so it cannot limit per account. The auth routes need both - "5 failed
logins per email per 15 minutes" is the limit that actually stops password
guessing, and a shared office NAT must not be able to lock out an entire
building by exhausting one IP allowance.

Design notes:

* **Sliding window**, as a Redis sorted set of timestamps. A fixed window lets
  through two full allowances back to back across the boundary, which for a
  login limit is the whole attack.
* **Failures, not requests**, for /auth/login: the route reports the outcome
  (`note_login_failure` / `note_login_success`), so a user who keeps typing
  their password correctly is never limited. A successful login clears the
  per-email counter only - never the per-IP one, which would let an attacker
  reset their budget with one known-good account.
* **Only a hash of the email** is ever sent to Redis, so the key space carries
  no addresses.
* **Redis down**: fail CLOSED for /auth/login and /auth/register (a limiter
  that cannot count must not wave guessing through) and fail OPEN elsewhere
  with a loud log, because /auth/refresh and /auth/firebase-login failing
  closed would take the whole product down with the cache.
* `X-Forwarded-For` is honoured ONLY when the immediate peer is a configured
  trusted proxy. With the default (empty) list the socket address is used.
"""
from __future__ import annotations

import hashlib
import time
import uuid
from dataclasses import dataclass

import structlog
from fastapi import Request

from app.config import settings
from app.core.exceptions import RateLimitException, ServiceUnavailableException

logger = structlog.get_logger(__name__)

_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400,
          "second": 1, "minute": 60, "hour": 3600, "day": 86400}


@dataclass(frozen=True)
class Limit:
    """`count` events allowed per `window` seconds."""
    count: int
    window: int

    @property
    def retry_after_default(self) -> int:
        return max(self.window, 1)


def parse_limit(value: str) -> Limit:
    """"5/15m", "20/1m", "30/minute" -> Limit. Permissive fallback on garbage,
    with a warning: a malformed setting must not take the service down."""
    try:
        raw_count, raw_period = value.split("/", 1)
        raw_period = raw_period.strip().lower()
        # Leading digits are the multiplier, the rest is the unit. Scanned as a
        # prefix, not filtered: "minute" has no digits at all, and slicing by
        # the length of a defaulted "1" would eat its first letter.
        digits = ""
        for ch in raw_period:
            if not ch.isdigit():
                break
            digits += ch
        unit = raw_period[len(digits):].strip() or "s"
        return Limit(int(raw_count), int(digits or 1) * _UNITS[unit])
    except (ValueError, KeyError):
        logger.warning("rate_limit_setting_unparseable", value=value)
        return Limit(1000, 60)


# ── identity ──────────────────────────────────────────────────────────────────

def client_ip(request: Request) -> str:
    """The address to limit on.

    `X-Forwarded-For` is trusted only when the peer is in TRUSTED_PROXIES;
    anyone can set that header, and trusting it blindly hands out one fresh
    allowance per forged value.
    """
    peer = request.client.host if request.client else "unknown"
    trusted = {p.strip() for p in settings.TRUSTED_PROXIES if p.strip()}
    if peer in trusted:
        forwarded = request.headers.get("X-Forwarded-For", "")
        if forwarded:
            # Left-most entry is the original client.
            return forwarded.split(",")[0].strip() or peer
    return peer


def email_key(email: str | None) -> str:
    """A hash, never the address itself."""
    normalized = (email or "").strip().lower()
    if not normalized:
        return "anon"
    return hashlib.sha256(normalized.encode()).hexdigest()[:32]


def opaque_key(value: str | None) -> str:
    """For limiting on a credential (a refresh cookie) without storing it."""
    if not value:
        return "none"
    return hashlib.sha256(value.encode()).hexdigest()[:32]


# ── the window ────────────────────────────────────────────────────────────────

async def _consume(key: str, limit: Limit, *, fail_closed: bool, record: bool = True) -> None:
    """Raise 429 when `key` is over `limit`. `record=False` only inspects."""
    # One kill switch for every limiter in the app, including this one. The
    # test suite turns it off: the whole suite calls from a single address, so
    # a per-address limit would fail unrelated tests depending on run order.
    if not settings.RATE_LIMIT_ENABLED:
        return
    now = time.time()
    try:
        from app.core.redis import get_redis

        redis = await get_redis()
        await redis.zremrangebyscore(key, 0, now - limit.window)
        used = await redis.zcard(key)
        if used >= limit.count:
            retry_after = limit.retry_after_default
            oldest = await redis.zrange(key, 0, 0, withscores=True)
            if oldest:
                retry_after = max(int(limit.window - (now - oldest[0][1])) + 1, 1)
            raise RateLimitException(
                "Too many attempts. Please wait before trying again.",
                code="RATE_LIMITED",
                headers={"Retry-After": str(retry_after)},
            )
        if record:
            # The member is unique so two hits in the same millisecond both
            # count; the score is what the window is measured on.
            await redis.zadd(key, {f"{now}:{uuid.uuid4().hex[:8]}": now})
            await redis.expire(key, limit.window + 1)
    except RateLimitException:
        raise
    except Exception as exc:  # noqa: BLE001 - backend failure, not a limit hit
        logger.error(
            "rate_limit_backend_unavailable",
            key_prefix=key.split(":", 2)[:2], fail_closed=fail_closed,
            error=f"{type(exc).__name__}: {exc}",
        )
        if fail_closed:
            raise ServiceUnavailableException(
                "Sign-in", code="RATE_LIMITER_UNAVAILABLE"
            ) from exc


async def _clear(key: str) -> None:
    try:
        from app.core.redis import get_redis

        redis = await get_redis()
        await redis.delete(key)
    except Exception as exc:  # noqa: BLE001
        logger.warning("rate_limit_clear_failed", error=f"{type(exc).__name__}: {exc}")


async def _body_email(request: Request) -> str | None:
    """Read `email` from a JSON body without consuming it for the route.

    Starlette caches the body on the request, so the route's own Pydantic
    model still parses after this.
    """
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - not JSON, or empty
        return None
    if isinstance(body, dict):
        value = body.get("email")
        return value if isinstance(value, str) else None
    return None


# ── route dependencies ────────────────────────────────────────────────────────

async def limit_login(request: Request) -> None:
    """/auth/login: request flood per IP, plus failed attempts per IP and per
    email. Fails closed - a limiter that cannot count must not let password
    guessing through."""
    ip = client_ip(request)
    await _consume(
        f"rl:login:req:ip:{ip}",
        parse_limit(settings.RATE_LIMIT_LOGIN_REQUESTS),
        fail_closed=True,
    )
    # Inspect only (record=False): failures are recorded by
    # note_login_failure once the outcome is known, so correct passwords never
    # consume the allowance.
    await _consume(
        f"rl:login:fail:ip:{ip}",
        parse_limit(settings.RATE_LIMIT_LOGIN_FAILURES_PER_IP),
        fail_closed=True, record=False,
    )
    await _consume(
        f"rl:login:fail:email:{email_key(await _body_email(request))}",
        parse_limit(settings.RATE_LIMIT_LOGIN_FAILURES),
        fail_closed=True, record=False,
    )


async def note_login_failure(request: Request, email: str | None) -> None:
    """Count one failed /auth/login attempt against the IP and the email.

    Recording only - the budget was already checked by `limit_login` before
    the attempt ran, so the limit passed here is effectively infinite and the
    window is what matters.
    """
    if not settings.RATE_LIMIT_ENABLED:
        return
    ip = client_ip(request)
    per_ip = parse_limit(settings.RATE_LIMIT_LOGIN_FAILURES_PER_IP)
    per_email = parse_limit(settings.RATE_LIMIT_LOGIN_FAILURES)
    for key, limit in (
        (f"rl:login:fail:ip:{ip}", per_ip),
        (f"rl:login:fail:email:{email_key(email)}", per_email),
    ):
        try:
            await _consume(key, Limit(10**9, limit.window), fail_closed=False)
        except RateLimitException:  # pragma: no cover - the count is infinite
            pass


async def note_login_success(email: str | None) -> None:
    """Clear the per-EMAIL failure counter. The per-IP counter deliberately
    survives: otherwise one known-good account resets an attacker's budget."""
    if not settings.RATE_LIMIT_ENABLED:
        return
    await _clear(f"rl:login:fail:email:{email_key(email)}")


async def limit_register(request: Request) -> None:
    """/auth/register: account creation per IP. Fails closed."""
    await _consume(
        f"rl:register:ip:{client_ip(request)}",
        parse_limit(settings.RATE_LIMIT_REGISTER),
        fail_closed=True,
    )


async def limit_firebase_login(request: Request) -> None:
    """/auth/firebase-login: per IP, fails OPEN - this is the main sign-in
    path and a cache outage must not lock everyone out."""
    await _consume(
        f"rl:fblogin:ip:{client_ip(request)}",
        parse_limit(settings.RATE_LIMIT_FIREBASE_LOGIN),
        fail_closed=False,
    )


async def limit_refresh(request: Request) -> None:
    """/auth/refresh: per IP and per session (keyed on a hash of the presented
    cookie, never the cookie). Fails OPEN - every signed-in tab depends on it."""
    limit = parse_limit(settings.RATE_LIMIT_REFRESH)
    await _consume(f"rl:refresh:ip:{client_ip(request)}", limit, fail_closed=False)
    cookie = request.cookies.get("docflow_refresh")
    if cookie:
        await _consume(f"rl:refresh:sid:{opaque_key(cookie)}", limit, fail_closed=False)
