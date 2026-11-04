"""
DocFlow Backend — AI: shared HTTP plumbing for provider adapters.

Every provider talks to its vendor over plain HTTPS with httpx (already a
project dependency) rather than a vendor SDK. That keeps the dependency
surface small and means adding a provider is one small module, not a new
SDK with its own auth/retry/exception conventions to reconcile.

Centralised here: timeouts, bounded retries with exponential backoff for
retryable failures only, and translation of HTTP status codes into the
typed errors in app/ai/errors.py.
"""
from __future__ import annotations

import asyncio
import random
from typing import Any

import httpx
import structlog

from app.ai.errors import (
    AIRateLimitError,
    AIRequestError,
    AITransientError,
)
from app.config import settings

logger = structlog.get_logger(__name__)


def _redact(value: str) -> str:
    """Never log or raise an API key, even partially identifiable."""
    return "***redacted***" if value else ""


def _verify_option() -> object:
    """
    TLS verification setting for outbound AI calls.

    Returns a CA bundle path when one is configured (AI_CA_BUNDLE, or the
    standard SSL_CERT_FILE), else True to use the default trust store.
    Verification is never turned off: on a network that intercepts TLS with
    a private root, the correct fix is to trust that root explicitly, not to
    stop checking certificates.
    """
    import os

    bundle = settings.AI_CA_BUNDLE or os.environ.get("SSL_CERT_FILE") or ""
    if bundle and os.path.exists(bundle):
        return bundle
    if bundle:
        logger.warning("ai_ca_bundle_not_found", path=bundle)

    # No explicit bundle: fall back to the OS trust store when available,
    # which is what makes this work behind a TLS-inspecting proxy whose root
    # CA the machine already trusts.
    from app.core.trust import ensure_os_trust_store

    ensure_os_trust_store()
    return True


async def post_json(
    url: str,
    payload: dict[str, Any],
    *,
    headers: dict[str, str] | None = None,
    params: dict[str, str] | None = None,
    provider: str = "ai",
    timeout: float | None = None,
    max_retries: int | None = None,
) -> dict[str, Any]:
    """
    POST JSON and return the decoded response.

    Retries only on 429/5xx/timeout/connection errors, with jittered
    exponential backoff. A 4xx other than 429 is a request problem and is
    raised immediately — retrying it would just burn quota.
    """
    timeout = timeout if timeout is not None else settings.AI_REQUEST_TIMEOUT_SECONDS
    max_retries = max_retries if max_retries is not None else settings.AI_MAX_RETRIES

    attempt = 0
    last_error: Exception | None = None

    while attempt <= max_retries:
        try:
            async with httpx.AsyncClient(timeout=timeout, verify=_verify_option()) as client:
                resp = await client.post(
                    url, json=payload, headers=headers or {}, params=params or {}
                )

            if resp.status_code == 429:
                retry_after = resp.headers.get("retry-after")
                delay = float(retry_after) if retry_after and retry_after.isdigit() else None
                err = AIRateLimitError(
                    f"{provider} rate limit or quota exceeded", retry_after_seconds=delay
                )
                if attempt >= max_retries:
                    raise err
                last_error = err
                await _sleep_backoff(attempt, delay)
                attempt += 1
                continue

            if resp.status_code >= 500:
                err = AITransientError(
                    f"{provider} returned {resp.status_code} (server error)"
                )
                if attempt >= max_retries:
                    raise err
                last_error = err
                await _sleep_backoff(attempt)
                attempt += 1
                continue

            if resp.status_code >= 400:
                # Surface the vendor's own message (it names the bad model,
                # the too-long input, the safety block) but never echo the
                # request, which contains the key in some providers' params.
                detail = _extract_error_message(resp)
                raise AIRequestError(f"{provider} rejected the request: {detail}")

            return resp.json()

        except (httpx.TimeoutException, httpx.TransportError) as exc:
            err = AITransientError(f"{provider} connection failed: {type(exc).__name__}")
            if attempt >= max_retries:
                raise err from exc
            last_error = err
            await _sleep_backoff(attempt)
            attempt += 1

    # Loop only exits via return/raise, but keep this total for safety.
    raise last_error or AITransientError(f"{provider} request failed")


async def _sleep_backoff(attempt: int, explicit_delay: float | None = None) -> None:
    if explicit_delay is not None:
        await asyncio.sleep(min(explicit_delay, 30.0))
        return
    # 0.5s, 1s, 2s … plus jitter so concurrent callers don't retry in lockstep.
    delay = min(0.5 * (2**attempt), 8.0) + random.uniform(0, 0.25)
    await asyncio.sleep(delay)


def _extract_error_message(resp: httpx.Response) -> str:
    try:
        body = resp.json()
    except Exception:
        return f"HTTP {resp.status_code}"
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict):
            return str(err.get("message") or err.get("type") or f"HTTP {resp.status_code}")
        if isinstance(err, str):
            return err
        if "message" in body:
            return str(body["message"])
    return f"HTTP {resp.status_code}"
