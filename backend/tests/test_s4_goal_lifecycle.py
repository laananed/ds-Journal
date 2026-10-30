from uuid import uuid4

from app.journal.models import Journal
from app.writing.documents import project_document
from test_s4_goal_sync import goal_document
from test_s4_ritual_api import create


def test_set_delete_requires_related_version_preserves_review_and_does_not_reconnect(api):
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
    doc = client.get(f"/api/journals/{end['id']}").json()['content_doc']
    review = doc['content'][-1]
    review['content'] = [{'type': 'paragraph', 'content': [{'type': 'text', 'text': 'answer'}]}]
    assert client.patch(f"/api/journals/{end['id']}", json={'expected_revision': 2,
        'document_schema_version': 1, 'content_doc': doc}).status_code == 200
    path = f"/api/journals/{source['id']}"
    headers = {'If-Match': '"1"'}
    assert client.delete(path, headers=headers).status_code == 428
    body = {'related_revisions': [{'type': 'journal', 'id': end['id'], 'revision': 2}]}
    assert client.request('DELETE', path, headers=headers, json=body).status_code == 409
    body['related_revisions'][0]['revision'] = 3
    assert client.request('DELETE', path, headers=headers, json=body).status_code == 204
    after = client.get(f"/api/journals/{end['id']}").json()
    saved = after['content_doc']['content'][-1]
    assert after['revision'] == 4
    assert saved['attrs']['link_id'] is None
    assert saved['attrs']['goal_snapshot'] == 'one'
    assert saved['content'] == review['content']
    assert client.post(f"/api/trash/journal/{source['id']}/restore",
                       headers={'If-Match': '"2"'}).status_code == 200
    assert client.get(f"/api/journals/{end['id']}").json()['content_doc'] == after['content_doc']
    assert client.patch(f"/api/ritual-goals/{source['id']}/{goal_id}", json={
        'expected_set_revision': 3, 'text': 'changed while detached'}).status_code == 200
    rejoin = client.post('/api/ritual-goal-links', json={'source_set_id': source['id'],
        'goal_ids': [goal_id], 'expected_set_revision': 4, 'end_id': end['id'],
        'expected_end_revision': 4})
    assert rejoin.status_code == 200, rejoin.text
    reviews = [node for node in client.get(f"/api/journals/{end['id']}").json()['content_doc']['content']
               if node['type'] == 'goalReview']
    assert len(reviews) == 1
    assert reviews[0]['attrs']['link_id'] is not None
    assert reviews[0]['attrs']['goal_snapshot'] == 'one'
    assert reviews[0]['content'] == review['content']


def test_end_delete_unlinks_and_restore_retains_snapshot(api):
    client, db = api
    source, end = create(client), create(client, 'end')
    goal_id = str(uuid4())
    source_row = db.get(Journal, source['id'])
    source_row.content_doc = goal_document(goal_id)
    source_row.content = project_document(source_row.content_doc)
    end_row = db.get(Journal, end['id'])
    end_row.content_doc = {'type': 'doc', 'content': [{'type': 'paragraph',
        'content': [{'type': 'text', 'text': 'end'}]}]}
    end_row.content = project_document(end_row.content_doc)
    db.flush()
    assert client.post('/api/ritual-goal-links', json={'source_set_id': source['id'],
        'goal_ids': [goal_id], 'expected_set_revision': 1, 'end_id': end['id'],
        'expected_end_revision': 1}).status_code == 200
    body = {'related_revisions': [{'type': 'journal', 'id': source['id'], 'revision': 1}]}
    deleted = client.request('DELETE', f"/api/journals/{end['id']}", headers={'If-Match': '"2"'}, json=body)
    assert deleted.status_code == 204, deleted.text
    assert client.get(f"/api/journals/{source['id']}").json()['revision'] == 2
    restored = client.post(f"/api/trash/journal/{end['id']}/restore", headers={'If-Match': '"3"'})
    assert restored.status_code == 200, restored.text
    review = restored.json()['content_doc']['content'][-1]
    assert review['attrs']['link_id'] is None
    assert review['attrs']['goal_snapshot'] == 'one'
    assert client.patch(f"/api/ritual-goals/{source['id']}/{goal_id}",
        json={'expected_set_revision': 2, 'text': 'new'}).status_code == 200
    assert client.get(f"/api/journals/{end['id']}").json()['content_doc']['content'][-1] == review


