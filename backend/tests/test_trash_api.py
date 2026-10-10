"""Trash contract tests against PostgreSQL; fixture rolls back all test rows."""
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import event, text

from app.folder.models import Folder
from app.inbox.models import Inbox
from app.insight.models import Insight
from app.journal.models import Journal

STAMP = datetime(2020, 1, 1, tzinfo=timezone.utc)
MODELS = {'journal': Journal, 'insight': Insight}
TABLES = {'journal': 'journals', 'insight': 'insights'}
ROUTES = {'journal': 'journals', 'insight': 'insights'}


def snapshot(db, kind, id):
    return db.execute(text(f'SELECT * FROM {TABLES[kind]} WHERE id=:id'), {'id': id}).mappings().one_or_none()


def seed(db, kind, **values):
    values = {'title': None, 'content': '  # 原文\n\n- [ ] 内容  ', 'created_at': STAMP,
              'updated_at': STAMP + timedelta(days=1), **values}
    if kind == 'journal':
        values.setdefault('journal_date', date(2020, 1, 1))
    if values.get('deleted_at') is not None:
        values.setdefault('revision', 2)
    row = MODELS[kind](**values)
    db.add(row)
    db.flush()
    return row.id


@pytest.mark.parametrize('kind', MODELS)
@pytest.mark.parametrize('title', [None, '', '  ', '标题', '旧' * 81])
def test_lifecycle_preserves_every_column_and_folder(api, kind, title):
    client, db = api
    folder = Folder(name='T09 lifecycle')
    db.add(folder)
    db.flush()
    id = seed(db, kind, title=title, folder_id=folder.id)
    db.commit()
    before = dict(snapshot(db, kind, id))
    base = f'/api/{ROUTES[kind]}/{id}'
    trash = f'/api/trash/{kind}/{id}'
    assert client.get(trash).status_code == 404
    assert client.post(trash + '/restore', headers={"If-Match": '"2"'}).status_code == 404
    assert client.delete(trash, headers={"If-Match": '"2"'}).status_code == 404
    assert dict(snapshot(db, kind, id)) == before
    normal = client.get(base).json()
    deleted = client.delete(base, headers={"If-Match": '"1"'})
    assert deleted.status_code == 204 and deleted.content == b''
    after = dict(snapshot(db, kind, id))
    assert after['deleted_at'] is not None
    assert {k: v for k, v in after.items() if k not in {'deleted_at', 'revision'}} == {k: v for k, v in before.items() if k not in {'deleted_at', 'revision'}}
    detail = client.get(trash)
    assert detail.status_code == 200
    assert detail.json() == {**normal, 'revision': 2, 'deleted_at': detail.json()['deleted_at']}
    assert client.get('/api/trash').json()['items'] == [{k: v for k, v in detail.json().items() if k != 'content_blocks'}]
    assert dict(snapshot(db, kind, id)) == after
    assert client.get(base).status_code == 404
    assert client.patch(base, json={"expected_revision": 1, **{}}).status_code == 404
    assert client.delete(base, headers={"If-Match": '"1"'}).status_code == 404
    assert client.get(f'/api/{ROUTES[kind]}').json()['total'] == 0
    assert client.get(f'/api/folders/{folder.id}/files').json()['total'] == 0
    assert client.delete(f'/api/folders/{folder.id}').status_code == 409
    assert client.patch(trash, json={"expected_revision": 1, **{'content': 'forbidden'}}).status_code == 405
    restored = client.post(trash + '/restore', json={'content': 'ignored', 'folder_id': None}, headers={"If-Match": '"2"'})
    assert restored.status_code == 200 and restored.json() == {**normal, 'revision': 3}
    assert dict(snapshot(db, kind, id)) == {**before, 'revision': 3}
    assert client.get(base).json() == {**normal, 'revision': 3}
    assert client.get(f'/api/folders/{folder.id}/files').json()['items'] == [{k: v for k, v in {**normal, 'revision': 3}.items() if k != 'content_blocks'}]
    assert client.post(trash + '/restore', headers={"If-Match": '"2"'}).status_code == 404
    assert client.delete(trash, headers={"If-Match": '"2"'}).status_code == 404
    assert client.get('/api/trash').json()['total'] == 0
    assert client.delete(base, headers={"If-Match": '"3"'}).status_code == 204
    purged = client.delete(trash, headers={"If-Match": '"4"'})
    assert purged.status_code == 204 and purged.content == b''
    assert snapshot(db, kind, id) is None
    for response in (client.get(base), client.get(trash), client.post(trash + '/restore', headers={"If-Match": '"2"'}), client.delete(trash, headers={"If-Match": '"2"'})):
        assert response.status_code == 404
    assert client.delete(f'/api/folders/{folder.id}').status_code == 204


