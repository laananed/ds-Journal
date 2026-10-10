"""Read deleted files, restore deletion state, or purge one deleted row.

All mixed sorting/counting/pagination runs in PostgreSQL. No Model,
include_deleted switch on ordinary endpoints, or Folder mutation is added.
"""
from sqlalchemy import Date, Integer, delete, func, literal, select, union_all, update
from sqlalchemy.orm import Session

from app.insight.models import Insight
from app.insight.schemas import InsightResponse
from app.insight.service import build_insight_display_title, get_insight
from app.journal.models import Journal
from app.journal.schemas import JournalResponse, JournalDetail
from app.journal.service import get_journal
from app.journal.titles import build_display_title, numbered_subquery
from app.trash.schemas import TrashFilter, TrashItem, TrashPage, TrashType

from app.writing.service import require_revision, WriteConflict, cleanup_private_ai

PAGE_SIZE = 20


def _deleted_statement(kind: TrashType):
    model = Journal if kind == 'journal' else Insight
    columns = [
        literal(kind).label('type'),
        literal(0 if kind == 'journal' else 1).label('type_order'),
        model.id, model.revision, model.title, model.content, model.folder_id,
        model.created_at, model.updated_at, model.deleted_at,
    ]
    if kind == 'journal':
        numbered = numbered_subquery()
        return (select(*columns, Journal.journal_date.label('business_date'), numbered.c.seq)
                .outerjoin(numbered, numbered.c.id == Journal.id)
                .where(Journal.deleted_at.is_not(None)))
    return select(*columns, literal(None, type_=Date).label('business_date'),
                  literal(None, type_=Integer).label('seq')).where(Insight.deleted_at.is_not(None))


def _to_response(row) -> TrashItem:
    fields = {key: getattr(row, key) for key in (
        'type', 'id', 'revision', 'title', 'content', 'folder_id', 'created_at', 'updated_at', 'deleted_at'
    )}
    if row.type == 'journal':
        return JournalResponse(**fields, journal_date=row.business_date,
                               display_title=build_display_title(row.title, row.business_date, row.seq))
    return InsightResponse(**fields, display_title=build_insight_display_title(row.title))


def list_trash(db: Session, type: TrashFilter = 'all', page: int = 1) -> TrashPage:
    branches = [_deleted_statement(kind) for kind in ('journal', 'insight')
                if type == 'all' or type == kind]
    deleted = union_all(*branches).subquery('trash_files')
    # Reads must not flush unrelated pending ORM state, even in a reused Session.
    with db.no_autoflush:
        total = db.scalar(select(func.count()).select_from(deleted)) or 0
        rows = db.execute(select(deleted).order_by(
            deleted.c.deleted_at.desc(), deleted.c.type_order.asc(), deleted.c.id.desc()
        ).limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE)).all()
    return TrashPage(items=[_to_response(row) for row in rows], page=page,
                     page_size=PAGE_SIZE, total=total, has_next=page * PAGE_SIZE < total)


def get_trash(db: Session, type: TrashType, id: int) -> TrashItem | None:
    deleted = _deleted_statement(type).subquery('trash_detail')
    with db.no_autoflush:
        row = db.execute(select(deleted).where(deleted.c.id == id)).one_or_none()
    if row is None:
        return None
    response = _to_response(row)
    if type == 'journal':
        with db.no_autoflush:
            blocks = db.scalar(select(Journal.content_blocks).where(Journal.id == id))
        return JournalDetail(**response.model_dump(), content_blocks=blocks)
    return response


def restore_trash(db: Session, type: TrashType, id: int, expected_revision: int | None = None) -> TrashItem | None:
    require_revision(expected_revision)
    model = Journal if type == 'journal' else Insight
    # Explicit column self-assignment suppresses the existing Python onupdate.
    statement = (update(model).where(model.id == id, model.deleted_at.is_not(None), model.revision == expected_revision)
                 .values(deleted_at=None, updated_at=model.updated_at, revision=model.revision + 1)
                 .execution_options(synchronize_session=False))
    try:
        result = db.execute(statement)
        if result.rowcount == 0:
            if get_trash(db, type, id) is not None:
                raise WriteConflict('file revision has changed')
            return None
        db.commit()
    except Exception:
        db.rollback()
        raise
    restored = get_journal(db, id) if type == 'journal' else get_insight(db, id)
    if restored is None:
        raise RuntimeError('Restored file could not be read back')
    return restored


def purge_trash(db: Session, type: TrashType, id: int, expected_revision: int | None = None) -> bool:
    require_revision(expected_revision)
    model = Journal if type == 'journal' else Insight
    statement = (delete(model).where(model.id == id, model.deleted_at.is_not(None), model.revision == expected_revision)
                 .execution_options(synchronize_session=False))
    try:
        result = db.execute(statement)
        if result.rowcount == 0:
            if get_trash(db, type, id) is not None:
                raise WriteConflict('file revision has changed')
            return False
        cleanup_private_ai(db, type, id)
        db.commit()
    except Exception:
        db.rollback()
        raise
    return True
