"""Inbox request validation and read projections (Stage 2 / S2-T04)."""
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, field_validator

# Reuse the exact Journal request rules without changing its business behavior.
from app.journal.schemas import _validate_content, _validate_title


class InboxCreate(BaseModel):
    title: str | None = None
    content: str
    inbox_date: date
    is_daily: bool = False
    folder_id: int | None = None

    _check_title = field_validator('title')(_validate_title)
    _check_content = field_validator('content')(_validate_content)


class InboxUpdate(BaseModel):
    """Only submitted title/content/folder_id are writable; extra fields are ignored."""
    title: str | None = None
    # Omission is allowed; an explicitly submitted null still fails str validation.
    content: str = None
    folder_id: int | None = None

    _check_title = field_validator('title')(_validate_title)
    _check_content = field_validator('content')(_validate_content)


class InboxResponse(BaseModel):
    type: Literal['inbox'] = 'inbox'
    id: int
    title: str | None
    display_title: str
    content: str
    inbox_date: date
    is_daily: bool
    folder_id: int | None
    created_at: datetime
    updated_at: datetime
    # M2's column is retained but unused. Inbox has no soft-delete response state.
    deleted_at: None = None


class InboxPage(BaseModel):
    items: list[InboxResponse]
    page: int
    page_size: int
    total: int
    has_next: bool


class DailyInboxResponse(BaseModel):
    state: Literal['missing', 'active']
    id: int | None
    file: InboxResponse | None
