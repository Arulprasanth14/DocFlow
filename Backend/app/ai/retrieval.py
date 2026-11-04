"""
DocFlow Backend — AI: hybrid retrieval for the RAG pipeline (§12.3).

Two independent signals, combined:

  semantic  — cosine similarity between the query embedding and each
              chunk's stored embedding
  keyword   — Postgres trigram/ILIKE matching on the chunk text

§12.3 asks for "hybrid retrieval, such as semantic vector search combined
with keyword/BM25 retrieval, when supported by the current architecture".
Postgres full-text (ts_rank) stands in for BM25 here; the two scores are
blended with Reciprocal Rank Fusion, which needs no score calibration
between the two very differently-scaled signals.

Hard rules enforced here, not left to the model:
  1. ORGANIZATION SCOPE IS APPLIED IN SQL, before any similarity is
     computed (§12.3: "Every retrieval operation must be scoped to the
     current organization before similarity search results are returned.
     Do not rely on the LLM to enforce tenant isolation.")
  2. Only chunks from READY, non-archived sources are candidates, so
     replaced or withdrawn legal text is never served (§12.2: "Re-index or
     invalidate old chunks when a document is replaced or archived. Avoid
     serving stale legal text after an update.")
  3. Only chunks whose (embedding_model, embedding_dim) matches the CURRENT
     embedding configuration are eligible for the semantic signal — vectors
     from a different model are not comparable, so they are excluded and
     reported as needing re-embedding rather than silently mixed in.

Vector storage note: embeddings are a float array column (portable to any
Postgres; the local dev instance has no pgvector) and cosine similarity is
computed in Python over the org-scoped candidate set. That is correct and
tenant-safe at the scale of an organization's policy corpus. For a corpus
large enough that loading candidate vectors becomes the bottleneck, swap
`_semantic_candidates` for a pgvector `<=>` ORDER BY — it is the only
function that would need to change.
"""
from __future__ import annotations

import math
import uuid
from dataclasses import dataclass

import structlog
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.agent import AgentChunk, AgentKnowledgeSource, IngestionStatus

logger = structlog.get_logger(__name__)


