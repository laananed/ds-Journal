"""Synthetic cross-file goal tests, isolated by the api fixture."""
from uuid import uuid4
from datetime import datetime, timezone

from app.journal.models import Journal
from app.writing.documents import project_document
from test_s4_ritual_api import create


def goal_document(goal_id, text='one', checked=False):
    return {'type': 'doc', 'content': [{'type': 'goalItem', 'attrs': {
        'id': str(uuid4()), 'goal_id': goal_id, 'text': text, 'checked': checked}}]}


def test_link_existing_end_is_idempotent_and_sync_preserves_answer(api):
    client, db = api
    source, end = create(client), create(client, 'end')
    goal_id = str(uuid4())
    row = db.get(Journal, source['id'])
    row.content_doc = goal_document(goal_id)
    row.content = project_document(row.content_doc)
    end_row = db.get(Journal, end['id'])
    end_row.content_doc = {'type': 'doc', 'content': [{'type': 'paragraph',
        'content': [{'type': 'text', 'text': 'end text'}]}]}
    end_row.content = project_document(end_row.content_doc)
    db.flush()
    body = {'source_set_id': source['id'], 'goal_ids': [goal_id], 'expected_set_revision': 1,
            'end_id': end['id'], 'expected_end_revision': 1}
    first = client.post('/api/ritual-goal-links', json=body)
    assert first.status_code == 200, first.text
    replay_link = client.post('/api/ritual-goal-links', json=body)
    assert replay_link.status_code == 200, replay_link.text
    detail = client.get(f"/api/journals/{end['id']}").json()
    assert detail['goal_links'][0]['goal_id'] == goal_id
    assert detail['goal_links'][0]['set_id'] == source['id']
    end_doc = client.get(f"/api/journals/{end['id']}").json()['content_doc']
    review = next(node for node in end_doc['content'] if node['type'] == 'goalReview')
    review['content'] = [{'type': 'paragraph', 'content': [{'type': 'text', 'text': 'my answer'}]}]
    updated = client.patch(f"/api/journals/{end['id']}", json={
        'expected_revision': 2, 'document_schema_version': 1, 'content_doc': end_doc})
    assert updated.status_code == 200, updated.text
    stale = client.patch(f"/api/ritual-goals/{source['id']}/{goal_id}", json={
        'expected_set_revision': 1, 'expected_end_revision': 2, 'text': 'stale'})
    assert stale.status_code == 409
    assert client.get(f"/api/journals/{end['id']}").json()['content_doc'] == end_doc
    again = client.post('/api/ritual-goal-links', json={**body, 'expected_end_revision': 3})
    assert again.status_code == 200, again.text
    assert again.json()['files'][0]['id'] == end['id']
    assert again.json()['files'][0]['revision'] == 3
    changed = client.patch(f"/api/ritual-goals/{source['id']}/{goal_id}", json={
        'expected_set_revision': 1, 'expected_end_revision': 3, 'text': 'two', 'checked': True})
    assert changed.status_code == 200, changed.text
    replay = client.patch(f"/api/ritual-goals/{source['id']}/{goal_id}", json={
        'expected_set_revision': 1, 'expected_end_revision': 3, 'text': 'two', 'checked': True})
    assert replay.status_code == 200, replay.text
    saved = client.get(f"/api/journals/{end['id']}").json()['content_doc']
    reviews = [node for node in saved['content'] if node['type'] == 'goalReview']
    assert len(reviews) == 1
    assert reviews[0]['attrs']['goal_snapshot'] == 'two'
    assert reviews[0]['attrs']['checked_snapshot'] is True
    assert reviews[0]['content'] == review['content']
    saved['content'] = [node for node in saved['content'] if node['type'] != 'goalReview']
    response = client.patch(f"/api/journals/{end['id']}", json={
        'expected_revision': 4, 'document_schema_version': 1, 'content_doc': saved,
        'related_revisions': [{'type': 'journal', 'id': source['id'], 'revision': 2}]})
    assert response.status_code == 200, response.text
    assert client.get(f"/api/journals/{source['id']}").json()['related_revisions'] == []


def test_new_end_path_is_fail_closed_pending_capture_proof(api):
    from app.ritual.dates import business_date
    client, db = api
    now = datetime.now(timezone.utc)
    day = business_date(now).isoformat()
    source = client.post('/api/journals', json={'journal_kind': 'set', 'journal_date': day,
        'draft_started_at': now.isoformat(), 'content': 'synthetic'}).json()
    goal_id = str(uuid4())
    row = db.get(Journal, source['id'])
    row.content_doc = goal_document(goal_id)
    row.content = project_document(row.content_doc)
    db.flush()
    body = {'source_set_id': source['id'], 'goal_ids': [goal_id], 'expected_set_revision': 1,
            'end_id': None, 'expected_end_revision': 0, 'client_create_id': str(uuid4()),
            'draft_started_at': now.isoformat()}
    first = client.post('/api/ritual-goal-links', json=body)
    assert first.status_code == 422, first.text
    assert client.get('/api/rituals', params={'journal_date': day}).json()['end'] is None
    assert client.get(f"/api/journals/{source['id']}").json()['revision'] == 1


