"""Strict Pydantic contracts for ``/api/ai/*`` (``docs/stage3-api.md`` §3).

Two deliberate properties:

- ``extra="forbid"`` everywhere, so a browser cannot smuggle ``api_key``,
  ``model``, ``base_url`` or any other execution-end setting into a request.
  These are strict requests, not the legacy content schemas that ignore extras.
- Numeric limits on ``custom_prompt`` / ``expected_revision`` follow the
  code-point and bigint rules already used by the writing schemas.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.ai.settings import CUSTOM_PROMPT_MAX_CODE_POINTS, custom_prompt_limit_error
from app.writing.schemas import Revision

#: ``expected_revision=0`` means "no settings row exists yet"; every other value
#: must be a real stored revision >= 1.
ExpectedRevision = Annotated[int, Field(strict=True, ge=0, le=9223372036854775807)]


class AISettingsResponse(BaseModel):
    """Fixed settings shape. Contains status flags only — never a key."""

    custom_prompt: str
    web_enabled: bool
    revision: int
    model: str
    model_configured: bool
    search_configured: bool
    effective_web_enabled: bool


class AISettingsUpdate(BaseModel):
    #: ``hide_input_in_errors`` keeps the submitted value out of validation
    #: errors. A browser cannot set a key through this route, but an error body
    #: must still never echo back whatever the client happened to send.
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    #: Declared optional on purpose: the contract answers a *missing* version
    #: with 428 (a precondition problem), not with a Pydantic 422 body error.
    #: The service turns ``None`` into that 428, while an explicit JSON ``null``
    #: is rejected by the validator below.
    expected_revision: ExpectedRevision | None = None
    #: Omitted keeps the stored value; ``""`` clears it. ``None`` is rejected.
    custom_prompt: str | None = None
    web_enabled: bool | None = None

    @field_validator("custom_prompt")
    @classmethod
    def check_prompt(cls, value: str | None) -> str | None:
        if value is None:
            raise ValueError("custom_prompt cannot be null; send an empty string to clear it")
        error = custom_prompt_limit_error(value)
        if error is not None:
            raise ValueError(error)
        return value

    @field_validator("web_enabled")
    @classmethod
    def check_web_enabled(cls, value: bool | None) -> bool | None:
        if value is None:
            raise ValueError("web_enabled cannot be null")
        return value

    @model_validator(mode="after")
    def reject_explicit_null_revision(self):
        if "expected_revision" in self.model_fields_set and self.expected_revision is None:
            raise ValueError("expected_revision cannot be null")
        return self


class AIUsageResponse(BaseModel):
    """Confirmed totals plus the two things that are *not* tokens."""

    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    unknown_subcalls: int
    search_requests: int


class SourceIdentity(BaseModel):
    """Typed cross-table identity; no shared id space is assumed."""

    type: Literal["journal", "inbox"]
    id: int
    revision: int | None = None


class SavedTarget(BaseModel):
    type: Literal["journal"]
    id: int


class AICallSummary(BaseModel):
    """One call as seen from a file.

    Carries identities, status and metering. It deliberately excludes the
    question, the model result and the settings snapshot: a detail list is not a
    second copy of private request content.
    """

    request_id: str
    kind: str
    status: str
    created_at: datetime
    completed_at: datetime | None = None
    subcalls: int
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    unknown_subcalls: int
    search_requests: int
    sources: list[SourceIdentity]
    saved_target: SavedTarget | None = None


class AICallsPage(BaseModel):
    items: list[AICallSummary]
    page: int
    page_size: int
    total: int
    has_next: bool
