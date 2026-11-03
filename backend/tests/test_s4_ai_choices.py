from uuid import uuid4
import hashlib
from app.ai.models import AIRequest
from test_insight_ai_writing import insight


def prepare_candidate(client, file):
    request_id = str(uuid4())
    payload = {'request_id': request_id, 'kind': 'minds_comments', 'trigger': 'manual', 'candidate_mode': True,
               'source': {'type': 'insight', 'id': file['id'], 'expected_revision': file['revision']}}
    response = client.post('/api/ai/writing/prepare', json=payload)
    assert response.status_code == 200, response.text
    return request_id


def test_manual_comment_choice_applies_only_selected_candidate(api):
    client, db = api
    file, node = insight(client)
    request_id = prepare_candidate(client, file)
    quote = 'synthetic'
    anchor = {'node_id': node, 'start': 0, 'end': len(quote), 'quote': quote,
              'quote_sha256': hashlib.sha256(quote.encode()).hexdigest()}
    request = db.get(AIRequest, request_id)
    request.status = 'ready'
    request.result = {'comments': [
        {'mind_preset_id': 'gentle_reflection', 'text': 'first synthetic', 'anchor': anchor},
        {'mind_preset_id': 'gentle_reflection', 'text': 'second synthetic', 'anchor': anchor},
    ], 'reply': 'synthetic raw candidates'}
    db.commit()
    missing = client.post(f'/api/ai/writing/{request_id}/apply', json={'expected_revision': 1})
    assert missing.status_code == 422
    chosen = client.post(f'/api/ai/writing/{request_id}/apply', json={'expected_revision': 1, 'selected_comment_index': 1})
    assert chosen.status_code == 200, chosen.text
    comments = client.get(f"/api/insights/{file['id']}/comments").json()
    assert comments['total'] == 1
    assert comments['items'][0]['text'] == 'second synthetic'
    doc = client.get(f"/api/insights/{file['id']}").json()['content_doc']
    blocks = [block for block in doc['content'] if block['type'] == 'aiReply']
    assert len(blocks) == 1 and blocks[0]['content'][0]['content'][0]['text'] == 'second synthetic'
    replay = client.post(f'/api/ai/writing/{request_id}/apply', json={'expected_revision': 1, 'selected_comment_index': 1})
    assert replay.status_code == 200
    other = client.post(f'/api/ai/writing/{request_id}/apply', json={'expected_revision': 1, 'selected_comment_index': 0})
    assert other.status_code == 409
    detail = client.get(f'/api/ai/requests/{request_id}').json()
    assert detail['reply'] is None
    assert len(detail['comments']) == 1


def test_changed_source_does_not_insert_selected_candidate(api):
    client, db = api
    file, node = insight(client)
    request_id = prepare_candidate(client, file)
    quote = 'synthetic'
    anchor = {'node_id': node, 'start': 0, 'end': len(quote), 'quote': quote,
              'quote_sha256': hashlib.sha256(quote.encode()).hexdigest()}
    request = db.get(AIRequest, request_id)
    request.status = 'ready'
    request.result = {'comments': [{'mind_preset_id': 'gentle_reflection', 'text': 'candidate', 'anchor': anchor}]}
    db.commit()
    document = client.get(f"/api/insights/{file['id']}").json()['content_doc']
    document['content'][0]['content'][0]['text'] = 'synthetic changed'
    update = client.patch(f"/api/insights/{file['id']}", json={'expected_revision': 1, 'document_schema_version': 1, 'content_doc': document})
    assert update.status_code == 200, update.text
    response = client.post(f'/api/ai/writing/{request_id}/apply', json={'expected_revision': 2, 'selected_comment_index': 0})
    assert response.status_code == 409
    saved = client.get(f"/api/insights/{file['id']}").json()['content_doc']
    assert all(block['type'] != 'aiReply' for block in saved['content'])
