"""Inbox HTTP contract tests; all data stays inside the shared savepoint fixture."""
from datetime import date, datetime, timezone

import pytest
from sqlalchemy import event, select, text

from app.folder.models import Folder
from app.inbox.models import Inbox
from app.journal.schemas import _WHITESPACE_CODE_POINTS

DAY = '2034-01-01'
MARKDOWN = '  # Heading\n\n- [ ] task  \n1. item\n    code  \n'


def create(client, **values):
    return client.post('/api/inboxes', json={'content': MARKDOWN, 'inbox_date': DAY, **values})


def snapshot(session, identity):
    return tuple(session.execute(text('SELECT title, content, inbox_date, is_daily, folder_id, created_at, updated_at, deleted_at FROM inboxes WHERE id=:id'), {'id': identity}).one())


def test_create_inbox_defaults_title_to_client_business_date(api):
    client, session = api
    response = create(client)
    assert response.status_code == 201
    body = response.json()
    assert set(body) == {'type', 'id', 'title', 'display_title', 'content', 'inbox_date', 'is_daily', 'folder_id', 'created_at', 'updated_at', 'deleted_at'}
    assert body['title'] == body['display_title'] == DAY
    assert body['type'] == 'inbox' and body['is_daily'] is False
    assert body['deleted_at'] is None
    assert snapshot(session, body['id'])[1] == MARKDOWN


@pytest.mark.parametrize('title', [None, '', ' \t ', '中' * 80, '🐟' * 80], ids=lambda value: str(value) if isinstance(value, (bool, int)) or value is None else f"{type(value).__name__}-{len(value)}")
def test_explicit_title_preserves_original_value_and_display_fallback(api, title):
    client, session = api
    response = create(client, title=title)
    assert response.status_code == 201
    body = response.json()
    assert body['title'] == title
    assert body['display_title'] == (title or DAY)
    assert snapshot(session, body['id'])[0] == title
    assert client.get(f"/api/inboxes/{body['id']}").json() == body


@pytest.mark.parametrize('field,value', [('title', '中' * 81), ('title', '🐟' * 81), ('title', 4), ('content', ''), ('content', None), ('content', 'x' * 50001), ('content', '🐟' * 50001), ('inbox_date', None), ('inbox_date', '2034-02-30'), ('is_daily', None)], ids=lambda value: str(value) if isinstance(value, (bool, int)) or value is None else f"{type(value).__name__}-{len(value)}")
def test_invalid_create_is_422_without_insertion(api, field, value):
    client, session = api
    before = session.execute(text('SELECT count(*) FROM inboxes')).scalar_one()
    assert create(client, **{field: value}).status_code == 422
    assert session.execute(text('SELECT count(*) FROM inboxes')).scalar_one() == before


@pytest.mark.parametrize('character', [chr(code) for code in sorted(_WHITESPACE_CODE_POINTS)], ids=lambda value: str(value) if isinstance(value, (bool, int)) or value is None else f"{type(value).__name__}-{len(value)}")
def test_every_shared_whitespace_character_is_rejected(api, character):
    client, session = api
    assert create(client, content=character * 3).status_code == 422


@pytest.mark.parametrize('content', ['x' * 49999, '🐟' * 50000, ' ' * 49999 + 'x', '\u200b', '\x1c'], ids=lambda value: str(value) if isinstance(value, (bool, int)) or value is None else f"{type(value).__name__}-{len(value)}")
def test_valid_original_content_boundary_roundtrips(api, content):
    client, session = api
    response = create(client, content=content)
    assert response.status_code == 201
    assert response.json()['content'] == content
    assert snapshot(session, response.json()['id'])[1] == content


def test_required_creation_fields(api):
    client, session = api
    for payload in [{}, {'content': 'x'}, {'inbox_date': DAY}]:
        assert client.post('/api/inboxes', json=payload).status_code == 422


