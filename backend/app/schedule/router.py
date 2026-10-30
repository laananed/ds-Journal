from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.database import get_db
from app.schedule.models import Schedule
from app.schedule.schemas import ScheduleCreate, ScheduleUpdate
from app.schedule import service
from app.writing.router import matched_revision
from app.writing.service import WriteConflict

router = APIRouter(prefix='/api/schedules', tags=['schedules'])


def output(row):
    return {key: getattr(row, key) for key in ('id', 'title', 'starts_at', 'ends_at', 'completed', 'revision', 'created_at', 'updated_at')}


@router.get('')
def list_schedules(page: int = Query(1, ge=1), db: Session = Depends(get_db)):
    rows = db.scalars(select(Schedule).order_by(Schedule.starts_at, Schedule.id).offset((page - 1) * 20).limit(21)).all()
    return {'items': [output(row) for row in rows[:20]], 'page': page, 'has_next': len(rows) > 20}


@router.get('/{schedule_id}')
def get_schedule(schedule_id: int, db: Session = Depends(get_db)):
    row = db.get(Schedule, schedule_id)
    if row is None:
        raise HTTPException(404, 'Schedule not found')
    return output(row)


@router.post('', status_code=201)
def create_schedule(data: ScheduleCreate, response: Response, db: Session = Depends(get_db)):
    row, replayed = service.create(db, data)
    if replayed:
        response.status_code = 200
    return output(row)


@router.patch('/{schedule_id}')
def patch_schedule(schedule_id: int, data: ScheduleUpdate, db: Session = Depends(get_db)):
    row = service.locked(db, schedule_id)
    if row is None:
        raise HTTPException(404, 'Schedule not found')
    return output(service.update(db, row, data))


@router.delete('/{schedule_id}', status_code=204)
def delete_schedule(schedule_id: int, revision: int = Depends(matched_revision), db: Session = Depends(get_db)):
    row = service.locked(db, schedule_id)
    if row is None:
        raise HTTPException(404, 'Schedule not found')
    if row.revision != revision:
        raise WriteConflict('schedule revision has changed')
    db.delete(row)
    db.commit()
    return Response(status_code=204)
