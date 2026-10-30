"""Independent S04-T08 HTTP/PG contract tests (not authored by the implementer).

Every test uses synthetic text only. Real model/search transports are blocked in
the fixture; individual tests install a fake local.model_invoke.
"""
from copy import deepcopy
import json
from uuid import uuid4

import pytest

HDR = {'document_schema_version': 1}


@pytest.fixture(autouse=True)
def block_real_transports(monkeypatch):
    from app.ai import client, local, search

    def blocked(*args, **kwargs):
        raise AssertionError('real model/search transport is forbidden in independent tests')

    monkeypatch.setattr(client, 'invoke', blocked)
    monkeypatch.setattr(local, 'model_invoke', blocked)
    monkeypatch.setattr(search, 'search_web', blocked)


def node(text, kind='paragraph'):
    return {'type': kind, 'attrs': {'id': str(uuid4())},
            'content': [{'type': 'text', 'text': text}]}


def make_doc(client, text='synthetic', extra=None):
    nodes = [node(text)] + list(extra or [])
    response = client.post('/api/journals', json={'journal_date': '2026-10-30',
        'document_schema_version': 1, 'content_doc': {'type': 'doc', 'content': nodes}})
    assert response.status_code == 201, response.text
    return response.json()


def patch_doc(client, journal, document, revision=None):
    return client.patch(f"/api/journals/{journal['id']}", json={
        'expected_revision': revision if revision is not None else journal['revision'],
        'document_schema_version': 1, 'content_doc': document})


def prepare_body(journal, rid, kind='go_deeper', trigger='manual', **extra):
    body = {'request_id': rid, 'kind': kind, 'trigger': trigger,
            'source': {'type': 'journal', 'id': journal['id'],
                       'expected_revision': journal['revision']}}
    body.update(extra)
    return body


def fake_model(monkeypatch, text='synthetic answer', usage=(7, 3, 10)):
    from app.ai import client, local, review, writing_requests
    from app.ai.client import ModelResult, ModelUsage
    calls = []

    def invoke(messages, *args, **kwargs):
        calls.append(messages)
        return ModelResult(text, 'synthetic-response', ModelUsage(*usage) if usage else None, 'stop')

    monkeypatch.setattr(client, 'is_configured', lambda: True)
    monkeypatch.setattr(client, 'invoke', invoke)
    monkeypatch.setattr(local, 'model_invoke', invoke)
    # The ledger commits on its own session; inside the savepoint fixture that
    # would break isolation. Metering is verified in the real-connection module.
    monkeypatch.setattr(writing_requests, 'record_round', lambda *a, **k: None, raising=False)
    monkeypatch.setattr(review, 'record_round', lambda *a, **k: None, raising=False)
    return calls


def review_json(journal_id, text='structured synthetic'):
    evidence = [{'source': {'type': 'journal', 'id': journal_id}, 'quote': text}]
    return json.dumps({
        'facts': [{'text': 'synthetic fact', 'evidence': evidence}],
        'emotion_hypotheses': [{'text': 'synthetic feeling', 'uncertainty': 'medium',
                                'evidence': evidence}],
        'possible_explanations': [{'text': 'synthetic cause', 'uncertainty': 'low',
                                   'evidence': evidence}],
        'angles': [{'title': '事件与情绪', 'content': 'synthetic'},
                   {'title': '选择与行为', 'content': 'synthetic'},
                   {'title': '认知与关系', 'content': 'synthetic'}],
        'logic_chain': ['synthetic'],
        'follow_up_questions': ['synthetic?'],
        'insight_drafts': [{'title': 'synthetic insight', 'viewpoint': 'synthetic view',
                            'evidence': evidence, 'content': 'synthetic content'}],
    }, ensure_ascii=False)


def comment_json(items):
    return json.dumps({'comments': items}, ensure_ascii=False)


def anchor_of(document, index, start, end):
    paragraph = document['content'][index]
    text = ''.join(part.get('text', '') for part in paragraph.get('content', []))
    return {'node_id': paragraph['attrs']['id'], 'start': start, 'end': end,
            'quote': text[start:end]}


# ---------------------------------------------------------------- 1. lifecycle

