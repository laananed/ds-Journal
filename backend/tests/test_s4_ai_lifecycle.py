from uuid import uuid4
import pytest
from app.ai.models import AIRequest


@pytest.mark.parametrize('status', ['prepared', 'pending', 'ready'])
def test_soft_delete_invalidates_writing_request_and_keeps_result(api, status):
    client, db = api
    created = client.post('/api/journals', json={'journal_date':'2026-10-30','content':'synthetic'})
    assert created.status_code == 201
    journal = created.json()
    request_id = uuid4()
    db.add(AIRequest(id=request_id, kind='go_deeper', status=status, payload_hash='synthetic',
                     sources=[{'type':'journal','id':journal['id']}], settings={}, result={'reply':'synthetic'}))
    db.flush()
    assert client.delete(f"/api/journals/{journal['id']}", headers={'If-Match':'"1"'}).status_code == 204
    db.expire_all()
    request = db.get(AIRequest, request_id)
    assert request.status == 'conflict'
    assert request.result == {'reply':'synthetic'}
    assert client.post(f"/api/trash/journal/{journal['id']}/restore", headers={'If-Match':'"2"'}).status_code == 200
    db.expire_all()
    assert db.get(AIRequest, request_id).status == 'conflict'


@pytest.mark.parametrize('kind', ['set', 'end'])
def test_replacement_invalidates_target_request(api, kind):
    from test_s4_ritual_api import create
    client, db = api
    source = create(client, kind)
    assert client.delete(f"/api/journals/{source['id']}", headers={'If-Match': '"1"'}).status_code == 204
    target = create(client, kind)
    request_id = uuid4()
    db.add(AIRequest(id=request_id, kind='minds_comments', status='ready', payload_hash='synthetic',
                     sources=[{'type': 'journal', 'id': target['id']}], settings={}, result={'reply': 'synthetic'}))
    db.flush()
    response = client.post(f"/api/rituals/{source['id']}/restore-replace", headers={'If-Match': '"2"'},
                           json={'target_id': target['id'], 'expected_target_revision': 1, 'related_revisions': []})
    assert response.status_code == 200
    db.expire_all()
    assert db.get(AIRequest, request_id).status == 'conflict'
    assert db.get(AIRequest, request_id).result == {'reply': 'synthetic'}
