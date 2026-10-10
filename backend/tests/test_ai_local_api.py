"""Committed PostgreSQL sessions; only the model transport is mocked."""
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from threading import Event
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select, text
from sqlalchemy.orm import Session

from app.ai import client as model_client
from app.ai.models import AICheckpoint, AIRequest, AIUsage
from app.database import engine
from app.journal.models import Journal
from app.inbox.models import Inbox
from app.main import app
from app.writing.service import project_blocks


class MockTransport:
    def __init__(self):
        self.calls = []
        self.entered = Event()
        self.release = Event()
        self.block = False
        self.finish = 'stop'
        self.usage = {'prompt_tokens': 10, 'completion_tokens': 2, 'total_tokens': 12}
        self.error = None
        self.malformed = False
        self.response_id = 'synthetic-' + uuid4().hex

    def post_json(self, url, payload, headers, timeout, max_bytes):
        self.calls.append(payload)  # Never capture credentials.
        self.entered.set()
        if self.block:
            assert self.release.wait(10), 'test release deadline'
        if self.error:
            raise self.error
        body = {'id': self.response_id, 'choices': [{'finish_reason': self.finish,
                'message': {'content': '咦，是哪件事让你挂心呀？'}}]}
        if self.usage is not None:
            body['usage'] = self.usage
        if self.malformed:
            body['choices'] = []
        return model_client.TransportResponse(200, json.dumps(body).encode(), 'application/json')


@pytest.fixture
def local_env(monkeypatch):
    from scripts.prepare_test_db import BUSINESS_TABLES
    def counts():
        with engine.connect() as c:
            assert c.scalar(text('select current_database()')) == 'seekjournal_test'
            assert c.scalar(text('select version_num from alembic_version')) == '3aa16300a58a'
            return {t: c.scalar(text('select count(*) from ' + t)) for t in BUSINESS_TABLES}
    baseline = counts()
    with Session(engine) as db:
        usage_before = set(db.scalars(select(AIUsage.id)))
    transport = MockTransport()
    monkeypatch.setenv('DEEPSEEK_API_KEY', 'synthetic-mock-key')
    monkeypatch.setattr(model_client, 'UrllibTransport', lambda: transport)
    owned = []
    def create(content='用户甲😀', kind='journal', blocks=None):
        model = Journal if kind == 'journal' else Inbox
        with Session(engine) as db:
            row = model(content=project_blocks(blocks) if blocks is not None else content,
                        content_blocks=blocks, **{kind + '_date': date(2026, 10, 10)})
            db.add(row)
            db.commit()
            owned.append((kind, row.id))
            return {'type': kind, 'id': row.id, 'expected_revision': row.revision}
    http = TestClient(app, raise_server_exceptions=False)
    try:
        yield http, transport, create
    finally:
        transport.release.set()
        http.close()
        with Session(engine) as db:
            usage_owned = set(db.scalars(select(AIUsage.id).where(AIUsage.response_id == transport.response_id)))
            for kind, ident in owned:
                requests = list(db.scalars(select(AIRequest.id).where(AIRequest.sources.contains([{'type': kind, 'id': ident}]))))
                if requests:
                    usage_owned.update(db.scalars(select(AIUsage.id).where(AIUsage.request_id.in_(requests))))
                db.execute(delete(AICheckpoint).where(AICheckpoint.file_type == kind, AICheckpoint.file_id == ident))
                db.execute(delete(AIRequest).where(AIRequest.sources.contains([{'type': kind, 'id': ident}])))
                db.execute(delete(Journal if kind == 'journal' else Inbox).where((Journal if kind == 'journal' else Inbox).id == ident))
            if usage_owned:
                db.execute(delete(AIUsage).where(AIUsage.id.in_(usage_owned)))
            db.commit()
        assert counts() == baseline


def body(source, question=None, request_id=None):
    result = {'request_id': str(request_id or uuid4()), 'source': source}
    if question is not None:
        result['question'] = question
    return result


def checkpoint(source):
    with Session(engine) as db:
        row = db.get(AICheckpoint, (source['type'], source['id']))
        return row.consumed_user_text if row else None


