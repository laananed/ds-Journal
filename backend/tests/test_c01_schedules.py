from uuid import uuid4
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from sqlalchemy import event, select, func
from sqlalchemy.orm import Session
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from app.database import get_db
from app.schedule.models import Schedule
from app.schedule.router import router
from app.writing.service import WritingError
from app.schedule.schemas import ScheduleCreate, ScheduleUpdate
from app.schedule import service


def test_schedule_http_and_persistence_in_private_schema(stage3_engine):
    app = FastAPI()
    app.include_router(router)
    @app.exception_handler(WritingError)
    async def errors(request, error):
        return JSONResponse(status_code=error.status_code, content={'detail': str(error)})
    def session():
        with Session(stage3_engine) as db:
            yield db
    app.dependency_overrides[get_db] = session
    client = TestClient(app)
    payload = {'title': 'Synthetic', 'starts_at': '2026-10-30T09:00:00+08:00',
               'ends_at': '2026-10-30T10:00:00+08:00', 'completed': False,
               'client_create_id': str(uuid4())}
    created = client.post('/api/schedules', json=payload)
    assert created.status_code == 201, created.text
    first = created.json()
    path = '/api/schedules/' + str(first['id'])
    assert first['revision'] == 1
    with Session(stage3_engine) as db:
        row = db.get(Schedule, first['id'])
        assert row.starts_at.utcoffset().total_seconds() == 0
        assert row.starts_at.hour == 1
    assert client.post('/api/schedules', json=payload).json()['id'] == first['id']
    assert client.post('/api/schedules', json={**payload, 'title': 'other'}).status_code == 409
    assert client.patch(path, json={'completed': True}).status_code == 428
    same = client.patch(path, json={'expected_revision': 1, 'completed': False})
    assert same.status_code == 200 and same.json()['updated_at'] == first['updated_at']
    assert same.json()['revision'] == 1
    changed = client.patch(path, json={'expected_revision': 1, 'completed': True})
    assert changed.status_code == 200 and changed.json()['revision'] == 2
    assert client.patch(path, json={'expected_revision': 1, 'completed': False}).status_code == 409
    assert client.patch(path, json={'expected_revision': 2, 'ends_at': '2026-10-30T00:00:00Z'}).status_code == 422
    assert client.patch(path, json={'expected_revision': 2, 'extra': 1}).status_code == 422
    writes = []
    def capture(conn, cursor, statement, params, context, many):
        if statement.lstrip().upper().startswith(('INSERT', 'UPDATE', 'DELETE')):
            writes.append(statement)
    event.listen(stage3_engine, 'before_cursor_execute', capture)
    try:
        assert client.get(path).json()['completed'] is True
        assert client.get('/api/schedules').json()['items'][0]['id'] == first['id']
    finally:
        event.remove(stage3_engine, 'before_cursor_execute', capture)
    assert not writes
    assert client.delete(path).status_code == 428
    assert client.delete(path, headers={'If-Match': '"1"'}).status_code == 409
    assert client.delete(path, headers={'If-Match': '"2"'}).status_code == 204
    assert client.get(path).status_code == 404
    with Session(stage3_engine) as db:
        assert db.scalar(select(func.count()).select_from(Schedule)) == 0


def test_concurrent_creation_cas_and_paging(stage3_engine):
    key = uuid4()
    data = ScheduleCreate(title='same', starts_at='2026-10-30T01:00:00Z', ends_at=None,
                          completed=False, client_create_id=key)
    barrier = Barrier(2)
    def create_one(_):
        with Session(stage3_engine) as db:
            barrier.wait(timeout=10)
            row, replay = service.create(db, data)
            return row.id, replay
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(create_one, range(2)))
    assert results[0][0] == results[1][0]
    assert sorted(item[1] for item in results) == [False, True]
    schedule_id = results[0][0]
    barrier = Barrier(2)
    def change_one(index):
        with Session(stage3_engine) as db:
            barrier.wait(timeout=10)
            row = service.locked(db, schedule_id)
            try:
                service.update(db, row, ScheduleUpdate(expected_revision=1, title=f'change {index}'))
                return 'success'
            except WritingError as error:
                return error.status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(change_one, range(2)), key=str) == [409, 'success']
    with Session(stage3_engine) as db:
        for index in range(20):
            service.create(db, ScheduleCreate(title=f'page {index}', starts_at='2026-10-30T01:00:00Z',
                           ends_at=None, completed=False, client_create_id=uuid4()))
    app = FastAPI()
    app.include_router(router)
    def session():
        with Session(stage3_engine) as db:
            yield db
    app.dependency_overrides[get_db] = session
    client = TestClient(app)
    first, second = client.get('/api/schedules?page=1').json(), client.get('/api/schedules?page=2').json()
    ids = [item['id'] for item in first['items'] + second['items']]
    assert len(first['items']) == 20 and first['has_next'] is True
    assert len(second['items']) == 1 and second['has_next'] is False
    assert ids == sorted(ids) and len(set(ids)) == 21
