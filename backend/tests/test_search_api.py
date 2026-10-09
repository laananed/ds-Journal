"""S2-T11 real PostgreSQL contract tests; all rows use the shared savepoint."""
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import event, text

from app.folder.models import Folder
from app.inbox.models import Inbox
from app.insight.models import Insight
from app.journal.models import Journal

MODELS = {'journal': Journal, 'inbox': Inbox, 'insight': Insight}
ROUTES = {'journal': 'journals', 'inbox': 'inboxes', 'insight': 'insights'}
STAMP = datetime(2020, 1, 1, tzinfo=timezone.utc)


def seed(db, kind, **values):
    fields = {'title': None, 'content': 'plain', 'created_at': STAMP,
              'updated_at': STAMP, **values}
    if kind == 'journal':
        fields.setdefault('journal_date', date(2020, 1, 1))
    if kind == 'inbox':
        fields.setdefault('inbox_date', date(2020, 1, 1))
    row = MODELS[kind](**fields)
    db.add(row)
    db.flush()
    return row.id


def search(client, q=None, **params):
    if q is not None:
        params['q'] = q
    response = client.get('/api/search', params=params)
    assert response.status_code == 200
    return response.json()


@pytest.mark.parametrize('q', [None, '', ' ', '\n\t\r', '\u3000\u2003'])
def test_empty_query_does_not_return_entire_database(api, q):
    client, db = api
    for kind in MODELS:
        seed(db, kind, content='anything')
    body = search(client, q, page=8)
    assert body == {'items': [], 'page': 8, 'page_size': 20, 'total': 0, 'has_next': False}


@pytest.mark.parametrize('kind', MODELS)
@pytest.mark.parametrize('q', ['AI 培训', 'ai 培训', 'Ai\t培训\nAI', ' 培训\u3000aI  '])
def test_each_word_or_across_fields_and_between_words(api, kind, q):
    client, db = api
    first = seed(db, kind, title='AI notes', content='参加培训')
    second = seed(db, kind, title='培训记录', content='learn ai')
    seed(db, kind, title='AI only', content='no second term')
    seed(db, kind, title='培训 only', content='no first term')
    assert {row['id'] for row in search(client, q, type=kind)['items']} == {first, second}


@pytest.mark.parametrize('kind', MODELS)
@pytest.mark.parametrize('word', ['%', '_', '\\', 'a%_\\b', "' OR 1=1 --"])
def test_wildcards_backslash_and_sql_text_are_literal(api, kind, word):
    client, db = api
    id = seed(db, kind, title='literal ' + word, content='plain')
    seed(db, kind, title='literal axxyb', content='plain')
    assert [row['id'] for row in search(client, word, type=kind)['items']] == [id]


def test_global_pagination_counts_stable_order_and_type_ids(api):
    client, db = api
    expected = []
    for rank, kind in enumerate(MODELS):
        for i in range(23):
            stamp = STAMP + timedelta(days=i % 2)
            id = seed(db, kind, id=100000000 + i, content='mixed match', updated_at=stamp)
            expected.append((stamp, rank, id, kind))
    db.commit()
    expected.sort(key=lambda item: (-item[0].timestamp(), item[1], -item[2]))
    for kind in ('all', *MODELS):
        matches = [item for item in expected if kind == 'all' or item[3] == kind]
        seen = []
        for page in (1, 2, 3, 4, 9):
            body = search(client, 'mixed', type=kind, page=page, page_size=1)
            assert (body['page'], body['page_size'], body['total'], body['has_next']) == (page, 20, len(matches), page * 20 < len(matches))
            actual = [(item['type'], item['id']) for item in body['items']]
            assert actual == [(item[3], item[2]) for item in matches[(page-1)*20:page*20]]
            seen += actual
            for item in body['items']:
                assert client.get(f"/api/{ROUTES[item['type']]}/{item['id']}").json() == item
        assert len(seen) == len(set(seen)) == len(matches)