def test_first_append_revision_question_noop_and_replay(local_env):
    http, transport, create = local_env
    source = create()
    payload = body(source)
    first = http.post('/api/ai/local', json=payload)
    assert first.status_code == 200, first.text
    result = first.json()
    assert result['status'] == 'applied' and result['file']['revision'] == 2
    assert checkpoint(source) == '用户甲😀'
    blocks = result['file']['content_blocks']
    assert [b['kind'] for b in blocks] == ['user', 'ai_reply', 'user']
    assert blocks[-1]['text'] == ''
    assert '用户甲😀' in transport.calls[0]['messages'][-1]['content']
    assert transport.calls[0]['max_tokens'] == 512 and 'tools' not in transport.calls[0]
    assert http.post('/api/ai/local', json=payload).json()['status'] == 'applied'
    assert len(transport.calls) == 1

    assert http.post('/api/ai/local', json=dict(payload, question='different')).status_code == 409
    source['expected_revision'] = 2
    before = result['file']
    noop = http.post('/api/ai/local', json=body(source, '\ufeff\u3000')).json()
    assert noop == {'status': 'noop', 'message': '要我分析啥啊？', 'request_id': None, 'usage': None}
    assert http.get(f"/api/journals/{source['id']}").json() == before
    blocks[-1]['text'] = '\n追加乙'
    patched = http.patch(f"/api/journals/{source['id']}", json={'expected_revision': 2, 'content_blocks': blocks}).json()
    source['expected_revision'] = patched['revision']
    assert http.post('/api/ai/local', json=body(source)).json()['status'] == 'applied'
    message = transport.calls[-1]['messages'][-1]['content']
    assert '追加乙' in message and '用户甲' not in message and result['reply'] not in message
    source['expected_revision'] += 1
    assert http.post('/api/ai/local', json=body(source, '为什么？')).json()['status'] == 'applied'
    source['expected_revision'] += 1
    assert http.post('/api/ai/local', json=body(source, '还有呢？')).json()['status'] == 'applied'
    messages = transport.calls[-1]['messages']
    assert any(m['content'] == '为什么？' for m in messages)
    assert '用户甲' not in str(messages)
    with Session(engine) as db:
        assert len(db.scalars(select(AIUsage)).all()) == 4


def test_revision_summary_author_boundary_and_delete_reply(local_env):
    http, transport, create = local_env
    def block(kind, value):
        result = {'id': str(uuid4()), 'kind': kind, 'text': value}
        if kind != 'user':
            result['request_id'] = str(uuid4())
        return result
    blocks = [block('user', '旧甲😀'), block('ai_summary', '绝不发送的总结'),
              block('user', '新乙'), block('user', '')]
    source = create(blocks=blocks)
    with Session(engine) as db:
        db.add(AICheckpoint(file_type='journal', file_id=source['id'], consumed_user_text='旧甲😀'))
        db.commit()
    response = http.post('/api/ai/local', json=body(source)).json()
    assert response['status'] == 'applied'
    messages = str(transport.calls[-1]['messages'])
    assert '新乙' in messages and '旧甲' not in messages and '绝不发送的总结' not in messages
    output = response['file']['content_blocks']
    assert output[:3] == blocks[:3] and output[-1] == blocks[-1]
    reply = output[-2]
    assert http.delete(f"/api/files/journal/{source['id']}/ai-blocks/{reply['id']}",
                       headers={'If-Match': '"2"'}).status_code == 204
    assert checkpoint(source) == '旧甲😀新乙'
    source['expected_revision'] = 3
    assert http.post('/api/ai/local', json=body(source)).json()['status'] == 'noop'
    output = http.get(f"/api/journals/{source['id']}").json()['content_blocks']
    output[0]['text'] = '旧甲🌻'
    changed = http.patch(f"/api/journals/{source['id']}", json={
        'expected_revision': 3, 'content_blocks': output}).json()
    source['expected_revision'] = changed['revision']
    assert http.post('/api/ai/local', json=body(source)).json()['status'] == 'applied'
    message = transport.calls[-1]['messages'][-1]['content']
    assert '之前的文字有改动' in message and '🌻新乙' in message
    assert '旧甲' not in message and '第2个Unicode码点' in message


