from uuid import uuid4
from sqlalchemy.orm import Session
from app.ai.models import AICheckpoint
from app.database import engine
from test_ai_review_api import review_env, structured
import pytest


def test_review_full_user_only_stable_drafts(review_env):
    http, transport, create, generate, _ = review_env
    blocks = [{'id':str(uuid4()),'kind':'user','text':'用户甲😀'},
              {'id':str(uuid4()),'kind':'ai_reply','text':'排除蓝块','request_id':str(uuid4())},
              {'id':str(uuid4()),'kind':'ai_summary','text':'排除总结','request_id':str(uuid4())}]
    source = create(blocks=blocks)
    transport.output = structured([source], 2)
    response = generate([source])
    assert response.status_code == 200, response.text
    review = response.json()['review']
    assert len(review['insight_drafts']) == 2
    assert len({d['draft_id'] for d in review['insight_drafts']}) == 2
    assert http.get('/api/ai/requests/'+response.json()['request_id']).json()['review'] == review
    payload = str(transport.calls[0]['messages'])
    assert '用户甲😀' in payload and '排除蓝块' not in payload and '排除总结' not in payload


def test_forged_quote_fails_without_checkpoint(review_env):
    _, transport, create, generate, _ = review_env
    source = create()
    transport.output = structured([source])
    transport.output['facts'][0]['evidence'][0]['quote'] = '伪造正文'
    result = generate([source]).json()
    assert result['status'] == 'failed'
    assert result['usage']['total_tokens'] == 12
    with Session(engine) as db:
        assert db.get(AICheckpoint, ('journal',source['id'])) is None


@pytest.mark.parametrize('case', ['foreign_source','ai_quote','angles','json','extra','truncated'])
def test_invalid_outputs_never_advance(review_env,case):
    _, transport, create, generate, _ = review_env
    source = create()
    output = structured([source])
    if case=='foreign_source': output['facts'][0]['evidence'][0]['source']['id'] += 9999
    if case=='ai_quote': output['facts'][0]['evidence'][0]['quote'] = 'AI 回复'
    if case=='angles': output['angles'][1]['title'] = '认知与关系'
    if case=='extra': output['instruction'] = 'write database'
    if case=='json': output = '{bad json'
    if case=='truncated': transport.finish='length'
    transport.output = output
    response = generate([source])
    assert response.status_code==200,response.text
    assert response.json()['status']=='failed'
    assert response.json()['usage']['total_tokens']==12
    assert len(transport.calls)==1
    with Session(engine) as db:
        assert db.get(AICheckpoint,('journal',source['id'])) is None
        if case=='truncated':
            from app.ai.models import AIRequest
            from uuid import UUID
            row=db.get(AIRequest,UUID(response.json()['request_id']))
            assert row.result.get('raw_review') is not None
            assert response.json()['review'] is not None


def test_unknown_metering_ready_zero_drafts(review_env):
    _,transport,create,generate,_ = review_env
    transport.usage = None
    response = generate([create()]).json()
    assert response['status']=='ready'
    assert response['usage']['unknown_subcalls']==1
    assert response['usage']['total_tokens']==0
    assert response['review']['insight_drafts']==[]


def test_full_750000_user_codepoints_are_sent(review_env):
    _,transport,create,generate,_ = review_env
    sources=[create(content='用户'+('😀'*49998),day=i%7) for i in range(15)]
    response=generate(sources)
    assert response.status_code==200,response.text
    import json
    captured=json.loads(transport.calls[0]['messages'][-1]['content'].split('\n',1)[1])
    assert sum(len(s['user_text']) for s in captured)==750000
    assert transport.calls[0]['max_tokens']==4096


def test_ready_checkpoint_fault_rolls_back_every_source(review_env):
    from sqlalchemy import event
    from app.ai.models import AIRequest
    from uuid import UUID
    _,transport,create,generate,_=review_env
    sources=[create(),create(kind='inbox')]
    seen=[]
    def failure(connection,cursor,statement,parameters,context,many):
        if statement.startswith('INSERT INTO ai_checkpoints'):
            seen.append(statement)
            cursor.execute('SELECT 1/0')
    event.listen(engine,'before_cursor_execute',failure)
    try: response=generate(sources)
    finally:event.remove(engine,'before_cursor_execute',failure)
    assert response.status_code==200,response.text
    assert response.json()['status']=='failed' and response.json()['error']['category']=='storage'
    assert response.json()['review'] is not None and response.json()['usage']['total_tokens']==12
    assert seen
    with Session(engine) as db:
        for s in sources:assert db.get(AICheckpoint,(s['type'],s['id'])) is None
        assert db.get(AIRequest,UUID(response.json()['request_id'])).status=='failed'


