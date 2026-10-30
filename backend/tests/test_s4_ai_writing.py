from uuid import uuid4
import pytest
from app.ai.models import AIRequest


@pytest.fixture(autouse=True)
def block_real_model_and_search(monkeypatch):
    from app.ai import client, search
    def blocked(*args, **kwargs):
        raise AssertionError('real model/search calls are forbidden in this test')
    monkeypatch.setattr(client, 'invoke', blocked)
    monkeypatch.setattr(search, 'search_web', blocked)


def make_doc(client):
    node = str(uuid4())
    result = client.post('/api/journals', json={'journal_date':'2026-10-30',
        'document_schema_version':1, 'content_doc':{'type':'doc','content':[
            {'type':'paragraph','attrs':{'id':node},'content':[{'type':'text','text':'synthetic'}]}]}})
    assert result.status_code == 201
    return result.json()


def test_prepare_freezes_user_text_and_replays_without_second_placeholder(api):
    client, db = api
    journal = make_doc(client)
    rid = str(uuid4())
    payload = {'request_id':rid,'kind':'go_deeper','trigger':'manual',
               'source':{'type':'journal','id':journal['id'],'expected_revision':1}}
    result = client.post('/api/ai/writing/prepare',json=payload)
    assert result.status_code == 200, result.text
    assert result.json()['status'] == 'prepared'
    detail = client.get(f"/api/journals/{journal['id']}").json()
    assert detail['revision'] == 2
    assert [x['type'] for x in detail['content_doc']['content']] == ['paragraph','aiPlaceholder','paragraph']
    row = db.get(AIRequest, rid)
    assert row.sources[0]['user_text'] == 'synthetic'
    assert client.post('/api/ai/writing/prepare',json=payload).status_code == 200
    assert client.get(f"/api/journals/{journal['id']}").json()['revision'] == 2
    assert client.post('/api/ai/writing/prepare',json={**payload,'question':'different'}).status_code == 409


def test_auto_same_snapshot_is_deduplicated_across_request_ids(api):
    client, _ = api
    journal = make_doc(client)
    payload = {'request_id':str(uuid4()),'kind':'minds_comments','trigger':'automatic',
               'source':{'type':'journal','id':journal['id'],'expected_revision':1},
               'mind_preset_ids':['gentle_reflection'],'scope':'all'}
    first = client.post('/api/ai/writing/prepare',json=payload)
    assert first.status_code == 200, first.text
    second = client.post('/api/ai/writing/prepare',json={**payload,'request_id':str(uuid4())})
    assert second.status_code == 200, second.text
    assert second.json()['request_id'] == first.json()['request_id']


@pytest.mark.parametrize('state', ['prepared','failed','conflict','unknown'])
def test_auto_go_deeper_duplicate_after_own_placeholder(api, state):
    client, db = api
    journal = make_doc(client)
    payload = {'request_id':str(uuid4()),'kind':'go_deeper','trigger':'automatic',
               'source':{'type':'journal','id':journal['id'],'expected_revision':1}}
    first = client.post('/api/ai/writing/prepare',json=payload)
    assert first.status_code == 200
    request = db.get(AIRequest,payload['request_id'])
    request.status = state
    db.flush()
    second = client.post('/api/ai/writing/prepare',json={**payload,'request_id':str(uuid4())})
    assert second.status_code == 200, second.text
    assert second.json()['request_id'] == first.json()['request_id']
    assert second.json()['status'] == state
    assert client.get(f"/api/journals/{journal['id']}").json()['revision'] == 2


def test_ready_apply_keeps_continuation_and_advances_only_snapshot(api):
    from app.ai.models import AICheckpoint
    client, db = api
    journal = make_doc(client)
    rid = str(uuid4())
    body = {'request_id':rid,'kind':'go_deeper','trigger':'manual',
            'source':{'type':'journal','id':journal['id'],'expected_revision':1}}
    assert client.post('/api/ai/writing/prepare',json=body).status_code == 200
    row = db.get(AIRequest,rid)
    row.status = 'ready'
    row.result = {'reply':'synthetic response'}
    db.flush()
    detail = client.get(f"/api/journals/{journal['id']}").json()
    doc = detail['content_doc']
    doc['content'][-1]['content'] = [{'type':'text','text':'later text'}]
    assert client.patch(f"/api/journals/{journal['id']}",json={'expected_revision':2,
        'document_schema_version':1,'content_doc':doc}).status_code == 200
    result = client.post(f'/api/ai/writing/{rid}/apply',json={'expected_revision':3})
    assert result.status_code == 200, result.text
    saved = client.get(f"/api/journals/{journal['id']}").json()
    assert saved['content_doc']['content'][-1]['content'][0]['text'] == 'later text'
    assert saved['content_doc']['content'][-2]['type'] == 'aiReply'
    assert db.get(AICheckpoint, ('journal', journal['id'])).consumed_user_text == 'synthetic'
    assert client.post(f'/api/ai/writing/{rid}/apply',json={'expected_revision':3}).status_code == 200
    assert client.get(f"/api/journals/{journal['id']}").json()['revision'] == 4