@pytest.mark.parametrize('kind', MODELS)
def test_lifecycle_and_content_changes_refresh_matches(api, kind):
    client, db = api
    id = seed(db, kind, content='lifecycle match')
    db.commit()
    path = f'/api/{ROUTES[kind]}/{id}'
    assert search(client, 'lifecycle')['total'] == 1
    assert client.patch(path, json={'content': 'different'}).status_code == 200
    assert search(client, 'lifecycle')['total'] == 0
    assert client.patch(path, json={'title': 'lifecycle'}).status_code == 200
    assert search(client, 'lifecycle')['total'] == 1
    assert client.delete(path).status_code == 204
    assert search(client, 'lifecycle')['total'] == 0
    if kind != 'inbox':
        assert client.post(f'/api/trash/{kind}/{id}/restore').status_code == 200
        assert search(client, 'lifecycle')['total'] == 1
        assert client.delete(path).status_code == 204
        assert client.delete(f'/api/trash/{kind}/{id}').status_code == 204
        assert search(client, 'lifecycle')['total'] == 0
    else:
        assert client.post(f'/api/trash/inbox/{id}/restore').status_code == 422


def test_inbox_deleted_at_unused_and_journal_insight_excluded(api):
    client, db = api
    for kind in MODELS:
        seed(db, kind, content='hidden', deleted_at=STAMP)
    assert [item['type'] for item in search(client, 'hidden')['items']] == ['inbox']
    assert search(client, 'hidden')['items'][0]['deleted_at'] is None


def test_numbering_uses_nonmatching_deleted_and_other_folder_rows(api):
    client, db = api
    f = Folder(name='other')
    db.add(f)
    db.flush()
    for i in range(25):
        id = seed(db, 'journal', content='needle' if i == 24 else 'not matching',
                  folder_id=f.id if i < 24 else None, deleted_at=STAMP if i == 0 else None)
    item = search(client, 'needle')['items'][0]
    assert item['id'] == id and item['display_title'] == '2020-01-01 (25)'
    assert client.get(f'/api/journals/{id}').json() == item


def test_search_only_raw_title_content_not_projection_date_or_folder(api):
    client, db = api
    f = Folder(name='folder-only-marker')
    db.add(f)
    db.flush()
    for kind in MODELS:
        seed(db, kind, folder_id=f.id)
    for q in ('2020-01-01', '未命名 Insight', 'folder-only-marker'):
        assert search(client, q)['total'] == 0


@pytest.mark.parametrize('params', [{'type': 'bad'}, {'type': 'ALL'}, {'page': 0}, {'page': -1}, {'page': '1.5'}, {'page': 'bad'}])
def test_invalid_type_page_are_422(api, params):
    assert api[0].get('/api/search', params=params).status_code == 422


def test_get_zero_writes_no_flush_and_constant_query_count(api, monkeypatch):
    client, db = api
    for _ in range(25):
        seed(db, 'journal', content='readonly')
    db.commit()
    before = db.execute(text('SELECT * FROM journals ORDER BY id')).all()
    pending = Insight(content='pending')
    db.add(pending)
    statements = []
    def capture(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement.strip().split()[0].upper())
    def forbidden(*args, **kwargs):
        raise AssertionError('Search GET tried to write')
    event.listen(db.bind, 'before_cursor_execute', capture)
    try:
        with monkeypatch.context() as patch:
            patch.setattr(db, 'flush', forbidden)
            patch.setattr(db, 'commit', forbidden)
            assert search(client, 'readonly')['total'] == 25
            assert statements == ['SELECT', 'SELECT']
            statements.clear()
            assert search(client, '  ')['total'] == 0
            assert statements == []
        assert pending.id is None and pending in db.new
        with db.no_autoflush:
            assert db.execute(text('SELECT * FROM journals ORDER BY id')).all() == before
    finally:
        event.remove(db.bind, 'before_cursor_execute', capture)
