"""
DocFlow Backend — AI: provider-independent interfaces.

The Agent/RAG core (app/services/agent_service.py) depends ONLY on the
abstractions in this module. Concrete vendors live in app/ai/providers/*
and are selected at runtime from environment configuration by
app/ai/registry.py, so swapping Gemini → OpenAI → Anthropic is a config
change and never a rewrite of the Agent logic.

Two separate capabilities, deliberately not merged into one interface:

  LLMProvider       — text generation (chat/completion)
  EmbeddingProvider — turning text into vectors for retrieval

They are split because providers differ: Anthropic, for example, offers
generation but no embeddings endpoint, so a deployment may legitimately
generate with one vendor and embed with another. Embedding vectors also
carry a hard compatibility constraint that generation does not — see
EmbeddingResult.
"""
from __future__ import annotations

import abc
from dataclasses import dataclass, field


@dataclass(frozen=True)
class ChatMessage:
    """One turn in a conversation. `role` is "user" or "assistant";
    system instructions are passed separately to generate() because
    providers wire them differently (Gemini: systemInstruction, OpenAI: a
    system message, Anthropic: a top-level system parameter)."""
    role: str
    content: str


@dataclass(frozen=True)
class GenerationResult:
    text: str
    model: str
    provider: str
    # Token accounting where the provider reports it — used for cost/latency
    # diagnostics, never for billing decisions.
    input_tokens: int | None = None
    output_tokens: int | None = None
    # True when the provider stopped early (length cap, safety filter, …),
    # so callers can tell a deliberate refusal from a truncated answer.
    truncated: bool = False
    finish_reason: str | None = None


@dataclass(frozen=True)
class EmbeddingResult:
    """
    Vectors plus the identity of the space they live in.

    `model` and `dim` are persisted alongside every stored chunk. Two
    vectors are only comparable when BOTH match: cosine similarity between
    different models' embeddings is meaningless even when the dimensions
    happen to agree. The retrieval layer therefore filters on
    (model, dim) and treats anything else as "needs re-embedding" rather
    than silently mixing incompatible spaces.
    """
    vectors: list[list[float]]
    model: str
    provider: str
    dim: int
    input_tokens: int | None = None


class LLMProvider(abc.ABC):
    """Text generation."""

    name: str = "abstract"

    @property
    @abc.abstractmethod
    def chat_model(self) -> str:
        """The model id this instance will generate with."""

    @abc.abstractmethod
    async def generate(
        self,
        messages: list[ChatMessage],
        *,
        system: str | None = None,
        temperature: float = 0.2,
        max_output_tokens: int = 1024,
    ) -> GenerationResult:
        """
        Generate a reply. Implementations must raise the typed errors from
        app/ai/errors.py — never leak a vendor-specific exception or an HTTP
        status code to callers, and never include the API key in an error
        message.
        """

    async def stream(
        self,
        messages: list[ChatMessage],
        *,
        system: str | None = None,
        temperature: float = 0.2,
        max_output_tokens: int = 1024,
    ):
        """
        Stream text deltas. Concrete providers override with native streaming.
        Default implementation yields the complete generated text as a single delta.
        """
        result = await self.generate(
            messages,
            system=system,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
        )
        yield result.text


class EmbeddingProvider(abc.ABC):
    """Text → vector."""

    name: str = "abstract"

    @property
    @abc.abstractmethod
    def embedding_model(self) -> str: ...

    @property
    @abc.abstractmethod
    def embedding_dim(self) -> int: ...

    @abc.abstractmethod
    async def embed(
        self, texts: list[str], *, purpose: str = "document"
    ) -> EmbeddingResult:
        """
        Embed a batch of texts.

        `purpose` is "document" when indexing stored content and "query"
        when embedding a user question. Some providers (Gemini among them)
        produce measurably better retrieval when told which side of the
        comparison a text is on; providers that don't distinguish simply
        ignore it.
        """


@dataclass
class ProviderCapabilities:
    """What a configured provider can actually do — surfaced to the admin UI
    so a missing capability is visible before someone depends on it."""
    provider: str
    supports_generation: bool = True
    supports_embeddings: bool = True
    chat_model: str | None = None
    embedding_model: str | None = None
    embedding_dim: int | None = None
    notes: list[str] = field(default_factory=list)