def test_prepare_execute_apply_freezes_snapshot_and_runs_once(api, monkeypatch):
    from app.ai.models import AICheckpoint, AIRequest
    client, db = api
    journal = make_doc(client)
    rid = str(uuid4())
    body = prepare_body(journal, rid)

    prepared = client.post('/api/ai/writing/prepare', json=body)
    assert prepared.status_code == 200, prepared.text
    payload = prepared.json()
    assert payload['status'] == 'prepared' and payload['request_id'] == rid
    detail = client.get(f"/api/journals/{journal['id']}").json()
    assert detail['revision'] == 2
    kinds = [item['type'] for item in detail['content_doc']['content']]
    assert kinds == ['paragraph', 'aiPlaceholder', 'paragraph']
    placeholder = detail['content_doc']['content'][1]
    assert placeholder['attrs']['request_id'] == rid
    assert payload['effects'][0]['ops'] == [{'kind': 'replace_placeholder',
                                            'node_id': placeholder['attrs']['id']}]
    assert payload['effects'][0]['base_revision'] == 1 and payload['effects'][0]['revision'] == 2
    assert payload['files'][0]['revision'] == 2
    assert db.get(AIRequest, rid).sources[0]['user_text'] == 'synthetic'

    # Same key + same body: replay returns the stored state, no second placeholder.
    replay = client.post('/api/ai/writing/prepare', json=body)
    assert replay.status_code == 200 and replay.json()['status'] == 'prepared'
    assert client.get(f"/api/journals/{journal['id']}").json()['revision'] == 2
    # Same key + different body: conflict, never a silent overwrite.
    assert client.post('/api/ai/writing/prepare',
                       json={**body, 'question': 'different'}).status_code == 409

    calls = fake_model(monkeypatch)
    executed = client.post(f'/api/ai/writing/{rid}/execute')
    assert executed.status_code == 200, executed.text
    assert executed.json()['status'] == 'ready'
    assert executed.json()['reply'] == 'synthetic answer'
    assert len(calls) == 1
    assert client.post(f'/api/ai/writing/{rid}/execute').json()['status'] == 'ready'
    assert len(calls) == 1, 'execute must never run the upstream call twice'

    applied = client.post(f'/api/ai/writing/{rid}/apply', json={'expected_revision': 2})
    assert applied.status_code == 200, applied.text
    assert applied.json()['status'] == 'applied'
    saved = client.get(f"/api/journals/{journal['id']}").json()
    assert saved['revision'] == 3
    assert saved['content_doc']['content'][1]['type'] == 'aiReply'
    assert saved['content_doc']['content'][1]['attrs']['request_id'] == rid
    assert db.get(AICheckpoint, ('journal', journal['id'])).consumed_user_text == 'synthetic'
    # Re-applying the same request is a replay: no extra revision, no second reply.
    again = client.post(f'/api/ai/writing/{rid}/apply', json={'expected_revision': 3})
    assert again.status_code == 200 and again.json()['status'] == 'applied'
    assert client.get(f"/api/journals/{journal['id']}").json()['revision'] == 3
    assert client.post(f'/api/ai/writing/{rid}/execute').json()['status'] == 'applied'
    assert len(calls) == 1


def test_no_increment_returns_noop_without_request_or_tokens(api):
    from datetime import datetime, timezone
    from app.ai.models import AICheckpoint, AIRequest, AIUsage
    from sqlalchemy import func, select
    client, db = api
    journal = make_doc(client)
    db.add(AICheckpoint(file_type='journal', file_id=journal['id'],
                        consumed_user_text='synthetic', updated_at=datetime.now(timezone.utc)))
    db.flush()
    result = client.post('/api/ai/writing/prepare', json=prepare_body(journal, str(uuid4())))
    assert result.status_code == 200
    assert result.json()['status'] == 'noop' and result.json()['request_id'] is None
    detail = client.get(f"/api/journals/{journal['id']}").json()
    assert detail['revision'] == 1 and len(detail['content_doc']['content']) == 1
    assert db.scalar(select(func.count()).select_from(AIRequest)) == 0


def test_continuation_text_survives_in_place_apply_and_checkpoint_uses_snapshot(api, monkeypatch):
    from app.ai.models import AICheckpoint, AIRequest
    client, db = api
    journal = make_doc(client)
    rid = str(uuid4())
    assert client.post('/api/ai/writing/prepare', json=prepare_body(journal, rid)).status_code == 200
    doc = client.get(f"/api/journals/{journal['id']}").json()['content_doc']
    doc['content'][-1]['content'] = [{'type': 'text', 'text': 'typed while waiting'}]
    assert patch_doc(client, journal, doc, 2).status_code == 200

    fake_model(monkeypatch)
    assert client.post(f'/api/ai/writing/{rid}/execute').json()['status'] == 'ready'
    applied = client.post(f'/api/ai/writing/{rid}/apply', json={'expected_revision': 3})
    assert applied.status_code == 200, applied.text
    saved = client.get(f"/api/journals/{journal['id']}").json()
    assert saved['revision'] == 4
    assert saved['content_doc']['content'][-1]['content'][0]['text'] == 'typed while waiting'
    assert saved['content_doc']['content'][-2]['type'] == 'aiReply'
    # C advances only to the frozen call-time snapshot, never past the continuation.
    assert db.get(AICheckpoint, ('journal', journal['id'])).consumed_user_text == 'synthetic'
    assert db.get(AIRequest, rid).sources[0]['user_text'] == 'synthetic'


