"""Insight AI behavior using synthetic records and no real model calls."""
from uuid import uuid4
import hashlib
import pytest

from app.ai.models import AIRequest, AICheckpoint
from app.ritual.models import AIComment
from sqlalchemy import select


@pytest.fixture(autouse=True)
def block_real_model_and_search(monkeypatch):
    from app.ai import client, search
    def blocked(*args, **kwargs):
        raise AssertionError('real model/search calls are forbidden')
    monkeypatch.setattr(client, 'invoke', blocked)
    monkeypatch.setattr(search, 'search_web', blocked)


def insight(client):
    node = str(uuid4())
    doc = {'type': 'doc', 'content': [{'type': 'paragraph', 'attrs': {'id': node},
           'content': [{'type': 'text', 'text': 'synthetic text'}]}]}
    response = client.post('/api/insights', json={'document_schema_version': 1, 'content_doc': doc})
    assert response.status_code == 201, response.text
    return response.json(), node


def prepare(client, file, kind='go_deeper', question=None):
    rid = str(uuid4())
    payload = {'request_id': rid, 'kind': kind, 'trigger': 'manual',
               'source': {'type': 'insight', 'id': file['id'], 'expected_revision': file['revision']}}
    if question is not None:
        payload['question'] = question
    response = client.post('/api/ai/writing/prepare', json=payload)
    assert response.status_code == 200, response.text
    return rid, payload, response.json()


def test_insight_prepare_apply_replay_and_continuation(api):
    client, db = api
    file, _ = insight(client)
    rid, payload, initial = prepare(client, file, question='synthetic question')
    assert initial['files'][0]['type'] == 'insight'
    assert client.post('/api/ai/writing/prepare', json=payload).json()['request_id'] == rid
    request = db.get(AIRequest, rid)
    request.status, request.result = 'ready', {'reply': 'synthetic response'}
    db.flush()
    detail = client.get(f"/api/insights/{file['id']}").json()
    document = detail['content_doc']
    document['content'][-1]['content'] = [{'type': 'text', 'text': 'later input'}]
    response = client.patch(f"/api/insights/{file['id']}", json={'expected_revision': 2,
        'document_schema_version': 1, 'content_doc': document})
    assert response.status_code == 200, response.text
    response = client.post(f'/api/ai/writing/{rid}/apply', json={'expected_revision': 3})
    assert response.status_code == 200, response.text
    saved = client.get(f"/api/insights/{file['id']}").json()
    assert saved['content_doc']['content'][-1]['content'][0]['text'] == 'later input'
    assert saved['content_doc']['content'][-2]['type'] == 'aiReply'
    assert db.get(AICheckpoint, ('insight', file['id'])).consumed_user_text == 'synthetic text'
    assert client.post(f'/api/ai/writing/{rid}/apply', json={'expected_revision': 3}).status_code == 200


def test_insight_comment_ownership_and_edit(api):
    client, db = api
    file, node = insight(client)
    rid, _, _ = prepare(client, file, kind='minds_comments')
    quote = 'synthetic'
    anchor = {'node_id': node, 'start': 0, 'end': len(quote), 'quote': quote,
              'quote_sha256': hashlib.sha256(quote.encode()).hexdigest()}
    request = db.get(AIRequest, rid)
    request.status = 'ready'
    request.result = {'comments': [{'mind_preset_id': 'gentle_reflection', 'text': 'synthetic comment', 'anchor': anchor}]}
    db.flush()
    response = client.post(f'/api/ai/writing/{rid}/apply', json={'expected_revision': 1})
    assert response.status_code == 200, response.text
    comment = db.scalar(select(AIComment).where(AIComment.insight_id == file['id']))
    assert comment is not None and comment.journal_id is None
    assert client.get(f"/api/insights/{file['id']}/comments").json()['total'] == 1
    detail = client.get(f"/api/insights/{file['id']}").json()
    document = detail['content_doc']
    document['content'][0]['content'].append({'type': 'text', 'text': ' extra'})
    response = client.patch(f"/api/insights/{file['id']}", json={'expected_revision': 2,
        'document_schema_version': 1, 'content_doc': document})
    assert response.status_code == 200, response.text
    assert client.delete(f"/api/insights/{file['id']}/comments/{comment.id}",
                         headers={'If-Match': '"3"'}).status_code == 204


def test_insight_soft_delete_invalidates_ready_request(api):
    client, db = api
    file, _ = insight(client)
    rid, _, _ = prepare(client, file)
    assert client.delete(f"/api/insights/{file['id']}", headers={'If-Match': '"2"'}).status_code == 204
    db.expire_all()
    assert db.get(AIRequest, rid).status == 'conflict'


