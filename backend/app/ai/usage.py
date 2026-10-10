"""Token ledger reads/writes and the per-file call list.

Contract: ``docs/stage3-api.md`` §3 and ``docs/stage3-architecture.md`` §5.

Rules that this module is responsible for:

- one row per **model subcall**, uniquely identified by
  ``(request_id, subcall_index)``. Recording the same subcall twice must never
  create a second row and must never add its tokens a second time;
- official usage that is missing or unusable is stored as ``metering="unknown"``
  with NULL counters. It is *not* stored as ``0`` — "we were not told" and "it
  was zero" are different facts;
- cache hit/miss figures are kept for diagnostics only and are **not** added to
  ``prompt_tokens``; the provider already counts cached input there;
- the global total sums ``known`` subcalls only and counts unknown subcalls
  separately. A multi-source request is one ledger row, so it contributes to the
  global total exactly once even though it is listed under every source file;
- search requests are counted on their own axis and are never converted into
  model tokens;
- deleting a source sets ``ai_usage.request_id`` to NULL but keeps the row, so
  the anonymous global totals survive deletion.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as postgres_insert
from sqlalchemy.orm import Session

from app.ai.client import ModelUsage
from app.ai.models import AIRequest, AIUsage
from app.writing.service import WritingError

CALLS_PAGE_SIZE = 20


class SourceNotFound(WritingError):
    """The typed source identity has no ordinary, usable file (404)."""

    status_code = 404


@dataclass(frozen=True)
class UsageRecord:
    """Outcome of :func:`record_subcall`."""

    usage_id: UUID
    #: ``False`` when this subcall was already in the ledger and nothing changed.
    created: bool


def _canonical(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def call_payload_hash(payload: dict[str, Any]) -> str:
    """Stable hash of what a client actually submitted.

    Used to tell "same request replay" from "same key, different body" without
    storing a second copy of the content (``docs/stage3-architecture.md`` §5).
    """
    return hashlib.sha256(_canonical(payload).encode()).hexdigest()


def record_subcall(
    db: Session,
    *,
    request_id: UUID | None,
    subcall_index: int,
    usage: ModelUsage | None,
    response_id: str | None = None,
    search_requests: int = 0,
) -> UsageRecord:
    """Record exactly one model subcall and commit it.

    Called once per completed subcall so that a later failure (a second search
    round, a rejected answer) cannot erase tokens that were already spent. The
    unique constraint plus ``ON CONFLICT DO NOTHING`` makes a duplicate call a
    no-op instead of a double count.

    ``usage=None`` — or usage whose counters the provider did not send — is
    stored as ``unknown`` with NULL counters.
    """
    metering = "known" if usage is not None else "unknown"
    values = {
        "id": uuid4(),
        "request_id": request_id,
        "subcall_index": subcall_index,
        "response_id": response_id,
        "prompt_tokens": usage.prompt_tokens if usage is not None else None,
        "completion_tokens": usage.completion_tokens if usage is not None else None,
        "total_tokens": usage.total_tokens if usage is not None else None,
        "metering": metering,
        "search_requests": max(0, int(search_requests)),
        "created_at": datetime.now(timezone.utc),
    }
    # ``RETURNING`` is the only reliable "did this insert?" signal: SQLAlchemy
    # reports rowcount=-1 for statements whose rowcount is unknown, so testing
    # the rowcount would silently report every duplicate as a fresh insert.
    statement = postgres_insert(AIUsage).values(**values).returning(AIUsage.id)
    if request_id is not None:
        statement = statement.on_conflict_do_nothing(
            index_elements=[AIUsage.request_id, AIUsage.subcall_index]
        )
    inserted = db.execute(statement).scalar_one_or_none()
    created = inserted is not None
    row_id = values["id"]
    if not created:
        # A duplicate subcall: report the row that already owns this ledger slot.
        existing = db.scalar(
            select(AIUsage.id).where(
                AIUsage.request_id == request_id,
                AIUsage.subcall_index == subcall_index,
            )
        )
        if existing is not None:
            row_id = existing
    db.commit()
    return UsageRecord(usage_id=row_id, created=created)


def global_usage(db: Session) -> dict[str, int]:
    """Whole-software totals over every ledger row (pure read, no writes)."""
    row = db.execute(
        select(
            func.coalesce(func.sum(AIUsage.prompt_tokens), 0),
            func.coalesce(func.sum(AIUsage.completion_tokens), 0),
            func.coalesce(func.sum(AIUsage.total_tokens), 0),
            func.count().filter(AIUsage.metering == "unknown"),
            func.coalesce(func.sum(AIUsage.search_requests), 0),
        )
    ).one()
    return {
        "prompt_tokens": int(row[0]),
        "completion_tokens": int(row[1]),
        "total_tokens": int(row[2]),
        "unknown_subcalls": int(row[3]),
        "search_requests": int(row[4]),
    }


def _usage_totals(subcalls: int, unknown: int, prompt: int, completion: int,
                  total: int, searches: int) -> dict[str, int]:
    """Per-call totals over that call's subcalls; known-only for tokens."""
    return {
        "subcalls": subcalls,
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": total,
        "unknown_subcalls": unknown,
        "search_requests": searches,
    }


