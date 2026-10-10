"""Inbox CRUD and Daily identity: Router -> Service -> SQLAlchemy -> PostgreSQL."""
from datetime import date, datetime, timezone

from sqlalchemy import delete, update, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from app.writing.service import (require_revision, WriteConflict, create_hash, verify_create_replay, validate_blocks, writing_changes, cleanup_private_ai)

from app.folder.models import Folder, folder_fk_violation
from app.inbox.models import Inbox
from app.inbox.schemas import InboxDetail
from app.inbox.schemas import DailyInboxResponse, InboxCreate, InboxPage, InboxResponse, InboxUpdate

PAGE_SIZE = 20
DAILY_INDEX_NAME = 'uq_inboxes_daily_date'


def _utcnow():
    return datetime.now(timezone.utc)


class FolderNotFoundError(LookupError):
    """The requested Folder does not exist."""


class DailyInboxConflictError(ValueError):
    """An existing Daily already owns this business date."""


def _require_folder(db: Session, folder_id: int | None) -> None:
    if folder_id is not None and db.scalar(select(Folder.id).where(Folder.id == folder_id)) is None:
        raise FolderNotFoundError(f'Folder {folder_id} does not exist')


def _to_response(inbox: Inbox, *, detail=False) -> InboxResponse:
    return (InboxDetail if detail else InboxResponse)(
        **({"content_blocks": inbox.content_blocks} if detail else {}),
        id=inbox.id,
        revision=inbox.revision,
        title=inbox.title,
        display_title=inbox.title or inbox.inbox_date.isoformat(),
        content=inbox.content,
        inbox_date=inbox.inbox_date,
        is_daily=inbox.is_daily,
        folder_id=inbox.folder_id,
        created_at=inbox.created_at,
        updated_at=inbox.updated_at,
    )


def _get_row(db: Session, inbox_id: int) -> Inbox | None:
    # Query actual existence; the identity map cannot resurrect a physically deleted row.
    with db.no_autoflush:
        return db.scalar(select(Inbox).where(Inbox.id == inbox_id).execution_options(populate_existing=True))


def create_inbox(db: Session, data: InboxCreate) -> InboxResponse:
    payload_hash = create_hash(data)
    try:
        if data.client_create_id is not None:
            row = db.scalar(select(Inbox).where(Inbox.client_create_id == data.client_create_id))
            if row is not None:
                verify_create_replay(row, payload_hash)
                response = _to_response(row, detail=True)
                response._creation_replayed = True
                return response
        _require_folder(db, data.folder_id)
        blocks = None
        content = data.content
        if "content_blocks" in data.model_fields_set:
            blocks = data.model_dump(mode="json")["content_blocks"]
            content = validate_blocks(blocks)
        title = data.title if 'title' in data.model_fields_set else data.inbox_date.isoformat()
        row = Inbox(title=title, content=content, inbox_date=data.inbox_date,
                    is_daily=data.is_daily, folder_id=data.folder_id, content_blocks=blocks,
                    client_create_id=data.client_create_id,
                    create_payload_hash=payload_hash if data.client_create_id else None)
        db.add(row)
        db.commit()
    except Exception as error:
        db.rollback()
        if isinstance(error, IntegrityError) and data.client_create_id is not None:
            row = db.scalar(select(Inbox).where(Inbox.client_create_id == data.client_create_id))
            if row is not None:
                try:
                    verify_create_replay(row, payload_hash)
                    response = _to_response(row, detail=True)
                    response._creation_replayed = True
                    return response
                except Exception:
                    db.rollback()
                    raise
        if (isinstance(error, IntegrityError) and getattr(error.orig, 'sqlstate', None) == '23505'
                and getattr(getattr(error.orig, 'diag', None), 'constraint_name', None) == DAILY_INDEX_NAME):
            raise DailyInboxConflictError('Daily Inbox already exists for this date') from error
        if folder_fk_violation(error):
            raise FolderNotFoundError(f'Folder {data.folder_id} does not exist') from error
        raise
    return _to_response(row, detail=True)


def list_inboxes(db: Session, *, inbox_date: date | None = None,
                 folder_id: int | None = None, page: int = 1) -> InboxPage:
    conditions = []
    if inbox_date is not None:
        conditions.append(Inbox.inbox_date == inbox_date)
    if folder_id is not None:
        conditions.append(Inbox.folder_id == folder_id)
    with db.no_autoflush:
        total = db.scalar(select(func.count()).select_from(Inbox).where(*conditions)) or 0
    with db.no_autoflush:
        rows = db.scalars(select(Inbox).where(*conditions)
                          .order_by(Inbox.created_at.desc(), Inbox.id.desc())
                          .limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE)).all()
    return InboxPage(items=[_to_response(row) for row in rows], page=page,
                     page_size=PAGE_SIZE, total=total, has_next=page * PAGE_SIZE < total)


def get_inbox(db: Session, inbox_id: int) -> InboxResponse | None:
    inbox = _get_row(db, inbox_id)
    return _to_response(inbox, detail=True) if inbox is not None else None


def get_daily_inbox(db: Session, inbox_date: date) -> DailyInboxResponse:
    with db.no_autoflush:
        inbox = db.scalar(select(Inbox).where(Inbox.inbox_date == inbox_date, Inbox.is_daily.is_(True)))
    if inbox is None:
        return DailyInboxResponse(state='missing', id=None, file=None)
    return DailyInboxResponse(state='active', id=inbox.id, file=_to_response(inbox, detail=True))


def update_inbox(db: Session, inbox_id: int, data: InboxUpdate) -> InboxResponse | None:
    require_revision(data.expected_revision)
    try:
        row = _get_row(db, inbox_id)
        if row is None:
            return None
        changes = writing_changes(row, data)
        if not changes:
            return get_inbox(db, inbox_id)
        if row.revision != data.expected_revision:
            raise WriteConflict("file revision has changed")
        if "folder_id" in changes:
            _require_folder(db, changes["folder_id"])
        # CAS: every real mutation is conditional in PostgreSQL, never a blind ORM UPDATE.
        result = db.execute(update(Inbox).where(Inbox.id == inbox_id,
            Inbox.revision == data.expected_revision)
            .values(**changes, revision=Inbox.revision + 1,
                    updated_at=Inbox.updated_at if changes.keys() == {"content_blocks"} else _utcnow())
            .execution_options(synchronize_session=False))
        if result.rowcount == 0:
            db.expire_all()
            row = _get_row(db, inbox_id)
            if row is None:
                return None
            if not writing_changes(row, data):
                return get_inbox(db, inbox_id)
            raise WriteConflict("file revision has changed")
        db.commit()
    except Exception as error:
        db.rollback()
        if folder_fk_violation(error):
            raise FolderNotFoundError("Folder does not exist") from error
        raise
    return get_inbox(db, inbox_id)


def delete_inbox(db: Session, inbox_id: int, expected_revision: int | None = None) -> bool:
    require_revision(expected_revision)
    try:
        row = db.scalar(select(Inbox).where(Inbox.id == inbox_id).with_for_update())
        if row is None:
            return False
        if row.revision != expected_revision:
            raise WriteConflict("file revision has changed")
        result = db.execute(delete(Inbox).where(Inbox.id == inbox_id,
            Inbox.revision == expected_revision)
            .execution_options(synchronize_session=False))
        if result.rowcount == 0:
            db.expire_all()
            if _get_row(db, inbox_id) is None:
                return False
            raise WriteConflict("file revision has changed")
        cleanup_private_ai(db, "inbox", inbox_id)
        db.commit()
    except Exception:
        db.rollback()
        raise
    return True
