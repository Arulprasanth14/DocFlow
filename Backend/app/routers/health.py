"""DocFlow Backend — Health Check Router"""
from __future__ import annotations

from fastapi import APIRouter
from sqlalchemy import text

router = APIRouter(tags=["Health"])


@router.get("/health", summary="Health check")
async def health():
    """Returns ok when the API is running."""
    return {"status": "ok", "service": "docflow-backend"}


@router.get("/health/live", summary="Liveness probe (DB + Redis)")
async def health_live():
    """
    Liveness probe for Kubernetes/Docker healthchecks.
    Verifies DB and Redis connectivity.
    """
    checks: dict[str, str] = {}

    # Check PostgreSQL
    try:
        from app.database import check_db_connection
        db_info = await check_db_connection()
        checks["postgres"] = "ok"
        checks["postgres_version"] = db_info.get("postgres_version", "")
    except Exception as exc:
        checks["postgres"] = f"error: {exc}"

    # Check Redis
    try:
        from app.core.redis import get_redis
        redis = await get_redis()
        await redis.ping()
        checks["redis"] = "ok"
    except Exception as exc:
        checks["redis"] = f"error: {exc}"

    all_ok = all(v == "ok" for k, v in checks.items() if k in ("postgres", "redis"))
    return {
        "status": "ok" if all_ok else "degraded",
        "checks": checks,
    }