def test_editing_above_the_boundary_blocks_attachment_but_keeps_result(api, monkeypatch):
    from app.ai.models import AICheckpoint, AIRequest
    client, db = api
    journal = make_doc(client)
    rid = str(uuid4())
    assert client.post('/api/ai/writing/prepare', json=prepare_body(journal, rid)).status_code == 200
    doc = client.get(f"/api/journals/{journal['id']}").json()['content_doc']
    doc['content'][0]['content'][0]['text'] = 'rewritten above boundary'
    assert patch_doc(client, journal, doc, 2).status_code == 200

    calls = fake_model(monkeypatch)
    # The frozen prefix changed: the request is invalidated at save time and
    # executing it reports conflict without any upstream call.
    assert client.post(f'/api/ai/writing/{rid}/execute').json()['status'] == 'conflict'
    assert len(calls) == 0
    response = client.post(f'/api/ai/writing/{rid}/apply', json={'expected_revision': 3})
    assert response.status_code == 409
    db.expire_all()
    row = db.get(AIRequest, rid)
    assert row.status == 'conflict'
    assert db.get(AICheckpoint, ('journal', journal['id'])) is None
    saved = client.get(f"/api/journals/{journal['id']}").json()
    assert saved['revision'] == 3
    assert all(item['type'] != 'aiReply' for item in saved['content_doc']['content'])


def test_deleted_placeholder_and_soft_deleted_source_cannot_attach(api, monkeypatch):
    from app.ai.models import AICheckpoint, AIRequest
    client, db = api
    journal = make_doc(client)
    rid = str(uuid4())
    assert client.post('/api/ai/writing/prepare', json=prepare_body(journal, rid)).status_code == 200
    doc = client.get(f"/api/journals/{journal['id']}").json()['content_doc']
    placeholder = doc['content'][1]['attrs']['id']
    removed = client.delete(f"/api/files/journal/{journal['id']}/ai-blocks/{placeholder}",
                            headers={'If-Match': '"2"'})
    assert removed.status_code == 204, removed.text
    db.expire_all()
    assert db.get(AIRequest, rid).status == 'conflict'
    assert client.post(f'/api/ai/writing/{rid}/execute').json()['status'] == 'conflict'
    assert client.post(f'/api/ai/writing/{rid}/apply',
                       json={'expected_revision': 3}).status_code == 409

    # Soft delete before any execution: executing a prepared request records no usage.
    second = make_doc(client, 'second synthetic text')
    rid2 = str(uuid4())
    assert client.post('/api/ai/writing/prepare', json=prepare_body(second, rid2)).status_code == 200
    assert client.delete(f"/api/journals/{second['id']}",
                         headers={'If-Match': '"2"'}).status_code == 204
    fake_model(monkeypatch)
    # Executing a non-prepared request replays its stored status without a call.
    assert client.post(f'/api/ai/writing/{rid2}/execute').json()['status'] == 'conflict'
    db.expire_all()
    assert db.get(AIRequest, rid2).status == 'conflict'
    assert db.get(AICheckpoint, ('journal', second['id'])) is None
    # Restoring the file must not give the old request a second chance.
    restored = client.post(f"/api/trash/journal/{second['id']}/restore",
                           headers={'If-Match': '"3"'})
    assert restored.status_code == 200, restored.text
    assert restored.json()['revision'] == 4
    assert client.post(f'/api/ai/writing/{rid2}/apply',
                       json={'expected_revision': 3}).status_code == 409


# ------------------------------------------------------------ 2. auto dedupe

