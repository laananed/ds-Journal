from typing import Literal

from pydantic import BaseModel

from app.inbox.schemas import InboxResponse
from app.insight.schemas import InsightResponse
from app.journal.schemas import JournalResponse

SearchType = Literal['all', 'journal', 'inbox', 'insight']
SearchItem = JournalResponse | InboxResponse | InsightResponse


class SearchPage(BaseModel):
    items: list[SearchItem]
    page: int
    page_size: int
    total: int
    has_next: bool
