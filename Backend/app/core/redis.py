"""
DocFlow Backend — Core: Redis
Async Redis connection pool. Used for: cache, pub/sub, Celery broker.
Provides a simple interface for common cache operations.
"""
from __future__ import annotations

import json
from typing import Any

import redis.asyncio as aioredis

from app.config import settings

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

async def cache_get(key: str) -> Any | None:
    """Get a cached JSON value. Returns None on miss."""
    redis = await get_redis()
    value = await redis.get(key)
    if value is None:
        return None
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return value


async def cache_set(key: str, value: Any, ttl_seconds: int = 300) -> None:
    """Set a cached JSON value with TTL."""
    redis = await get_redis()
    await redis.setex(key, ttl_seconds, json.dumps(value, default=str))


async def cache_delete(key: str) -> None:
    """Delete a cached key."""
    redis = await get_redis()
    await redis.delete(key)


async def cache_delete_pattern(pattern: str) -> int:
    """Delete all keys matching a pattern (use sparingly — O(N))."""
    redis = await get_redis()
    keys = await redis.keys(pattern)
    if keys:
        return await redis.delete(*keys)
    return 0


# ── Pub/Sub Helpers ───────────────────────────────────────────────────────────

async def publish(channel: str, message: Any) -> None:
    """Publish a message to a Redis channel."""
    redis = await get_redis()
    payload = json.dumps(message, default=str)
    await redis.publish(channel, payload)


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