def test_automatic_dual_label_dedupes_per_snapshot_and_never_rekeys_failures(api, monkeypatch):
    from app.ai.models import AIRequest
    from sqlalchemy import func, select
    client, db = api
    journal = make_doc(client)
    go_deeper = prepare_body(journal, str(uuid4()), trigger='automatic')
    first = client.post('/api/ai/writing/prepare', json=go_deeper)
    assert first.status_code == 200, first.text
    go_rid = first.json()['request_id']
    repeated = client.post('/api/ai/writing/prepare',
                           json={**go_deeper, 'request_id': str(uuid4())})
    assert repeated.status_code == 200 and repeated.json()['request_id'] == go_rid
    assert client.get(f"/api/journals/{journal['id']}").json()['revision'] == 2

    # While Go Deeper is still in flight the same file is serialised, not duplicated.
    minds = prepare_body(client.get(f"/api/journals/{journal['id']}").json(), str(uuid4()),
                         kind='minds_comments', trigger='automatic',
                         mind_preset_ids=['gentle_reflection'], scope='all')
    blocked = client.post('/api/ai/writing/prepare', json=minds)
    assert blocked.status_code == 409
    assert db.scalar(select(func.count()).select_from(AIRequest)) == 1

    # Failure does not become a licence to re-key and resend the same snapshot.
    db.get(AIRequest, go_rid).status = 'failed'
    db.get(AIRequest, go_rid).error_category = 'timeout'
    db.flush()
    retried = client.post('/api/ai/writing/prepare',
                          json={**go_deeper, 'request_id': str(uuid4())})
    assert retried.status_code == 200
    assert retried.json()['request_id'] == go_rid and retried.json()['status'] == 'failed'
    assert db.scalar(select(func.count()).select_from(AIRequest)) == 1


def test_automatic_minds_same_snapshot_and_scope_returns_same_request(api):
    from app.ai.models import AIRequest
    from sqlalchemy import func, select
    client, db = api
    journal = make_doc(client)
    body = prepare_body(journal, str(uuid4()), kind='minds_comments', trigger='automatic',
                        mind_preset_ids=['gentle_reflection'], scope='all')
    first = client.post('/api/ai/writing/prepare', json=body)
    assert first.status_code == 200, first.text
    second = client.post('/api/ai/writing/prepare', json={**body, 'request_id': str(uuid4())})
    assert second.json()['request_id'] == first.json()['request_id']
    assert db.scalar(select(func.count()).select_from(AIRequest)) == 1
    # A different preset set is a different analysis, so it is a different request.
    other = client.post('/api/ai/writing/prepare',
                        json={**body, 'request_id': str(uuid4()),
                              'mind_preset_ids': ['alternative_perspectives']})
    assert other.status_code == 409
    db.get(AIRequest, first.json()['request_id']).status = 'unknown'
    db.flush()
    replay = client.post('/api/ai/writing/prepare', json={**body, 'request_id': str(uuid4())})
    assert replay.json()['request_id'] == first.json()['request_id']
    assert replay.json()['status'] == 'unknown'
    assert db.scalar(select(func.count()).select_from(AIRequest)) == 1


# ------------------------------------------------------- 3. Minds range + marks

def test_multi_node_ranges_produce_scoped_comments_and_marks(api, monkeypatch):
    from app.ai.models import AICheckpoint, AIRequest
    client, db = api
    journal = make_doc(client, 'alpha synthetic', [node('beta synthetic')])
    doc = client.get(f"/api/journals/{journal['id']}").json()['content_doc']
    rid = str(uuid4())
    body = prepare_body(journal, rid, kind='minds_comments', trigger='manual',
                        mind_preset_ids=['gentle_reflection'],
                        scope={'ranges': [{'node_id': doc['content'][0]['attrs']['id'], 'start': 0, 'end': 5},
                                          {'node_id': doc['content'][1]['attrs']['id'], 'start': 5, 'end': 14}]})
    assert client.post('/api/ai/writing/prepare', json=body).status_code == 200, 'prepare ranges'
    frozen = db.get(AIRequest, rid).sources[0]
    assert frozen['scope'] == 'all' or len(frozen['scope']['ranges']) == 2
    assert sorted(item['quote'] for item in frozen['scope']['ranges']) == ['alpha', 'synthetic']

    fake_model(monkeypatch, text=comment_json([
        {'mind_preset_id': 'gentle_reflection', 'text': 'first note',
         'anchor': {'node_id': doc['content'][0]['attrs']['id'], 'start': 0, 'end': 5, 'quote': 'alpha'}},
        {'mind_preset_id': 'gentle_reflection', 'text': 'second note',
         'anchor': {'node_id': doc['content'][1]['attrs']['id'], 'start': 5, 'end': 14,
                    'quote': 'synthetic'}}]))
    assert client.post(f'/api/ai/writing/{rid}/execute').json()['status'] == 'ready'
    applied = client.post(f'/api/ai/writing/{rid}/apply', json={'expected_revision': 1})
    assert applied.status_code == 200, applied.text
    assert len(applied.json()['comments']) == 2
    assert all(item['anchor_state'] == 'available' for item in applied.json()['comments'])
    saved = client.get(f"/api/journals/{journal['id']}").json()
    assert saved['revision'] == 2
    first_text = saved['content_doc']['content'][0]['content'][0]
    assert first_text['text'] == 'alpha'
    assert first_text['marks'][0]['type'] == 'mindComment'
    assert db.get(AICheckpoint, ('journal', journal['id'])) is None, 'Minds must not advance C'
    listing = client.get(f"/api/journals/{journal['id']}/comments").json()
    assert listing['total'] == 2 and listing['page_size'] == 20
    assert [item['text'] for item in listing['items']] == ['first note', 'second note']
    assert client.get(f'/api/ai/requests/{rid}').json()['comments'][0]['text'] == 'first note'