def test_unlinked_update_does_not_create_end(api):
    client, db = api
    source = create(client)
    goal_id = str(uuid4())
    row = db.get(Journal, source['id'])
    row.content_doc = goal_document(goal_id)
    row.content = project_document(row.content_doc)
    db.flush()
    result = client.patch(f"/api/ritual-goals/{source['id']}/{goal_id}", json={
        'expected_set_revision': 1, 'text': 'changed'})
    assert result.status_code == 200, result.text
    assert client.get('/api/rituals', params={'journal_date': '2026-10-30'}).json()['end'] is None
    assert client.get(f"/api/journals/{source['id']}").json()['content_doc']['content'][0]['attrs']['text'] == 'changed'


def test_only_set_can_create_goal_item_with_normal_document_patch(api):
    client, db = api
    source = create(client)
    writing = client.post('/api/journals', json={'journal_date': '2026-10-30', 'content': 'synthetic'}).json()
    for item in (source, writing):
        row = db.get(Journal, item['id'])
        row.content_doc = {'type': 'doc', 'content': [{'type': 'paragraph',
            'content': [{'type': 'text', 'text': 'text'}]}]}
        row.content = project_document(row.content_doc)
    db.flush()
    new_doc = goal_document(str(uuid4()))
    payload = {'expected_revision': 1, 'document_schema_version': 1, 'content_doc': new_doc}
    assert client.patch(f"/api/journals/{source['id']}", json=payload).status_code == 200
    assert client.patch(f"/api/journals/{writing['id']}", json=payload).status_code == 422
    assert client.get('/api/rituals', params={'journal_date': '2026-10-30'}).json()['end'] is None


def test_sync_failure_rolls_back_both_documents(api, monkeypatch):
    client, db = api
    source, end = create(client), create(client, 'end')
    goal_id = str(uuid4())
    row = db.get(Journal, source['id'])
    row.content_doc = goal_document(goal_id)
    row.content = project_document(row.content_doc)
    end_row = db.get(Journal, end['id'])
    end_row.content_doc = {'type': 'doc', 'content': [{'type': 'paragraph',
        'content': [{'type': 'text', 'text': 'end'}]}]}
    end_row.content = project_document(end_row.content_doc)
    db.flush()
    assert client.post('/api/ritual-goal-links', json={'source_set_id': source['id'],
        'goal_ids': [goal_id], 'expected_set_revision': 1, 'end_id': end['id'],
        'expected_end_revision': 1}).status_code == 200
    assert client.get(f"/api/journals/{source['id']}").json()['related_revisions'] == [
        {'type': 'journal', 'id': end['id'], 'revision': 2}]
    before_set = client.get(f"/api/journals/{source['id']}").json()
    before_end = client.get(f"/api/journals/{end['id']}").json()
    original_commit = db.commit
    monkeypatch.setattr(db, 'commit', lambda: (_ for _ in ()).throw(RuntimeError('synthetic failure')))
    result = client.patch(f"/api/ritual-goals/{source['id']}/{goal_id}", json={
        'expected_set_revision': 1, 'expected_end_revision': 2, 'text': 'changed'})
    monkeypatch.setattr(db, 'commit', original_commit)
    assert result.status_code == 500
    assert client.get(f"/api/journals/{source['id']}").json() == before_set
    assert client.get(f"/api/journals/{end['id']}").json() == before_end


