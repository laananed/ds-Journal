"""Read-only business clock."""
from datetime import date, datetime, timezone
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.database import get_db
from app.ritual.dates import DAY_START_HOUR, business_date
from app.ritual.models import RitualTemplate

router = APIRouter(prefix='/api', tags=['rituals'])


def utc_now():
    return datetime.now(timezone.utc)


@router.get('/business-day')
def get_business_day():
    now = utc_now()
    return {'timezone': 'Asia/Shanghai', 'day_start_hour': DAY_START_HOUR,
            'server_time': now.isoformat(), 'business_date': business_date(now).isoformat()}


@router.get('/rituals')
def get_rituals(journal_date: date, db: Session = Depends(get_db)):
    from app.journal.models import Journal
    from app.journal.service import _projected_statement, _to_response
    with db.no_autoflush:
        rows = db.execute(_projected_statement().where(
            Journal.journal_date == journal_date, Journal.journal_kind.in_(['set', 'end']))).all()
    result = {'journal_date': journal_date.isoformat(), 'set': None, 'end': None}
    for row, sequence in rows:
        result[row.journal_kind] = _to_response(row, sequence, detail=True)
    return result


@router.get('/ritual-templates')
def get_ritual_templates(db: Session = Depends(get_db)):
    with db.no_autoflush:
        templates = db.scalars(select(RitualTemplate)).all()
    result = {kind: {'questions': [], 'revision': 0} for kind in ('set', 'end')}
    for template in templates:
        result[template.kind] = {'questions': template.questions, 'revision': template.revision}
    return result