@pytest.mark.parametrize('changes', [{}, {'inbox_date': '2035-01-01', 'is_daily': True}, {'id': 999, 'display_title': 'override', 'created_at': '2000-01-01', 'updated_at': '2000-01-01', 'deleted_at': '2000-01-01', 'type': 'journal', 'unknown': 'x'}, {'content': MARKDOWN, 'title': DAY, 'folder_id': None}], ids=lambda value: str(value) if isinstance(value, (bool, int)) or value is None else f"{type(value).__name__}-{len(value)}")
def test_empty_ignored_and_same_patch_do_not_write_or_change_time(api, changes):
    client, session = api
    original = create(client).json()
    statements = []
    def capture(connection, cursor, statement, parameters, context, many):
        statements.append(statement.lstrip().split()[0].upper())
    event.listen(session.bind, 'before_cursor_execute', capture)
    try:
        response = client.patch(f"/api/inboxes/{original['id']}", json=changes)
        assert response.status_code == 200
        assert response.json() == original
        assert not {'INSERT', 'UPDATE', 'DELETE'} & set(statements)
    finally:
        event.remove(session.bind, 'before_cursor_execute', capture)


@pytest.mark.parametrize('title', [None, '', '  ', '🐟' * 80], ids=lambda value: str(value) if isinstance(value, (bool, int)) or value is None else f"{type(value).__name__}-{len(value)}")
def test_patch_title_clear_and_original_content_roundtrip(api, title):
    client, session = api
    original = create(client).json()
    changes = {'title': title, 'content': MARKDOWN + '\n  changed  '}
    response = client.patch(f"/api/inboxes/{original['id']}", json=changes)
    assert response.status_code == 200
    updated = response.json()
    assert updated['title'] == title
    assert updated['display_title'] == (title or DAY)
    assert updated['content'] == changes['content']
    assert updated['updated_at'] != original['updated_at']
    assert updated['created_at'] == original['created_at']
    assert updated['id'] == original['id']
    assert client.get('/api/inboxes', params={'inbox_date': DAY}).json()['items'][0] == updated


@pytest.mark.parametrize('changes', [{'title': '🐟' * 81}, {'content': None}, {'content': ' \n\t\u3000\ufeff'}, {'content': 'x' * 50001}], ids=lambda value: str(value) if isinstance(value, (bool, int)) or value is None else f"{type(value).__name__}-{len(value)}")
def test_invalid_patch_leaves_every_field_unchanged(api, changes):
    client, session = api
    original = create(client).json()
    before = snapshot(session, original['id'])
    assert client.patch(f"/api/inboxes/{original['id']}", json=changes).status_code == 422
    assert snapshot(session, original['id']) == before


@pytest.mark.parametrize('total', [0, 20, 21, 41], ids=lambda value: str(value) if isinstance(value, (bool, int)) or value is None else f"{type(value).__name__}-{len(value)}")
def test_pagination_counts_sorting_dates_and_fixed_page_size(api, total):
    client, session = api
    timestamp = datetime(2020, 1, 1, tzinfo=timezone.utc)
    rows = [Inbox(title='', content=f'S2T04 page {i}', inbox_date=date.fromisoformat(DAY), created_at=timestamp) for i in range(total)]
    session.add_all(rows)
    session.flush()
    expected = sorted([row.id for row in rows], reverse=True)
    for page in (1, 2, 3, 10):
        response = client.get('/api/inboxes', params={'inbox_date': DAY, 'page': page, 'page_size': 1})
        assert response.status_code == 200
        body = response.json()
        assert body['page'] == page and body['page_size'] == 20
        assert body['total'] == total and body['has_next'] == (page * 20 < total)
        assert [row['id'] for row in body['items']] == expected[(page - 1) * 20:page * 20]


@pytest.mark.parametrize('params', [{'page': 0}, {'page': -1}, {'page': '1.2'}, {'page': 'bad'}, {'inbox_date': 'bad'}, {'folder_id': 'bad'}], ids=lambda value: str(value) if isinstance(value, (bool, int)) or value is None else f"{type(value).__name__}-{len(value)}")
def test_invalid_query_is_422(api, params):
    client, session = api
    assert client.get('/api/inboxes', params=params).status_code == 422


