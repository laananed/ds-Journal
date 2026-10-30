"""Full review: register / bounded HTTP / ledger / atomic ready+checkpoints."""
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from uuid import uuid5

from pydantic import ValidationError
from sqlalchemy import select, text, update
from sqlalchemy.orm import Session

from app.ai import client, search, settings, tool_calls, usage
from app.ai.incremental import user_text
from app.ai.local import _slots, LocalError, lock_source, active
from app.ai.models import AIRequest, AIUsage, AICheckpoint
from app.ai.prompts import review_messages
from app.ai.requests import recover_pending, request_response, RequestNotFound
from app.ai.schemas import StructuredReview
from app.writing.service import WritingError, WriteConflict, LegacyConversionRequired


def lock_sources(db, sources):
    """Every review phase uses the same source-before-request lock order."""
    return [(s, lock_source(db, s)) for s in sorted(sources, key=lambda s: (s['type'], s['id']))]


def matches(row, source):
    if not active(row):
        return False
    document = getattr(row, 'content_doc', None)
    if 'document' in source:
        from app.writing.documents import user_text_document
        body_matches = (document is not None and document == source['document']
                        and user_text_document(document) == source['user_text'])
    else:
        body_matches = (document is None and user_text(row.content_blocks, row.content) == source['user_text']
                        and row.content_blocks == source['blocks'])
    return (body_matches and row.revision == source['revision']
            and row.title == source['title'] and row.folder_id == source['folder_id']
            and getattr(row, source['type'] + '_date').isoformat() == source['date'])


def validate_review(raw, sources, request_id):
    """Untrusted output fails closed; no repair request or regex JSON recovery."""
    review = StructuredReview.model_validate_json(raw)
    texts = {(s['type'], s['id']): s['user_text'] for s in sources}
    for item in [*review.facts, *review.emotion_hypotheses,
                 *review.possible_explanations, *review.insight_drafts]:
        for e in item.evidence:
            original = texts.get((e.source.type, e.source.id))
            if original is None or e.quote not in original or not e.quote.strip():
                raise WritingError('Review evidence does not match selected user text')
    result = review.model_dump(mode='json')
    for i, draft in enumerate(result['insight_drafts']):
        draft['draft_id'] = str(uuid5(request_id, f'insight:{i}'))
    # The server renders the validated fields, keeping evidence and uncertainty
    # visible in the editable preview rather than trusting a second AI summary.
    parts = []
    for key, title in [('facts','事实'),('emotion_hypotheses','情绪推测'),
                       ('possible_explanations','可能解释')]:
        parts.append('## ' + title)
        for item in result[key]:
            parts.append('- ' + item['text'])
            if 'uncertainty' in item: parts.append('  不确定性：' + item['uncertainty'])
            for e in item['evidence']:
                parts.append(f"  依据 [{e['source']['type']}:{e['source']['id']}]：{e['quote']}")
    for angle in result['angles']:
        parts.extend(['## '+angle['title'], angle['content']])
    for key, title in [('logic_chain','行为与思考逻辑'),('follow_up_questions','追问')]:
        parts.extend(['## '+title, *['- '+s for s in result[key]]])
    result['markdown'] = '\n\n'.join(parts)
    return result


def register_review(db, payload):
    digest = usage.call_payload_hash(payload.model_dump(mode='json', exclude_unset=True))
    key = int.from_bytes(payload.request_id.bytes[:8], 'big', signed=True)
    db.execute(text('select pg_advisory_xact_lock(:key)'), {'key': key})
    previous = db.get(AIRequest, payload.request_id)
    if previous is not None:
        if previous.kind != 'review' or previous.payload_hash != digest:
            raise WriteConflict('request_id was used for a different payload')
        response = request_response(db, payload.request_id)
        db.rollback()
        return response, 202 if response['status'] == 'pending' else 200, None
    captured = []
    for source, row in lock_sources(db, [s.model_dump(mode='json') for s in payload.sources]):
        if not active(row): raise RequestNotFound('File not found')
        if row.revision != source['expected_revision']: raise WriteConflict('file revision has changed')
        if db.scalar(select(AIRequest.id).where(AIRequest.status.in_(['prepared', 'pending']),
                AIRequest.sources.contains([{'type':source['type'],'id':source['id']}]))) is not None:
            raise WriteConflict('source already has a pending AI request')
        document = getattr(row, 'content_doc', None)
        if document is not None:
            from app.writing.documents import user_text_document
            snapshot_text = user_text_document(document)
        else:
            snapshot_text = user_text(row.content_blocks, row.content)
        snapshot = {'type':source['type'], 'id':source['id'], 'revision':row.revision,
                         'user_text':snapshot_text,
                         'title':row.title, 'folder_id':row.folder_id,
                         'date':getattr(row, source['type']+'_date').isoformat(),
                         'blocks':deepcopy(row.content_blocks)}
        if document is not None:
            snapshot['document'] = deepcopy(document)
        captured.append(snapshot)
    if len({s['date'] for s in captured}) > 7:
        raise WritingError('review supports at most seven distinct business dates')
    if not client.is_configured(): raise LocalError('Model is not configured',503)
    if not _slots.acquire(blocking=False): raise LocalError('Too many simultaneous AI calls',429)
    try:
        frozen = settings.settings_snapshot(db)
        access = search.web_access(frozen)
        messages = review_messages(captured, frozen['custom_prompt'], web_tools=access.enabled)
        private = tuple(s['user_text'] for s in captured) + (frozen['custom_prompt'],)
        db.add(AIRequest(id=payload.request_id,kind='review',payload_hash=digest,
                         status='pending',sources=captured,settings=frozen))
        db.commit()
        return None, None, (captured,messages,access,private)
    except Exception:
        _slots.release()
        raise


