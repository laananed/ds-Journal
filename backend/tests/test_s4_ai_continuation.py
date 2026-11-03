from app.ai.models import AIRequest
from test_insight_ai_writing import insight
from uuid import uuid4


def test_continuation_preview_does_not_change_document_until_accepted(api):
    client, db = api
    file, node = insight(client)
    request_id = str(uuid4())
    before = client.get(f"/api/insights/{file['id']}").json()
    payload = {'request_id': request_id, 'kind': 'go_deeper', 'trigger': 'manual',
               'writing_mode': 'continuation', 'cursor': {'node_id': node, 'offset': 9},
               'source': {'type': 'insight', 'id': file['id'], 'expected_revision': 1}}
    response = client.post('/api/ai/writing/prepare', json=payload)
    assert response.status_code == 200, response.text
    assert response.json()['files'] == []
    assert client.get(f"/api/insights/{file['id']}").json()['content_doc'] == before['content_doc']
    request = db.get(AIRequest, request_id)
    assert request.sources[0]['continuation_context'] == 'synthetic'
    request.status = 'ready'
    request.result = {'reply': ' continuation'}
    db.commit()
    ready = client.get(f'/api/ai/requests/{request_id}').json()
    assert ready['reply'] == ' continuation'
    assert client.get(f"/api/insights/{file['id']}").json()['revision'] == 1
    applied = client.post(f'/api/ai/writing/{request_id}/apply', json={'expected_revision': 1})
    assert applied.status_code == 200, applied.text
    doc = client.get(f"/api/insights/{file['id']}").json()['content_doc']
    assert doc['content'][0] == before['content_doc']['content'][0]
    assert doc['content'][1]['type'] == 'aiReply'
    assert doc['content'][1]['content'][0]['content'][0]['text'] == ' continuation'
    assert client.post(f'/api/ai/writing/{request_id}/apply', json={'expected_revision': 1}).status_code == 200


def test_continuation_rejects_changed_source_without_overwriting(api):
    client, db = api
    file, node = insight(client)
    request_id = str(uuid4())
    payload = {'request_id': request_id, 'kind': 'go_deeper', 'trigger': 'manual',
               'writing_mode': 'continuation', 'cursor': {'node_id': node, 'offset': 9},
               'source': {'type': 'insight', 'id': file['id'], 'expected_revision': 1}}
    assert client.post('/api/ai/writing/prepare', json=payload).status_code == 200
    request = db.get(AIRequest, request_id)
    request.status, request.result = 'ready', {'reply': 'candidate'}
    db.commit()
    document = client.get(f"/api/insights/{file['id']}").json()['content_doc']
    document['content'][0]['content'][0]['text'] = 'synthetic text changed'
    assert client.patch(f"/api/insights/{file['id']}", json={'expected_revision': 1, 'document_schema_version': 1, 'content_doc': document}).status_code == 200
    assert client.post(f'/api/ai/writing/{request_id}/apply', json={'expected_revision': 2}).status_code == 409
    result = client.get(f'/api/ai/requests/{request_id}').json()
    assert result['reply'] == 'candidate' and result['status'] == 'conflict'
    assert all(block['type'] != 'aiReply' for block in client.get(f"/api/insights/{file['id']}").json()['content_doc']['content'])


def test_continuation_remains_ready_when_only_format_changes(api):
    client, db = api
    file, node = insight(client)
    request_id = str(uuid4())
    payload = {'request_id': request_id, 'kind': 'go_deeper', 'trigger': 'manual',
               'writing_mode': 'continuation', 'cursor': {'node_id': node, 'offset': 9},
               'source': {'type': 'insight', 'id': file['id'], 'expected_revision': 1}}
    assert client.post('/api/ai/writing/prepare', json=payload).status_code == 200
    request = db.get(AIRequest, request_id)
    request.status, request.result = 'ready', {'reply': 'candidate'}
    db.commit()
    doc = client.get(f"/api/insights/{file['id']}").json()['content_doc']
    doc['content'][0]['content'][0]['marks'] = [{'type': 'bold'}]
    assert client.patch(f"/api/insights/{file['id']}", json={'expected_revision': 1, 'document_schema_version': 1, 'content_doc': doc}).status_code == 200
    assert client.get(f'/api/ai/requests/{request_id}').json()['status'] == 'ready'