@pytest.mark.parametrize('mode', ['soft', 'hard'])
def test_delete_during_model_does_not_resurrect_and_preserves_usage(local_env, mode):
    http, transport, create = local_env
    source = create(kind='journal' if mode == 'soft' else 'inbox')
    payload = body(source)
    transport.block = True
    with ThreadPoolExecutor(2) as pool:
        future = pool.submit(http.post, '/api/ai/local', json=payload)
        assert transport.entered.wait(5)
        endpoint = 'journals' if mode == 'soft' else 'inboxes'
        assert http.delete(f"/api/{endpoint}/{source['id']}", headers={'If-Match': '"1"'}).status_code == 204
        transport.release.set()
        response = future.result(5)
    assert checkpoint(source) is None
    assert http.get(f"/api/{endpoint}/{source['id']}").status_code == 404
    with Session(engine) as db:
        ledger = db.scalar(select(AIUsage))
        assert ledger.total_tokens == 12
        if mode == 'soft':
            assert response.json()['status'] == 'conflict'
            assert db.get(Journal, source['id']).content_blocks is None
        else:
            assert response.status_code == 404
            assert ledger.request_id is None
            assert db.get(Inbox, source['id']) is None
            assert db.get(AIRequest, UUID(payload['request_id'])) is None


def test_oversized_question_revision_and_forbidden_inputs_no_call(local_env):
    http, transport, create = local_env
    source = create()
    assert http.post('/api/ai/local', json=body(dict(source, expected_revision=2))).status_code == 409
    assert http.post('/api/ai/local', json=body(source, '😀' * 2001)).status_code == 422
    assert http.post('/api/ai/local', json=dict(body(source), model='other')).status_code == 422
    assert http.post('/api/ai/local', json=body(dict(source, type='insight'))).status_code == 422
    assert not transport.calls


def test_malformed_completion_keeps_known_usage(local_env):
    http, transport, create = local_env
    source = create()
    payload = body(source)
    transport.malformed = True
    assert http.post('/api/ai/local', json=payload).status_code == 502
    response = http.get('/api/ai/requests/' + payload['request_id']).json()
    assert response['status'] == 'failed' and checkpoint(source) is None
    assert response['usage']['total_tokens'] == 12
    assert response['usage']['unknown_subcalls'] == 0


@pytest.mark.parametrize('kind', ['journal', 'inbox'])
def test_concurrent_same_key_source_pending_and_unlocked_http(local_env, kind):
    http, transport, create = local_env
    source = create(kind=kind)
    payload = body(source)
    transport.block = True
    with ThreadPoolExecutor(2) as pool:
        future = pool.submit(http.post, '/api/ai/local', json=payload)
        assert transport.entered.wait(5)
        assert http.post('/api/ai/local', json=payload).status_code == 202
        assert http.post('/api/ai/local', json=body(source)).status_code == 409
        # Real independent session commits while model HTTP is waiting.
        with Session(engine) as db:
            db.execute(text("set local lock_timeout='1000ms'"))
            row = db.get(Journal if kind == 'journal' else Inbox, source['id'])
            row.content = '并发新文'
            row.revision += 1
            db.commit()
        transport.release.set()
        response = future.result(5)
    assert response.status_code == 200 and response.json()['status'] == 'conflict'
    assert checkpoint(source) is None and len(transport.calls) == 1
    with Session(engine) as db:
        row = db.get(Journal if kind == 'journal' else Inbox, source['id'])
        assert row.content == '并发新文' and row.content_blocks is None
        assert db.scalar(select(AIUsage.total_tokens)) == 12


@pytest.mark.parametrize('failure', ['timeout', 'truncated', 'missing_usage', 'storage', 'overflow'])
def test_failure_usage_and_no_half_write(local_env, monkeypatch, failure):
    from app.ai import local
    http, transport, create = local_env
    source = create('x' * 50000 if failure == 'overflow' else 'original')
    payload = body(source)
    if failure == 'timeout':
        transport.error = model_client.UpstreamTimeout('synthetic timeout')
    if failure == 'truncated':
        transport.finish = 'length'
    if failure == 'missing_usage':
        transport.usage = None
    if failure == 'storage':
        def fail(*args, **kwargs):
            raise RuntimeError('synthetic insert failure')
        monkeypatch.setattr(local, 'attach_reply', fail)
    response = http.post('/api/ai/local', json=payload)
    result = http.get('/api/ai/requests/' + payload['request_id']).json()
    if failure == 'missing_usage':
        assert result['status'] == 'applied' and result['usage']['unknown_subcalls'] == 1
    else:
        assert result['status'] == 'failed', response.text
        assert checkpoint(source) is None
        with Session(engine) as db:
            row = db.get(Journal, source['id'])
            assert row.revision == 1 and row.content_blocks is None
        assert result['usage']['unknown_subcalls'] == (1 if failure == 'timeout' else 0)
        assert result['usage']['total_tokens'] == (0 if failure == 'timeout' else 12)
    assert http.post('/api/ai/local', json=payload).status_code == 200
    assert len(transport.calls) == 1


