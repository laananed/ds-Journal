"""HTTP routes for AI settings and metering (``docs/stage3-api.md`` §3).

``GET`` routes are pure reads: they never flush, never commit and never create
the settings row or any checkpoint. The only writes in this module are the
settings PATCH and its compare-and-swap.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.ai import settings as settings_service
from app.ai import usage as usage_service
from app.ai.schemas import (
    AICallsPage,
    AISettingsResponse,
    AISettingsUpdate,
    AIUsageResponse,
)
from app.ai.usage import SourceNotFound
from app.database import get_db

router = APIRouter(prefix="/api/ai", tags=["ai"])
files_router = APIRouter(prefix="/api/files", tags=["ai"])

_CONFLICT = "AI settings revision has changed; re-read and retry"
_PRECONDITION_REQUIRED = "expected_revision is required"


@router.get("/settings", response_model=AISettingsResponse)
def get_settings(db: Session = Depends(get_db)) -> dict[str, object]:
    """Default (``revision=0``) or persisted settings; performs zero writes."""
    return settings_service.read_settings(db)


@router.patch("/settings", response_model=AISettingsResponse)
def patch_settings(
    payload: AISettingsUpdate,
    db: Session = Depends(get_db),
) -> dict[str, object]:
    """Create the single settings row or apply one CAS update.

    ``expected_revision=0`` means "not created yet"; anything else must match the
    stored revision or the request fails with 409. The API key cannot be set
    here — only the server process environment holds it.
    """
    try:
        return settings_service.update_settings(
            db,
            expected_revision=payload.expected_revision,
            custom_prompt=payload.custom_prompt,
            web_enabled=payload.web_enabled,
        )
    except settings_service.SettingsPreconditionRequired as error:
        raise HTTPException(status_code=428, detail=_PRECONDITION_REQUIRED) from error
    except settings_service.SettingsConflict as error:
        raise HTTPException(status_code=409, detail=_CONFLICT) from error


@router.get("/usage", response_model=AIUsageResponse)
def get_usage(db: Session = Depends(get_db)) -> dict[str, int]:
    """Confirmed model tokens, unknown subcall count and search request count."""
    return usage_service.global_usage(db)


@files_router.get("/{type}/{id}/ai-calls", response_model=AICallsPage,
                  response_model_exclude_none=True)
def get_file_calls(
    type: Literal["journal", "inbox"],
    id: int,
    page: int = Query(1, ge=1),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    """Fixed 20-row page of calls whose sources include this typed identity."""
    try:
        return usage_service.list_file_calls(db, type, id, page)
    except SourceNotFound as error:
        raise HTTPException(status_code=404, detail="File not found") from error
