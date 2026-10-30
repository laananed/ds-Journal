"""Replacement restore contracts using the rollback-isolated test client."""
import pytest
from uuid import uuid4
from test_s4_ritual_api import create


@pytest.mark.parametrize('kind', ['set', 'end'])
def test_replace_restore_is_atomic_and_checks_both_revisions(api, kind):
    client, _ = api
    source = create(client, kind)
    assert client.delete(f"/api/journals/{source['id']}", headers={'If-Match': '"1"'}).status_code == 204
    target = create(client, kind)
    path = f"/api/rituals/{source['id']}/restore-replace"
    body = {'target_id': target['id'], 'expected_target_revision': 9, 'related_revisions': []}
    assert client.post(path, headers={'If-Match': '"2"'}, json={
        'target_id': target['id'], 'related_revisions': []}).status_code == 428
    assert client.post(path, headers={'If-Match': '"2"'}, json={
        **body, 'expected_target_revision': None}).status_code == 422
    assert client.post(path, headers={'If-Match': '"2"'}, json=body).status_code == 409
    assert client.get(f"/api/journals/{target['id']}").status_code == 200
    body['expected_target_revision'] = 1
    result = client.post(path, headers={'If-Match': '"2"'}, json=body)
    assert result.status_code == 200
    assert client.get(f"/api/journals/{source['id']}").json()['revision'] == 3
    assert client.get(f"/api/trash/journal/{target['id']}").json()['revision'] == 2


def test_replace_failure_rolls_back_both_files(api, monkeypatch):
    client, db = api
    source = create(client)
    assert client.delete(f"/api/journals/{source['id']}", headers={'If-Match': '"1"'}).status_code == 204
    target = create(client)
    execute = db.execute
    writes = 0
    def fail_second(statement, *args, **kwargs):
        nonlocal writes
        if getattr(statement, 'is_update', False):
            writes += 1
            if writes == 2:
                raise RuntimeError('synthetic failure')
        return execute(statement, *args, **kwargs)
    monkeypatch.setattr(db, 'execute', fail_second)
    result = client.post(f"/api/rituals/{source['id']}/restore-replace", headers={'If-Match': '"2"'},
                         json={'target_id': target['id'], 'expected_target_revision': 1, 'related_revisions': []})
    assert result.status_code == 500
    assert client.get(f"/api/journals/{target['id']}").json()['revision'] == 1
    assert client.get(f"/api/trash/journal/{source['id']}").json()['revision'] == 2


@pytest.mark.parametrize('kind', ['set', 'end'])
def test_copy_selection_replays_once_and_rejects_changed_result(api, kind):
    client, _ = api
    node_id, target_node, copy_id = (str(uuid4()) for _ in range(3))
    def document(node, text):
        return {'type': 'doc', 'content': [{'type': 'paragraph', 'attrs': {'id': node},
                 'content': [{'type': 'text', 'text': text}]}]}
    def make(node, text):
        response = client.post('/api/journals', json={
            'journal_kind': kind, 'journal_date': '2026-10-30',
            'draft_started_at': '2026-10-30T04:00:00+08:00',
            'content_doc': document(node, text), 'document_schema_version': 1,
        })
        assert response.status_code == 201
        return response.json()
    source = make(node_id, 'a😀bc')
    assert client.delete(f"/api/journals/{source['id']}", headers={'If-Match': '"1"'}).status_code == 204
    target = make(target_node, 'target')
    path = f"/api/rituals/{source['id']}/copy-content"
    body = {'source_revision': 2, 'target_id': target['id'], 'expected_target_revision': 1,
            'copy_id': copy_id, 'selection': [{'node_id': node_id, 'from': 1, 'to': 3}],
            'insert_after_node_id': target_node, 'related_revisions': []}
    first = client.post(path, json=body)
    assert first.status_code == 200
    again = client.post(path, json=body)
    assert again.status_code == 200
    current = client.get(f"/api/journals/{target['id']}").json()
    assert current['revision'] == 2
    assert '😀b' in current['content']
    changed = dict(body, selection=[{'node_id': node_id, 'from': 0, 'to': 1}])
    assert client.post(path, json=changed).status_code == 409
    edited = current['content_doc']
    edited['content'][1]['content'][0]['text'] = 'changed'
    assert client.patch(f"/api/journals/{target['id']}", json={
        'expected_revision': 2, 'content_doc': edited, 'document_schema_version': 1,
    }).status_code == 200
    assert client.post(path, json=body).status_code == 409


