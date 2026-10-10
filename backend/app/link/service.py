"""Match current display titles in PostgreSQL before global count/pagination."""
from sqlalchemy import Date, Integer, String, case, cast, func, literal, select, union_all
from sqlalchemy.orm import Session

from app.inbox.models import Inbox
from app.insight.models import Insight
from app.insight.service import build_insight_display_title
from app.journal.models import Journal
from app.journal.titles import build_display_title, numbered_subquery, untitled_predicate
from app.link.schemas import JournalLinkCandidate, LinkCandidate, LinkPage

PAGE_SIZE = 20


def _candidates():
    numbered = numbered_subquery()
    day = cast(Journal.journal_date, String)
    journal_display = case(
        (~untitled_predicate(Journal.title), Journal.title),
        (numbered.c.seq > 1, day + literal(' (') + cast(numbered.c.seq, String) + literal(')')),
        else_=day,
    )
    branches = []
    for order, (kind, model, display) in enumerate((
        ('journal', Journal, journal_display),
        ('inbox', Inbox, func.coalesce(func.nullif(Inbox.title, ''), cast(Inbox.inbox_date, String))),
        ('insight', Insight, func.coalesce(func.nullif(Insight.title, ''), build_insight_display_title(None))),
    )):
        statement = select(
            literal(kind).label('type'), literal(order).label('type_order'),
            model.id, model.title, display.label('display_title'), model.created_at,
            (Journal.journal_date if kind == 'journal' else literal(None, type_=Date)).label('journal_date'),
            (numbered.c.seq if kind == 'journal' else literal(None, type_=Integer)).label('seq'),
        )
        if kind == 'journal':
            statement = statement.outerjoin(numbered, numbered.c.id == Journal.id)
        if kind != 'inbox':
            statement = statement.where(model.deleted_at.is_(None))
        branches.append(statement)
    return union_all(*branches).subquery('link_candidates')


def resolve_links(db: Session, title: str, page: int = 1) -> LinkPage:
    candidates = _candidates()
    matched = select(candidates).where(candidates.c.display_title == title).subquery('matched_links')
    with db.no_autoflush:
        total = db.scalar(select(func.count()).select_from(matched)) or 0
        rows = db.execute(select(matched).order_by(
            matched.c.type_order.asc(), matched.c.id.desc()
        ).limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE)).all()
    items = []
    for row in rows:
        fields = dict(type=row.type, id=row.id, title=row.title,
                      display_title=row.display_title, created_at=row.created_at)
        if row.type == 'journal':
            fields['display_title'] = build_display_title(row.title, row.journal_date, row.seq)
            items.append(JournalLinkCandidate(**fields, journal_date=row.journal_date))
        else:
            items.append(LinkCandidate(**fields))
    return LinkPage(items=items, page=page, page_size=PAGE_SIZE,
                    total=total, has_next=page * PAGE_SIZE < total)
