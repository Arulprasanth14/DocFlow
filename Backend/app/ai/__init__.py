"""
DocFlow Backend — provider-independent AI layer.

Import from here (or from app.ai.registry) rather than from a provider
module, so the configured vendor stays swappable:

    from app.ai import get_llm_provider, get_embedding_provider
"""
from app.ai.base import (
    ChatMessage,
    EmbeddingProvider,
    EmbeddingResult,
    GenerationResult,
    LLMProvider,
    ProviderCapabilities,
)
from app.ai.errors import (
    AIError,
    AINotConfiguredError,
    AIRateLimitError,
    AIRequestError,
    AITransientError,
    AIUnsupportedCapabilityError,
)
from app.ai.registry import (
    SUPPORTED_PROVIDERS,
    describe_configuration,
    get_embedding_provider,
    get_llm_provider,
)

__all__ = [
    "ChatMessage",
    "EmbeddingProvider",
    "EmbeddingResult",
    "GenerationResult",
    "LLMProvider",
    "ProviderCapabilities",
    "AIError",
    "AINotConfiguredError",
    "AIRateLimitError",
    "AIRequestError",
    "AITransientError",
    "AIUnsupportedCapabilityError",
    "SUPPORTED_PROVIDERS",
    "describe_configuration",
    "get_embedding_provider",
    "get_llm_provider",
]