def test_execute_claims_once_and_replay_does_not_invoke_again(api, monkeypatch):
    from app.ai import client as model_client, local, writing_requests
    from app.ai.client import ModelResult
    client, db = api
    journal = make_doc(client)
    rid = str(uuid4())
    body = {'request_id':rid,'kind':'go_deeper','trigger':'manual',
            'source':{'type':'journal','id':journal['id'],'expected_revision':1}}
    assert client.post('/api/ai/writing/prepare',json=body).status_code == 200
    calls = []
    monkeypatch.setattr(model_client,'is_configured',lambda: True)
    monkeypatch.setattr(writing_requests,'record_round',lambda *args, **kwargs: None, raising=False)
    def invoke(*args, **kwargs):
        calls.append(True)
        return ModelResult('synthetic answer', 'synthetic', None, 'stop')
    monkeypatch.setattr(local,'model_invoke',invoke)
    first = client.post(f'/api/ai/writing/{rid}/execute')
    assert first.status_code == 200, first.text
    assert first.json()['status'] == 'ready'
    assert client.post(f'/api/ai/writing/{rid}/execute').json()['status'] == 'ready'
    assert len(calls) == 1
    assert client.get(f'/api/ai/requests/{rid}').json()['status'] == 'ready'


def test_delete_placeholder_invalidates_request(api):
    client, db = api
    journal = make_doc(client)
    rid = str(uuid4())
    body = {'request_id':rid,'kind':'go_deeper','trigger':'manual',
            'source':{'type':'journal','id':journal['id'],'expected_revision':1}}
    assert client.post('/api/ai/writing/prepare',json=body).status_code == 200
    doc = client.get(f"/api/journals/{journal['id']}").json()['content_doc']
    placeholder = doc['content'][-2]['attrs']['id']
    response = client.delete(f"/api/files/journal/{journal['id']}/ai-blocks/{placeholder}", headers={'If-Match':'"2"'})
    assert response.status_code == 204, response.text
    db.expire_all()
    assert db.get(AIRequest,rid).status == 'conflict'


def test_apply_old_text_change_retains_result_without_advancing_checkpoint(api):
    from app.ai.models import AICheckpoint
    client, db = api
    journal = make_doc(client)
    rid = str(uuid4())
    payload = {'request_id':rid,'kind':'go_deeper','trigger':'manual',
               'source':{'type':'journal','id':journal['id'],'expected_revision':1}}
    assert client.post('/api/ai/writing/prepare',json=payload).status_code == 200
    request = db.get(AIRequest,rid)
    request.status, request.result = 'ready', {'reply':'retained'}
    db.flush()
    doc = client.get(f"/api/journals/{journal['id']}").json()['content_doc']
    doc['content'][0]['content'][0]['text'] = 'changed'
    assert client.patch(f"/api/journals/{journal['id']}",json={'expected_revision':2,
        'document_schema_version':1,'content_doc':doc}).status_code == 200
    assert client.post(f'/api/ai/writing/{rid}/apply',json={'expected_revision':3}).status_code == 409
    db.expire_all()
    assert db.get(AIRequest,rid).status == 'conflict'
    assert db.get(AIRequest,rid).result['reply'] == 'retained'
    assert db.get(AICheckpoint,('journal',journal['id'])) is None


def test_review_matches_structured_document_snapshot(api):
    from app.ai.review import matches
    from app.journal.models import Journal
    from app.writing.documents import user_text_document
    client, db = api
    journal = make_doc(client)
    row = db.get(Journal,journal['id'])
    source = {'type':'journal','id':row.id,'revision':row.revision,
              'user_text':user_text_document(row.content_doc),'document':row.content_doc,
              'title':row.title,'folder_id':row.folder_id,'date':row.journal_date.isoformat()}
    assert matches(row,source)
    source['user_text'] += 'wrong'
    assert not matches(row,source)


