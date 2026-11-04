"""
DocFlow Backend — AI: provider registry.

The single place that maps configuration → concrete provider. Everything
else in the app asks this module for an interface and never imports a
provider module directly, which is what makes the vendor swappable.

    AI_PROVIDER=gemini            # generation
    AI_EMBEDDING_PROVIDER=gemini  # embeddings (defaults to AI_PROVIDER)

Adding a provider = one module in app/ai/providers/ + one entry in the
tables below.
"""
from __future__ import annotations

import structlog

from app.ai.base import EmbeddingProvider, LLMProvider, ProviderCapabilities
from app.ai.errors import AINotConfiguredError, AIUnsupportedCapabilityError
from app.ai.providers.anthropic import AnthropicProvider
from app.ai.providers.gemini import GeminiProvider
from app.ai.providers.openai import OpenAIProvider
from app.config import settings

logger = structlog.get_logger(__name__)

_LLM_PROVIDERS: dict[str, type[LLMProvider]] = {
    "gemini": GeminiProvider,
    "openai": OpenAIProvider,
    "anthropic": AnthropicProvider,
}

# Anthropic is deliberately absent: it has no embeddings endpoint.
_EMBEDDING_PROVIDERS: dict[str, type[EmbeddingProvider]] = {
    "gemini": GeminiProvider,
    "openai": OpenAIProvider,
}

SUPPORTED_PROVIDERS = sorted(_LLM_PROVIDERS)


def get_llm_provider(name: str | None = None) -> LLMProvider:
    """
    The configured generation provider.

    Raises AINotConfiguredError when the provider is unknown or its key is
    missing — callers surface that as "AI is not configured" rather than a
    500, so the rest of the app keeps working.
    """
    provider_name = (name or settings.AI_PROVIDER or "").lower()
    cls = _LLM_PROVIDERS.get(provider_name)
    if cls is None:
        raise AINotConfiguredError(
            f"Unknown AI_PROVIDER '{provider_name}'. "
            f"Supported: {', '.join(SUPPORTED_PROVIDERS)}."
        )
    if not settings.ai_api_key_for(provider_name):
        raise AINotConfiguredError(
            f"AI_PROVIDER is '{provider_name}' but its API key is not set. "
            f"Add {provider_name.upper()}_API_KEY to Backend/.env."
        )
    return cls()


def get_embedding_provider(name: str | None = None) -> EmbeddingProvider:
    """The configured embedding provider (defaults to AI_EMBEDDING_PROVIDER,
    then AI_PROVIDER)."""
    provider_name = (name or settings.ai_embedding_provider or "").lower()
    if provider_name in _LLM_PROVIDERS and provider_name not in _EMBEDDING_PROVIDERS:
        raise AIUnsupportedCapabilityError(
            f"Provider '{provider_name}' does not offer embeddings. Set "
            f"AI_EMBEDDING_PROVIDER to one of: "
            f"{', '.join(sorted(_EMBEDDING_PROVIDERS))}."
        )
    cls = _EMBEDDING_PROVIDERS.get(provider_name)
    if cls is None:
        raise AINotConfiguredError(
            f"Unknown AI_EMBEDDING_PROVIDER '{provider_name}'. "
            f"Supported: {', '.join(sorted(_EMBEDDING_PROVIDERS))}."
        )
    if not settings.ai_api_key_for(provider_name):
        raise AINotConfiguredError(
            f"Embedding provider is '{provider_name}' but its API key is not "
            f"set. Add {provider_name.upper()}_API_KEY to Backend/.env."
        )
    return cls()


def describe_configuration() -> ProviderCapabilities:
    """
    Non-secret description of the current AI setup, for the admin UI and
    health checks. Never includes or hints at the key value — only whether
    one is present.
    """
    llm_name = (settings.AI_PROVIDER or "").lower()
    emb_name = (settings.ai_embedding_provider or "").lower()
    notes: list[str] = []

    caps = ProviderCapabilities(provider=llm_name)

    try:
        llm = get_llm_provider(llm_name)
        caps.chat_model = llm.chat_model
        caps.supports_generation = True
    except Exception as exc:
        caps.supports_generation = False
        notes.append(f"Generation unavailable: {exc}")

    try:
        emb = get_embedding_provider(emb_name)
        caps.embedding_model = emb.embedding_model
        caps.embedding_dim = emb.embedding_dim
        caps.supports_embeddings = True
    except Exception as exc:
        caps.supports_embeddings = False
        notes.append(f"Embeddings unavailable: {exc}")

    if emb_name != llm_name:
        notes.append(
            f"Generation uses '{llm_name}', embeddings use '{emb_name}'."
        )
    caps.notes = notes
    return caps
