"""Recovery writes are explicit; request GET never performs recovery."""
from datetime import datetime, timedelta, timezone
from uuid import UUID
from concurrent.futures import ThreadPoolExecutor

from sqlalchemy import select, event
from sqlalchemy.orm import Session

from app.ai.models import AIRequest, AIUsage, AICheckpoint
from app.ai.requests import recover_pending
from app.database import engine
from test_ai_local_api import local_env, body, checkpoint


def test_expiry_get_pure_read_late_result_cannot_attach(local_env):
    http, transport, create = local_env
    source = create()
    payload = body(source)
    transport.block = True
    with ThreadPoolExecutor(2) as pool:
        future = pool.submit(http.post, '/api/ai/local', json=payload)
        assert transport.entered.wait(5)
        with Session(engine) as db:
            request = db.get(AIRequest, UUID(payload['request_id']))
            request.created_at = datetime.now(timezone.utc) - timedelta(seconds=121)
            db.commit()
        statements = []
        def capture(c, cursor, statement, parameters, context, many):
            statements.append(statement.lower().lstrip())
        event.listen(engine, 'before_cursor_execute', capture)
        try:
            assert http.get('/api/ai/requests/' + payload['request_id']).json()['status'] == 'pending'
        finally:
            event.remove(engine, 'before_cursor_execute', capture)
        assert not any(s.startswith(('insert', 'update', 'delete')) for s in statements)
        with Session(engine) as db:
            assert recover_pending(db) == 1
        assert http.get('/api/ai/requests/' + payload['request_id']).json()['status'] == 'unknown'
        transport.release.set()
        assert future.result(5).json()['status'] == 'unknown'
    recovered = http.get('/api/ai/requests/' + payload['request_id']).json()
    assert recovered['reply'] and recovered['usage']['total_tokens'] == 12
    assert checkpoint(source) is None


def test_restart_and_lost_http_response_query(local_env):
    http, transport, create = local_env
    source = create()
    payload = body(source)
    # The returned POST body is deliberately discarded.
    assert http.post('/api/ai/local', json=payload).status_code == 200
    assert http.get('/api/ai/requests/' + payload['request_id']).json()['status'] == 'applied'
    assert len(transport.calls) == 1

    with Session(engine) as db:
        request = db.get(AIRequest, UUID(payload['request_id']))
        request.status = 'pending'
        db.commit()
        assert recover_pending(db, restart=True) == 1
    assert http.get('/api/ai/requests/' + payload['request_id']).json()['status'] == 'unknown'
    assert http.post('/api/ai/local', json=payload).json()['status'] == 'unknown'
    assert len(transport.calls) == 1


def test_late_result_expiry_without_another_post(local_env):
    http, transport, create = local_env
    source = create()
    payload = body(source)
    transport.block = True
    with ThreadPoolExecutor(2) as pool:
        future = pool.submit(http.post, '/api/ai/local', json=payload)
        assert transport.entered.wait(5)
        with Session(engine) as db:
            row = db.get(AIRequest, UUID(payload['request_id']))
            row.created_at = datetime.now(timezone.utc) - timedelta(seconds=121)
            db.commit()
        transport.release.set()
        response = future.result(5).json()
    assert response['status'] == 'unknown' and response['reply']
    assert response['usage']['total_tokens'] == 12
    assert checkpoint(source) is None


def test_expired_old_call_cannot_overwrite_newer_checkpoint(local_env):
    http, transport, create = local_env
    source = create()
    old_payload = body(source)
    transport.block = True
    with ThreadPoolExecutor(2) as pool:
        old = pool.submit(http.post, '/api/ai/local', json=old_payload)
        assert transport.entered.wait(5)
        with Session(engine) as db:
            row = db.get(AIRequest, UUID(old_payload['request_id']))
            row.created_at = datetime.now(timezone.utc) - timedelta(seconds=121)
            db.commit()
        transport.block = False
        new_payload = body(source)
        assert http.post('/api/ai/local', json=new_payload).json()['status'] == 'applied'
        assert checkpoint(source) == '用户甲😀'
        transport.release.set()
        assert old.result(5).json()['status'] == 'unknown'
    with Session(engine) as db:
        row = db.get(AICheckpoint, ('journal', source['id']))
        assert str(row.last_request_id) == new_payload['request_id']
        assert len(db.scalars(select(AIUsage)).all()) == 2


def test_runtime_lifespan_recovery(local_env):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.ai.usage import call_payload_hash
    from uuid import uuid4
    http, transport, create = local_env
    source = create()
    request_id = uuid4()
    with Session(engine) as db:
        db.add(AIRequest(id=request_id, kind='local', payload_hash=call_payload_hash({}),
                         sources=[{'type': source['type'], 'id': source['id'], 'revision': 1}],
                         settings={}, status='pending'))
        db.commit()
    with TestClient(app) as restarted:
        response = restarted.get('/api/ai/requests/' + str(request_id)).json()
        assert response['status'] == 'unknown' and response['usage']['unknown_subcalls'] == 1
    assert not transport.calls and checkpoint(source) is None