def test_save_review_appends_summary_to_document_without_changing_kind(api):
    from app.journal.models import Journal
    from app.writing.documents import user_text_document
    client, db = api
    journal = make_doc(client)
    row = db.get(Journal,journal['id'])
    rid = uuid4()
    source = {'type':'journal','id':row.id,'revision':row.revision,
              'user_text':user_text_document(row.content_doc),'document':row.content_doc,
              'title':row.title,'folder_id':row.folder_id,'date':row.journal_date.isoformat()}
    db.add(AIRequest(id=rid,kind='review',status='ready',payload_hash='synthetic',sources=[source],settings={}))
    db.commit()
    result = client.post(f'/api/ai/reviews/{rid}/save',json={
        'markdown':'synthetic summary','target':{'mode':'append_source'}})
    assert result.status_code == 200, result.text
    saved = client.get(f"/api/journals/{journal['id']}").json()
    assert saved['journal_kind'] == 'writing'
    assert saved['content_doc']['content'][-2]['type'] == 'aiSummary'
    assert user_text_document(saved['content_doc']).startswith('synthetic')


def test_review_rejects_inbox_source_before_model(api):
    client, _ = api
    result = client.post('/api/ai/reviews',json={'request_id':str(uuid4()),
         'sources':[{'type':'inbox','id':1,'expected_revision':1}]})
    assert result.status_code == 422


def test_new_review_target_uses_document_and_writing_kind(api):
    from app.journal.models import Journal
    from app.writing.documents import user_text_document
    client,db = api
    journal = make_doc(client)
    row = db.get(Journal,journal['id'])
    rid=uuid4()
    source={'type':'journal','id':row.id,'revision':row.revision,
            'user_text':user_text_document(row.content_doc),'document':row.content_doc,
            'title':row.title,'folder_id':row.folder_id,'date':row.journal_date.isoformat()}
    db.add(AIRequest(id=rid,kind='review',status='ready',payload_hash='synthetic',sources=[source],settings={}))
    db.commit()
    response=client.post(f'/api/ai/reviews/{rid}/save',json={'markdown':'synthetic summary',
       'target':{'mode':'new_journal','journal_date':'2026-10-30'}})
    assert response.status_code==201, response.text
    target=response.json()['target']
    assert target['journal_kind']=='writing'
    assert target['content_doc']['content'][0]['type']=='aiSummary'


def test_review_and_prepared_writing_are_mutually_exclusive(api):
    client, _ = api
    journal=make_doc(client)
    rid=str(uuid4())
    payload={'request_id':rid,'kind':'go_deeper','trigger':'manual',
             'source':{'type':'journal','id':journal['id'],'expected_revision':1}}
    assert client.post('/api/ai/writing/prepare',json=payload).status_code==200
    result=client.post('/api/ai/reviews',json={'request_id':str(uuid4()),
        'sources':[{'type':'journal','id':journal['id'],'expected_revision':2}]})
    assert result.status_code==409, result.text


def test_expired_pending_recovers_unknown_without_a_new_call(api):
    from datetime import datetime, timedelta, timezone
    from app.ai.models import AIUsage
    from sqlalchemy import select
    client,db=api
    journal=make_doc(client)
    rid=str(uuid4())
    payload={'request_id':rid,'kind':'go_deeper','trigger':'manual',
             'source':{'type':'journal','id':journal['id'],'expected_revision':1}}
    assert client.post('/api/ai/writing/prepare',json=payload).status_code==200
    request=db.get(AIRequest,rid)
    request.status='pending'
    request.started_at=datetime.now(timezone.utc)-timedelta(seconds=121)
    db.commit()
    assert client.get(f'/api/ai/requests/{rid}').json()['status']=='pending'
    response=client.post(f'/api/ai/writing/{rid}/execute')
    assert response.status_code==200 and response.json()['status']=='unknown'
    assert len(db.scalars(select(AIUsage).where(AIUsage.request_id==rid)).all())==1


