"""Inbox CRUD and Daily identity: Router -> Service -> SQLAlchemy -> PostgreSQL."""
from datetime import date

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.folder.models import Folder
from app.inbox.models import Inbox
from app.inbox.schemas import DailyInboxResponse, InboxCreate, InboxPage, InboxResponse, InboxUpdate

PAGE_SIZE = 20
DAILY_INDEX_NAME = 'uq_inboxes_daily_date'


class FolderNotFoundError(LookupError):
    """The requested Folder does not exist."""


class DailyInboxConflictError(ValueError):
    """An existing Daily already owns this business date."""


def _require_folder(db: Session, folder_id: int | None) -> None:
    if folder_id is not None and db.scalar(select(Folder.id).where(Folder.id == folder_id)) is None:
        raise FolderNotFoundError(f'Folder {folder_id} does not exist')


def _to_response(inbox: Inbox) -> InboxResponse:
    return InboxResponse(
        id=inbox.id,
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
    return db.scalar(select(Inbox).where(Inbox.id == inbox_id))


def create_inbox(db: Session, data: InboxCreate) -> InboxResponse:
    try:
        _require_folder(db, data.folder_id)
        # Only omission selects the default: explicit NULL/empty remain unchanged.
        title = data.title if 'title' in data.model_fields_set else data.inbox_date.isoformat()
        inbox = Inbox(title=title, content=data.content, inbox_date=data.inbox_date,
                      is_daily=data.is_daily, folder_id=data.folder_id)
        db.add(inbox)
        db.commit()
    except Exception as error:
        db.rollback()
        # psycopg's diagnostic names the exact unique index. Other DB failures propagate.
        if (isinstance(error, IntegrityError)
                and getattr(error.orig, 'sqlstate', None) == '23505'
                and getattr(getattr(error.orig, 'diag', None), 'constraint_name', None) == DAILY_INDEX_NAME):
            raise DailyInboxConflictError('Daily Inbox already exists for this date') from error
        raise
    db.refresh(inbox)
    return _to_response(inbox)


def list_inboxes(db: Session, *, inbox_date: date | None = None,
                 folder_id: int | None = None, page: int = 1) -> InboxPage:
    conditions = []
    if inbox_date is not None:
        conditions.append(Inbox.inbox_date == inbox_date)
    if folder_id is not None:
        conditions.append(Inbox.folder_id == folder_id)
    total = db.scalar(select(func.count()).select_from(Inbox).where(*conditions)) or 0
    rows = db.scalars(select(Inbox).where(*conditions)
                      .order_by(Inbox.created_at.desc(), Inbox.id.desc())
                      .limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE)).all()
    return InboxPage(items=[_to_response(row) for row in rows], page=page,
                     page_size=PAGE_SIZE, total=total, has_next=page * PAGE_SIZE < total)


def get_inbox(db: Session, inbox_id: int) -> InboxResponse | None:
    inbox = _get_row(db, inbox_id)
    return _to_response(inbox) if inbox is not None else None


def get_daily_inbox(db: Session, inbox_date: date) -> DailyInboxResponse:
    inbox = db.scalar(select(Inbox).where(Inbox.inbox_date == inbox_date, Inbox.is_daily.is_(True)))
    if inbox is None:
        return DailyInboxResponse(state='missing', id=None, file=None)
    return DailyInboxResponse(state='active', id=inbox.id, file=_to_response(inbox))


def update_inbox(db: Session, inbox_id: int, data: InboxUpdate) -> InboxResponse | None:
    try:
        inbox = _get_row(db, inbox_id)
        if inbox is None:
            return None
        submitted = data.model_dump(exclude_unset=True)
        if 'folder_id' in submitted:
            _require_folder(db, submitted['folder_id'])
        changes = {field: value for field, value in submitted.items() if getattr(inbox, field) != value}
        if not changes:
            return _to_response(inbox)
        for field, value in changes.items():
            setattr(inbox, field, value)
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.refresh(inbox)
    return _to_response(inbox)


def delete_inbox(db: Session, inbox_id: int) -> bool:
    """All Inbox kinds are hard deleted; Daily's unique key becomes available again."""
    try:
        result = db.execute(delete(Inbox).where(Inbox.id == inbox_id)
                            .execution_options(synchronize_session=False))
        if result.rowcount == 0:
            return False
        db.commit()
    except Exception:
        db.rollback()
        raise
    return True
