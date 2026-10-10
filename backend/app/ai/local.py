"""Synchronous local orchestration, with short registration/account/attach phases.

The semaphore belongs to this single local process. Source row locks protect
cross-session registration. No DB transaction crosses the upstream invocation.
"""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from threading import BoundedSemaphore

from sqlalchemy import select, text, update
from sqlalchemy.orm import Session

from app.ai import client, settings, usage
from app.ai.incremental import compute_increment, user_text, bounded_context
from app.ai.models import AIRequest, AICheckpoint, AIUsage
from app.ai.prompts import local_messages
from app.ai.requests import RequestNotFound, recover_pending, request_response
from app.inbox.models import Inbox
from app.journal.models import Journal
from app.journal.schemas import _is_blank
from app.writing.service import WritingError, WriteConflict, insert_ai_reply

_slots = BoundedSemaphore(2)


class LocalError(WritingError):
    def __init__(self, message, status_code, request_id=None):
        super().__init__(message)
        self.status_code = status_code
        self.request_id = request_id


def lock_source(db, source):
    model = Journal if source['type'] == 'journal' else Inbox
    return db.scalar(select(model).where(model.id == source['id']).with_for_update()
                     .execution_options(populate_existing=True))


def active(row):
    return row is not None and getattr(row, 'deleted_at', None) is None


def recent_context(db, source):
    rows = db.scalars(select(AIRequest).where(
        AIRequest.kind == 'local', AIRequest.status == 'applied',
        AIRequest.sources.contains([{'type': source['type'], 'id': source['id']}]))
        .order_by(AIRequest.created_at.desc(), AIRequest.id.desc()).limit(3)).all()
    return bounded_context([{'question': r.question, 'reply': (r.result or {}).get('reply')}
                            for r in reversed(rows)])


def register(db, payload):
    """Returns replay/noop or frozen execution data. Caller owns acquired slot."""
    source = payload.source.model_dump(mode='json')
    digest = usage.call_payload_hash(payload.model_dump(mode='json', exclude_unset=True))
    # A transaction-scoped key lock handles the same UUID racing on different
    # sources without a placeholder request or holding a lock during HTTP.
    key = int.from_bytes(payload.request_id.bytes[:8], 'big', signed=True)
    db.execute(text('select pg_advisory_xact_lock(:key)'), {'key': key})
    previous = db.get(AIRequest, payload.request_id)
    if previous is not None:
        if previous.payload_hash != digest:
            raise WriteConflict('request_id was used for a different payload')
        response = request_response(db, payload.request_id)
        db.rollback()
        return response, 202 if response['status'] == 'pending' else 200, None
    row = lock_source(db, source)
    if not active(row):
        raise RequestNotFound('File not found')
    if row.revision != source['expected_revision']:
        raise WriteConflict('file revision has changed')
    pending = db.scalar(select(AIRequest.id).where(AIRequest.status == 'pending',
        AIRequest.sources.contains([{'type': source['type'], 'id': source['id']}])))
    if pending is not None:
        raise WriteConflict('source already has a pending AI request')
    current = user_text(row.content_blocks, row.content)
    checkpoint = db.get(AICheckpoint, (source['type'], source['id']))
    increment = compute_increment(current, checkpoint.consumed_user_text if checkpoint else None)
    question = payload.question if payload.question and not _is_blank(payload.question) else None
    if not increment.valid and question is None:
        db.rollback()
        return {'status': 'noop', 'message': '要我分析啥啊？', 'request_id': None, 'usage': None}, 200, None
    if not client.is_configured():
        raise LocalError('Model is not configured', 503)
    if not _slots.acquire(blocking=False):
        raise LocalError('Too many simultaneous AI calls', 429)
    try:
        captured = {'type': source['type'], 'id': source['id'], 'revision': row.revision,
                    'user_text': current, 'title': row.title, 'folder_id': row.folder_id,
                    'date': getattr(row, source['type'] + '_date').isoformat(),
                    'blocks': deepcopy(row.content_blocks)}
        frozen_settings = settings.settings_snapshot(db)
        messages = local_messages(increment, question, frozen_settings['custom_prompt'],
                                  recent_context(db, source) if question else [])
        db.add(AIRequest(id=payload.request_id, kind='local', payload_hash=digest,
                         status='pending', sources=[captured], question=question,
                         settings=frozen_settings))
        db.commit()
        return None, None, (captured, messages)
    except Exception:
        _slots.release()
        raise


