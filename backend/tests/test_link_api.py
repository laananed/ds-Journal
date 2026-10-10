"""Exact current display titles; real PostgreSQL, shared savepoint isolation."""
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import event

from app.inbox.models import Inbox
from app.insight.models import Insight
from app.journal.models import Journal

MODELS = {'journal': Journal, 'inbox': Inbox, 'insight': Insight}
ROUTES = {'journal': 'journals', 'inbox': 'inboxes', 'insight': 'insights'}
STAMP = datetime(2020, 1, 1, tzinfo=timezone.utc)


def seed(db, kind, **values):
    fields = dict(title=None, content='original [[source]]', created_at=STAMP,
                  updated_at=STAMP)
    fields.update(values)
    if kind == 'journal':
        fields.setdefault('journal_date', date(2020, 1, 1))
    if kind == 'inbox':
        fields.setdefault('inbox_date', date(2020, 1, 1))
    row = MODELS[kind](**fields)
    db.add(row)
    db.flush()
    return row.id


def resolve(client, title, **params):
    response = client.get('/api/links/resolve', params=dict(title=title, **params))
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize('kind', MODELS)
@pytest.mark.parametrize('title', ['标题', ' A &+#%_\\ ', ' ', "' OR 1=1 --", '😀'])
def test_single_exact_original_title_and_light_fields(api, kind, title):
    client, db = api
    target = seed(db, kind, title=title)
    seed(db, kind, title='prefix' + title)
    item = resolve(client, title)['items'][0]
    assert item['type'] == kind and item['id'] == target
    assert item['title'] == item['display_title'] == title
    assert set(item) == {'type', 'id', 'title', 'display_title', 'created_at'} | (
        {'journal_date'} if kind == 'journal' else set())
    assert resolve(client, title)['total'] == 1


@pytest.mark.parametrize('query', ['ai', 'AI ', ' AI', 'A', '不存在'])
def test_no_case_folding_trimming_or_fuzzy_search(api, query):
    client, db = api
    for kind in MODELS:
        seed(db, kind, title='AI')
    assert resolve(client, query) == dict(items=[], page=1, page_size=20, total=0, has_next=False)


@pytest.mark.parametrize('params', [{}, {'title': ''}, {'title': 'x', 'page': 'abc'},
                                    {'title': 'x', 'page': 0}, {'title': 'x', 'page': -1},
                                    {'title': 'x', 'page': '1.5'}])
def test_invalid_query_standard_422(api, params):
    client, _ = api
    response = client.get('/api/links/resolve', params=params)
    assert response.status_code == 422
    assert isinstance(response.json()['detail'], list)


def test_cross_type_same_id_global_order_and_pages(api):
    client, db = api
    expected = []
    for kind in MODELS:
        for i in range(23):
            target = seed(db, kind, id=900000000 + i, title='same')
            expected.append((kind, target))
    expected = [(kind, id) for kind in MODELS for id in
                sorted((id for k, id in expected if k == kind), reverse=True)]
    for page in (1, 2, 3, 4, 8):
        body = resolve(client, 'same', page=page, page_size=1)
        assert (body['page'], body['page_size'], body['total'], body['has_next']) == (page, 20, 69, page < 4)
        assert [(item['type'], item['id']) for item in body['items']] == expected[(page-1)*20:page*20]


def test_generated_titles_complete_numbering_and_deleted_lifecycle(api):
    client, db = api
    ids = [seed(db, 'journal', created_at=STAMP + timedelta(seconds=i)) for i in range(25)]
    # A manual date title is a duplicate candidate, not part of numbering.
    manual = seed(db, 'journal', title='2020-01-01 (25)')
    inbox = seed(db, 'inbox', title='')
    insight = seed(db, 'insight', title='')
    assert resolve(client, '2020-01-01')['total'] == 2
    assert resolve(client, '未命名 Insight')['items'][0]['id'] == insight
    assert [i['id'] for i in resolve(client, '2020-01-01 (25)')['items']] == [manual, ids[-1]]
    assert client.delete(f'/api/journals/{ids[0]}').status_code == 204
    assert resolve(client, '2020-01-01')['items'][0]['id'] == inbox
    assert resolve(client, '2020-01-01 (25)')['total'] == 2
    assert client.post(f'/api/trash/journal/{ids[0]}/restore').status_code == 200
    assert resolve(client, '2020-01-01')['total'] == 2
    assert client.delete(f'/api/journals/{ids[0]}').status_code == 204
    assert client.delete(f'/api/trash/journal/{ids[0]}').status_code == 204
    assert resolve(client, '2020-01-01 (25)')['items'][0]['id'] == manual
    assert resolve(client, '2020-01-01 (24)')['items'][0]['id'] == ids[-1]