def test_database_update_failure_rolls_back_set_and_end(api):
    from sqlalchemy import event
    client, db = api
    source, end = create(client), create(client, 'end')
    goal_id = str(uuid4())
    row = db.get(Journal, source['id'])
    row.content_doc = goal_document(goal_id)
    row.content = project_document(row.content_doc)
    end_row = db.get(Journal, end['id'])
    end_row.content_doc = {'type': 'doc', 'content': [{'type': 'paragraph',
        'content': [{'type': 'text', 'text': 'end'}]}]}
    end_row.content = project_document(end_row.content_doc)
    db.flush()
    assert client.post('/api/ritual-goal-links', json={'source_set_id': source['id'],
        'goal_ids': [goal_id], 'expected_set_revision': 1, 'end_id': end['id'],
        'expected_end_revision': 1}).status_code == 200
    before_set = client.get(f"/api/journals/{source['id']}").json()
    before_end = client.get(f"/api/journals/{end['id']}").json()
    connection = db.connection()
    def fail_update(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith('UPDATE JOURNALS'):
            raise RuntimeError('synthetic SQL update fault')
    event.listen(connection, 'before_cursor_execute', fail_update)
    try:
        result = client.patch(f"/api/ritual-goals/{source['id']}/{goal_id}", json={
            'expected_set_revision': 1, 'expected_end_revision': 2, 'text': 'changed'})
    finally:
        event.remove(connection, 'before_cursor_execute', fail_update)
    assert result.status_code == 500
    assert client.get(f"/api/journals/{source['id']}").json() == before_set
    assert client.get(f"/api/journals/{end['id']}").json() == before_end


def test_goal_sync_over_limit_rolls_back_both_files(api):
    client, db = api
    source, end = create(client), create(client, 'end')
    goal_id = str(uuid4())
    row = db.get(Journal, source['id'])
    row.content_doc = goal_document(goal_id)
    row.content_doc['content'].insert(0, {'type': 'paragraph',
        'content': [{'type': 'text', 'text': 'x' * 49990}]})
    row.content = project_document(row.content_doc)
    end_row = db.get(Journal, end['id'])
    end_row.content_doc = {'type': 'doc', 'content': [{'type': 'paragraph',
        'content': [{'type': 'text', 'text': 'end'}]}]}
    end_row.content = project_document(end_row.content_doc)
    db.flush()
    assert client.post('/api/ritual-goal-links', json={'source_set_id': source['id'],
        'goal_ids': [goal_id], 'expected_set_revision': 1, 'end_id': end['id'],
        'expected_end_revision': 1}).status_code == 200
    before_set = client.get(f"/api/journals/{source['id']}").json()
    before_end = client.get(f"/api/journals/{end['id']}").json()
    result = client.patch(f"/api/ritual-goals/{source['id']}/{goal_id}", json={
        'expected_set_revision': 1, 'expected_end_revision': 2, 'text': 'a' * 100})
    assert result.status_code == 422
    assert client.get(f"/api/journals/{source['id']}").json() == before_set
    assert client.get(f"/api/journals/{end['id']}").json() == before_end


def test_set_document_patch_requires_related_version_and_syncs_goal(api):
    client, db = api
    source, end = create(client), create(client, 'end')
    goal_id = str(uuid4())
    row = db.get(Journal, source['id'])
    row.content_doc = goal_document(goal_id)
    row.content = project_document(row.content_doc)
    end_row = db.get(Journal, end['id'])
    end_row.content_doc = {'type': 'doc', 'content': [{'type': 'paragraph',
        'content': [{'type': 'text', 'text': 'end'}]}]}
    end_row.content = project_document(end_row.content_doc)
    db.flush()
    assert client.post('/api/ritual-goal-links', json={'source_set_id': source['id'],
        'goal_ids': [goal_id], 'expected_set_revision': 1, 'end_id': end['id'],
        'expected_end_revision': 1}).status_code == 200
    doc = client.get(f"/api/journals/{source['id']}").json()['content_doc']
    doc['content'][0]['attrs']['text'] = 'edited in set'
    payload = {'expected_revision': 1, 'document_schema_version': 1, 'content_doc': doc}
    assert client.patch(f"/api/journals/{source['id']}", json=payload).status_code == 428
    payload['related_revisions'] = [{'type': 'journal', 'id': end['id'], 'revision': 2}]
    result = client.patch(f"/api/journals/{source['id']}", json=payload)
    assert result.status_code == 200, result.text
    mutation = result.json()['file_mutation']
    assert {item['id'] for item in mutation['files']} == {source['id'], end['id']}
    assert {effect['id'] for effect in mutation['effects']} == {source['id'], end['id']}
    assert client.patch(f"/api/journals/{source['id']}", json=payload).status_code == 200
    end_file = client.get(f"/api/journals/{end['id']}").json()
    assert end_file['revision'] == 3
    assert end_file['content_doc']['content'][-1]['attrs']['goal_snapshot'] == 'edited in set'
    payload['expected_revision'] = 2
    payload['related_revisions'][0]['revision'] = 3
    payload['content_doc'] = {'type': 'doc', 'content': [{'type': 'paragraph',
        'content': [{'type': 'text', 'text': 'converted to plain text'}]}]}
    result = client.patch(f"/api/journals/{source['id']}", json=payload)
    assert result.status_code == 200, result.text
    detached = client.get(f"/api/journals/{end['id']}").json()['content_doc']['content'][-1]
    assert detached['attrs']['link_id'] is None
    assert detached['attrs']['goal_snapshot'] == 'edited in set'
