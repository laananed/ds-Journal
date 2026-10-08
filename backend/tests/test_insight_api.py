"""Insight HTTP contract tests; all data stays inside the shared savepoint fixture.

Covers the S2-T06 manual Insight CRUD loop end-to-end through the Router:
create / list (pagination + folder filter) / detail / partial update / soft delete.
"""
from datetime import datetime, timezone

import pytest
from sqlalchemy import event, text

from app.folder.models import Folder
from app.insight.models import Insight
from app.journal.schemas import _WHITESPACE_CODE_POINTS

MARKDOWN = '  # Heading\n\n- [ ] task  \n1. item\n    code  \n'
FIELDS = {'type', 'id', 'title', 'display_title', 'content', 'folder_id', 'created_at', 'updated_at', 'deleted_at'}


def create(client, **values):
    return client.post('/api/insights', json={'content': MARKDOWN, **values})


def snapshot(session, identity):
    return tuple(session.execute(text('SELECT title, content, folder_id, created_at, updated_at, deleted_at FROM insights WHERE id=:id'), {'id': identity}).one())


def test_create_insight_returns_full_record_without_date_fields(api):
    client, session = api
    response = create(client)
    assert response.status_code == 201
    body = response.json()
    assert set(body) == FIELDS
    assert body['type'] == 'insight'
    assert body['title'] is None
    assert body['display_title'] == '未命名 Insight'
    assert body['content'] == MARKDOWN
    assert body['folder_id'] is None
    assert body['deleted_at'] is None
    assert not {'journal_date', 'inbox_date', 'is_daily'} & set(body)
    row = snapshot(session, body['id'])
    assert row[0] is None and row[1] == MARKDOWN and row[2] is None and row[5] is None
    assert row[3] is not None and row[4] is not None


@pytest.mark.parametrize('title', [None, '', ' \t ', '中' * 80, '🐟' * 80], ids=['null', 'empty', 'whitespace', 'cjk80', 'emoji80'])
def test_explicit_title_preserved_and_display_fallback(api, title):
    client, session = api
    body = create(client, title=title).json()
    assert body['title'] == title
    assert body['display_title'] == (title if title not in (None, '') else '未命名 Insight')
    assert snapshot(session, body['id'])[0] == title
    assert client.get(f"/api/insights/{body['id']}").json() == body


@pytest.mark.parametrize('field,value', [('title', '中' * 81), ('title', '🐟' * 81), ('content', ''), ('content', None), ('content', 'x' * 50001), ('content', '🐟' * 50001), ('title', 4), ('folder_id', 'bad')], ids=['cjk81', 'emoji81', 'content-empty', 'content-null', 'content-50001', 'content-emoji50001', 'title-int', 'folder-bad'])
def test_invalid_create_is_422_without_insertion(api, field, value):
    client, session = api
    before = session.execute(text('SELECT count(*) FROM insights')).scalar_one()
    assert create(client, **{field: value}).status_code == 422
    assert session.execute(text('SELECT count(*) FROM insights')).scalar_one() == before


@pytest.mark.parametrize('character', [chr(code) for code in sorted(_WHITESPACE_CODE_POINTS)], ids=lambda value: str(value) if isinstance(value, (bool, int)) or value is None else f"{type(value).__name__}-{len(value)}")
def test_every_shared_whitespace_character_is_rejected(api, character):
    client, session = api
    assert create(client, content=character * 3).status_code == 422


@pytest.mark.parametrize('content', ['x' * 49999, '🐟' * 50000, ' ' * 49999 + 'x'], ids=['ascii-49999', 'emoji-50000', 'leading-space'])
def test_valid_original_content_boundary_roundtrips(api, content):
    client, session = api
    response = create(client, content=content)
    assert response.status_code == 201
    assert response.json()['content'] == content
    assert snapshot(session, response.json()['id'])[1] == content


def test_required_creation_fields(api):
    client, session = api
    for payload in [{}, {'title': 'x'}, {'folder_id': None}]:
        assert client.post('/api/insights', json=payload).status_code == 422


def test_create_system_and_date_fields_are_ignored(api):
    client, session = api
    body = create(client, id=10**9, type='journal', display_title='evil', deleted_at='2000-01-01', created_at='2000-01-01', updated_at='2000-01-01', journal_date='2030-01-01', inbox_date='2030-01-01', is_daily=True).json()
    assert body['id'] != 10**9
    assert body['type'] == 'insight'
    assert body['display_title'] == '未命名 Insight'
    assert body['deleted_at'] is None
    assert not body['created_at'].startswith('2000')
    assert 'journal_date' not in body


@pytest.mark.parametrize('changes', [{}, {'id': 999, 'display_title': 'override', 'created_at': '2000-01-01', 'updated_at': '2000-01-01', 'deleted_at': '2000-01-01', 'type': 'journal', 'unknown': 'x'}, {'title': None, 'content': MARKDOWN, 'folder_id': None}], ids=['empty', 'ignored', 'same'])
def test_empty_ignored_and_same_patch_do_not_write_or_change_time(api, changes):
    client, session = api
    original = create(client).json()
    statements = []

    def capture(connection, cursor, statement, parameters, context, many):
        statements.append(statement.lstrip().split()[0].upper())

    event.listen(session.bind, 'before_cursor_execute', capture)
    try:
        response = client.patch(f"/api/insights/{original['id']}", json=changes)
        assert response.status_code == 200
        assert response.json() == original
        assert not {'INSERT', 'UPDATE', 'DELETE'} & set(statements)
    finally:
        event.remove(session.bind, 'before_cursor_execute', capture)


