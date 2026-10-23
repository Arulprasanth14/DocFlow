"""
DocFlow Backend — Core: Redis
Async Redis connection pool. Used for: cache, pub/sub, Celery broker.
Provides a simple interface for common cache operations.

Resilience: Redis is a cache / fan-out layer, not the source of truth
(Postgres is, for everything that matters — see chat/notification services).
The cache_* and publish() helpers below therefore swallow connection errors
and degrade to a no-op/miss rather than raising, so a Redis outage degrades
real-time push and caching, but doesn't 500 unrelated requests (e.g. listing
document types, which previously crashed outright when Redis was down).
"""
from __future__ import annotations

import json
from typing import Any

import redis.asyncio as aioredis
import structlog

from app.config import settings

logger = structlog.get_logger(__name__)

# ── Connection Pool ────────────────────────────────────────────────────────────
_redis_pool: aioredis.Redis | None = None


async def get_redis() -> aioredis.Redis:
    """Get the shared async Redis connection pool (lazily initialised)."""
    global _redis_pool
    if _redis_pool is None:
        _redis_pool = aioredis.from_url(
            settings.REDIS_URL,
            max_connections=settings.REDIS_MAX_CONNECTIONS,
            decode_responses=True,
            encoding="utf-8",
        )
    return _redis_pool


async def close_redis() -> None:
    """Close the Redis connection pool (call on app shutdown)."""
    global _redis_pool
    if _redis_pool:
        await _redis_pool.aclose()
        _redis_pool = None


# ── Cache Helpers ─────────────────────────────────────────────────────────────
# All of these catch redis.RedisError (includes ConnectionError/TimeoutError)
# and degrade to a safe no-op — callers should treat a Redis outage the same
# as a cache miss, never as a request failure.

async def cache_get(key: str) -> Any | None:
    """Get a cached JSON value. Returns None on miss OR Redis unavailability."""
    try:
        redis = await get_redis()
        value = await redis.get(key)
    except Exception as exc:  # cache must never break a request (any failure = miss)
        logger.warning("redis_cache_get_failed", key=key, error=str(exc))
        return None
    if value is None:
        return None
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return value


async def cache_set(key: str, value: Any, ttl_seconds: int = 300) -> None:
    """Set a cached JSON value with TTL. No-op if Redis is unavailable."""
    try:
        redis = await get_redis()
        await redis.setex(key, ttl_seconds, json.dumps(value, default=str))
    except Exception as exc:  # cache must never break a request (any failure = miss)
        logger.warning("redis_cache_set_failed", key=key, error=str(exc))


async def cache_delete(key: str) -> None:
    """Delete a cached key. No-op if Redis is unavailable."""
    try:
        redis = await get_redis()
        await redis.delete(key)
    except Exception as exc:  # cache must never break a request (any failure = miss)
        logger.warning("redis_cache_delete_failed", key=key, error=str(exc))


async def cache_delete_pattern(pattern: str) -> int:
    """Delete all keys matching a pattern (use sparingly — O(N)). Returns 0 if Redis is unavailable."""
    try:
        redis = await get_redis()
        keys = await redis.keys(pattern)
        if keys:
            return await redis.delete(*keys)
        return 0
    except Exception as exc:  # cache must never break a request (any failure = miss)
        logger.warning("redis_cache_delete_pattern_failed", pattern=pattern, error=str(exc))
        return 0


# ── Pub/Sub Helpers ───────────────────────────────────────────────────────────

async def publish(channel: str, message: Any) -> None:
    """
    Publish a message to a Redis channel. No-op if Redis is unavailable —
    Postgres remains the source of truth for chat/notifications; publish()
    only drives real-time push, so losing it degrades liveness, not data.
    """
    try:
        redis = await get_redis()
        payload = json.dumps(message, default=str)
        await redis.publish(channel, payload)
    except Exception as exc:  # cache must never break a request (any failure = miss)
        logger.warning("redis_publish_failed", channel=channel, error=str(exc))


# ── Distributed Lock ──────────────────────────────────────────────────────────

class RedisLock:
    """Simple distributed lock using Redis SET NX EX."""

    def __init__(self, key: str, ttl_seconds: int = 30):
        self.key = f"lock:{key}"
        self.ttl = ttl_seconds
        self._token: str | None = None

    async def __aenter__(self) -> "RedisLock":
        import secrets
        redis = await get_redis()
        self._token = secrets.token_hex(16)
        acquired = await redis.set(
            self.key, self._token, nx=True, ex=self.ttl
        )
        if not acquired:
            raise RuntimeError(f"Could not acquire lock: {self.key}")
        return self

    async def __aexit__(self, *args: Any) -> None:
        redis = await get_redis()
        # Only release if we own the lock (Lua script for atomicity)
        lua_script = """
        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
        else
            return 0
        end
        """
        await redis.eval(lua_script, 1, self.key, self._token)