def test_repeated_quote_attaches_by_node_and_offset_only(api, monkeypatch):
    client, _ = api
    journal = make_doc(client, 'synthetic', [node('synthetic')])
    doc = client.get(f"/api/journals/{journal['id']}").json()['content_doc']
    rid = str(uuid4())
    target = anchor_of(doc, 1, 0, 9)
    body = prepare_body(journal, rid, kind='minds_comments', trigger='manual',
                        mind_preset_ids=['gentle_reflection'],
                        scope={'node_id': doc['content'][1]['attrs']['id'], 'start': 0, 'end': 9})
    assert client.post('/api/ai/writing/prepare', json=body).status_code == 200
    fake_model(monkeypatch, text=comment_json([
        {'mind_preset_id': 'gentle_reflection', 'text': 'note one', 'anchor': target},
        {'mind_preset_id': 'gentle_reflection', 'text': 'note two',
         'anchor': {**target, 'start': 0, 'end': 9, 'quote': 'synthetic'}}]))
    assert client.post(f'/api/ai/writing/{rid}/execute').json()['status'] == 'ready'
    applied = client.post(f'/api/ai/writing/{rid}/apply', json={'expected_revision': 1})
    assert applied.status_code == 200, applied.text
    saved = client.get(f"/api/journals/{journal['id']}").json()
    first, second = saved['content_doc']['content']
    assert 'marks' not in first, 'the duplicate quote in the other node must stay unmarked'
    marked = [part for part in second['content'] if part.get('marks')]
    assert len(marked) == 1 and marked[0]['text'] == 'synthetic'
    assert len(marked[0]['marks'][0]['attrs']['comment_ids']) == 2


def test_unreliable_anchor_is_kept_but_not_attached(api, monkeypatch):
    from app.ai.models import AICheckpoint, AIRequest
    client, db = api
    journal = make_doc(client, 'alpha synthetic')
    doc = client.get(f"/api/journals/{journal['id']}").json()['content_doc']
    rid = str(uuid4())
    body = prepare_body(journal, rid, kind='minds_comments', trigger='manual',
                        mind_preset_ids=['gentle_reflection'], scope='all')
    assert client.post('/api/ai/writing/prepare', json=body).status_code == 200
    # Hostile quote: the offsets exist but the quoted text is not the saved text.
    fake_model(monkeypatch, text=comment_json([
        {'mind_preset_id': 'gentle_reflection', 'text': 'hostile note',
         'anchor': {'node_id': doc['content'][0]['attrs']['id'], 'start': 0, 'end': 5,
                    'quote': 'forged'}}]))
    assert client.post(f'/api/ai/writing/{rid}/execute').json()['status'] == 'ready'
    applied = client.post(f'/api/ai/writing/{rid}/apply', json={'expected_revision': 1})
    assert applied.status_code == 200, applied.text
    assert applied.json()['files'] == [] and applied.json()['effects'] == []
    assert applied.json()['comments'][0]['anchor_state'] == 'unavailable'
    saved = client.get(f"/api/journals/{journal['id']}").json()
    assert saved['revision'] == 1, 'an unusable anchor must not change the file'
    assert 'marks' not in saved['content_doc']['content'][0]['content'][0]
    listing = client.get(f"/api/journals/{journal['id']}/comments").json()
    assert listing['items'][0]['quote'] == 'forged' and listing['items'][0]['anchor_state'] == 'unavailable'
    assert db.get(AICheckpoint, ('journal', journal['id'])) is None


