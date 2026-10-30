"""S04-T01 synthetic PostgreSQL integration tests; shared fixtures enforce target guard."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import pytest
from sqlalchemy import event, select, text
from sqlalchemy.orm import Session

from app.journal.models import Journal
from app.insight.models import Insight
from app.writing.service import LegacyConversionRequired, insert_ai_reply
from app.ai.models import AICheckpoint, AIRequest


def document(value):
    return {'type': 'doc', 'content': [{'type': 'paragraph', 'content': [{'type': 'text', 'text': value}]}]}


@pytest.mark.parametrize('endpoint', ['journals', 'insights'])
def test_document_crud_legacy_client_protection_and_get_zero_write(api, endpoint):
    client, db = api
    payload = {'content_doc': document('合成😀'), 'document_schema_version': 1, 'client_create_id': str(uuid4())}
    if endpoint == 'journals': payload['journal_date'] = '2026-10-30'
    created = client.post('/api/' + endpoint, json=payload)
    assert created.status_code == 201, created.text
    body = created.json()
    path = f"/api/{endpoint}/{body['id']}"
    assert body['document_format'] == 'tiptap' and body['content'] == '合成😀'
    model = Journal if endpoint == 'journals' else Insight
    before = db.execute(select(model.revision, model.updated_at, model.content, model.content_doc).where(model.id == body['id'])).one()
    writes = []
    def capture(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith(('UPDATE', 'INSERT', 'DELETE')): writes.append(statement.split()[0])
    connection = db.connection()
    event.listen(connection, 'before_cursor_execute', capture)
    try:
        read = client.get(path)
    finally:
        event.remove(connection, 'before_cursor_execute', capture)
    assert read.status_code == 200 and read.json()['content_doc'] == payload['content_doc']
    assert writes == []
    assert db.execute(select(model.revision, model.updated_at, model.content, model.content_doc).where(model.id == body['id'])).one() == before
    assert client.post('/api/' + endpoint, json=payload).status_code == 200
    conflict = client.patch(path, json={'expected_revision': 1, 'content': '旧客户端'})
    assert conflict.status_code == 409 and conflict.json()['code'] == 'legacy_conversion_required'
    updated = client.patch(path, json={'expected_revision': 1, 'content_doc': document('更新')})
    assert updated.status_code == 200 and updated.json()['content'] == '更新' and updated.json()['revision'] == 2
    assert client.patch(path, json={'expected_revision': 1, 'content_doc': document('冲突')}).status_code == 409


def test_legacy_conversion_and_blocks_never_lose_source(api):
    client, db = api
    raw = '旧文😀\n\n[[引用]]\n'
    created = client.post('/api/journals', json={'journal_date':'2026-10-30', 'content':raw}).json()
    row = db.get(Journal, created['id'])
    before_time = row.updated_at
    request_id = uuid4()
    checkpoint = AICheckpoint(file_type='journal', file_id=created['id'], consumed_user_text='旧文😀', last_request_id=request_id)
    request = AIRequest(id=request_id, kind='local', payload_hash='synthetic', status='applied',
                        sources=[{'type':'journal', 'id':created['id'], 'quote':'[[引用]]'}], settings={})
    db.add_all([checkpoint, request]); db.commit()
    legacy = {'type':'doc', 'content':[{'type':'legacyText', 'attrs':{'id':str(uuid4()), 'author':'user', 'raw_text':raw}}]}
    path = f"/api/journals/{created['id']}"
    converted = client.patch(path, json={'expected_revision':1, 'content_doc':legacy})
    assert converted.status_code == 200, converted.text
    assert converted.json()['content'] == raw and converted.json()['revision'] == 2
    db.expire_all()
    assert db.get(Journal, created['id']).updated_at == before_time
    assert db.get(AICheckpoint, ('journal', created['id'])).consumed_user_text == '旧文😀'
    assert db.get(AIRequest, request_id).sources[0]['quote'] == '[[引用]]'
    with pytest.raises(LegacyConversionRequired):
        insert_ai_reply(db.get(Journal, created['id']), 'not called', uuid4(), None)
    blocks = [{'id':str(uuid4()), 'kind':'user', 'text':'用户'}, {'id':str(uuid4()), 'kind':'ai_reply', 'text':'回复', 'request_id':str(uuid4())}]
    other = client.post('/api/journals', json={'journal_date':'2026-10-30', 'content':'user'}).json()
    old = db.get(Journal, other['id'])
    old.content_blocks = blocks
    old.content = 'synthetic legacy projection'
    db.flush()
    db.commit()  # Release the fixture savepoint before exercising rollback.
    snapshot = (old.content, old.content_blocks, old.revision, old.updated_at)
    refused = client.patch(f"/api/journals/{other['id']}", json={'expected_revision':1, 'content_doc':document('user')})
    assert refused.status_code == 409 and refused.json()['code'] == 'legacy_conversion_required'
    db.expire_all()
    preserved = db.get(Journal, other['id'])
    assert (preserved.content, preserved.content_blocks, preserved.revision, preserved.updated_at) == snapshot


def test_ritual_unique_date_kind_and_writing_numbering(api):
    client, _ = api
    first = client.post('/api/journals', json={'journal_date':'2026-10-30', 'content':'one'}).json()
    key = str(uuid4())
    body = {'journal_date':'2026-10-30', 'journal_kind':'set', 'draft_started_at':'2026-10-29T20:01:00Z', 'content':'set', 'client_create_id':key}
    ritual = client.post('/api/journals', json=body)
    assert ritual.status_code == 201, ritual.text
    replay = client.post('/api/journals', json=body)
    assert replay.status_code == 200 and replay.json()['id'] == ritual.json()['id']
    duplicate = client.post('/api/journals', json={**body, 'client_create_id':str(uuid4())})
    assert duplicate.status_code == 409 and duplicate.json()['code'] == 'ritual_slot_conflict'
    assert duplicate.json()['conflict']['current_id'] == ritual.json()['id']
    second = client.post('/api/journals', json={'journal_date':'2026-10-30', 'content':'two'}).json()
    assert first['display_title'] == '2026-10-30'
    assert second['display_title'] == '2026-10-30 (2)'
    assert ritual.json()['display_title'] == '开始今天 2026-10-30'
    items = client.get('/api/journals', params={'journal_date':'2026-10-30', 'journal_kind':'writing'}).json()['items']
    assert len(items) == 2 and all(item['journal_kind'] == 'writing' for item in items)
    result = client.get('/api/rituals', params={'journal_date':'2026-10-30'}).json()
    assert result['set']['id'] == ritual.json()['id'] and result['end'] is None
    assert client.patch(f"/api/journals/{ritual.json()['id']}", json={'expected_revision':1, 'journal_date':'2026-10-29'}).status_code == 422


def test_ritual_identity_consistent_in_folder_and_search(api):
    client, _ = api
    folder = client.post('/api/folders', json={'name':'synthetic'}).json()
    body = {'journal_date':'2026-10-30', 'journal_kind':'set', 'draft_started_at':'2026-10-29T20:01:00Z', 'content':'synthetic marker', 'folder_id':folder['id']}
    created = client.post('/api/journals', json=body).json()
    folder_item = client.get(f"/api/folders/{folder['id']}/files").json()['items'][0]
    search_item = client.get('/api/search', params={'q':'synthetic marker'}).json()['items'][0]
    for item in (folder_item, search_item):
        assert item['id'] == created['id']
        assert item['journal_kind'] == 'set'
        assert item['display_title'] == '开始今天 2026-10-30'
    resolved = client.get('/api/links/resolve', params={'title':'开始今天 2026-10-30'}).json()
    assert resolved['total'] == 1 and resolved['items'][0]['id'] == created['id']
    assert client.get('/api/links/resolve', params={'title':'2026-10-30'}).json()['total'] == 0


def test_legacy_ai_path_rejects_new_document_before_any_model_call(api, monkeypatch):
    from app.ai import local
    client, db = api
    record = client.post('/api/journals', json={'journal_date':'2026-10-30', 'content_doc':document('测试')}).json()
    def no_model(*args, **kwargs):
        pytest.fail('model invocation must not occur')
    monkeypatch.setattr(local, 'model_invoke', no_model)
    response = client.post('/api/ai/local', json={'request_id':str(uuid4()), 'source':{'type':'journal','id':record['id'],'expected_revision':1}})
    assert response.status_code == 409 and response.json()['code'] == 'legacy_conversion_required'
    after = client.get(f"/api/journals/{record['id']}").json()
    assert after['revision'] == 1 and after['content_doc'] == document('测试')


def test_empty_ritual_reads_do_not_write_real_database(api):
    client, db = api
    connection = db.connection()
    writes = []
    def capture(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith(('UPDATE', 'INSERT', 'DELETE')): writes.append(statement.split()[0])
    before = db.execute(text('select (select count(*) from journals), (select count(*) from ritual_templates)')).one()
    event.listen(connection, 'before_cursor_execute', capture)
    try:
        assert client.get('/api/rituals', params={'journal_date':'2026-10-30'}).json() == {'journal_date':'2026-10-30', 'set':None, 'end':None}
        templates = client.get('/api/ritual-templates').json()
        assert templates['set'] == {'questions': [], 'revision': 0}
    finally:
        event.remove(connection, 'before_cursor_execute', capture)
    assert writes == []
    assert db.execute(text('select (select count(*) from journals), (select count(*) from ritual_templates)')).one() == before


def test_document_cas_with_two_real_sessions(stage3_engine, monkeypatch):
    from app.journal import service
    from app.journal.schemas import JournalCreate, JournalUpdate
    from app.writing.service import WriteConflict
    with Session(stage3_engine) as db:
        initial = service.create_journal(db, JournalCreate(journal_date='2026-10-30', content_doc=document('start')))
    original = service._get_active_journal
    barrier = Barrier(2)
    seen = set()
    def get(db, ident):
        row = original(db, ident)
        if id(db) not in seen:
            seen.add(id(db)); barrier.wait(timeout=10)
        return row
    monkeypatch.setattr(service, '_get_active_journal', get)
    def change(value):
        with Session(stage3_engine) as db:
            try:
                return service.update_journal(db, initial.id, JournalUpdate(expected_revision=1, content_doc=document(value))).revision
            except WriteConflict:
                return 'conflict'
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(change, ['first', 'second']))
    assert sorted(map(str, results)) == ['2', 'conflict']
    with Session(stage3_engine) as db:
        row = db.get(Journal, initial.id)
        assert row.revision == 2 and row.content in ('first', 'second')


def test_migration_preserves_old_data_and_refuses_lossy_downgrade(stage3_schema):
    import json
    from test_stage2_migrations import _run_alembic
    schema, engine = stage3_schema
    _run_alembic(schema, 'upgrade', '3aa16300a58a')
    blocks = [{'id':str(uuid4()), 'kind':'user', 'text':'原文😀 [[引用]]'},
              {'id':str(uuid4()), 'kind':'ai_reply', 'text':'AI', 'request_id':str(uuid4())}]
    with engine.begin() as c:
        ident = c.execute(text("insert into journals(content, journal_date, created_at, updated_at, content_blocks) values (:content, '2026-10-30', '2020-01-01Z', '2020-01-02Z', cast(:blocks as jsonb)) returning id"), {'content':'合成投影', 'blocks':json.dumps(blocks, ensure_ascii=False)}).scalar_one()
        c.execute(text("insert into ai_checkpoints(file_type,file_id,consumed_user_text,updated_at) values ('journal',:id,:value,'2020-01-01Z')"), {'id':ident, 'value':'原文😀 [[引用]]'})
    def old_snapshot():
        with engine.connect() as c:
            row = dict(c.execute(text('select * from journals where id=:id'), {'id':ident}).mappings().one())
            checkpoint = tuple(c.execute(text('select * from ai_checkpoints where file_id=:id'), {'id':ident}).one())
            seq = c.execute(text("select last_value from journals_id_seq")).scalar_one()
            return row, checkpoint, seq
    original, checkpoint, sequence = old_snapshot()
    _run_alembic(schema, 'upgrade', 'head')
    current, checkpoint_after, sequence_after = old_snapshot()
    assert {key: current[key] for key in original} == original
    assert current['content_doc'] is None and current['journal_kind'] == 'writing'
    assert checkpoint_after == checkpoint and sequence_after == sequence
    with engine.begin() as c:
        c.execute(text("update journals set content_doc=cast(:doc as jsonb) where id=:id"), {'doc':json.dumps(document('synthetic')), 'id':ident})
    with pytest.raises(AssertionError):
        _run_alembic(schema, 'downgrade', '3aa16300a58a')
    with engine.begin() as c:
        assert c.execute(text('select version_num from alembic_version')).scalar_one() == '4f8e1a3c9d02'
        assert c.execute(text('select content_doc is not null from journals where id=:id'), {'id':ident}).scalar_one()
        c.execute(text('update journals set content_doc=null where id=:id'), {'id':ident})
    _run_alembic(schema, 'downgrade', '3aa16300a58a')
    assert old_snapshot() == (original, checkpoint, sequence)


def test_copy_receipt_blocks_lossy_downgrade(stage3_engine):
    from test_stage2_migrations import _run_alembic
    engine = stage3_engine
    with engine.begin() as c:
        schema = c.execute(text('select current_schema()')).scalar_one()
        c.execute(text("insert into ritual_copies(id, source_id, target_id, payload_hash, copied_nodes) "
                       "values (:id, 1, 2, 'synthetic', '[]'::jsonb)"), {'id': uuid4()})
    with pytest.raises(AssertionError):
        _run_alembic(schema, 'downgrade', '9e7a6c42d011')
    with engine.connect() as c:
        assert c.execute(text('select version_num from alembic_version')).scalar_one() == '4f8e1a3c9d02'
        assert c.execute(text('select count(*) from ritual_copies')).scalar_one() == 1
