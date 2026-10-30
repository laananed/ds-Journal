"""Short transactions for frozen writing requests. No upstream call during prepare."""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
from sqlalchemy import select, text
from app.ai import client, local, search, settings, tool_calls, usage
from app.ai.incremental import Increment, compute_increment
from app.ai.local import active, lock_source, LocalError
from app.ai.prompts import local_messages, minds_messages
from app.ai.requests import recover_pending, request_response
from app.ai.review import record_round as _record_review_round
from app.ai.models import AIRequest, AICheckpoint
from app.ai.requests import RequestNotFound
from app.journal.schemas import _is_blank, _validate_content
from app.journal.service import get_journal
from app.writing.documents import (DocumentError, _plain, convert_legacy_text, prepare_ai_placeholder,
                                   apply_ai_placeholder, project_document, user_text_document, validate_anchor)
from app.writing.service import LegacyConversionRequired, WriteConflict, WritingError


def record_round(bind, request_id, source, index, result, error, searches):
    _record_review_round(bind, request_id, [source], index, result, error, searches)


def execute(db, request_id):
    recover_pending(db)
    initial = db.get(AIRequest, request_id)
    if initial is None or initial.kind not in ('go_deeper', 'minds_comments'):
        raise RequestNotFound('AI request not found')
    source = deepcopy(initial.sources[0])
    row = lock_source(db, source)
    request = db.scalar(select(AIRequest).where(AIRequest.id == request_id).with_for_update()
                        .execution_options(populate_existing=True))
    if request is None:
        raise RequestNotFound('AI request not found')
    source = deepcopy(request.sources[0])
    if request.status != 'prepared':
        status = request.status
        result = request_response(db, request_id)
        db.rollback()
        return result, 202 if status == 'pending' else 200
    if not active(row):
        request.status, request.error_category = 'conflict', 'source_changed'
        db.commit()
        raise WriteConflict('source unavailable')
    if not client.is_configured():
        raise LocalError('Model is not configured', 503, str(request_id))
    if not local._slots.acquire(blocking=False):
        raise LocalError('Too many simultaneous AI calls', 429, str(request_id))
    try:
        frozen_settings = deepcopy(request.settings)
        question = request.question
        kind = request.kind
        request.status = 'pending'
        request.started_at = datetime.now(timezone.utc)
        db.commit()  # releases source and request locks before any network call
        increment = Increment(**source['increment'])
        access = search.web_access(frozen_settings)
        if kind == 'minds_comments':
            from app.ai.comments import prompt_nodes
            messages = minds_messages(prompt_nodes(source), source['mind_preset_ids'],
                                      frozen_settings['custom_prompt'], web_tools=access.enabled)
        else:
            messages = local_messages(increment, question, frozen_settings['custom_prompt'],
                                      source.get('context', []), web_tools=access.enabled)
        private = (source['user_text'], question or '', frozen_settings['custom_prompt'],
                   *(message.get('content', '') for message in source.get('context', [])))
        bind = db.get_bind()
        outcome = tool_calls.run_tool_loop(messages, max_tokens=client.LOCAL_MAX_TOKENS,
            access=access, invoke=local.model_invoke,
            search=lambda query, timeout: search.search_web(query, source_texts=private, timeout=timeout),
            on_subcall=lambda index, result, error, searches: record_round(bind, request_id, source, index, result, error, searches),
            private_texts=private)
        lock_source(db, source)
        request = db.scalar(select(AIRequest).where(AIRequest.id == request_id).with_for_update()
                            .execution_options(populate_existing=True))
        if request is None:
            db.rollback()
            raise RequestNotFound('AI request not found')
        stored = {'web_status':outcome.web_status, 'citations':list(outcome.citations)}
        if outcome.result is not None:
            stored['reply'] = outcome.result.text
        parse_error = None
        if kind == 'minds_comments' and outcome.result is not None and not outcome.result.truncated:
            from app.ai.comments import parse_comments
            try:
                stored['comments'] = parse_comments(outcome.result.text, source)
            except WritingError:
                parse_error = 'minds_invalid'
        request.result = stored
        if request.status == 'pending':
            category = outcome.failure_category or (outcome.error.category if outcome.error else None) or parse_error
            if outcome.result is not None and outcome.result.truncated:
                category = 'truncated'
            request.status = 'failed' if category or outcome.result is None else 'ready'
            request.error_category = category
            request.completed_at = datetime.now(timezone.utc)
        db.commit()
        result = request_response(db, request_id)
        db.rollback()
        if outcome.error is not None:
            raise LocalError('Model request failed; query request_id for status',
                             504 if isinstance(outcome.error, client.UpstreamTimeout) else 502,
                             str(request_id))
        return result, 200
    finally:
        local._slots.release()


