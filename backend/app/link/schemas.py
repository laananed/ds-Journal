from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel


class LinkCandidate(BaseModel):
    type: Literal['journal', 'inbox', 'insight']
    id: int
    title: str | None
    display_title: str
    created_at: datetime


class JournalLinkCandidate(LinkCandidate):
    type: Literal['journal'] = 'journal'
    journal_date: date


class LinkPage(BaseModel):
    items: list[JournalLinkCandidate | LinkCandidate]
    page: int
    page_size: int
    total: int
    has_next: bool