@dataclass
class RetrievedChunk:
    chunk_id: uuid.UUID
    source_id: uuid.UUID
    source_title: str
    chunk_index: int
    content: str
    page_number: int | None
    section_label: str | None
    similarity: float
    keyword_rank: float | None = None
    version_label: str | None = None
    effective_date: str | None = None
    is_archived_source: bool = False


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Plain cosine similarity. Returns 0.0 for zero/mismatched vectors
    rather than raising — a malformed stored vector should degrade one
    result, not fail the whole query."""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 0.0 or nb <= 0.0:
        return 0.0
    return dot / (math.sqrt(na) * math.sqrt(nb))


class Retriever:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def embedding_health(self, org_id: uuid.UUID, model: str, dim: int) -> dict:
        """
        How much of this org's indexed knowledge is usable with the CURRENT
        embedding configuration. Drives the admin UI's "N sources need
        re-embedding after a model change" warning.
        """
        rows = (
            await self.db.execute(
                select(
                    AgentChunk.embedding_model,
                    AgentChunk.embedding_dim,
                    func.count(),
                )
                .where(AgentChunk.org_id == org_id)
                .group_by(AgentChunk.embedding_model, AgentChunk.embedding_dim)
            )
        ).all()

        compatible = 0
        incompatible: list[dict] = []
        for m, d, count in rows:
            if m == model and d == dim:
                compatible += int(count)
            else:
                incompatible.append(
                    {"model": m, "dim": d, "chunks": int(count)}
                )
        return {
            "current_model": model,
            "current_dim": dim,
            "compatible_chunks": compatible,
            "incompatible_groups": incompatible,
            "needs_reembedding": bool(incompatible),
        }

    async def retrieve(
        self,
        org_id: uuid.UUID,
        query: str,
        query_embedding: list[float] | None,
        *,
        model: str,
        dim: int,
        top_k: int | None = None,
        min_similarity: float | None = None,
    ) -> tuple[list[RetrievedChunk], dict]:
        """
        Return (chunks, diagnostics). Diagnostics carry counts and scores
        only — never document text — so they are safe to log (§12.5).
        """
        top_k = top_k or settings.AI_RETRIEVAL_TOP_K
        min_similarity = (
            min_similarity
            if min_similarity is not None
            else settings.AI_RETRIEVAL_MIN_SIMILARITY
        )

        semantic = (
            await self._semantic_candidates(org_id, query_embedding, model, dim)
            if query_embedding
            else []
        )
        keyword = await self._keyword_candidates(org_id, query, limit=top_k * 4)

        fused = self._fuse(semantic, keyword, top_k=top_k)

        # Apply the similarity floor only to results that have a semantic
        # score. A keyword-only hit has no comparable similarity, so judging
        # it against a cosine threshold would silently drop exact-phrase
        # matches (the case keyword search exists for).
        kept = [
            c for c in fused
            if c.similarity >= min_similarity or c.keyword_rank is not None
        ]

        diagnostics = {
            "query_chars": len(query),
            "semantic_candidates": len(semantic),
            "keyword_candidates": len(keyword),
            "fused": len(fused),
            "returned": len(kept),
            "top_similarity": round(max((c.similarity for c in kept), default=0.0), 4),
            "min_similarity_threshold": min_similarity,
            "embedding_model": model,
            "embedding_dim": dim,
            "had_query_embedding": bool(query_embedding),
        }
        return kept[:top_k], diagnostics

    async def _base_candidate_query(self, org_id: uuid.UUID):
        """
        Chunks eligible for retrieval at all: this org only, from a READY,
        non-archived source. This is the tenant boundary and it lives in
        SQL.
        """
        return (
            select(AgentChunk, AgentKnowledgeSource)
            .join(AgentKnowledgeSource, AgentKnowledgeSource.id == AgentChunk.source_id)
            .where(
                AgentChunk.org_id == org_id,
                AgentKnowledgeSource.org_id == org_id,
                AgentKnowledgeSource.status == IngestionStatus.READY,
                AgentKnowledgeSource.archived_at.is_(None),
                AgentKnowledgeSource.deleted_at.is_(None),
                AgentChunk.deleted_at.is_(None),
            )
        )

    async def _semantic_candidates(
        self,
        org_id: uuid.UUID,
        query_embedding: list[float],
        model: str,
        dim: int,
    ) -> list[RetrievedChunk]:
        q = (await self._base_candidate_query(org_id)).where(
            AgentChunk.embedding.is_not(None),
            # Only the current embedding space — see module docstring rule 3.
            AgentChunk.embedding_model == model,
            AgentChunk.embedding_dim == dim,
        )
        rows = (await self.db.execute(q)).all()

        scored: list[RetrievedChunk] = []
        for chunk, source in rows:
            sim = cosine_similarity(query_embedding, chunk.embedding or [])
            scored.append(_to_retrieved(chunk, source, similarity=sim))
        scored.sort(key=lambda c: c.similarity, reverse=True)
        return scored

    async def _keyword_candidates(
        self, org_id: uuid.UUID, query: str, limit: int
    ) -> list[RetrievedChunk]:
        terms = [t for t in _tokenize(query) if len(t) > 2]
        if not terms:
            return []

        q = await self._base_candidate_query(org_id)
        # websearch_to_tsquery tolerates arbitrary user input (quotes, OR,
        # punctuation) without raising the way to_tsquery does.
        ts_query = func.websearch_to_tsquery("english", query)
        ts_vector = func.to_tsvector("english", AgentChunk.content)
        rank = func.ts_rank(ts_vector, ts_query)

        q = q.where(
            or_(
                ts_vector.op("@@")(ts_query),
                *[AgentChunk.content.ilike(f"%{t}%") for t in terms[:5]],
            )
        ).order_by(rank.desc()).limit(limit)

        rows = (await self.db.execute(q)).all()
        out: list[RetrievedChunk] = []
        for position, (chunk, source) in enumerate(rows):
            rc = _to_retrieved(chunk, source, similarity=0.0)
            # Rank by position; ts_rank's absolute value isn't comparable to
            # cosine, and RRF only needs the ordering.
            rc.keyword_rank = 1.0 / (position + 1)
            out.append(rc)
        return out

    @staticmethod
    def _fuse(
        semantic: list[RetrievedChunk],
        keyword: list[RetrievedChunk],
        *,
        top_k: int,
        k: int = 60,
    ) -> list[RetrievedChunk]:
        """
        Reciprocal Rank Fusion: score = Σ 1/(k + rank). Scale-free, so it
        combines cosine similarity and ts_rank without needing either
        normalised — which is exactly why it's preferred over a weighted sum
        of two incomparable scores.
        """
        scores: dict[uuid.UUID, float] = {}
        best: dict[uuid.UUID, RetrievedChunk] = {}

        for rank, c in enumerate(semantic, start=1):
            scores[c.chunk_id] = scores.get(c.chunk_id, 0.0) + 1.0 / (k + rank)
            best[c.chunk_id] = c

        for rank, c in enumerate(keyword, start=1):
            scores[c.chunk_id] = scores.get(c.chunk_id, 0.0) + 1.0 / (k + rank)
            if c.chunk_id in best:
                # Keep the semantic similarity, add the keyword signal.
                best[c.chunk_id].keyword_rank = c.keyword_rank
            else:
                best[c.chunk_id] = c

        ordered = sorted(best.values(), key=lambda c: scores[c.chunk_id], reverse=True)
        return ordered[: max(top_k * 2, top_k)]


def _to_retrieved(chunk, source, *, similarity: float) -> RetrievedChunk:
    return RetrievedChunk(
        chunk_id=chunk.id,
        source_id=source.id,
        source_title=source.title,
        chunk_index=chunk.chunk_index,
        content=chunk.content,
        page_number=chunk.page_number,
        section_label=chunk.section_label,
        similarity=round(float(similarity), 6),
        version_label=source.version_label,
        effective_date=(
            source.effective_date.isoformat() if source.effective_date else None
        ),
        is_archived_source=source.archived_at is not None,
    )


def _tokenize(text: str) -> list[str]:
    import re

    return [t for t in re.split(r"[^\w]+", (text or "").lower()) if t]