def persist_subcall(bind, request_id, source, result=None, error=None):
    """Independent ledger commit first, then a separate result transaction.

    Lock source before request, as source deletion does. A hard deletion may
    remove the request: meter anonymously and never recreate private snapshots.
    """
    with Session(bind) as ledger:
        lock_source(ledger, source)
        row = ledger.scalar(select(AIRequest).where(AIRequest.id == request_id).with_for_update())
        record = usage.record_subcall(ledger, request_id=request_id if row else None,
            subcall_index=0, usage=result.usage if result else getattr(error, 'usage', None),
            response_id=result.response_id if result else getattr(error, 'response_id', None))
        measured = result.usage if result else getattr(error, 'usage', None)
        if measured is not None and not record.created:
            # Explicit unknown recovery slot -> confirmed late usage. Never
            # add a second ledger row or overwrite already confirmed metering.
            ledger.execute(update(AIUsage).where(AIUsage.id == record.usage_id,
                AIUsage.metering == 'unknown').values(metering='known',
                prompt_tokens=measured.prompt_tokens, completion_tokens=measured.completion_tokens,
                total_tokens=measured.total_tokens,
                response_id=result.response_id if result else getattr(error, 'response_id', None)))
            ledger.commit()
    with Session(bind) as db:
        lock_source(db, source)
        row = db.scalar(select(AIRequest).where(AIRequest.id == request_id).with_for_update())
        if row is None:
            return
        if row.status == 'pending' and row.created_at <= datetime.now(timezone.utc) - timedelta(seconds=120):
            row.status = 'unknown'
            row.error_category = 'expired'
            row.completed_at = datetime.now(timezone.utc)
        if result is not None:
            row.result = {'reply': result.text, 'web_status': 'not_needed', 'citations': []}
        if row.status == 'pending' and (error is not None or (result and result.truncated)):
            row.status = 'failed'
            row.error_category = error.category if error else 'truncated'
            row.completed_at = datetime.now(timezone.utc)
        db.commit()


def attach_reply(db, request_id, source, reply):
    """One source + request + checkpoint transaction; no internally committing CRUD."""
    row = lock_source(db, source)
    request = db.scalar(select(AIRequest).where(AIRequest.id == request_id).with_for_update()
                        .execution_options(populate_existing=True))
    if request is None or request.status != 'pending':
        db.rollback()
        return
    if (not active(row) or row.revision != source['revision']
            or user_text(row.content_blocks, row.content) != source['user_text']
            or row.content_blocks != source['blocks']):
        request.status = 'conflict'
        request.error_category = 'source_changed'
    else:
        insert_ai_reply(row, reply, request_id, source['blocks'])
        checkpoint = db.get(AICheckpoint, (source['type'], source['id']))
        if checkpoint is None:
            checkpoint = AICheckpoint(file_type=source['type'], file_id=source['id'])
            db.add(checkpoint)
        checkpoint.consumed_user_text = source['user_text']
        checkpoint.last_request_id = request_id
        checkpoint.updated_at = datetime.now(timezone.utc)
        request.status = 'applied'
    request.completed_at = datetime.now(timezone.utc)
    db.commit()


def mark_attach_failure(bind, request_id, source, category):
    with Session(bind) as db:
        lock_source(db, source)
        row = db.scalar(select(AIRequest).where(AIRequest.id == request_id).with_for_update())
        if row is not None and row.status == 'pending':
            row.status = 'failed'
            row.error_category = category
            row.completed_at = datetime.now(timezone.utc)
            db.commit()


def execute_local(db, payload):
    """T06 can extend the invocation phase; T08 can reuse request/ledger primitives.

    Model transport stays T03's invoke; only the invocation phase may perform
    network work. Registration, metering/result and attachment remain distinct.
    """
    recover_pending(db)
    try:
        response, code, execution = register(db, payload)
    except Exception:
        db.rollback()
        raise
    if execution is None:
        return response, code
    source, messages = execution
    bind = db.get_bind()
    try:
        error = None
        result = None
        try:
            result = client.invoke(messages, max_tokens=client.LOCAL_MAX_TOKENS)
        except client.AIClientError as caught:
            error = caught
        persist_subcall(bind, payload.request_id, source, result, error)
        if result is not None and not result.truncated:
            try:
                attach_reply(db, payload.request_id, source, result.text)
            except Exception as caught:
                db.rollback()
                category = 'content_limit' if isinstance(caught, WritingError) else 'storage'
                mark_attach_failure(bind, payload.request_id, source, category)
        response = request_response(db, payload.request_id)
        if error is not None:
            raise LocalError('Model request failed; query request_id for status',
                             504 if isinstance(error, client.UpstreamTimeout) else 502,
                             str(payload.request_id))
        return response, 200
    finally:
        _slots.release()