def test_created_timestamp_has_priority_over_business_date_and_id(api):
    client, session = api
    folder = Folder(name='S2T04 ordering')
    session.add(folder)
    session.flush()
    later = Inbox(content='later', inbox_date=date(2030, 1, 1), folder_id=folder.id, created_at=datetime(2022, 1, 1, tzinfo=timezone.utc))
    older = Inbox(content='older', inbox_date=date(2040, 1, 1), folder_id=folder.id, created_at=datetime(2021, 1, 1, tzinfo=timezone.utc))
    session.add_all([later, older])
    session.flush()
    body = client.get('/api/inboxes', params={'folder_id': folder.id}).json()
    assert [item['id'] for item in body['items']] == [later.id, older.id]
    assert client.get('/api/inboxes', params={'folder_id': folder.id, 'inbox_date': '2030-01-01'}).json()['total'] == 1


def test_folder_create_move_clear_and_missing_folder_are_atomic(api):
    client, session = api
    folder = Folder(name='S2T04 folder')
    session.add(folder)
    session.flush()
    original = create(client, folder_id=folder.id).json()
    assert original['folder_id'] == folder.id
    assert create(client, folder_id=10**9).status_code == 404
    before = snapshot(session, original['id'])
    response = client.patch(f"/api/inboxes/{original['id']}", json={'folder_id': 10**9, 'content': 'should roll back'})
    assert response.status_code == 404
    assert snapshot(session, original['id']) == before
    assert session.scalar(text('SELECT 1')) == 1
    cleared = client.patch(f"/api/inboxes/{original['id']}", json={'folder_id': None}).json()
    assert cleared['folder_id'] is None and cleared['updated_at'] != original['updated_at']
    assert client.get('/api/inboxes', params={'folder_id': folder.id}).json()['total'] == 0


def test_create_system_fields_are_ignored(api):
    client, session = api
    body = create(client, id=10**9, type='journal', display_title='evil', deleted_at='2000-01-01', created_at='2000-01-01', updated_at='2000-01-01').json()
    assert body['id'] != 10**9
    assert body['type'] == 'inbox' and body['display_title'] == DAY
    assert body['deleted_at'] is None
    assert not body['created_at'].startswith('2000')


@pytest.mark.parametrize('is_daily,day', [(False, DAY), (True, date.today().isoformat()), (True, '2001-01-01')], ids=lambda value: str(value) if isinstance(value, (bool, int)) or value is None else f"{type(value).__name__}-{len(value)}")
def test_all_inbox_kinds_are_physically_deleted_and_then_404(api, is_daily, day):
    client, session = api
    original = create(client, inbox_date=day, is_daily=is_daily).json()
    sibling = create(client, inbox_date=day).json()
    response = client.delete(f"/api/inboxes/{original['id']}")
    assert response.status_code == 204 and response.content == b''
    assert session.scalar(select(Inbox.id).where(Inbox.id == original['id'])) is None
    assert client.get(f"/api/inboxes/{sibling['id']}").status_code == 200
    assert client.get(f"/api/inboxes/{original['id']}").status_code == 404
    assert client.patch(f"/api/inboxes/{original['id']}", json={}).status_code == 404
    assert client.delete(f"/api/inboxes/{original['id']}").status_code == 404
    if is_daily:
        assert client.get('/api/inboxes/daily', params={'inbox_date': day}).json() == {'state': 'missing', 'id': None, 'file': None}
        recreated = create(client, inbox_date=day, is_daily=True)
        assert recreated.status_code == 201 and recreated.json()['id'] != original['id']


def test_missing_ids_and_non_integer_paths(api):
    client, session = api
    for method, kwargs in [(client.get, {}), (client.patch, {'json': {}}), (client.delete, {})]:
        assert method('/api/inboxes/1000000000', **kwargs).status_code == 404
        assert method('/api/inboxes/not-an-id', **kwargs).status_code == 422


def test_unused_deleted_at_column_is_not_a_filter_or_response_value(api):
    client, session = api
    row = Inbox(content='S2T04 unused column', inbox_date=date.fromisoformat(DAY), is_daily=True, deleted_at=datetime(2020, 1, 1, tzinfo=timezone.utc))
    session.add(row)
    session.flush()
    detail = client.get(f'/api/inboxes/{row.id}')
    assert detail.status_code == 200 and detail.json()['deleted_at'] is None
    assert client.get('/api/inboxes', params={'inbox_date': DAY}).json()['total'] == 1
    assert client.get('/api/inboxes/daily', params={'inbox_date': DAY}).json()['id'] == row.id