def test_recovered_review_late_result_only_upgrades_usage(review_env):
    from concurrent.futures import ThreadPoolExecutor
    from datetime import datetime,timedelta,timezone
    from app.ai.requests import recover_pending
    from app.ai.models import AIRequest,AIUsage
    from uuid import UUID
    http,transport,create,generate,_=review_env
    source=create();transport.block=True
    with ThreadPoolExecutor() as pool:
        future=pool.submit(generate,[source])
        try:
            assert transport.entered.wait(5)
            with Session(engine) as db:
                request=db.query(AIRequest).filter(AIRequest.status=='pending').one()
                ident=request.id;request.created_at=datetime.now(timezone.utc)-timedelta(seconds=121);db.commit()
                assert recover_pending(db)==1
            assert http.get('/api/ai/requests/'+str(ident)).json()['status']=='unknown'
        finally:transport.release.set()
        response=future.result().json()
    assert response['status']=='unknown' and response['review']
    assert response['usage']['total_tokens']==12 and response['usage']['unknown_subcalls']==0
    with Session(engine) as db:
        assert db.get(AICheckpoint,('journal',source['id'])) is None
        assert db.query(AIUsage).filter(AIUsage.request_id==ident).count()==1


def test_review_tool_rounds_use_same_privacy_and_ledger(review_env,monkeypatch):
    import json
    from app.ai import client,search
    _,transport,create,generate,_=review_env
    source=create(content='用户原文不能发送的十二个字私密内容')
    monkeypatch.setenv('BRAVE_SEARCH_API_KEY','synthetic-search')
    original=transport.post_json
    count=[0]
    def tool_transport(url,payload,headers,timeout,max_bytes):
        if count[0]==0:
            count[0]+=1;transport.calls.append(payload)
            body={'id':transport.response_id,'usage':transport.usage,'choices':[{'finish_reason':'tool_calls',
                'message':{'content':None,'tool_calls':[{'id':'call-review','type':'function','function':
                {'name':'web_search','arguments':json.dumps({'public_query':'用户原文不能发送的十二个字私密内容'})}}]}}]}
            return client.TransportResponse(200,json.dumps(body).encode(),'application/json')
        return original(url,payload,headers,timeout,max_bytes)
    monkeypatch.setattr(transport,'post_json',tool_transport)
    def no_outbound(*args,**kwargs):raise AssertionError('private query reached network')
    monkeypatch.setattr(search.UrllibSearchTransport,'get_json',no_outbound)
    response=generate([source]).json()
    assert response['status']=='ready' and response['web_status']=='blocked'
    assert response['usage']['total_tokens']==24 and response['usage']['search_requests']==0
    assert len(transport.calls)==2 and transport.calls[0]['tools']


def test_hard_delete_during_review_never_recreates_private_request(review_env):
    from concurrent.futures import ThreadPoolExecutor
    from app.ai.models import AIRequest,AIUsage
    from uuid import UUID
    http,transport,create,generate,_=review_env
    sources=[create(kind='inbox'),create()]
    transport.block=True
    with ThreadPoolExecutor() as pool:
        future=pool.submit(generate,sources)
        try:
            assert transport.entered.wait(5)
            with Session(engine) as db:
                request=db.query(AIRequest).filter(AIRequest.status=='pending').one()
                ident=request.id
            response=http.delete('/api/inboxes/'+str(sources[0]['id']),headers={'If-Match':'"1"'})
            assert response.status_code==204,response.text
        finally:transport.release.set()
        assert future.result().status_code==404
    with Session(engine) as db:
        assert db.get(AIRequest,ident) is None
        assert db.get(AICheckpoint,('journal',sources[1]['id'])) is None
        usage=db.query(AIUsage).filter(AIUsage.response_id==transport.response_id).one()
        assert usage.request_id is None and usage.total_tokens==12


def test_truncated_tool_round_stops_without_search_or_second_model(review_env,monkeypatch):
    import json
    from app.ai import client,search
    _,transport,create,generate,_=review_env
    source=create();monkeypatch.setenv('BRAVE_SEARCH_API_KEY','synthetic-search')
    original=transport.post_json
    count=[0]
    def tool_transport(url,payload,headers,timeout,max_bytes):
        if count[0]==0:
            count[0]+=1;transport.calls.append(payload)
            body={'id':transport.response_id,'usage':transport.usage,'choices':[{'finish_reason':'length',
                'message':{'content':'','tool_calls':[{'id':'partial-call','type':'function','function':
                {'name':'web_search','arguments':json.dumps({'public_query':'公开定义'})}}]}}]}
            return client.TransportResponse(200,json.dumps(body).encode(),'application/json')
        return original(url,payload,headers,timeout,max_bytes)
    monkeypatch.setattr(transport,'post_json',tool_transport)
    searched=[]
    def fake_search(query,**kwargs):
        searched.append(query)
        return search.SearchOutcome(status='failed',query=query,results=(),requests=1,reason='synthetic')
    monkeypatch.setattr(search,'search_web',fake_search)
    response=generate([source])
    assert response.status_code==200,response.text
    assert response.json()['status']=='failed' and response.json()['error']['category']=='truncated'
    assert len(transport.calls)==1 and searched==[]
    assert response.json()['usage']['total_tokens']==12
