"""Request reads and explicit recovery; importing and GET never write."""
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from app.ai.models import AIRequest, AIUsage
from app.ai.usage import _aggregate, _source_identity
from app.writing.service import WritingError


class RequestNotFound(WritingError):
    status_code = 404


ERROR_MESSAGES = {
    'source_changed': '源文件已修改或删除，结果未附着。',
    'expired': '请求状态不明，可能已消耗 Token；请勿自动重发。',
    'restart': '应用重启，先前请求状态不明，可能已消耗 Token。',
    'timeout': '上游超时，可能已消耗 Token。',
    'truncated': '回复不完整，未附着正文。',
    'content_limit': '追加回复将超过正文长度限制，结果已保留。',
    'storage': '正文保存失败，结果已保留，检查点未推进。',
}


def recover_pending(db, *, restart=False, now=None):
    """POST recovers expired rows; lifespan recovers all old process pending rows.

    Unknown ledger slots may later gain confirmed metering when that same
    subcall arrives. No retry, worker or timer is created.
    """
    now = now or datetime.now(timezone.utc)
    statement = select(AIRequest).where(AIRequest.status == 'pending')
    if not restart:
        statement = statement.where(AIRequest.created_at <= now - timedelta(seconds=120))
    rows = db.scalars(statement.with_for_update(skip_locked=True)).all()
    for row in rows:
        row.status = 'unknown'
        row.error_category = 'restart' if restart else 'expired'
        row.completed_at = now
        db.execute(insert(AIUsage).values(request_id=row.id, subcall_index=0,
                                          metering='unknown', search_requests=0)
                   .on_conflict_do_nothing(index_elements=['request_id', 'subcall_index']))
    if rows:
        db.commit()
    else:
        db.rollback()  # End the read transaction too, before any model HTTP.
    return len(rows)


def request_response(db, request_id):
    """Safe stable API projection; no request snapshots/settings are exposed."""
    row = db.scalar(select(AIRequest).where(AIRequest.id == request_id)
                    .execution_options(populate_existing=True))
    if row is None:
        raise RequestNotFound('AI request not found')
    result = row.result or {}
    file = None
    if row.kind == 'local' and row.status == 'applied' and row.sources:
        source = row.sources[0]
        if source['type'] == 'journal':
            from app.journal.service import get_journal
            detail = get_journal(db, source['id'])
        else:
            from app.inbox.service import get_inbox
            detail = get_inbox(db, source['id'])
        if detail is not None:
            file = detail.model_dump(mode='json')
    category = row.error_category
    return {
        'request_id': str(row.id), 'kind': row.kind, 'status': row.status,
        'sources': [identity for s in row.sources if (identity := _source_identity(s))],
        'reply': result.get('reply'), 'file': file, 'review': result.get('review'),
        'saved_target': row.saved_target,
        'usage': _aggregate(db, [row.id])[row.id],
        'web_status': result.get('web_status', 'not_needed'),
        'citations': result.get('citations', []),
        'error': {'category': category, 'message': ERROR_MESSAGES.get(category, '上游调用失败，未附着正文。')}
                 if category else None,
    }
