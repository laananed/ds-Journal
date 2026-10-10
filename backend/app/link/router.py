from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.link.schemas import LinkPage
from app.link.service import resolve_links

router = APIRouter(prefix='/api/links', tags=['links'])


@router.get('/resolve', response_model=LinkPage)
def resolve(title: str = Query(..., min_length=1), page: int = Query(1, ge=1),
            db: Session = Depends(get_db)) -> LinkPage:
    return resolve_links(db, title, page)
