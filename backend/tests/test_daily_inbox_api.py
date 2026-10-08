"""Daily reads never create rows; uniqueness lives in PostgreSQL."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from threading import Barrier, Lock
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, select, text
from sqlalchemy.orm import Session

from app.database import engine, get_db
from app.inbox.models import Inbox
from app.main import app

DAY = '2034-02-02'


def daily(client, **changes):
    return client.post('/api/inboxes', json={'content': '# S2T04 Daily  \n', 'inbox_date': DAY, 'is_daily': True, **changes})


def test_daily_missing_read_is_zero_write_and_requires_date(api):
    client, session = api
    statements = []
    def capture(connection, cursor, statement, parameters, context, many):
        statements.append(statement.lstrip().split()[0].upper())
    event.listen(session.bind, 'before_cursor_execute', capture)
    try:
        before = session.scalar(text('SELECT count(*) FROM inboxes'))
        for _ in range(2):
            response = client.get('/api/inboxes/daily', params={'inbox_date': DAY})
            assert response.status_code == 200
            assert response.json() == {'state': 'missing', 'id': None, 'file': None}
        assert session.scalar(text('SELECT count(*) FROM inboxes')) == before
        assert not {'INSERT', 'UPDATE', 'DELETE'} & set(statements)
    finally:
        event.remove(session.bind, 'before_cursor_execute', capture)
    assert client.get('/api/inboxes/daily').status_code == 422
    assert client.get('/api/inboxes/daily', params={'inbox_date': 'bad'}).status_code == 422


def test_daily_identity_survives_rename_clear_and_ignored_identity_patch(api):
    client, session = api
    original = daily(client).json()
    for title in ['renamed', None, '', '   ']:
        response = client.patch(f"/api/inboxes/{original['id']}", json={'title': title, 'inbox_date': '2035-01-01', 'is_daily': False})
        assert response.status_code == 200
        updated = response.json()
        state = client.get('/api/inboxes/daily', params={'inbox_date': DAY}).json()
        assert state == {'state': 'active', 'id': original['id'], 'file': updated}
        assert updated['inbox_date'] == DAY and updated['is_daily'] is True
    assert client.get('/api/inboxes/daily', params={'inbox_date': '2035-01-01'}).json()['state'] == 'missing'


def test_daily_duplicate_returns_409_without_overwriting_and_session_recovers(api):
    client, session = api
    original = daily(client).json()
    assert daily(client, content='must not overwrite').status_code == 409
    assert session.scalar(text('SELECT 1')) == 1
    assert client.get(f"/api/inboxes/{original['id']}").json() == original
    assert daily(client, is_daily=False).status_code == 201
    assert daily(client, is_daily=False).status_code == 201
    assert client.get('/api/inboxes', params={'inbox_date': DAY}).json()['total'] == 3


def test_daily_conflict_checks_unused_deleted_column_too(api):
    client, session = api
    from datetime import datetime, timezone
    row = Inbox(content='synthetic unused deleted flag', inbox_date=date.fromisoformat(DAY), is_daily=True, deleted_at=datetime(2020, 1, 1, tzinfo=timezone.utc))
    session.add(row)
    session.flush()
    assert daily(client).status_code == 409
    assert session.scalar(text('SELECT 1')) == 1


def test_two_independent_sessions_concurrently_create_daily_with_one_api_409():
    """True commits use a fresh date/marker and clean only the generated typed IDs."""
    assert engine.url.database == 'seekjournal_test'
    business_date = date(2200, 1, 1) + timedelta(days=uuid4().int % 25000)
    marker = f'S2T04 concurrent {uuid4()}'
    with engine.connect() as connection:
        assert connection.scalar(select(Inbox.id).where(Inbox.inbox_date == business_date, Inbox.is_daily.is_(True))) is None
    barrier = Barrier(2)
    lock = Lock()
    session_ids = []
    reusable = []
    created_ids = []
    class RacingSession(Session):
        def commit(self):
            # Both independent transactions reach commit before either flushes.
            barrier.wait(timeout=10)
            return super().commit()
    def override():
        with RacingSession(bind=engine) as session:
            with lock:
                session_ids.append(id(session))
            try:
                yield session
            finally:
                with lock:
                    reusable.append(session.scalar(text('SELECT 1')))
    def submit():
        with TestClient(app, raise_server_exceptions=False) as client:
            response = client.post('/api/inboxes', json={'content': marker, 'inbox_date': business_date.isoformat(), 'is_daily': True})
        if response.status_code == 201:
            with lock:
                created_ids.append(response.json()['id'])
        return response
    app.dependency_overrides[get_db] = override
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(submit) for _ in range(2)]
            responses = [future.result(timeout=20) for future in futures]
        assert sorted(response.status_code for response in responses) == [201, 409]
        assert len(set(session_ids)) == 2
        assert reusable == [1, 1]
        with engine.connect() as connection:
            rows = connection.execute(select(Inbox.id, Inbox.content).where(Inbox.inbox_date == business_date, Inbox.is_daily.is_(True))).all()
        assert rows == [(created_ids[0], marker)]
    finally:
        app.dependency_overrides.clear()
        # Recover own successful write even if a response assertion failed.
        with engine.begin() as connection:
            own_ids = connection.execute(select(Inbox.id).where(Inbox.inbox_date == business_date, Inbox.content == marker)).scalars().all()
            if own_ids:
                connection.execute(delete(Inbox).where(Inbox.id.in_(own_ids)))
        with engine.connect() as connection:
            assert connection.scalar(select(Inbox.id).where(Inbox.inbox_date == business_date, Inbox.content == marker)) is None
