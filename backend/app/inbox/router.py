"""Inbox endpoints; HTTP mapping only, business rules stay in the Service."""
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.writing.router import matched_revision
from app.inbox import service
from app.inbox.schemas import InboxDetail
from app.inbox.schemas import DailyInboxResponse, InboxCreate, InboxPage, InboxResponse, InboxUpdate

router = APIRouter(prefix='/api/inboxes', tags=['inboxes'])


@router.post('', response_model=InboxDetail, status_code=status.HTTP_201_CREATED)
def create_inbox(payload: InboxCreate, response: Response, db: Session = Depends(get_db)) -> InboxResponse:
    try:
        result = service.create_inbox(db, payload)
        if result._creation_replayed:
            response.status_code = 200
        return result
    except service.FolderNotFoundError:
        raise HTTPException(status_code=404, detail='Folder not found')
    except service.DailyInboxConflictError:
        raise HTTPException(status_code=409, detail='Daily Inbox already exists for this date')


@router.get('', response_model=InboxPage)
def list_inboxes(inbox_date: date | None = None, folder_id: int | None = None,
                 page: int = Query(1, ge=1), db: Session = Depends(get_db)) -> InboxPage:
    return service.list_inboxes(db, inbox_date=inbox_date, folder_id=folder_id, page=page)


# Static /daily must be registered before the integer /{id} path.
@router.get('/daily', response_model=DailyInboxResponse)
def get_daily_inbox(inbox_date: date, db: Session = Depends(get_db)) -> DailyInboxResponse:
    return service.get_daily_inbox(db, inbox_date)


@router.get('/{id}', response_model=InboxDetail)
def get_inbox(id: int, db: Session = Depends(get_db)) -> InboxResponse:
    inbox = service.get_inbox(db, id)
    if inbox is None:
        raise HTTPException(status_code=404, detail='Inbox not found')
    return inbox


@router.patch('/{id}', response_model=InboxDetail)
def update_inbox(id: int, payload: InboxUpdate, db: Session = Depends(get_db)) -> InboxResponse:
    try:
        inbox = service.update_inbox(db, id, payload)
    except service.FolderNotFoundError:
        raise HTTPException(status_code=404, detail='Folder not found')
    if inbox is None:
        raise HTTPException(status_code=404, detail='Inbox not found')
    return inbox


@router.delete('/{id}', status_code=status.HTTP_204_NO_CONTENT)
def delete_inbox(id: int, expected_revision: int = Depends(matched_revision), db: Session = Depends(get_db)) -> Response:
    if not service.delete_inbox(db, id, expected_revision):
        raise HTTPException(status_code=404, detail='Inbox not found')
    return Response(status_code=status.HTTP_204_NO_CONTENT)