def test_two_function_slots_and_same_key_registration_race(local_env):
    import time
    http, transport, create = local_env
    sources = [create(content=f'source {i}') for i in range(3)]
    payload = body(sources[0])
    transport.block = True
    with ThreadPoolExecutor(3) as pool:
        first = pool.submit(http.post, '/api/ai/local', json=payload)
        assert transport.entered.wait(5)
        duplicate = pool.submit(http.post, '/api/ai/local', json=payload)
        assert duplicate.result(5).status_code == 202
        second = pool.submit(http.post, '/api/ai/local', json=body(sources[1]))
        deadline = time.monotonic() + 5
        while len(transport.calls) < 2 and time.monotonic() < deadline:
            time.sleep(.01)
        assert len(transport.calls) == 2
        assert http.post('/api/ai/local', json=body(sources[2])).status_code == 429
        transport.release.set()
        assert first.result(5).json()['status'] == 'applied'
        assert second.result(5).json()['status'] == 'applied'
    with Session(engine) as db:
        assert db.scalar(select(AIRequest).where(AIRequest.id == UUID(payload['request_id']))).status == 'applied'
        assert len(db.scalars(select(AIUsage)).all()) == 2
    assert checkpoint(sources[2]) is None


def test_sql_flushed_then_failure_rolls_back_body_and_checkpoint(local_env):
    from sqlalchemy import event
    http, transport, create = local_env
    source = create()
    payload = body(source)
    flushed = []
    def reject_after_flush(session, context):
        if any(isinstance(row, Journal) and row.content_blocks is not None for row in session.dirty):
            flushed.append(True)
            raise RuntimeError('synthetic failure after SQL body/checkpoint flush')
    event.listen(Session, 'after_flush', reject_after_flush)
    try:
        assert http.post('/api/ai/local', json=payload).json()['status'] == 'failed'
    finally:
        event.remove(Session, 'after_flush', reject_after_flush)
    assert flushed == [True]
    with Session(engine) as db:
        row = db.get(Journal, source['id'])
        assert row.revision == 1 and row.content_blocks is None and row.content == '用户甲😀'
        assert db.get(AICheckpoint, ('journal', row.id)) is None
        assert db.scalar(select(AIUsage.total_tokens)) == 12
        assert db.get(AIRequest, UUID(payload['request_id'])).result['reply']


@pytest.mark.parametrize('current', ['', '甲', '\ufeff\u3000'])
def test_deletion_or_whitespace_noop_does_not_advance_c(local_env, current):
    http, transport, create = local_env
    source = create(current)
    with Session(engine) as db:
        db.add(AICheckpoint(file_type='journal', file_id=source['id'], consumed_user_text='甲乙'))
        db.commit()
    assert http.post('/api/ai/local', json=body(source)).json()['status'] == 'noop'
    assert not transport.calls and checkpoint(source) == '甲乙'
    with Session(engine) as db:
        assert db.get(Journal, source['id']).content_blocks is None
        assert not db.scalars(select(AIRequest)).all()
    response = http.post('/api/ai/local', json=body(source, '删了旧文，聊聊？')).json()
    assert response['status'] == 'applied'
    assert '旧内容已修改或被删' in transport.calls[-1]['messages'][-1]['content']
    assert checkpoint(source) == current


def test_simultaneous_first_registration_same_id(local_env):
    from threading import Barrier
    http, transport, create = local_env
    source = create()
    payload = body(source)
    barrier = Barrier(2)
    transport.block = True
    def send():
        barrier.wait(5)
        return http.post('/api/ai/local', json=payload)
    with ThreadPoolExecutor(2) as pool:
        futures = [pool.submit(send) for _ in range(2)]
        assert transport.entered.wait(5)
        # One first POST owns the UUID; another first POST observes pending.
        from concurrent.futures import wait, FIRST_COMPLETED
        done, pending = wait(futures, timeout=5, return_when=FIRST_COMPLETED)
        assert len(done) == 1 and next(iter(done)).result().status_code == 202
        transport.release.set()
        assert next(iter(pending)).result(5).json()['status'] == 'applied'
    assert len(transport.calls) == 1