def _capture_scope(document, scope):
    if scope == 'all':
        return 'all'
    if hasattr(scope, 'ranges'):
        ranges = [_capture_scope(document, item) for item in scope.ranges]
        return {'ranges':sorted(ranges, key=lambda item: (item['node_id'], item['start'], item['end']))}
    target = str(scope.node_id)
    found = []
    def visit(node, protected=False):
        protected = protected or node['type'] in ('aiReply','aiSummary','aiPlaceholder','ritualQuestion','legacyText','goalItem')
        if not protected and node['type'] in ('paragraph','heading') and node.get('attrs',{}).get('id') == target:
            found.append(_plain(node, True))
        for child in node.get('content', []):
            visit(child, protected)
    visit(document)
    if len(found) != 1 or scope.end > len(found[0]):
        raise WritingError('invalid selection')
    quote = found[0][scope.start:scope.end]
    anchor = {'node_id':target,'start':scope.start,'end':scope.end,'quote':quote,
              'quote_sha256':hashlib.sha256(quote.encode('utf-8')).hexdigest()}
    try:
        validate_anchor(document, anchor)
    except DocumentError as error:
        raise WritingError('invalid selection') from error
    return anchor


def prepare(db, payload):
    body = payload.model_dump(mode='json', exclude_unset=True)
    digest = usage.call_payload_hash(body)
    db.execute(text('select pg_advisory_xact_lock(:key)'),
               {'key':int.from_bytes(payload.request_id.bytes[:8], 'big', signed=True)})
    existing = db.get(AIRequest, payload.request_id)
    if existing is not None:
        if existing.payload_hash != digest:
            raise WriteConflict('request_id was used for a different payload')
        result = {'request_id':str(existing.id),'status':existing.status,'files':[],'effects':[]}
        db.rollback()
        return result
    source = payload.source.model_dump(mode='json')
    row = lock_source(db, source)
    if not active(row):
        raise RequestNotFound('File not found')
    if row.content_doc is None and (row.content_blocks is not None or payload.kind != 'go_deeper'):
        raise LegacyConversionRequired('legacy body requires safe conversion')
    if row.revision != source['expected_revision']:
        if payload.trigger == 'automatic' and payload.kind == 'go_deeper' and row.content_doc is not None:
            candidates = db.scalars(select(AIRequest).where(
                AIRequest.kind == 'go_deeper', AIRequest.auto_dedupe_key.is_not(None),
                AIRequest.sources.contains([{'type':'journal','id':row.id}]))).all()
            nodes = row.content_doc['content']
            for candidate in candidates:
                frozen = candidate.sources[0]
                if frozen.get('revision') != source['expected_revision']:
                    continue
                original = frozen.get('document', {}).get('content', [])
                if len(nodes) != len(original) + 2 or nodes[:len(original)] != original:
                    continue
                boundary, continuation = nodes[-2:]
                if (boundary.get('type') in ('aiPlaceholder', 'aiReply') and
                    boundary.get('attrs', {}).get('request_id') == str(candidate.id) and
                    continuation.get('type') == 'paragraph' and not continuation.get('content')):
                    result = {'request_id':str(candidate.id),'status':candidate.status,'files':[],'effects':[]}
                    db.rollback()
                    return result
        raise WriteConflict('file revision has changed')
    doc = (deepcopy(row.content_doc) if row.content_doc is not None
           else convert_legacy_text(row.content, row.content_blocks))
    current = user_text_document(doc)
    captured_settings = settings.settings_snapshot(db)
    scope = _capture_scope(doc, payload.scope or 'all') if payload.kind == 'minds_comments' else None
    presets = (sorted(payload.mind_preset_ids or captured_settings['mind_preset_ids'])
               if payload.kind == 'minds_comments' else [])
    dedupe = None
    if payload.trigger == 'automatic':
        dedupe = usage.call_payload_hash({'journal_id':row.id,'kind':payload.kind,
                 'snapshot_hash':hashlib.sha256(current.encode('utf-8')).hexdigest(),
                 'scope':scope,'presets':presets})
        old = db.scalar(select(AIRequest).where(AIRequest.auto_dedupe_key == dedupe))
        if old is not None:
            result = {'request_id':str(old.id),'status':old.status,'files':[],'effects':[]}
            db.rollback()
            return result
    inflight = db.scalar(select(AIRequest.id).where(
        AIRequest.status.in_(['prepared','pending']),
        AIRequest.sources.contains([{'type':'journal','id':row.id}])).limit(1))
    if inflight is not None:
        raise WriteConflict('source already has an in-flight writing request')
    checkpoint = db.get(AICheckpoint, ('journal', row.id))
    increment = compute_increment(current, checkpoint.consumed_user_text if checkpoint else None)
    question = payload.question if payload.question and not _is_blank(payload.question) else None
    if payload.kind == 'go_deeper' and not increment.valid and question is None:
        db.rollback()
        return {'status':'noop','message':'要我分析啥啊？','request_id':None,'usage':None}
    frozen = {'type':'journal','id':row.id,'revision':row.revision,'user_text':current,
              'title':row.title,'folder_id':row.folder_id,'date':row.journal_date.isoformat(),
              'format':'document_v1','document':doc,'scope':scope,
              'increment':{'text':increment.text,'revised':increment.revised,'position':increment.position},
              'mind_preset_ids':presets,'trigger':payload.trigger}
    if payload.kind == 'go_deeper' and question:
        frozen['context'] = local.recent_context(db, source)
    files, effects = [], []
    if payload.kind == 'go_deeper':
        updated = prepare_ai_placeholder(doc, str(payload.request_id))
        projection = project_document(updated)
        try:
            _validate_content(projection)
        except ValueError as error:
            raise WritingError('content limit exceeded') from error
        base = row.revision
        row.content_doc = updated
        row.content = projection
        row.revision += 1
        row.updated_at = datetime.now(timezone.utc)
        db.flush()
        files = [get_journal(db,row.id).model_dump(mode='json')]
        effects = [{'type':'journal','id':row.id,'base_revision':base,'revision':row.revision,
                    'ops':[{'kind':'replace_placeholder','node_id':updated['content'][-2]['attrs']['id']}]}]
    db.add(AIRequest(id=payload.request_id,kind=payload.kind,payload_hash=digest,
                     status='prepared',sources=[frozen],question=question,settings=captured_settings,
                     auto_dedupe_key=dedupe))
    db.commit()
    return {'request_id':str(payload.request_id),'status':'prepared','files':files,'effects':effects}