@pytest.mark.parametrize('total', [0, 1, 21, 41, 45])
def test_global_mixed_pagination_type_and_stable_sort(api, total):
    client, db = api
    expected = []
    for i in range(total):
        kind = 'journal' if i % 2 == 0 else 'insight'
        deleted = STAMP + timedelta(days=i % 3)
        id = seed(db, kind, deleted_at=deleted)
        expected.append((deleted, 0 if kind == 'journal' else 1, id, kind))
    seed(db, 'journal')
    seed(db, 'insight')
    db.add(Inbox(content='excluded even with legacy deleted_at', inbox_date=date(2020, 1, 1), deleted_at=STAMP))
    db.commit()
    expected.sort(key=lambda row: (-row[0].timestamp(), row[1], -row[2]))
    for kind in ('all', 'journal', 'insight'):
        matches = [row for row in expected if kind == 'all' or row[3] == kind]
        for page in (1, 2, 3, 9):
            response = client.get('/api/trash', params={'type': kind, 'page': page, 'page_size': 1})
            assert response.status_code == 200
            body = response.json()
            assert (body['page'], body['page_size'], body['total'], body['has_next']) == (page, 20, len(matches), page * 20 < len(matches))
            assert [(item['type'], item['id']) for item in body['items']] == [(row[3], row[2]) for row in matches[(page-1)*20:page*20]]
            for item in body['items']:
                assert client.get(f"/api/trash/{item['type']}/{item['id']}").json() == ({**item, "content_blocks": None} if item["type"] == "journal" else item)


@pytest.mark.parametrize('kind', ['inbox', 'all', 'journals', 'other', 'JOURNAL'])
def test_invalid_path_type_is_422(api, kind):
    client, _ = api
    for response in (client.get(f'/api/trash/{kind}/1'), client.post(f'/api/trash/{kind}/1/restore', headers={"If-Match": '"2"'}), client.delete(f'/api/trash/{kind}/1', headers={"If-Match": '"2"'})):
        assert response.status_code == 422


@pytest.mark.parametrize('params', [{'type': 'inbox'}, {'type': 'bad'}, {'page': 0}, {'page': -1}, {'page': '1.2'}, {'page': 'bad'}])
def test_invalid_list_query_is_422(api, params):
    assert api[0].get('/api/trash', params=params).status_code == 422


@pytest.mark.parametrize('kind', MODELS)
@pytest.mark.parametrize('id,status', [('bad', 422), (1000000000, 404)])
def test_missing_and_invalid_id(api, kind, id, status):
    client, _ = api
    for response in (client.get(f'/api/trash/{kind}/{id}'), client.post(f'/api/trash/{kind}/{id}/restore', headers={"If-Match": '"2"'}), client.delete(f'/api/trash/{kind}/{id}', headers={"If-Match": '"2"'})):
        assert response.status_code == status


def test_numbering_uses_full_date_and_purge_can_renumber(api):
    client, db = api
    ids = [seed(db, 'journal', deleted_at=STAMP if i == 0 else None) for i in range(23)]
    db.commit()
    last = f'/api/journals/{ids[-1]}'
    assert client.get(last).json()['display_title'] == '2020-01-01 (23)'
    assert client.get(f'/api/trash/journal/{ids[0]}').json()['display_title'] == '2020-01-01'
    assert client.post(f'/api/trash/journal/{ids[0]}/restore', headers={"If-Match": '"2"'}).json()['display_title'] == '2020-01-01'
    assert client.get(last).json()['display_title'] == '2020-01-01 (23)'
    assert client.delete(f'/api/journals/{ids[0]}', headers={"If-Match": '"3"'}).status_code == 204
    assert client.delete(f'/api/trash/journal/{ids[0]}', headers={"If-Match": '"4"'}).status_code == 204
    assert client.get(last).json()['display_title'] == '2020-01-01 (22)'


def test_gets_execute_only_reads_no_flush_or_commit(api, monkeypatch):
    client, db = api
    id = seed(db, 'journal', deleted_at=STAMP)
    db.commit()
    before = dict(snapshot(db, 'journal', id))
    statements = []
    def capture(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement.strip().split()[0].upper())
    def forbidden(*args, **kwargs):
        raise AssertionError('GET attempted flush/commit')
    event.listen(db.bind, 'before_cursor_execute', capture)
    try:
        with monkeypatch.context() as patch:
            patch.setattr(db, 'flush', forbidden)
            patch.setattr(db, 'commit', forbidden)
            assert client.get('/api/trash').status_code == 200
            assert client.get(f'/api/trash/journal/{id}').status_code == 200
        assert statements and set(statements) == {'SELECT'}
        assert dict(snapshot(db, 'journal', id)) == before
    finally:
        event.remove(db.bind, 'before_cursor_execute', capture)