def test_question_continuation_uses_bounded_prior_dialogue(api, monkeypatch):
    from app.ai import client as model_client, local, writing_requests
    from app.ai.client import ModelResult
    client,db=api
    journal=make_doc(client)
    db.add(AIRequest(id=uuid4(),kind='go_deeper',status='applied',payload_hash='synthetic',
        sources=[{'type':'journal','id':journal['id']}],question='old question',
        result={'reply':'old answer'},settings={}))
    db.commit()
    rid=str(uuid4())
    payload={'request_id':rid,'kind':'go_deeper','trigger':'manual','question':'new question',
             'source':{'type':'journal','id':journal['id'],'expected_revision':1}}
    assert client.post('/api/ai/writing/prepare',json=payload).status_code==200
    monkeypatch.setattr(model_client,'is_configured',lambda: True)
    monkeypatch.setattr(writing_requests,'record_round',lambda *args:None)
    captured=[]
    private_inputs=[]
    original_loop=writing_requests.tool_calls.run_tool_loop
    def capture_loop(*args, **kwargs):
        private_inputs.extend(kwargs['private_texts'])
        return original_loop(*args, **kwargs)
    monkeypatch.setattr(writing_requests.tool_calls,'run_tool_loop',capture_loop)
    def invoke(messages,**kwargs):
        captured.extend(messages)
        return ModelResult('answer','synthetic',None,'stop')
    monkeypatch.setattr(local,'model_invoke',invoke)
    assert client.post(f'/api/ai/writing/{rid}/execute').status_code==200
    assert any(m['content']=='old question' for m in captured)
    assert any(m['content']=='old answer' for m in captured)
    assert 'old question' in private_inputs and 'old answer' in private_inputs


def test_edit_then_restore_old_text_does_not_restore_request_permission(api):
    client,db=api
    journal=make_doc(client)
    rid=str(uuid4())
    payload={'request_id':rid,'kind':'go_deeper','trigger':'manual',
             'source':{'type':'journal','id':journal['id'],'expected_revision':1}}
    assert client.post('/api/ai/writing/prepare',json=payload).status_code==200
    original=client.get(f"/api/journals/{journal['id']}").json()['content_doc']
    from copy import deepcopy
    changed=deepcopy(original)
    changed['content'][0]['content'][0]['text']='changed'
    assert client.patch(f"/api/journals/{journal['id']}",json={'expected_revision':2,
        'document_schema_version':1,'content_doc':changed}).status_code==200
    assert client.patch(f"/api/journals/{journal['id']}",json={'expected_revision':3,
        'document_schema_version':1,'content_doc':original}).status_code==200
    db.expire_all()
    assert db.get(AIRequest,rid).status=='conflict'


def test_unconfigured_execute_keeps_prepared_without_usage(api, monkeypatch):
    from app.ai import client as model_client
    from app.ai.models import AIUsage
    from sqlalchemy import select
    client,db=api
    journal=make_doc(client)
    rid=str(uuid4())
    payload={'request_id':rid,'kind':'go_deeper','trigger':'manual',
             'source':{'type':'journal','id':journal['id'],'expected_revision':1}}
    assert client.post('/api/ai/writing/prepare',json=payload).status_code==200
    monkeypatch.setattr(model_client,'is_configured',lambda:False)
    assert client.post(f'/api/ai/writing/{rid}/execute').status_code==503
    assert client.get(f'/api/ai/requests/{rid}').json()['status']=='prepared'
    assert db.scalars(select(AIUsage).where(AIUsage.request_id==rid)).all()==[]


def test_plain_legacy_can_prepare_without_changing_user_checkpoint(api):
    from app.ai.models import AICheckpoint
    from app.writing.documents import user_text_document
    client,db=api
    journal=client.post('/api/journals',json={'journal_date':'2026-10-30','content':'legacy user text'}).json()
    payload={'request_id':str(uuid4()),'kind':'go_deeper','trigger':'manual',
             'source':{'type':'journal','id':journal['id'],'expected_revision':1}}
    response=client.post('/api/ai/writing/prepare',json=payload)
    assert response.status_code==200, response.text
    saved=client.get(f"/api/journals/{journal['id']}").json()
    assert user_text_document(saved['content_doc']).startswith('legacy user text')
    assert db.get(AICheckpoint,('journal',journal['id'])) is None


def test_stale_auto_plain_legacy_returns_conflict(api):
    client,_=api
    journal=client.post('/api/journals',json={'journal_date':'2026-10-30','content':'legacy user text'}).json()
    payload={'request_id':str(uuid4()),'kind':'go_deeper','trigger':'automatic',
             'source':{'type':'journal','id':journal['id'],'expected_revision':2}}
    assert client.post('/api/ai/writing/prepare',json=payload).status_code==409
