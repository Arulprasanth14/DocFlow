"""
DocFlow Backend — Configuration
Pydantic BaseSettings: all env vars typed, validated, and documented.
App refuses to start if critical values are missing in production.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import AnyHttpUrl, PostgresDsn, RedisDsn, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Application ──────────────────────────────────────────────────────────
    APP_ENV: Literal["development", "staging", "production"] = "development"
    APP_DEBUG: bool = True
    APP_VERSION: str = "0.1.0"
    SECRET_KEY: str = "change-me-in-production"

    # ── Database ─────────────────────────────────────────────────────────────
    DATABASE_URL: str = "postgresql+asyncpg://docflow:docflow@localhost:5432/docflow"
    DATABASE_POOL_SIZE: int = 20
    DATABASE_MAX_OVERFLOW: int = 40
    DATABASE_ECHO: bool = False

    # ── Redis ─────────────────────────────────────────────────────────────────
    REDIS_URL: str = "redis://localhost:6379/0"
    REDIS_MAX_CONNECTIONS: int = 50

    # ── JWT (RS256) ───────────────────────────────────────────────────────────
    JWT_PRIVATE_KEY: str = ""
    JWT_PUBLIC_KEY: str = ""
    JWT_ALGORITHM: str = "RS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 120
    REFRESH_TOKEN_EXPIRE_DAYS: int = 30

    # ── Firebase ─────────────────────────────────────────────────────────────
    FIREBASE_PROJECT_ID: str = ""
    FIREBASE_CREDENTIALS_JSON: str = ""   # path or base64-encoded JSON

    # ── Storage ──────────────────────────────────────────────────────────────
    STORAGE_BACKEND: Literal["minio", "s3"] = "minio"
    AWS_ACCESS_KEY_ID: str = "minioadmin"
    AWS_SECRET_ACCESS_KEY: str = "minioadmin"
    AWS_REGION: str = "us-east-1"
    MINIO_ENDPOINT: str = "http://localhost:9000"
    S3_BUCKET_DOCUMENTS: str = "docflow-documents"
    S3_BUCKET_PREVIEWS: str = "docflow-previews"
    S3_BUCKET_EXPORTS: str = "docflow-exports"
    S3_BUCKET_OCR_INPUT: str = "docflow-ocr-input"
    S3_BUCKET_TEMPLATES: str = "docflow-templates"

    # ── AI ───────────────────────────────────────────────────────────────────
    ANTHROPIC_API_KEY: str = ""
    OPENAI_API_KEY: str = ""
    AI_PRIMARY_MODEL: str = "claude-sonnet-4-5"
    AI_FALLBACK_MODEL: str = "gpt-4o-mini"
    AI_EMBEDDING_MODEL: str = "text-embedding-3-small"

    # ── Email ─────────────────────────────────────────────────────────────────
    EMAIL_FROM: str = "noreply@docflow.local"
    EMAIL_FROM_NAME: str = "DocFlow"
    RESEND_API_KEY: str = ""
    SMTP_HOST: str = "localhost"
    SMTP_PORT: int = 1025
    SMTP_TLS: bool = False
    SMTP_USER: str = ""
    SMTP_PASSWORD: str = ""

    # ── Celery ────────────────────────────────────────────────────────────────
    CELERY_BROKER_URL: str = "redis://localhost:6379/1"
    CELERY_RESULT_BACKEND: str = "redis://localhost:6379/2"
    CELERY_WORKER_CONCURRENCY: int = 4

    # ── Observability ─────────────────────────────────────────────────────────
    SENTRY_DSN: str = ""
    OTEL_EXPORTER_OTLP_ENDPOINT: str = "http://localhost:4317"
    OTEL_SERVICE_NAME: str = "docflow-backend"
    LOG_LEVEL: str = "INFO"

    # ── CORS ─────────────────────────────────────────────────────────────────
    CORS_ORIGINS: list[str] = [
        "http://localhost:5173",
        "http://localhost:3000",
    ]

    # ── Rate Limiting ─────────────────────────────────────────────────────────
    RATE_LIMIT_GLOBAL: str = "120/minute"
    RATE_LIMIT_AUTH: str = "10/minute"
    RATE_LIMIT_AI_CHAT: str = "100/hour"
    RATE_LIMIT_UPLOADS: str = "5/minute"

    # ── Derived Properties ────────────────────────────────────────────────────
    @property
    def is_production(self) -> bool:
        return self.APP_ENV == "production"

    @property
    def is_development(self) -> bool:
        return self.APP_ENV == "development"

    @property
    def firebase_enabled(self) -> bool:
        return bool(self.FIREBASE_PROJECT_ID and self.FIREBASE_CREDENTIALS_JSON)

    @property
    def ai_enabled(self) -> bool:
        return bool(self.ANTHROPIC_API_KEY or self.OPENAI_API_KEY)

    def validate_production(self) -> None:
        """Call on startup in production to fail fast on misconfiguration."""
        if not self.is_production:
            return
        assert len(self.JWT_PRIVATE_KEY) > 100, "JWT_PRIVATE_KEY too short for production"
        assert len(self.SECRET_KEY) >= 32, "SECRET_KEY must be at least 32 chars in production"
        assert "localhost" not in self.DATABASE_URL, "Production DB cannot be localhost"
        assert self.SENTRY_DSN, "SENTRY_DSN must be set in production"


@lru_cache
def get_settings() -> Settings:
    """Cached settings singleton — import and call this everywhere."""
    return Settings()


# Module-level singleton for convenience
settings = get_settings()
