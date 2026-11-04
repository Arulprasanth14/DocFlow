"""
DocFlow Backend — Router: Unified Search

  GET /api/v1/search — one entry point for documents, workflows, members,
                       and messages the signed-in user may access (§8)

Previously there was no search endpoint at all: the frontend Search page
rendered a hardcoded MOCK_RESULTS array, which the requirements explicitly
forbid ("Do not use hardcoded or mock values ... All data must come from
the actual backend and database").
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Query

from app.dependencies import CurrentUser, DatabaseDep
from app.services.search_service import ALL_ENTITIES, SearchService

router = APIRouter(prefix="/search", tags=["Search"])


@router.get(
    "",
    summary="Search documents, workflows, members, and messages (permission-filtered)",
)
async def search(
    current_user: CurrentUser,
    db: DatabaseDep,
    q: Annotated[str, Query(description="Search text", max_length=200)] = "",
    entities: Annotated[
        Optional[str],
        Query(
            description=(
                "Comma-separated subset of: documents,workflows,members,messages. "
                "Defaults to all."
            )
        ),
    ] = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 10,
    offset: Annotated[int, Query(ge=0)] = 0,
    status: Annotated[Optional[str], Query()] = None,
    doc_type_id: Annotated[Optional[uuid.UUID], Query()] = None,
    dept_id: Annotated[Optional[uuid.UUID], Query()] = None,
    owner_id: Annotated[Optional[uuid.UUID], Query()] = None,
    date_from: Annotated[Optional[datetime], Query()] = None,
    date_to: Annotated[Optional[datetime], Query()] = None,
    sort: Annotated[
        Literal["relevance", "newest", "oldest", "title"], Query()
    ] = "relevance",
) -> dict:
    """
    Results are grouped per entity type, each with its own total so the UI
    can paginate groups independently and show accurate counts.

    Authorization is applied inside the SQL for every group — a document,
    workflow, member, or message the caller cannot access never appears,
    not even as a title or snippet (§8).
    """
    if not current_user.org_id:
        return {"query": q, "groups": {}, "total": 0, "entities": []}

    requested = ALL_ENTITIES
    if entities:
        wanted = {e.strip() for e in entities.split(",") if e.strip()}
        requested = tuple(e for e in ALL_ENTITIES if e in wanted) or ALL_ENTITIES

    svc = SearchService(db)
    return await svc.search(
        current_user,
        q=q,
        entities=requested,
        limit=limit,
        offset=offset,
        status=status,
        doc_type_id=doc_type_id,
        dept_id=dept_id,
        owner_id=owner_id,
        date_from=date_from,
        date_to=date_to,
        sort=sort,
    )