def record_round(bind, request_id, sources, index, result, error, searches):
    """Ledger commits independently, with unknown-slot upgrade on late usage."""
    with Session(bind) as db:
        lock_sources(db,sources)
        row = db.scalar(select(AIRequest).where(AIRequest.id==request_id).with_for_update())
        measured = result.usage if result else getattr(error,'usage',None)
        response_id = result.response_id if result else getattr(error,'response_id',None)
        record = usage.record_subcall(db, request_id=request_id if row else None,
            subcall_index=index, usage=measured, response_id=response_id, search_requests=searches)
        if measured is not None and not record.created:
            db.execute(update(AIUsage).where(AIUsage.id==record.usage_id,AIUsage.metering=='unknown')
                       .values(metering='known',prompt_tokens=measured.prompt_tokens,
                               completion_tokens=measured.completion_tokens,
                               total_tokens=measured.total_tokens,response_id=response_id))
            db.commit()


def finish_review(db, request_id, sources, outcome):
    locked = lock_sources(db,sources)
    row = db.scalar(select(AIRequest).where(AIRequest.id==request_id).with_for_update()
                    .execution_options(populate_existing=True))
    if row is None:
        db.rollback()
        return
    category = outcome.failure_category or (outcome.error.category if outcome.error else None)
    if outcome.result and outcome.result.truncated: category = 'truncated'
    preview = None
    if outcome.result is not None and category in (None, 'truncated'):
        try:
            preview = validate_review(outcome.result.text,sources,request_id)
        except (ValidationError, WritingError, ValueError):
            if category is None:
                category = 'review_invalid'
    row.result = {'review':preview,'web_status':outcome.web_status,'citations':list(outcome.citations)}
    if outcome.result is not None and category in ('truncated', 'review_invalid'):
        # Partial/non-JSON output cannot be a structured review, but the private
        # result must survive together with usage. Never repair or append it.
        row.result = {**row.result, 'raw_review': outcome.result.text}
    now = datetime.now(timezone.utc)
    if row.status == 'pending' and row.created_at <= now-timedelta(seconds=120):
        row.status = 'unknown'
        row.error_category = 'expired'
    if row.status == 'pending':
        if category is not None or preview is None:
            row.status = 'failed'
            row.error_category = category or 'review_invalid'
        elif not all(matches(current,s) for s,current in locked):
            row.status = 'conflict'
            row.error_category = 'source_changed'
        else:
            for s,_ in locked:
                checkpoint = db.get(AICheckpoint,(s['type'],s['id']))
                if checkpoint is None:
                    checkpoint = AICheckpoint(file_type=s['type'],file_id=s['id'])
                    db.add(checkpoint)
                checkpoint.consumed_user_text = s['user_text']
                checkpoint.last_request_id = request_id
                checkpoint.updated_at = now
            row.status = 'ready'
        row.completed_at = now
    db.commit()


def execute_review(db, payload):
    recover_pending(db)
    try: response, code, execution = register_review(db,payload)
    except Exception:
        db.rollback()
        raise
    if execution is None: return response, code
    sources,messages,access,private = execution
    bind = db.get_bind()
    def invoke(messages, *, tools_enabled, timeout):
        parameters = {'tools':list(tool_calls.TOOLS),'tool_choice':'auto'} if tools_enabled else None
        result = client.invoke(messages,max_tokens=client.REVIEW_MAX_TOKENS,parameters=parameters,timeout=timeout)
        # An incomplete tool round is not authority to search or spend another
        # subcall. Keep its usage/finish reason, and finish as truncated.
        return replace(result, tool_calls=()) if result.truncated else result
    try:
        outcome = tool_calls.run_tool_loop(messages,max_tokens=client.REVIEW_MAX_TOKENS,
            access=access,invoke=invoke,
            search=lambda query,timeout: search.search_web(query,source_texts=private,timeout=timeout),
            on_subcall=lambda index,result,error,searches: record_round(
                bind,payload.request_id,sources,index,result,error,searches),private_texts=private)
        try: finish_review(db,payload.request_id,sources,outcome)
        except Exception:
            db.rollback()
            # Save the usable preview without changing C if the atomic ready
            # transaction failed. Metering was already committed.
            with Session(bind) as recovery:
                lock_sources(recovery,sources)
                row = recovery.scalar(select(AIRequest).where(AIRequest.id==payload.request_id).with_for_update())
                if row is not None and row.status == 'pending':
                    preview = None
                    if outcome.result and not outcome.result.truncated:
                        try: preview = validate_review(outcome.result.text,sources,payload.request_id)
                        except (ValidationError, WritingError, ValueError): pass
                    row.result = {'review':preview,'web_status':outcome.web_status,'citations':list(outcome.citations)}
                    row.status = 'failed'
                    row.error_category = 'storage'
                    row.completed_at = datetime.now(timezone.utc)
                    recovery.commit()
        response = request_response(db,payload.request_id)
        if outcome.error:
            raise LocalError('Model request failed; reduce selected sources if the input exceeds model context; '
                             'query request_id for status',
                504 if isinstance(outcome.error,client.UpstreamTimeout) else 502,str(payload.request_id))
        return response,200
    finally: _slots.release()