def request_usage(db: Session, request_id: UUID) -> dict[str, int] | None:
    """Totals for one request, or ``None`` when the request does not exist."""
    if db.scalar(select(AIRequest.id).where(AIRequest.id == request_id)) is None:
        return None
    return _aggregate(db, [request_id])[request_id]


def _aggregate(db: Session, request_ids: list[UUID]) -> dict[UUID, dict[str, int]]:
    totals: dict[UUID, dict[str, int]] = {
        request_id: _usage_totals(0, 0, 0, 0, 0, 0) for request_id in request_ids
    }
    if not request_ids:
        return totals
    rows = db.execute(
        select(
            AIUsage.request_id,
            func.count(),
            func.count().filter(AIUsage.metering == "unknown"),
            func.coalesce(func.sum(AIUsage.prompt_tokens), 0),
            func.coalesce(func.sum(AIUsage.completion_tokens), 0),
            func.coalesce(func.sum(AIUsage.total_tokens), 0),
            func.coalesce(func.sum(AIUsage.search_requests), 0),
        )
        .where(AIUsage.request_id.in_(request_ids))
        .group_by(AIUsage.request_id)
    ).all()
    for row in rows:
        totals[row[0]] = _usage_totals(
            int(row[1]), int(row[2]), int(row[3]), int(row[4]), int(row[5]), int(row[6])
        )
    return totals


def _source_identity(source: Any) -> dict[str, Any] | None:
    """Reduce a stored source snapshot to its typed identity.

    ``(type, id)`` is the only cross-table identity; no shared id space is
    assumed, and the private user snapshot is dropped here on purpose.
    """
    if not isinstance(source, dict):
        return None
    source_type = source.get("type")
    source_id = source.get("id")
    if source_type not in ("journal", "inbox"):
        return None
    if isinstance(source_id, bool) or not isinstance(source_id, int):
        return None
    identity: dict[str, Any] = {"type": source_type, "id": source_id}
    if isinstance(source.get("revision"), int) and not isinstance(source.get("revision"), bool):
        identity["revision"] = source["revision"]
    return identity


def _saved_target(request: AIRequest) -> dict[str, Any] | None:
    """Only a well-formed journal target is exposed; anything else stays hidden."""
    target = request.saved_target
    if not isinstance(target, dict):
        return None
    target_id = target.get("id")
    if target.get("type") != "journal":
        return None
    if isinstance(target_id, bool) or not isinstance(target_id, int):
        return None
    return {"type": "journal", "id": target_id}


def _summary(request: AIRequest, usage: dict[str, int]) -> dict[str, Any]:
    return {
        # JSON carries the UUID as its canonical string form.
        "request_id": str(request.id),
        "kind": request.kind,
        "status": request.status,
        "created_at": request.created_at,
        "completed_at": request.completed_at,
        **usage,
        "sources": [
            identity for identity in (_source_identity(s) for s in request.sources or [])
            if identity is not None
        ],
        "saved_target": _saved_target(request),
    }


def list_file_calls(db: Session, file_type: str, file_id: int, page: int) -> dict[str, Any]:
    """Fixed 20-row page of calls whose sources include this typed identity.

    A multi-source request appears in every one of its source files with the
    same ``request_id``. That is a *listing* fact only; the ledger still holds a
    single row, so ``GET /api/ai/usage`` counts it once.
    """
    require_source_file(db, file_type, file_id)
    identity_filter = AIRequest.sources.contains([{"type": file_type, "id": file_id}])
    total = db.scalar(select(func.count()).select_from(AIRequest).where(identity_filter)) or 0
    page = max(1, page)
    requests = db.scalars(
        select(AIRequest)
        .where(identity_filter)
        .order_by(AIRequest.created_at.desc(), AIRequest.id.desc())
        .offset((page - 1) * CALLS_PAGE_SIZE)
        .limit(CALLS_PAGE_SIZE)
    ).all()
    totals = _aggregate(db, [request.id for request in requests])
    return {
        "items": [_summary(request, totals[request.id]) for request in requests],
        "page": page,
        "page_size": CALLS_PAGE_SIZE,
        "total": int(total),
        "has_next": page * CALLS_PAGE_SIZE < int(total),
    }


def require_source_file(db: Session, file_type: str, file_id: int) -> None:
    """Validate a typed identity against the real file tables.

    Raises :class:`SourceNotFound` for an unknown type, a missing row or a
    soft-deleted Journal, which is how "源普通入口失效 404" is produced.
    """
    from app.inbox.models import Inbox
    from app.journal.models import Journal

    if file_type == "journal":
        exists = db.scalar(
            select(Journal.id).where(Journal.id == file_id, Journal.deleted_at.is_(None))
        )
    elif file_type == "inbox":
        exists = db.scalar(select(Inbox.id).where(Inbox.id == file_id))
    else:
        raise SourceNotFound("unsupported file type")
    if exists is None:
        raise SourceNotFound("file not found")