def test_edited_range_makes_comment_unavailable_and_deletion_removes_mark(api, monkeypatch):
    client, db = api
    journal = make_doc(client, 'alpha synthetic')
    doc = client.get(f"/api/journals/{journal['id']}").json()['content_doc']
    rid = str(uuid4())
    body = prepare_body(journal, rid, kind='minds_comments', trigger='manual',
                        mind_preset_ids=['gentle_reflection'], scope='all')
    assert client.post('/api/ai/writing/prepare', json=body).status_code == 200
    fake_model(monkeypatch, text=comment_json([
        {'mind_preset_id': 'gentle_reflection', 'text': 'anchored note',
         'anchor': {'node_id': doc['content'][0]['attrs']['id'], 'start': 0, 'end': 5, 'quote': 'alpha'}}]))
    assert client.post(f'/api/ai/writing/{rid}/execute').json()['status'] == 'ready'
    assert client.post(f'/api/ai/writing/{rid}/apply', json={'expected_revision': 1}).status_code == 200

    # Editing the anchored range must drop the mark and mark the comment unavailable.
    changed = client.get(f"/api/journals/{journal['id']}").json()
    document = deepcopy(changed['content_doc'])
    document['content'][0]['content'] = [{'type': 'text', 'text': 'rewritten synthetic'}]
    assert patch_doc(client, changed, document, 2).status_code == 200
    after = client.get(f"/api/journals/{journal['id']}").json()
    assert 'marks' not in after['content_doc']['content'][0]['content'][0]
    listing = client.get(f"/api/journals/{journal['id']}/comments").json()
    assert listing['total'] == 1 and listing['items'][0]['anchor_state'] == 'unavailable'
    assert listing['items'][0]['quote'] == 'alpha'

    # Deleting the record is CAS-guarded and leaves usage/checkpoint untouched.
    comment_id = listing['items'][0]['id']
    assert client.delete(f"/api/journals/{journal['id']}/comments/{comment_id}").status_code == 428
    assert client.delete(f"/api/journals/{journal['id']}/comments/{comment_id}",
                         headers={'If-Match': '"3"'}).status_code == 204
    assert client.get(f"/api/journals/{journal['id']}/comments").json()['total'] == 0
    assert client.get(f"/api/journals/{journal['id']}").json()['revision'] == 4


def test_client_cannot_inject_comment_marks_or_reuse_another_files_comment(api, monkeypatch):
    from datetime import datetime, timezone
    from uuid import UUID
    from hashlib import sha256
    from app.ritual.models import AIComment
    from app.writing.documents import add_comment_mark
    client, db = api
    journal = make_doc(client, 'alpha synthetic')
    doc = client.get(f"/api/journals/{journal['id']}").json()['content_doc']
    foreign = str(uuid4())
    forged = add_comment_mark(doc, {'node_id': doc['content'][0]['attrs']['id'], 'start': 0, 'end': 5,
        'quote': 'alpha', 'quote_sha256': sha256(b'alpha').hexdigest()}, foreign)
    rejected = patch_doc(client, journal, forged, 1)
    assert rejected.status_code == 422, rejected.text

    # A mark that already exists in the stored document but belongs to another file.
    other = make_doc(client, 'other synthetic')
    db.add(AIComment(id=UUID(foreign), journal_id=other['id'],
        mind_preset_id='gentle_reflection', text='foreign', quote='alpha',
        anchor={'node_id': doc['content'][0]['attrs']['id'], 'start': 0, 'end': 5, 'quote': 'alpha',
                'quote_sha256': sha256(b'alpha').hexdigest()},
        anchor_state='available', created_at=datetime.now(timezone.utc)))
    db.flush()
    from app.journal.models import Journal
    row = db.get(Journal, journal['id'])
    row.content_doc = forged
    db.flush()
    conflict = patch_doc(client, journal, forged, 1)
    assert conflict.status_code == 422, conflict.text


# ------------------------------------------------ 4. ranges / payload validation

@pytest.mark.parametrize('scope', [
    {'ranges': []},
    {'ranges': [{'node_id': str(uuid4()), 'start': 3, 'end': 3}]},
    {'ranges': [{'node_id': str(uuid4()), 'start': 0, 'end': 2}] * 101},
])
def test_invalid_range_shapes_are_rejected_before_any_write(api, scope):
    from app.ai.models import AIRequest
    from sqlalchemy import func, select
    client, db = api
    journal = make_doc(client)
    body = prepare_body(journal, str(uuid4()), kind='minds_comments',
                        mind_preset_ids=['gentle_reflection'], scope=scope)
    assert client.post('/api/ai/writing/prepare', json=body).status_code == 422
    assert db.scalar(select(func.count()).select_from(AIRequest)) == 0


