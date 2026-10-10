"""Parameterised raw title/content search, globally paginated in PostgreSQL."""
from sqlalchemy import Boolean, Date, Integer, func, literal, or_, select, union_all
from sqlalchemy.orm import Session

from app.inbox.models import Inbox
from app.inbox.schemas import InboxResponse
from app.insight.models import Insight
from app.insight.schemas import InsightResponse
from app.insight.service import build_insight_display_title
from app.journal.models import Journal
from app.journal.schemas import JournalResponse
from app.journal.titles import build_display_title, numbered_subquery
from app.search.schemas import SearchItem, SearchPage, SearchType

PAGE_SIZE = 20


def _pattern(word: str) -> str:
    # Escape the escape character first. SQLAlchemy binds this value, never
    # interpolates it into SQL; LIKE wildcards supplied by the user are literal.
    return '%' + word.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'


def _branch(kind: str, model, order: int, patterns: list[str]):
    columns = [
        literal(kind).label('type'), literal(order).label('type_order'),
        model.id, model.revision, model.title, model.content, model.folder_id,
        model.created_at, model.updated_at,
        (literal(None, type_=Journal.deleted_at.type) if kind == 'inbox'
         else model.deleted_at).label('deleted_at'),
    ]
    conditions = [or_(model.title.ilike(pattern, escape='\\'),
                      model.content.ilike(pattern, escape='\\')) for pattern in patterns]
    if kind != 'inbox':
        conditions.append(model.deleted_at.is_(None))
    if kind == 'journal':
        numbered = numbered_subquery()
        return select(
            *columns, Journal.journal_date.label('business_date'),
            literal(None, type_=Boolean).label('is_daily'), numbered.c.seq,
        ).outerjoin(numbered, numbered.c.id == Journal.id).where(*conditions)
    return select(
        *columns,
        (Inbox.inbox_date if kind == 'inbox' else literal(None, type_=Date)).label('business_date'),
        (Inbox.is_daily if kind == 'inbox' else literal(None, type_=Boolean)).label('is_daily'),
        literal(None, type_=Integer).label('seq'),
    ).where(*conditions)


def _to_response(row) -> SearchItem:
    fields = {key: getattr(row, key) for key in (
        'type', 'id', 'revision', 'title', 'content', 'folder_id', 'created_at', 'updated_at', 'deleted_at'
    )}
    if row.type == 'journal':
        return JournalResponse(**fields, journal_date=row.business_date,
                               display_title=build_display_title(row.title, row.business_date, row.seq))
    if row.type == 'inbox':
        return InboxResponse(**fields, inbox_date=row.business_date, is_daily=row.is_daily,
                             display_title=row.title or row.business_date.isoformat())
    return InsightResponse(**fields, display_title=build_insight_display_title(row.title))


def search_files(db: Session, q: str = '', type: SearchType = 'all', page: int = 1) -> SearchPage:
    words = list(dict.fromkeys(q.split()))
    if not words:
        return SearchPage(items=[], page=page, page_size=PAGE_SIZE, total=0, has_next=False)
    patterns = [_pattern(word) for word in words]
    branches = [_branch(kind, model, order, patterns) for order, (kind, model) in enumerate(
        (('journal', Journal), ('inbox', Inbox), ('insight', Insight))
    ) if type == 'all' or type == kind]
    matched = union_all(*branches).subquery('search_files')
    # GET cannot autoflush pending state when a Session is reused in a test.
    with db.no_autoflush:
        total = db.scalar(select(func.count()).select_from(matched)) or 0
        rows = db.execute(select(matched).order_by(
            matched.c.updated_at.desc(), matched.c.type_order.asc(), matched.c.id.desc()
        ).limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE)).all()
    return SearchPage(items=[_to_response(row) for row in rows], page=page,
                      page_size=PAGE_SIZE, total=total, has_next=page * PAGE_SIZE < total)
