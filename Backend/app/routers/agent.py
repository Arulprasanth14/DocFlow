"""
DocFlow Backend — Router: AI Agent (§12)

User-facing:
  POST   /api/v1/agent/ask                       — ask a question (RAG)
  GET    /api/v1/agent/conversations             — my Agent threads
  GET    /api/v1/agent/conversations/{id}        — one thread with citations
  POST   /api/v1/agent/messages/{id}/feedback    — rate an answer
  GET    /api/v1/agent/status                    — is the Agent configured?

Main Administrator only (§13.6):
  GET    /api/v1/agent/knowledge                 — sources + index health
  POST   /api/v1/agent/knowledge                 — upload a legal document
  POST   /api/v1/agent/knowledge/{id}/reembed    — re-embed after a model change
  POST   /api/v1/agent/knowledge/{id}/archive    — withdraw a source

Note on route order: literal paths are declared before any "{id}" route in
the same shape, since FastAPI matches in declaration order.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, File, Form, Path, Query, UploadFile, status
from pydantic import BaseModel, Field

from app.ai import describe_configuration
from app.config import settings
from app.dependencies import CurrentUser, DatabaseDep
from app.services.agent_service import AgentService

router = APIRouter(prefix="/agent", tags=["AI Agent"])


class AskRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=4000)
    conversation_id: uuid.UUID | None = None


class FeedbackRequest(BaseModel):
    vote: str = Field(..., pattern="^(up|down)$")
    note: str | None = Field(default=None, max_length=2000)


# ── Status ──────────────────────────────────────────────────────────────────

@router.get("/status", summary="Whether the AI Agent is configured on this server")
async def agent_status(current_user: CurrentUser) -> dict:
    """
    Non-secret description of the AI setup: which provider and models are
    selected and whether a key is present. Never returns the key itself or
    any part of it.
    """
    caps = describe_configuration()
    return {
        "enabled": caps.supports_generation and caps.supports_embeddings,
        "provider": caps.provider,
        "chat_model": caps.chat_model,
        "embedding_model": caps.embedding_model,
        "embedding_dim": caps.embedding_dim,
        "supports_generation": caps.supports_generation,
        "supports_embeddings": caps.supports_embeddings,
        "notes": caps.notes,
        "retrieval": {
            "top_k": settings.AI_RETRIEVAL_TOP_K,
            "min_similarity": settings.AI_RETRIEVAL_MIN_SIMILARITY,
        },
    }


# ── Knowledge management (Main Administrator only) ──────────────────────────

@router.get("/knowledge", summary="List Agent knowledge sources and index health")
async def list_knowledge(
    current_user: CurrentUser,
    db: DatabaseDep,
    include_archived: Annotated[bool, Query()] = True,
) -> dict:
    svc = AgentService(db)
    return await svc.list_sources(current_user, include_archived=include_archived)


@router.post(
    "/knowledge",
    status_code=status.HTTP_201_CREATED,
    summary="Upload a legal/policy document into the Agent's knowledge base",
)
async def upload_knowledge(
    current_user: CurrentUser,
    db: DatabaseDep,
    file: UploadFile = File(...),
    title: str = Form(...),
    category: Optional[str] = Form(None),
    version_label: Optional[str] = Form(None),
    effective_date: Optional[datetime] = Form(None),
    review_due_at: Optional[datetime] = Form(None),
    replaces_source_id: Optional[uuid.UUID] = Form(None),
) -> dict:
    """
    Ingests the file synchronously: extract → chunk → embed → index.

    The response always includes `status` and, on failure, a human-readable
    `extraction_error` (e.g. "this PDF is scanned and needs OCR"), rather
    than reporting success for a document that produced no indexable text.
    """
    svc = AgentService(db)
    data = await file.read()
    source = await svc.create_source(
        user=current_user,
        title=title,
        data=data,
        filename=file.filename,
        mime_type=file.content_type,
        category=category,
        version_label=version_label,
        effective_date=effective_date,
        review_due_at=review_due_at,
        replaces_source_id=replaces_source_id,
    )
    from app.services.agent_service import _source_dict

    return _source_dict(source)


@router.post(
    "/knowledge/{source_id}/reembed",
    summary="Re-embed a source with the current embedding model",
)
async def reembed_knowledge(
    source_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    db: DatabaseDep,
) -> dict:
    svc = AgentService(db)
    source = await svc.reembed_source(current_user, source_id)
    from app.services.agent_service import _source_dict

    return _source_dict(source)


@router.post(
    "/knowledge/{source_id}/archive",
    summary="Archive (withdraw) a knowledge source so it is no longer retrieved",
)
async def archive_knowledge(
    source_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    db: DatabaseDep,
    reason: Annotated[Optional[str], Query(max_length=500)] = None,
) -> dict:
    svc = AgentService(db)
    source = await svc.archive_source(current_user, source_id, reason=reason)
    from app.services.agent_service import _source_dict

    return _source_dict(source)


# ── Ask / conversations (all roles) ─────────────────────────────────────────

@router.post("/ask", summary="Ask the Agent a question about your organization")
async def ask(
    req: AskRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> dict:
    """
    Retrieval is scoped to the caller's organization in SQL before any
    similarity search runs, and the answer cites the exact passages used.
    When the indexed documents don't support an answer, the Agent says so
    (`answer_state: "insufficient_evidence"`) instead of guessing.
    """
    svc = AgentService(db)
    return await svc.ask(current_user, req.question, req.conversation_id)


@router.get("/conversations", summary="My Agent conversations")
async def list_conversations(
    current_user: CurrentUser,
    db: DatabaseDep,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
) -> list[dict]:
    svc = AgentService(db)
    return await svc.list_conversations(current_user, limit=limit)


@router.get("/conversations/{conversation_id}", summary="One Agent conversation")
async def get_conversation(
    conversation_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    db: DatabaseDep,
) -> dict:
    svc = AgentService(db)
    return await svc.get_conversation(current_user, conversation_id)


@router.post("/messages/{message_id}/feedback", summary="Rate an Agent answer")
async def submit_feedback(
    message_id: Annotated[uuid.UUID, Path(...)],
    req: FeedbackRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> dict:
    svc = AgentService(db)
    return await svc.submit_feedback(current_user, message_id, req.vote, req.note)