@pytest.mark.parametrize('kind', MODELS)
@pytest.mark.parametrize('action', ['restore', 'purge'])
@pytest.mark.parametrize('failure', ['execute', 'commit'])
def test_failure_rolls_back_real_changes_and_session_reusable(api, monkeypatch, kind, action, failure):
    client, db = api
    id = seed(db, kind, deleted_at=STAMP)
    sibling = seed(db, kind)
    db.commit()
    before = dict(snapshot(db, kind, id))
    sibling_before = dict(snapshot(db, kind, sibling))
    original = getattr(db, failure)
    def fail(*args, **kwargs):
        if failure == 'execute':
            original(*args, **kwargs)
        else:
            db.flush()
        raise RuntimeError('T09 injected write failure')
    with monkeypatch.context() as patch:
        patch.setattr(db, failure, fail)
        response = client.post(f'/api/trash/{kind}/{id}/restore', headers={"If-Match": '"2"'}) if action == 'restore' else client.delete(f'/api/trash/{kind}/{id}', headers={"If-Match": '"2"'})
        assert response.status_code == 500
    assert db.scalar(text('SELECT 1')) == 1
    assert dict(snapshot(db, kind, id)) == before
    assert dict(snapshot(db, kind, sibling)) == sibling_before
    response = client.post(f'/api/trash/{kind}/{id}/restore', headers={"If-Match": '"2"'}) if action == 'restore' else client.delete(f'/api/trash/{kind}/{id}', headers={"If-Match": '"2"'})
    assert response.status_code == (200 if action == 'restore' else 204)

@pytest.mark.parametrize('kind', MODELS)
@pytest.mark.parametrize('action', ['restore', 'purge'])
def test_database_error_rolls_back_and_clears_failed_transaction(api, monkeypatch, kind, action):
    client, db = api
    id = seed(db, kind, deleted_at=STAMP)
    db.commit()
    before = dict(snapshot(db, kind, id))
    execute = db.execute
    def fail_commit():
        # Actual PostgreSQL error leaves this Session transaction failed.
        execute(text('SELECT 1 / 0'))
    with monkeypatch.context() as patch:
        patch.setattr(db, 'commit', fail_commit)
        response = client.post(f'/api/trash/{kind}/{id}/restore', headers={"If-Match": '"2"'}) if action == 'restore' else client.delete(f'/api/trash/{kind}/{id}', headers={"If-Match": '"2"'})
        assert response.status_code == 500
    assert db.scalar(text('SELECT 1')) == 1
    assert dict(snapshot(db, kind, id)) == before
    response = client.post(f'/api/trash/{kind}/{id}/restore', headers={"If-Match": '"2"'}) if action == 'restore' else client.delete(f'/api/trash/{kind}/{id}', headers={"If-Match": '"2"'})
    assert response.status_code == (200 if action == 'restore' else 204)


def test_same_numeric_id_is_distinct_by_type(api):
    client, db = api
    j = seed(db, 'journal', id=100000000, deleted_at=STAMP, content='journal')
    i = seed(db, 'insight', id=j, deleted_at=STAMP, content='insight')
    db.commit()
    items = client.get('/api/trash').json()['items']
    assert [(item['type'], item['id']) for item in items] == [('journal', j), ('insight', i)]
    assert client.delete(f'/api/trash/journal/{j}', headers={"If-Match": '"2"'}).status_code == 204
    assert client.get(f'/api/trash/insight/{i}').json()['content'] == 'insight'
    assert client.post(f'/api/trash/insight/{i}/restore', headers={"If-Match": '"2"'}).status_code == 200


def test_reads_do_not_autoflush_pending_state(api):
    client, db = api
    id = seed(db, 'insight', deleted_at=STAMP)
    db.commit()
    pending = Insight(content='not flushed')
    db.add(pending)
    assert client.get('/api/trash').status_code == 200
    assert client.get(f'/api/trash/insight/{id}').status_code == 200
    assert pending.id is None and pending in db.new


@pytest.mark.parametrize('kind', MODELS)
def test_legacy_content_read_restore_not_revalidated(api, kind):
    client, db = api
    id = seed(db, kind, content=' \n\t', title='x' * 81, deleted_at=STAMP)
    db.commit()
    before = dict(snapshot(db, kind, id))
    detail = client.get(f'/api/trash/{kind}/{id}')
    assert detail.status_code == 200 and detail.json()['content'] == ' \n\t'
    restored = client.post(f'/api/trash/{kind}/{id}/restore', headers={"If-Match": '"2"'})
    assert restored.status_code == 200 and restored.json()['title'] == 'x' * 81
    assert dict(snapshot(db, kind, id)) == {**before, 'deleted_at': None, 'revision': before['revision'] + 1}