def test_overlapping_ranges_and_unknown_node_are_rejected(api):
    client, _ = api
    journal = make_doc(client, 'alpha synthetic')
    doc = client.get(f"/api/journals/{journal['id']}").json()['content_doc']
    nid = doc['content'][0]['attrs']['id']
    overlap = prepare_body(journal, str(uuid4()), kind='minds_comments',
        mind_preset_ids=['gentle_reflection'],
        scope={'ranges': [{'node_id': nid, 'start': 0, 'end': 6}, {'node_id': nid, 'start': 5, 'end': 9}]})
    assert client.post('/api/ai/writing/prepare', json=overlap).status_code == 422
    beyond = prepare_body(journal, str(uuid4()), kind='minds_comments',
        mind_preset_ids=['gentle_reflection'], scope={'node_id': nid, 'start': 0, 'end': 99})
    assert client.post('/api/ai/writing/prepare', json=beyond).status_code == 422
    unknown = prepare_body(journal, str(uuid4()), kind='minds_comments',
        mind_preset_ids=['gentle_reflection'], scope={'node_id': str(uuid4()), 'start': 0, 'end': 3})
    assert client.post('/api/ai/writing/prepare', json=unknown).status_code == 422


def test_kind_specific_options_and_source_types_are_enforced(api):
    client, _ = api
    journal = make_doc(client)
    bogus_scope = prepare_body(journal, str(uuid4()), kind='go_deeper', scope='all')
    assert client.post('/api/ai/writing/prepare', json=bogus_scope).status_code == 422
    bad_preset = prepare_body(journal, str(uuid4()), kind='minds_comments',
                              mind_preset_ids=['not_a_preset'])
    assert client.post('/api/ai/writing/prepare', json=bad_preset).status_code == 422
    insight = client.post('/api/insights', json={'title': 'synthetic insight', 'content': 'x'}).json()
    wrong_type = {'request_id': str(uuid4()), 'kind': 'go_deeper', 'trigger': 'manual',
                  'source': {'type': 'insight', 'id': insight['id'], 'expected_revision': 1}}
    assert client.post('/api/ai/writing/prepare', json=wrong_type).status_code == 422
    missing = {'request_id': str(uuid4()), 'kind': 'go_deeper', 'trigger': 'manual',
               'source': {'type': 'journal', 'id': 999999, 'expected_revision': 1}}
    assert client.post('/api/ai/writing/prepare', json=missing).status_code == 404


# --------------------------------------------------------- 5. settings contract

def test_settings_auto_flags_are_cas_guarded_and_validated(api):
    client, _ = api
    current = client.get('/api/ai/settings').json()
    assert current['auto_go_deeper'] is False and current['auto_minds_comments'] is False
    assert current['mind_preset_ids'] == ['gentle_reflection']
    first = client.patch('/api/ai/settings',
                         json={'expected_revision': 0, 'auto_go_deeper': True,
                               'auto_minds_comments': True,
                               'mind_preset_ids': ['gentle_reflection', 'thinking_traps']})
    assert first.status_code == 200, first.text
    assert first.json()['auto_go_deeper'] is True and first.json()['revision'] == 1
    assert first.json()['mind_preset_ids'] == ['gentle_reflection', 'thinking_traps']
    # Stale revision and invalid payloads never partially apply.
    assert client.patch('/api/ai/settings',
                        json={'expected_revision': 0, 'auto_go_deeper': False}).status_code == 409
    for payload in ({'auto_go_deeper': 'yes'}, {'mind_preset_ids': []},
                    {'mind_preset_ids': ['gentle_reflection', 'gentle_reflection']},
                    {'mind_preset_ids': ['custom']}):
        assert client.patch('/api/ai/settings',
                            json={'expected_revision': 1, **payload}).status_code == 422
    unchanged = client.get('/api/ai/settings').json()
    assert unchanged['auto_go_deeper'] is True and unchanged['revision'] == 1


# ------------------------------------------------------------- 6. legacy boundary

def test_legacy_body_boundary_blocks_minds_but_allows_go_deeper_conversion(api):
    client, _ = api
    journal = client.post('/api/journals', json={'journal_date': '2026-10-30',
                                                'content': 'legacy synthetic body'}).json()
    minds = {'request_id': str(uuid4()), 'kind': 'minds_comments', 'trigger': 'manual',
             'source': {'type': 'journal', 'id': journal['id'], 'expected_revision': 1},
             'mind_preset_ids': ['gentle_reflection']}
    blocked = client.post('/api/ai/writing/prepare', json=minds)
    assert blocked.status_code == 409 and blocked.json()['code'] == 'legacy_conversion_required'
    go_deeper = {'request_id': str(uuid4()), 'kind': 'go_deeper', 'trigger': 'manual',
                 'source': {'type': 'journal', 'id': journal['id'], 'expected_revision': 1}}
    converted = client.post('/api/ai/writing/prepare', json=go_deeper)
    assert converted.status_code == 200, converted.text
    saved = client.get(f"/api/journals/{journal['id']}").json()
    assert saved['revision'] == 2 and saved['content_doc']['content'][-2]['type'] == 'aiPlaceholder'