@pytest.mark.parametrize('kind', MODELS)
def test_removal_other_duplicate_restore_and_stale_detail(api, kind):
    client, db = api
    first = seed(db, kind, title='duplicate')
    second = seed(db, kind, title='duplicate')
    assert resolve(client, 'duplicate')['total'] == 2
    assert client.delete(f'/api/{ROUTES[kind]}/{first}').status_code == 204
    assert resolve(client, 'duplicate')['items'][0]['id'] == second
    assert client.get(f'/api/{ROUTES[kind]}/{first}').status_code == 404
    if kind != 'inbox':
        assert client.post(f'/api/trash/{kind}/{first}/restore').status_code == 200
        assert resolve(client, 'duplicate')['total'] == 2
        assert client.delete(f'/api/{ROUTES[kind]}/{first}').status_code == 204
        assert client.delete(f'/api/trash/{kind}/{first}').status_code == 204
    assert resolve(client, 'duplicate')['total'] == 1
    assert client.patch(f'/api/{ROUTES[kind]}/{second}', json={'title': 'renamed'}).status_code == 200
    assert resolve(client, 'duplicate')['total'] == 0
    assert resolve(client, 'renamed')['items'][0]['id'] == second


def test_get_no_writes_no_autoflush_and_time_unchanged(api):
    client, db = api
    targets = [seed(db, kind, title='read') for kind in MODELS]
    db.commit()
    before = [client.get(f'/api/{ROUTES[k]}/{id}').json() for k, id in zip(MODELS, targets)]
    db.add(Insight(title='pending', content='unsaved'))
    statements = []
    connection = db.connection()
    def capture(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)
    event.listen(connection, 'before_cursor_execute', capture)
    try:
        assert resolve(client, 'read')['total'] == 3
    finally:
        event.remove(connection, 'before_cursor_execute', capture)
    assert len(statements) == 2
    assert all(s.lstrip().upper().startswith('SELECT') for s in statements)
    assert len(db.new) == 1
    db.expunge(next(iter(db.new)))
    assert before == [client.get(f'/api/{ROUTES[k]}/{id}').json() for k, id in zip(MODELS, targets)]


def test_numbering_date_title_changes_and_folder_projection(api):
    client, db = api
    first = seed(db, 'journal', title='')
    second = seed(db, 'journal', created_at=STAMP + timedelta(seconds=1))
    assert resolve(client, '2020-01-01 (2)')['items'][0]['id'] == second
    assert client.patch(f'/api/journals/{first}', json={'title': 'manual'}).status_code == 200
    assert resolve(client, '2020-01-01 (2)')['total'] == 0
    assert resolve(client, '2020-01-01')['items'][0]['id'] == second
    assert client.patch(f'/api/journals/{second}', json={'journal_date': '2020-02-01'}).status_code == 200
    assert resolve(client, '2020-01-01')['total'] == 0
    item = resolve(client, '2020-02-01')['items'][0]
    assert item['id'] == second and item['journal_date'] == '2020-02-01'
    folder = client.post('/api/folders', json={'name': 'link folder'}).json()['id']
    assert client.patch(f'/api/journals/{second}', json={'folder_id': folder}).status_code == 200
    folder_item = client.get(f'/api/folders/{folder}/files').json()['items'][0]
    assert folder_item['display_title'] == item['display_title']
    assert resolve(client, '2020-02-01')['items'][0]['display_title'] == item['display_title']


def test_inbox_existing_row_ignores_reserved_deleted_field(api):
    client, db = api
    id = seed(db, 'inbox', title='reserved', deleted_at=STAMP)
    assert resolve(client, 'reserved')['items'][0]['id'] == id


def test_legacy_long_title_readable_and_empty_out_of_range(api):
    client, db = api
    title = '旧' * 90
    id = seed(db, 'insight', title=title)
    assert resolve(client, title)['items'][0]['id'] == id
    assert resolve(client, title, page=10) == dict(items=[], page=10, page_size=20, total=1, has_next=False)
