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

    # ── Document Digital Signatures (RSA-PSS-SHA256) ────────────────────────
    # Requirements report §6.4: approval decisions are cryptographically
    # signed with a standard, reviewed algorithm — never a custom one — and
    # the private key is never stored in an application table or exposed to
    # the frontend. Same env-var-only pattern as JWT_PRIVATE_KEY above; see
    # app/core/signing.py for the dev-mode ephemeral-key fallback when unset.
    DOCUMENT_SIGNING_PRIVATE_KEY: str = ""
    DOCUMENT_SIGNING_PUBLIC_KEY: str = ""

    # ── Firebase ─────────────────────────────────────────────────────────────
    FIREBASE_PROJECT_ID: str = ""
    FIREBASE_CREDENTIALS_JSON: str = ""   # path or base64-encoded JSON
    # Revocation check needs a live call to Google on every login. Keep it on,
    # but by default tolerate that single step being unreachable (the token
    # signature is already verified) instead of locking everyone out.
    FIREBASE_CHECK_REVOKED: bool = True
    FIREBASE_REVOCATION_FAIL_CLOSED: bool = False

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
    # Provider-independent configuration. The Agent/RAG core never talks to a
    # vendor SDK directly — it goes through app/ai/base.py's LLMProvider and
    # EmbeddingProvider interfaces, and app/ai/registry.py picks the concrete
    # implementation from AI_PROVIDER / AI_EMBEDDING_PROVIDER. Switching
    # vendors is an env change, not a code change.
    #
    # Keys are read from the environment / Backend/.env ONLY — never
    # hardcoded, never sent to the frontend, never returned by any endpoint.
    AI_PROVIDER: Literal["gemini", "openai", "anthropic"] = "gemini"
    # Defaults to AI_PROVIDER when blank. Split out because providers differ
    # in embedding support (Anthropic has no embeddings endpoint), so a
    # deployment can e.g. generate with Anthropic and embed with Gemini.
    AI_EMBEDDING_PROVIDER: str = ""

    GEMINI_API_KEY: str = ""
    ANTHROPIC_API_KEY: str = ""
    OPENAI_API_KEY: str = ""

    # Chat/generation model. Blank falls back to the provider's default (see
    # app/ai/providers/*.DEFAULT_CHAT_MODEL).
    AI_MODEL: str = ""
    # Embedding model + its vector dimension. The dimension is persisted with
    # every stored chunk; retrieval ignores chunks embedded with a different
    # model/dimension and the admin UI surfaces them as needing re-embedding,
    # so switching models can never silently mix incompatible vector spaces.
    AI_EMBEDDING_MODEL: str = ""
    AI_EMBEDDING_DIM: int = 0        # 0 = use the provider default

    AI_REQUEST_TIMEOUT_SECONDS: float = 60.0
    AI_MAX_RETRIES: int = 2
    # Path to a CA bundle (PEM) for outbound AI HTTPS calls. Needed on
    # networks that terminate TLS with a private root (corporate proxy,
    # sandboxed CI), where the public bundle legitimately cannot verify the
    # presented chain. Leave blank to use the default trust store.
    # Certificate verification is NEVER disabled — supply the proxy's root
    # CA here (or via the standard SSL_CERT_FILE env var) instead.
    AI_CA_BUNDLE: str = ""
    # Route TLS verification through the OS certificate store (via the
    # `truststore` package) instead of Python's bundled certifi roots, so a
    # corporate/private root CA the machine already trusts is honoured.
    # Verification is still fully enforced — see app/core/trust.py.
    SSL_USE_OS_TRUST_STORE: bool = True
    # Retrieval tuning (§12.3 — "Tune retrieval thresholds against a
    # representative test set; do not assume one similarity threshold works
    # for every embedding model"), hence env-configurable rather than baked in.
    AI_RETRIEVAL_TOP_K: int = 6
    AI_RETRIEVAL_MIN_SIMILARITY: float = 0.25
    AI_CHUNK_TARGET_CHARS: int = 1200
    AI_CHUNK_OVERLAP_CHARS: int = 180

    # Legacy aliases kept so existing references don't break.
    AI_PRIMARY_MODEL: str = "claude-sonnet-4-5"
    AI_FALLBACK_MODEL: str = "gpt-4o-mini"

    # ── Email ─────────────────────────────────────────────────────────────────
    # Which transport actually sends mail:
    #   smtp    - any SMTP server/relay (Mailpit in dev, Gmail/SES/Brevo/... in prod)
    #   resend  - Resend's HTTPS API (returns a message id that can be queried
    #             later, so "accepted" can be told apart from "delivered")
    #   console - log the message instead of sending (dev only; never fails)
    EMAIL_PROVIDER: Literal["smtp", "resend", "console"] = "smtp"
    # How mail reaches the transport:
    #   queue  - publish to the Celery `email` queue (needs a running worker)
    #   inline - send directly from the API process, in a background thread
    EMAIL_DELIVERY_MODE: Literal["queue", "inline"] = "queue"
    # When True, mail is NEVER silently lost: if Redis is down, or Redis is up
    # but no worker is consuming the queue, the message is sent inline instead.
    # (Without this, a queue with no worker accepts mail and never sends it.)
    EMAIL_SYNC_FALLBACK: bool = True
    EMAIL_MAX_RETRIES: int = 5
    EMAIL_RETRY_BASE_SECONDS: int = 5      # backoff: base * 2**attempt (+ jitter)
    EMAIL_WORKER_CHECK_TTL_SECONDS: int = 30
    EMAIL_FROM: str = "noreply@docflow.local"
    EMAIL_FROM_NAME: str = "DocFlow"
    EMAIL_REPLY_TO: str = ""
    # SMTP envelope sender / bounce (Return-Path) address. Defaults to
    # EMAIL_FROM. Point it at a mailbox on your own domain (or your provider's
    # bounce domain) so bounces are collected and SPF aligns with From.
    EMAIL_ENVELOPE_FROM: str = ""
    # Optional public https URL of the logo PNG. Needed only for providers
    # that can't embed images (Resend); SMTP embeds the logo inline instead.
    EMAIL_LOGO_URL: str = ""
    RESEND_API_KEY: str = ""
    SMTP_HOST: str = "localhost"
    SMTP_PORT: int = 1025
    SMTP_TLS: bool = False        # STARTTLS (port 587)
    SMTP_SSL: bool = False        # implicit TLS (port 465)
    SMTP_USER: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_TIMEOUT_SECONDS: int = 15

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

    # Base URL of the deployed frontend — used to build absolute links
    # (deep_link paths) inside outgoing emails, which have no browser
    # context to resolve a relative path against.
    FRONTEND_URL: str = "http://localhost:5173"

    # ── Rate Limiting ─────────────────────────────────────────────────────────
    RATE_LIMIT_GLOBAL: str = "120/minute"
    RATE_LIMIT_AUTH: str = "10/minute"
    RATE_LIMIT_AI_CHAT: str = "100/hour"
    RATE_LIMIT_UPLOADS: str = "5/minute"

    # ── Admin Seed (dev/staging only — NEVER log or expose in API responses) ──
    # Used exclusively by scripts/seed_admin.py to bootstrap the initial admin.
    # In production, set these via environment variables only, never in code.
    ADMIN_EMAIL: str = ""
    ADMIN_PASSWORD: str = ""


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
        """True when the SELECTED provider actually has a key configured.
        Checking "any key is set" would wrongly report enabled when, say,
        AI_PROVIDER=gemini but only OPENAI_API_KEY is present."""
        return bool(self.ai_api_key_for(self.AI_PROVIDER))

    @property
    def ai_embedding_provider(self) -> str:
        return self.AI_EMBEDDING_PROVIDER or self.AI_PROVIDER

    def ai_api_key_for(self, provider: str) -> str:
        return {
            "gemini": self.GEMINI_API_KEY,
            "openai": self.OPENAI_API_KEY,
            "anthropic": self.ANTHROPIC_API_KEY,
        }.get(provider, "")

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