def apply(db, request_id, expected_revision):
    existing = db.get(AIRequest, request_id)
    if existing is None or existing.kind not in ('go_deeper', 'minds_comments'):
        raise RequestNotFound('AI request not found')
    source = deepcopy(existing.sources[0])
    row = lock_source(db, source)
    request = db.scalar(select(AIRequest).where(AIRequest.id == request_id).with_for_update()
                        .execution_options(populate_existing=True))
    if request is None:
        raise RequestNotFound('AI request not found')
    source = deepcopy(request.sources[0])
    if request.status == 'applied':
        db.rollback()
        return {'request_id':str(request_id),'status':'applied','files':[],'effects':[]}
    if request.status != 'ready':
        raise WriteConflict('request is not ready')
    if not active(row) or row.content_doc is None:
        request.status = 'conflict'
        request.error_category = 'source_changed'
        db.commit()
        raise WriteConflict('source unavailable')
    if row.revision != expected_revision:
        raise WriteConflict('file revision has changed')
    if request.kind == 'minds_comments':
        from app.ai.comments import apply_comments
        doc, comments = apply_comments(db, row, request, source)
        changed = doc != row.content_doc
        if changed:
            projection = project_document(doc)
            try:
                _validate_content(projection)
            except ValueError as error:
                raise WritingError('content limit exceeded') from error
            row.content_doc, row.content = doc, projection
            row.revision += 1
            row.updated_at = datetime.now(timezone.utc)
        request.status = 'applied'
        request.completed_at = datetime.now(timezone.utc)
        db.flush()
        detail = get_journal(db, row.id).model_dump(mode='json')
        result = {'request_id':str(request_id),'status':'applied','files':[detail] if changed else [],
                  'effects':[{'type':'journal','id':row.id,'base_revision':expected_revision,
                              'revision':row.revision,'ops':[{'kind':'comment_marks'}]}] if changed else [],
                  'comments':[{'id':str(c.id),'anchor_state':c.anchor_state} for c in comments]}
        db.commit()
        return result
    try:
        doc = apply_ai_placeholder(row.content_doc, str(request_id), source['user_text'],
                                   (request.result or {}).get('reply'))
    except DocumentError as error:
        request.status = 'conflict'
        request.error_category = 'source_changed'
        db.commit()
        raise WriteConflict('source or placeholder changed') from error
    projection = project_document(doc)
    try:
        _validate_content(projection)
    except ValueError as error:
        raise WritingError('content limit exceeded') from error
    node = next(n for n in doc['content'] if n['type'] == 'aiReply' and n['attrs']['request_id'] == str(request_id))
    row.content_doc, row.content = doc, projection
    row.revision += 1
    row.updated_at = datetime.now(timezone.utc)
    checkpoint = db.get(AICheckpoint, ('journal', row.id))
    if checkpoint is None:
        checkpoint = AICheckpoint(file_type='journal',file_id=row.id)
        db.add(checkpoint)
    checkpoint.consumed_user_text = source['user_text']
    checkpoint.last_request_id = request_id
    checkpoint.updated_at = datetime.now(timezone.utc)
    request.status = 'applied'
    request.completed_at = datetime.now(timezone.utc)
    db.flush()
    detail = get_journal(db, row.id).model_dump(mode='json')
    result = {'request_id':str(request_id),'status':'applied','files':[detail],
              'effects':[{'type':'journal','id':row.id,'base_revision':expected_revision,
                          'revision':row.revision,'ops':[{'kind':'replace_placeholder','node_id':node['attrs']['id']}]}]}
    db.commit()
    return result
