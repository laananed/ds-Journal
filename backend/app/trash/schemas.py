"""Trash reuses full file responses without new input restrictions."""
from typing import Literal

from pydantic import BaseModel

from app.insight.schemas import InsightResponse
from app.journal.schemas import JournalResponse

TrashType = Literal['journal', 'insight']
TrashFilter = Literal['all', 'journal', 'insight']
TrashItem = JournalResponse | InsightResponse


class TrashPage(BaseModel):
    items: list[TrashItem]
    page: int
    page_size: int
    total: int
    has_next: bool
