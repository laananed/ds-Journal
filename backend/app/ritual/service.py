"""Ritual transactions."""
from sqlalchemy import select, update, or_, func
from sqlalchemy.exc import IntegrityError
from app.ritual.models import RitualTemplate, RitualGoalLink
from app.writing.service import require_revision, WriteConflict
from app.writing.service import WritingError


class RelatedFilesChanged(WriteConflict):
    code = 'related_files_changed'


def lock_day(db, day):
    db.execute(select(func.pg_advisory_xact_lock(193674, day.toordinal())))


def require_no_links(db, *ids):
    if db.scalar(select(RitualGoalLink.id).where(or_(
        RitualGoalLink.set_journal_id.in_(ids), RitualGoalLink.end_journal_id.in_(ids)
    )).limit(1)) is not None:
        raise RelatedFilesChanged('linked Ritual operations are not available yet')


def restore_replace(db, source_id, source_revision, data):
    from datetime import datetime, timezone
    from app.journal.models import Journal
    from app.journal.service import get_journal
    from app.trash.service import get_trash
    require_revision(data.expected_target_revision)
    try:
        source = db.get(Journal, source_id)
        if source is None:
            raise WritingError('source does not exist')
        lock_day(db, source.journal_date)
        rows = db.scalars(select(Journal).where(Journal.id.in_([source_id, data.target_id]))
                          .order_by(Journal.id).with_for_update()
                          .execution_options(populate_existing=True)).all()
        found = {row.id: row for row in rows}
        source, target = found.get(source_id), found.get(data.target_id)
        if (source is None or target is None or source.id == target.id or
            source.journal_kind not in ('set', 'end') or source.journal_kind != target.journal_kind or
            source.journal_date != target.journal_date or source.deleted_at is None or target.deleted_at is not None):
            raise WritingError('source and target must be matching deleted and active Rituals')
        if source.revision != source_revision or target.revision != data.expected_target_revision:
            raise WriteConflict('file revision has changed')
        require_no_links(db, source.id, target.id)
        if data.related_revisions:
            raise RelatedFilesChanged('related file set has changed')
        db.execute(update(Journal).where(Journal.id == target.id).values(
            deleted_at=datetime.now(timezone.utc), revision=Journal.revision + 1,
            updated_at=Journal.updated_at))
        db.execute(update(Journal).where(Journal.id == source.id).values(
            deleted_at=None, revision=Journal.revision + 1, updated_at=Journal.updated_at))
        db.commit()
        db.expire_all()
        restored, deleted = get_journal(db, source_id), get_trash(db, 'journal', data.target_id)
        return {'files': [restored, deleted], 'effects': [
            {'type': 'journal', 'id': source_id, 'base_revision': source_revision,
             'revision': source_revision + 1, 'ops': [{'kind': 'restore_identity'}]},
            {'type': 'journal', 'id': data.target_id, 'base_revision': data.expected_target_revision,
             'revision': data.expected_target_revision + 1, 'ops': [{'kind': 'restore_identity'}]},
        ], 'request_id': None}
    except Exception:
        db.rollback()
        raise


def update_template(db, kind, data):
    revision = require_revision(data.expected_revision)
    questions = [question.model_dump(mode='json') for question in data.questions]
    try:
        existing = db.scalar(select(RitualTemplate).where(
            RitualTemplate.kind == kind).with_for_update())
        if existing is not None and existing.questions == questions:
            return {'questions': existing.questions, 'revision': existing.revision}
        if existing is None and not questions and revision == 0:
            return {'questions': [], 'revision': 0}
        if existing is not None and existing.revision != revision:
            raise WriteConflict('template revision has changed')
        if revision == 0:
            db.add(RitualTemplate(kind=kind, questions=questions, revision=1))
            db.flush()
            next_revision = 1
        else:
            result = db.execute(update(RitualTemplate).where(
                RitualTemplate.kind == kind, RitualTemplate.revision == revision
            ).values(questions=questions, revision=RitualTemplate.revision + 1))
            if result.rowcount != 1:
                raise WriteConflict('template revision has changed')
            next_revision = revision + 1
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise WriteConflict('template revision has changed') from error
    except Exception:
        db.rollback()
        raise
    return {'questions': questions, 'revision': next_revision}
