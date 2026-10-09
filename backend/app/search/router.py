from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.search.schemas import SearchPage, SearchType
from app.search.service import search_files

router = APIRouter(prefix='/api/search', tags=['search'])


@router.get('', response_model=SearchPage)
def search(q: str = '', type: SearchType = 'all', page: int = Query(1, ge=1),
           db: Session = Depends(get_db)) -> SearchPage:
    return search_files(db, q, type, page)