# ------------------------------------------------ 7. review / insight regression

def test_review_keeps_snapshot_semantics_for_json_sources(api, monkeypatch):
    from app.ai.models import AIRequest
    client, db = api
    structured = make_doc(client, 'structured synthetic')
    fake_model(monkeypatch, text=review_json(structured['id']))
    rid = uuid4()
    response = client.post('/api/ai/reviews', json={'request_id': str(rid), 'sources': [
        {'type': 'journal', 'id': structured['id'], 'expected_revision': 1}]})
    assert response.status_code == 200, response.text
    snapshot = db.get(AIRequest, rid).sources[0]
    assert 'document' in snapshot and snapshot['user_text'] == 'structured synthetic'
    assert snapshot['blocks'] is None

    changed = client.get(f"/api/journals/{structured['id']}").json()
    document = deepcopy(changed['content_doc'])
    document['content'][0]['content'][0]['text'] = 'edited after snapshot'
    assert patch_doc(client, changed, document, 1).status_code == 200
    db.get(AIRequest, rid).status = 'ready'
    db.get(AIRequest, rid).result = {'review': {'summary': 'synthetic'}}
    db.flush()
    rejected = client.post(f'/api/ai/reviews/{rid}/save', json={
        'markdown': 'synthetic summary', 'target': {'mode': 'append_source'}})
    assert rejected.status_code == 409, rejected.text
    saved = client.get(f"/api/journals/{structured['id']}").json()
    assert saved['revision'] == 2
    assert all(item['type'] != 'aiSummary' for item in saved['content_doc']['content'])

    # A clean JSON source with identical user text still validates and appends
    # the summary without changing kind/date.
    other = make_doc(client, 'structured synthetic')
    fake_model(monkeypatch, text=review_json(other['id']))
    rid2 = uuid4()
    second = client.post('/api/ai/reviews', json={'request_id': str(rid2), 'sources': [
        {'type': 'journal', 'id': other['id'], 'expected_revision': 1}]})
    assert second.status_code == 200 and second.json()['status'] == 'ready', second.text
    ok = client.post(f'/api/ai/reviews/{rid2}/save', json={
        'markdown': 'synthetic summary', 'target': {'mode': 'append_source'}})
    assert ok.status_code == 200, ok.text
    final = client.get(f"/api/journals/{other['id']}").json()
    assert final['journal_kind'] == 'writing'
    assert final['content_doc']['content'][-2]['type'] == 'aiSummary'
    assert final['content_doc']['content'][-2]['attrs']['request_id'] == str(rid2)


def test_review_rejects_insight_sources_and_more_than_seven_dates(api):
    from uuid import uuid4
    client, _ = api
    insight = client.post('/api/insights', json={'title': 'synthetic', 'content': 'x'}).json()
    assert client.post('/api/ai/reviews', json={'request_id': str(uuid4()), 'sources': [
        {'type': 'insight', 'id': insight['id'], 'expected_revision': 1}]}).status_code == 422
    journals = []
    for day in range(1, 9):
        journals.append(client.post('/api/journals', json={
            'journal_date': f'2026-09-0{day}', 'content': f'synthetic {day}'}).json())
    over = client.post('/api/ai/reviews', json={'request_id': str(uuid4()), 'sources': [
        {'type': 'journal', 'id': item['id'], 'expected_revision': 1} for item in journals]})
    assert over.status_code == 422, over.text


def test_comments_are_journal_only_and_absent_for_insights(api):
    client, _ = api
    insight = client.post('/api/insights', json={'title': 'synthetic', 'content': 'x'}).json()
    assert client.get(f"/api/journals/{insight['id']}/comments").status_code == 404
    journal = make_doc(client)
    assert client.get(f"/api/journals/{journal['id']}/comments").json()['total'] == 0
    assert client.delete(f"/api/journals/{journal['id']}/comments/{uuid4()}",
                         headers={'If-Match': '"1"'}).status_code == 404


def test_local_generation_still_rejects_a_prepared_writing_request(api):
    client, _ = api
    journal = make_doc(client)
    body = prepare_body(journal, str(uuid4()))
    assert client.post('/api/ai/writing/prepare', json=body).status_code == 200
    conflict = client.post('/api/ai/local', json={
        'request_id': str(uuid4()),
        'source': {'type': 'journal', 'id': journal['id'], 'expected_revision': 2}})
    assert conflict.status_code == 409, conflict.text