def test_patch_title_clear_content_and_folder_move(api):
    client, session = api
    folder = Folder(name='S2T06 move')
    session.add(folder)
    session.flush()
    original = create(client).json()
    moved = client.patch(f"/api/insights/{original['id']}", json={'title': '原则', 'content': 'changed', 'folder_id': folder.id}).json()
    assert moved['title'] == '原则' and moved['display_title'] == '原则'
    assert moved['content'] == 'changed' and moved['folder_id'] == folder.id
    assert moved['created_at'] == original['created_at'] and moved['updated_at'] != original['updated_at']
    assert client.get('/api/insights', params={'folder_id': folder.id}).json()['total'] == 1
    cleared = client.patch(f"/api/insights/{original['id']}", json={'title': None, 'folder_id': None}).json()
    assert cleared['title'] is None and cleared['display_title'] == '未命名 Insight'
    assert cleared['folder_id'] is None
    assert client.get('/api/insights', params={'folder_id': folder.id}).json()['total'] == 0


@pytest.mark.parametrize('changes', [{'title': '🐟' * 81}, {'content': None}, {'content': ' \n\t\u3000\ufeff'}, {'content': 'x' * 50001}], ids=lambda value: str(value) if isinstance(value, (bool, int)) or value is None else f"{type(value).__name__}-{len(value)}")
def test_invalid_patch_leaves_every_field_unchanged(api, changes):
    client, session = api
    original = create(client).json()
    before = snapshot(session, original['id'])
    assert client.patch(f"/api/insights/{original['id']}", json=changes).status_code == 422
    assert snapshot(session, original['id']) == before


def test_missing_folder_patch_is_atomic_404(api):
    client, session = api
    original = create(client).json()
    before = snapshot(session, original['id'])
    response = client.patch(f"/api/insights/{original['id']}", json={'folder_id': 10**9, 'content': 'should roll back'})
    assert response.status_code == 404
    assert snapshot(session, original['id']) == before
    assert session.scalar(text('SELECT 1')) == 1
    assert create(client, folder_id=10**9).status_code == 404


@pytest.mark.parametrize('total', [0, 20, 21, 41], ids=['0', '20', '21', '41'])
def test_pagination_counts_sorting_and_fixed_page_size(api, total):
    client, session = api
    stamp = datetime(2020, 1, 1, tzinfo=timezone.utc)
    rows = [Insight(content=f'S2T06 page {i}', created_at=stamp, updated_at=stamp) for i in range(total)]
    session.add_all(rows)
    session.flush()
    expected = sorted([row.id for row in rows], reverse=True)
    for page in (1, 2, 3, 10):
        body = client.get('/api/insights', params={'page': page, 'page_size': 1}).json()
        assert body['page'] == page and body['page_size'] == 20
        assert body['total'] == total and body['has_next'] == (page * 20 < total)
        assert [row['id'] for row in body['items']] == expected[(page - 1) * 20:page * 20]


def test_real_edit_resorts_record_to_front(api):
    client, session = api
    stamp = datetime(2020, 1, 1, tzinfo=timezone.utc)
    first = Insight(content='S2T06 A', created_at=stamp, updated_at=stamp)
    second = Insight(content='S2T06 B', created_at=stamp, updated_at=stamp)
    session.add_all([first, second])
    session.flush()
    assert [item['id'] for item in client.get('/api/insights').json()['items']] == [second.id, first.id]
    assert client.patch(f'/api/insights/{first.id}', json={'content': 'S2T06 A edited'}).status_code == 200
    assert [item['id'] for item in client.get('/api/insights').json()['items']] == [first.id, second.id]


@pytest.mark.parametrize('params', [{'page': 0}, {'page': -1}, {'page': '1.2'}, {'page': 'bad'}, {'folder_id': 'bad'}], ids=lambda value: str(value) if isinstance(value, (bool, int)) or value is None else f"{type(value).__name__}-{len(value)}")
def test_invalid_query_is_422(api, params):
    client, session = api
    assert client.get('/api/insights', params=params).status_code == 422


def test_soft_delete_preserves_row_and_timestamps_then_404(api):
    client, session = api
    original = create(client).json()
    before = snapshot(session, original['id'])
    response = client.delete(f"/api/insights/{original['id']}")
    assert response.status_code == 204 and response.content == b''
    after = snapshot(session, original['id'])
    assert after[0] == before[0] and after[1] == before[1] and after[2] == before[2]
    assert after[3] == before[3] and after[4] == before[4]
    assert before[5] is None and after[5] is not None
    assert client.get(f"/api/insights/{original['id']}").status_code == 404
    assert client.patch(f"/api/insights/{original['id']}", json={}).status_code == 404
    assert client.delete(f"/api/insights/{original['id']}").status_code == 404
    assert client.get('/api/insights').json()['total'] == 0


def test_already_soft_deleted_rows_are_hidden_from_list_and_detail(api):
    client, session = api
    row = Insight(content='S2T06 hidden', deleted_at=datetime(2021, 1, 1, tzinfo=timezone.utc))
    session.add(row)
    session.flush()
    assert client.get(f'/api/insights/{row.id}').status_code == 404
    assert client.get('/api/insights').json()['total'] == 0


def test_missing_ids_and_non_integer_paths(api):
    client, session = api
    for method, kwargs in [(client.get, {}), (client.patch, {'json': {}}), (client.delete, {})]:
        assert method('/api/insights/1000000000', **kwargs).status_code == 404
        assert method('/api/insights/not-an-id', **kwargs).status_code == 422