def test_replace_set_detaches_current_without_losing_end_answer(api):
    client, db = api
    old = create(client)
    assert client.delete(f"/api/journals/{old['id']}", headers={'If-Match': '"1"'}).status_code == 204
    current, end = create(client), create(client, 'end')
    goal_id = str(uuid4())
    source_row = db.get(Journal, current['id'])
    source_row.content_doc = goal_document(goal_id)
    source_row.content = project_document(source_row.content_doc)
    end_row = db.get(Journal, end['id'])
    end_row.content_doc = {'type': 'doc', 'content': [{'type': 'paragraph',
        'content': [{'type': 'text', 'text': 'end'}]}]}
    end_row.content = project_document(end_row.content_doc)
    db.flush()
    assert client.post('/api/ritual-goal-links', json={'source_set_id': current['id'],
        'goal_ids': [goal_id], 'expected_set_revision': 1, 'end_id': end['id'],
        'expected_end_revision': 1}).status_code == 200
    end_doc = client.get(f"/api/journals/{end['id']}").json()['content_doc']
    before = end_doc['content'][-1]
    before['content'] = [{'type': 'paragraph', 'content': [{'type': 'text', 'text': 'saved answer'}]}]
    assert client.patch(f"/api/journals/{end['id']}", json={'expected_revision': 2,
        'document_schema_version': 1, 'content_doc': end_doc}).status_code == 200
    path = f"/api/rituals/{old['id']}/restore-replace"
    data = {'target_id': current['id'], 'expected_target_revision': 1,
            'related_revisions': [{'type': 'journal', 'id': end['id'], 'revision': 3}]}
    result = client.post(path, headers={'If-Match': '"2"'}, json=data)
    assert result.status_code == 200, result.text
    review = client.get(f"/api/journals/{end['id']}").json()['content_doc']['content'][-1]
    assert review['attrs']['link_id'] is None
    assert review['attrs']['goal_snapshot'] == before['attrs']['goal_snapshot']
    assert review['content'] == before['content']
    assert client.get(f"/api/journals/{old['id']}").status_code == 200
    assert client.get(f"/api/trash/journal/{current['id']}").status_code == 200


def test_copy_goal_into_linked_set_uses_new_goal_identity(api):
    client, db = api
    old = create(client)
    old_goal = str(uuid4())
    old_row = db.get(Journal, old['id'])
    old_row.content_doc = goal_document(old_goal)
    old_row.content = project_document(old_row.content_doc)
    old_node = old_row.content_doc['content'][0]['attrs']['id']
    db.flush()
    assert client.delete(f"/api/journals/{old['id']}", headers={'If-Match': '"1"'}).status_code == 204
    current, end = create(client), create(client, 'end')
    goal_id = str(uuid4())
    row = db.get(Journal, current['id'])
    row.content_doc = goal_document(goal_id)
    row.content = project_document(row.content_doc)
    insert_after = row.content_doc['content'][0]['attrs']['id']
    end_row = db.get(Journal, end['id'])
    end_row.content_doc = {'type': 'doc', 'content': [{'type': 'paragraph',
        'content': [{'type': 'text', 'text': 'end'}]}]}
    end_row.content = project_document(end_row.content_doc)
    db.flush()
    assert client.post('/api/ritual-goal-links', json={'source_set_id': current['id'],
        'goal_ids': [goal_id], 'expected_set_revision': 1, 'end_id': end['id'],
        'expected_end_revision': 1}).status_code == 200
    response = client.post(f"/api/rituals/{old['id']}/copy-content", json={'source_revision': 2,
        'target_id': current['id'], 'expected_target_revision': 1, 'copy_id': str(uuid4()),
        'selection': [{'node_id': old_node}], 'insert_after_node_id': insert_after,
        'related_revisions': [{'type': 'journal', 'id': end['id'], 'revision': 2}]})
    assert response.status_code == 200, response.text
    copied = client.get(f"/api/journals/{current['id']}").json()['content_doc']['content'][-1]
    assert copied['attrs']['goal_id'] not in (goal_id, old_goal)
    end_doc = client.get(f"/api/journals/{end['id']}").json()['content_doc']
    assert len([node for node in end_doc['content'] if node['type'] == 'goalReview']) == 1


def test_delete_failure_after_detachment_rolls_back_all(api, monkeypatch):
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
    execute, writes = db.execute, 0
    def fail_second(statement, *args, **kwargs):
        nonlocal writes
        if getattr(statement, 'is_update', False):
            writes += 1
            if writes == 2:
                raise RuntimeError('synthetic delete SQL failure')
        return execute(statement, *args, **kwargs)
    monkeypatch.setattr(db, 'execute', fail_second)
    result = client.request('DELETE', f"/api/journals/{source['id']}", headers={'If-Match': '"1"'},
        json={'related_revisions': [{'type': 'journal', 'id': end['id'], 'revision': 2}]})
    monkeypatch.setattr(db, 'execute', execute)
    assert result.status_code == 500
    assert client.get(f"/api/journals/{source['id']}").json() == before_set
    assert client.get(f"/api/journals/{end['id']}").json() == before_end
