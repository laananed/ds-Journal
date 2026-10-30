"""Read-only business clock."""
from datetime import date, datetime, timezone
from uuid import UUID
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.database import get_db
from app.ritual.dates import DAY_START_HOUR, business_date
from app.ritual.models import RitualTemplate
from typing import Literal
from app.ritual.schemas import TemplateUpdate, RestoreReplace, CopyContent, GoalLinkCreate, GoalUpdate
from app.ritual.service import update_template, restore_replace
from app.writing.router import matched_revision

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
    from app.journal.service import _projected_statement, get_journal
    with db.no_autoflush:
        rows = db.execute(_projected_statement().where(
            Journal.journal_date == journal_date, Journal.journal_kind.in_(['set', 'end']))).all()
    result = {'journal_date': journal_date.isoformat(), 'set': None, 'end': None}
    for row, sequence in rows:
        result[row.journal_kind] = get_journal(db, row.id)
    return result


@router.get('/ritual-templates')
def get_ritual_templates(db: Session = Depends(get_db)):
    with db.no_autoflush:
        templates = db.scalars(select(RitualTemplate)).all()
    result = {kind: {'questions': [], 'revision': 0} for kind in ('set', 'end')}
    for template in templates:
        result[template.kind] = {'questions': template.questions, 'revision': template.revision}
    return result


@router.patch('/ritual-templates/{kind}')
def patch_ritual_template(kind: Literal['set', 'end'], data: TemplateUpdate,
                          db: Session = Depends(get_db)):
    return update_template(db, kind, data)


@router.post('/rituals/{source_id}/restore-replace')
def replace_ritual(source_id: int, data: RestoreReplace,
                   source_revision: int = Depends(matched_revision), db: Session = Depends(get_db)):
    return restore_replace(db, source_id, source_revision, data)


@router.post('/rituals/{source_id}/copy-content')
def copy_ritual(source_id: int, data: CopyContent, db: Session = Depends(get_db)):
    from app.ritual.copying import copy_content
    return copy_content(db, source_id, data)


@router.post('/ritual-goal-links')
def link_goals(data: GoalLinkCreate, db: Session = Depends(get_db)):
    from app.ritual.goals import create_links
    return create_links(db, data)


@router.patch('/ritual-goals/{set_id}/{goal_id}')
def patch_goal(set_id: int, goal_id: UUID, data: GoalUpdate, db: Session = Depends(get_db)):
    from app.ritual.goals import update_goal
    return update_goal(db, set_id, goal_id, data)
