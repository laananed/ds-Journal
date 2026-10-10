"""Inbox safe writing inputs and separate list/detail projections."""
from datetime import date, datetime
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, PrivateAttr, field_validator
from app.journal.schemas import _validate_content, _validate_title
from app.writing.schemas import Block, Revision, StructuredCreate, StructuredInput


class InboxCreate(StructuredCreate):
    title: str | None = None
    inbox_date: date
    is_daily: bool = False
    folder_id: int | None = None
    client_create_id: UUID | None = None
    _check_title = field_validator('title')(_validate_title)
    _check_content = field_validator('content')(_validate_content)


class InboxUpdate(StructuredInput):
    title: str | None = None
    folder_id: int | None = None
    expected_revision: Revision = None
    _check_title = field_validator('title')(_validate_title)
    _check_content = field_validator('content')(_validate_content)


class InboxResponse(BaseModel):
    _creation_replayed: bool = PrivateAttr(default=False)
    type: Literal['inbox'] = 'inbox'
    id: int
    revision: Revision
    title: str | None
    display_title: str
    content: str
    inbox_date: date
    is_daily: bool
    folder_id: int | None
    created_at: datetime
    updated_at: datetime
    deleted_at: None = None


class InboxDetail(InboxResponse):
    content_blocks: list[Block] | None = None


class InboxPage(BaseModel):
    items: list[InboxResponse]
    page: int
    page_size: int
    total: int
    has_next: bool


class DailyInboxResponse(BaseModel):
    state: Literal['missing', 'active']
    id: int | None
    file: InboxDetail | None
