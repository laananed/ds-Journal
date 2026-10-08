"""Trash HTTP boundary: validation/status only; no editing endpoint."""
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from app.database import get_db
from app.trash import service
from app.trash.schemas import TrashFilter, TrashItem, TrashPage, TrashType

router = APIRouter(prefix='/api/trash', tags=['trash'])


@router.get('', response_model=TrashPage)
def list_trash(type: TrashFilter = 'all', page: int = Query(1, ge=1),
               db: Session = Depends(get_db)) -> TrashPage:
    return service.list_trash(db, type, page)


@router.get('/{type}/{id}', response_model=TrashItem)
def get_trash(type: TrashType, id: int, db: Session = Depends(get_db)) -> TrashItem:
    item = service.get_trash(db, type, id)
    if item is None:
        raise HTTPException(status_code=404, detail='Deleted file not found')
    return item


@router.post('/{type}/{id}/restore', response_model=TrashItem)
def restore_trash(type: TrashType, id: int, db: Session = Depends(get_db)) -> TrashItem:
    item = service.restore_trash(db, type, id)
    if item is None:
        raise HTTPException(status_code=404, detail='Deleted file not found')
    return item


@router.delete('/{type}/{id}', status_code=204)
def purge_trash(type: TrashType, id: int, db: Session = Depends(get_db)) -> Response:
    if not service.purge_trash(db, type, id):
        raise HTTPException(status_code=404, detail='Deleted file not found')
    return Response(status_code=204)