def test_insight_conflict_keeps_result_and_checkpoint_unchanged(api):
    client, db = api
    file, _ = insight(client)
    rid, _, _ = prepare(client, file)
    request = db.get(AIRequest, rid)
    request.status, request.result = 'ready', {'reply': 'synthetic response'}
    db.flush()
    document = client.get(f"/api/insights/{file['id']}").json()['content_doc']
    document['content'][0]['content'][0]['text'] = 'changed text'
    response = client.patch(f"/api/insights/{file['id']}", json={'expected_revision': 2,
        'document_schema_version': 1, 'content_doc': document})
    assert response.status_code == 200, response.text
    assert client.post(f'/api/ai/writing/{rid}/apply', json={'expected_revision': 3}).status_code == 409
    db.expire_all()
    assert db.get(AIRequest, rid).result['reply'] == 'synthetic response'
    assert db.get(AICheckpoint, ('insight', file['id'])) is None


def test_insight_execute_mocked_model_once(api, monkeypatch):
    from app.ai import client as model_client, local, writing_requests
    from app.ai.client import ModelResult
    client, _ = api
    file, _ = insight(client)
    rid, _, _ = prepare(client, file, question='synthetic question')
    calls = []
    monkeypatch.setattr(model_client, 'is_configured', lambda: True)
    monkeypatch.setattr(writing_requests, 'record_round', lambda *args, **kwargs: None)
    monkeypatch.setattr(local, 'model_invoke', lambda *args, **kwargs:
                        (calls.append(True) or ModelResult('synthetic answer', 'synthetic', None, 'stop')))
    first = client.post(f'/api/ai/writing/{rid}/execute')
    assert first.status_code == 200, first.text
    assert first.json()['status'] == 'ready'
    assert first.json()['sources'][0]['type'] == 'insight'
    assert client.post(f'/api/ai/writing/{rid}/execute').json()['status'] == 'ready'
    assert len(calls) == 1
    assert client.post(f'/api/ai/writing/{rid}/apply', json={'expected_revision': 2}).status_code == 200


def test_equal_journal_and_insight_ids_do_not_share_inflight_request(api):
    from app.insight.models import Insight
    from sqlalchemy import update
    client, db = api
    journal = client.post('/api/journals', json={'journal_date': '2026-10-30',
        'document_schema_version': 1, 'content_doc': {'type': 'doc', 'content': [
            {'type': 'paragraph', 'attrs': {'id': str(uuid4())},
             'content': [{'type': 'text', 'text': 'synthetic journal'}]}]}})
    assert journal.status_code == 201, journal.text
    journal = journal.json()
    file, _ = insight(client)
    if file['id'] != journal['id']:
        db.execute(update(Insight).where(Insight.id == file['id']).values(id=journal['id']))
        db.flush()
        db.expire_all()
    file['id'] = journal['id']
    journal_payload = {'request_id': str(uuid4()), 'kind': 'minds_comments', 'trigger': 'manual',
        'source': {'type': 'journal', 'id': journal['id'], 'expected_revision': 1}}
    response = client.post('/api/ai/writing/prepare', json=journal_payload)
    assert response.status_code == 200, response.text
    insight_id, _, _ = prepare(client, file, kind='minds_comments')
    assert insight_id != journal_payload['request_id']
    assert db.get(AIRequest, insight_id).sources[0]['type'] == 'insight'


@pytest.mark.parametrize('kind', ['set', 'end'])
@pytest.mark.parametrize('ai_kind', ['go_deeper', 'minds_comments'])
def test_ritual_ai_prepare_preserves_journal_kind(api, kind, ai_kind):
    client, _ = api
    response = client.post('/api/journals', json={
        'journal_kind': kind, 'journal_date': '2026-10-30',
        'draft_started_at': '2026-10-30T04:00:00+08:00',
        'document_schema_version': 1, 'content_doc': {'type': 'doc', 'content': [
            {'type': 'paragraph', 'attrs': {'id': str(uuid4())},
             'content': [{'type': 'text', 'text': 'synthetic plan'}]}]}})
    assert response.status_code == 201, response.text
    file = response.json()
    body = {'request_id': str(uuid4()), 'kind': ai_kind, 'trigger': 'manual',
            'source': {'type': 'journal', 'id': file['id'], 'expected_revision': 1}}
    response = client.post('/api/ai/writing/prepare', json=body)
    assert response.status_code == 200, response.text
    saved = client.get(f"/api/journals/{file['id']}").json()
    assert saved['journal_kind'] == kind
    assert saved['journal_date'] == '2026-10-30'
