import hashlib
import json
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from app.schedule.models import Schedule, utcnow
from app.writing.service import PreconditionRequired, WriteConflict, WritingError


def payload_hash(data):
    payload = data.model_dump(mode='json', exclude={'client_create_id'})
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def create(db, data):
    digest = payload_hash(data)
    row = db.scalar(select(Schedule).where(Schedule.client_create_id == data.client_create_id))
    if row is not None:
        if row.create_payload_hash != digest:
            raise WriteConflict('client_create_id was used for another payload')
        return row, True
    row = Schedule(**data.model_dump(), create_payload_hash=digest)
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        row = db.scalar(select(Schedule).where(Schedule.client_create_id == data.client_create_id))
        if row is None:
            raise
        if row.create_payload_hash != digest:
            raise WriteConflict('client_create_id was used for another payload')
        return row, True
    db.refresh(row)
    return row, False


def locked(db, schedule_id):
    return db.scalar(select(Schedule).where(Schedule.id == schedule_id).with_for_update())


def update(db, row, data):
    if data.expected_revision is None:
        raise PreconditionRequired('expected_revision is required')
    if row.revision != data.expected_revision:
        raise WriteConflict('schedule revision has changed')
    changes = data.model_dump(exclude_unset=True, exclude={'expected_revision'})
    start = changes.get('starts_at', row.starts_at)
    end = changes.get('ends_at', row.ends_at)
    if end is not None and end <= start:
        raise WritingError('end must be after start')
    if any(getattr(row, key) != value for key, value in changes.items()):
        for key, value in changes.items():
            setattr(row, key, value)
        row.revision += 1
        row.updated_at = utcnow()
        db.commit()
        db.refresh(row)
    return row