def test_copy_failure_rolls_back_receipt_and_target(api, monkeypatch):
    from app.ritual.models import RitualCopy
    from sqlalchemy import select
    client, db = api
    source_id, target_id, copy_id = (str(uuid4()) for _ in range(3))
    def make(node):
        response = client.post('/api/journals', json={'journal_kind': 'set',
            'journal_date': '2026-10-30', 'draft_started_at': '2026-10-30T04:00:00+08:00',
            'content_doc': {'type': 'doc', 'content': [{'type': 'paragraph', 'attrs': {'id': node},
                'content': [{'type': 'text', 'text': 'test'}]}]}, 'document_schema_version': 1})
        assert response.status_code == 201
        return response.json()['id']
    source = make(source_id)
    assert client.delete(f'/api/journals/{source}', headers={'If-Match': '"1"'}).status_code == 204
    target = make(target_id)
    original_commit = db.commit
    def fail_commit():
        raise RuntimeError('synthetic commit failure')
    monkeypatch.setattr(db, 'commit', fail_commit)
    result = client.post(f'/api/rituals/{source}/copy-content', json={
        'source_revision': 2, 'target_id': target, 'expected_target_revision': 1,
        'copy_id': copy_id, 'selection': [{'node_id': source_id}],
        'insert_after_node_id': target_id, 'related_revisions': []})
    monkeypatch.setattr(db, 'commit', original_commit)
    assert result.status_code == 500
    assert client.get(f'/api/journals/{target}').json()['revision'] == 1
    assert db.scalar(select(RitualCopy).where(RitualCopy.id == copy_id)) is None


def test_copy_ai_comes_from_saved_source_and_keeps_author(api):
    from app.journal.models import Journal
    from app.writing.documents import project_document
    client, db = api
    source = create(client)
    ai_id, request_id, target_id = (str(uuid4()) for _ in range(3))
    row = db.get(Journal, source['id'])
    row.content_doc = {'type': 'doc', 'content': [{'type': 'aiReply',
        'attrs': {'id': ai_id, 'request_id': request_id},
        'content': [{'type': 'paragraph', 'content': [{'type': 'text', 'text': 'synthetic AI'}]}]}]}
    row.content = project_document(row.content_doc)
    db.flush()
    assert client.delete(f"/api/journals/{source['id']}", headers={'If-Match': '"1"'}).status_code == 204
    target = client.post('/api/journals', json={'journal_kind': 'set', 'journal_date': '2026-10-30',
        'draft_started_at': '2026-10-30T04:00:00+08:00', 'document_schema_version': 1,
        'content_doc': {'type': 'doc', 'content': [{'type': 'paragraph', 'attrs': {'id': target_id},
                        'content': [{'type': 'text', 'text': 'target'}]}]}}).json()
    result = client.post(f"/api/rituals/{source['id']}/copy-content", json={
        'source_revision': 2, 'target_id': target['id'], 'expected_target_revision': 1,
        'copy_id': str(uuid4()), 'selection': [{'node_id': ai_id}],
        'insert_after_node_id': target_id, 'related_revisions': []})
    assert result.status_code == 200
    copied = client.get(f"/api/journals/{target['id']}").json()['content_doc']['content'][1]
    assert copied['type'] == 'aiReply' and copied['attrs']['request_id'] == request_id
    assert copied['attrs']['id'] != ai_id
    assert copied['content'][0]['content'][0]['text'] == 'synthetic AI'
    changed = client.get(f"/api/journals/{target['id']}").json()['content_doc']
    changed['content'][1]['content'][0]['content'][0]['text'] = 'forged'
    assert client.patch(f"/api/journals/{target['id']}", json={
        'expected_revision': 2, 'content_doc': changed, 'document_schema_version': 1,
    }).status_code == 422


def test_replace_rejects_link_without_half_write(api):
    from app.ritual.models import RitualGoalLink
    client, db = api
    source = create(client)
    assert client.delete(f"/api/journals/{source['id']}", headers={'If-Match': '"1"'}).status_code == 204
    target, end = create(client), create(client, 'end')
    db.add(RitualGoalLink(id=uuid4(), set_journal_id=target['id'], end_journal_id=end['id'],
                          goal_id=uuid4(), end_node_id=uuid4()))
    db.flush()
    result = client.post(f"/api/rituals/{source['id']}/restore-replace", headers={'If-Match': '"2"'},
        json={'target_id': target['id'], 'expected_target_revision': 1, 'related_revisions': []})
    assert result.status_code == 409 and result.json()['code'] == 'related_files_changed'
    assert client.get(f"/api/journals/{target['id']}").json()['revision'] == 1
    assert client.get(f"/api/trash/journal/{source['id']}").json()['revision'] == 2
