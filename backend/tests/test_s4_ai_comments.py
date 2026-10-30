import hashlib
from uuid import uuid4
import pytest
from app.writing import documents


@pytest.fixture(autouse=True)
def block_real_model_and_search(monkeypatch):
    from app.ai import client, search
    def blocked(*args, **kwargs):
        raise AssertionError('real model/search calls are forbidden in this test')
    monkeypatch.setattr(client, 'invoke', blocked)
    monkeypatch.setattr(search, 'search_web', blocked)


def anchor(node, text, start, end):
    quote=text[start:end]
    return {'node_id':node,'start':start,'end':end,'quote':quote,
            'quote_sha256':hashlib.sha256(quote.encode()).hexdigest()}


def test_comment_mark_uses_node_and_code_points_and_allows_overlap():
    one,two = str(uuid4()),str(uuid4())
    document={'type':'doc','content':[
        {'type':'paragraph','attrs':{'id':one},'content':[{'type':'text','text':'重复😀重复'}]},
        {'type':'paragraph','attrs':{'id':two},'content':[{'type':'text','text':'重复😀重复'}]}]}
    comment1,comment2 = str(uuid4()),str(uuid4())
    first=documents.add_comment_mark(document,anchor(two,'重复😀重复',0,2),comment1)
    second=documents.add_comment_mark(first,anchor(two,'重复😀重复',1,3),comment2)
    assert 'marks' not in second['content'][0]['content'][0]
    nodes=second['content'][1]['content']
    assert [x['text'] for x in nodes] == ['重','复','😀','重复']
    assert set(nodes[1]['marks'][0]['attrs']['comment_ids']) == {comment1,comment2}
    removed=documents.remove_comment_mark(second,comment1)
    assert removed['content'][1]['content'][1]['marks'][0]['attrs']['comment_ids'] == [comment2]


def test_comment_mark_rejects_changed_anchor_instead_of_finding_duplicate():
    node = str(uuid4())
    document={'type':'doc','content':[{'type':'paragraph','attrs':{'id':node},
              'content':[{'type':'text','text':'新词重复'}]}]}
    with pytest.raises(documents.DocumentError):
        documents.add_comment_mark(document,anchor(node,'重复重复',0,2),str(uuid4()))


def test_apply_comment_binds_only_original_node_and_keeps_invalid_as_unavailable(api):
    from app.ai.models import AIRequest, AICheckpoint
    from app.ritual.models import AIComment
    from sqlalchemy import select
    client,db = api
    first, second, rid = (str(uuid4()) for _ in range(3))
    doc = {'type':'doc','content':[{'type':'paragraph','attrs':{'id':n},
           'content':[{'type':'text','text':'重复😀重复'}]} for n in (first,second)]}
    response = client.post('/api/journals',json={'journal_date':'2026-10-30',
        'document_schema_version':1,'content_doc':doc})
    journal = response.json()
    payload={'request_id':rid,'kind':'minds_comments','trigger':'manual',
        'source':{'type':'journal','id':journal['id'],'expected_revision':1},
        'mind_preset_ids':['gentle_reflection'],'scope':'all'}
    assert client.post('/api/ai/writing/prepare',json=payload).status_code == 200
    request=db.get(AIRequest,rid)
    request.status='ready'
    request.result={'comments':[{'mind_preset_id':'gentle_reflection','text':'first',
                                 'anchor':anchor(second,'重复😀重复',0,2)},
                                {'mind_preset_id':'gentle_reflection','text':'second',
                                 'anchor':anchor(second,'其他重复😀',0,2)}]}
    db.flush()
    result=client.post(f'/api/ai/writing/{rid}/apply',json={'expected_revision':1})
    assert result.status_code == 200, result.text
    comments=db.scalars(select(AIComment).where(AIComment.journal_id==journal['id']).order_by(AIComment.text)).all()
    assert [c.anchor_state for c in comments] == ['available','unavailable']
    saved=client.get(f"/api/journals/{journal['id']}").json()['content_doc']
    assert 'marks' not in saved['content'][0]['content'][0]
    assert saved['content'][1]['content'][0]['marks'][0]['attrs']['comment_ids'] == [str(comments[0].id)]
    assert db.get(AICheckpoint,('journal',journal['id'])) is None
    listed = client.get(f"/api/journals/{journal['id']}/comments")
    assert listed.status_code == 200
    assert len(listed.json()['items']) == 2
    assert client.delete(f"/api/journals/{journal['id']}/comments/{comments[0].id}",
                         headers={'If-Match':'"2"'}).status_code == 204
    saved = client.get(f"/api/journals/{journal['id']}").json()['content_doc']
    assert 'marks' not in saved['content'][1]['content'][0]
    assert client.get(f"/api/journals/{journal['id']}/comments").json()['total'] == 1


def test_minds_execute_one_mocked_call_and_persists_comments(api, monkeypatch):
    import json
    from app.ai import client as model_client, local, writing_requests
    from app.ai.client import ModelResult
    client,db=api
    node,rid=str(uuid4()),str(uuid4())
    doc={'type':'doc','content':[{'type':'paragraph','attrs':{'id':node},
         'content':[{'type':'text','text':'synthetic'}]}]}
    journal=client.post('/api/journals',json={'journal_date':'2026-10-30',
        'document_schema_version':1,'content_doc':doc}).json()
    payload={'request_id':rid,'kind':'minds_comments','trigger':'manual',
        'source':{'type':'journal','id':journal['id'],'expected_revision':1},
        'mind_preset_ids':['gentle_reflection'],'scope':'all'}
    assert client.post('/api/ai/writing/prepare',json=payload).status_code == 200
    body={'comments':[{'mind_preset_id':'gentle_reflection','text':'synthetic comment',
                       'anchor':anchor(node,'synthetic',0,4)}]}
    calls=[]
    monkeypatch.setattr(model_client,'is_configured',lambda: True)
    monkeypatch.setattr(writing_requests,'record_round',lambda *args: None)
    def invoke(*args,**kwargs):
        calls.append(True)
        return ModelResult(json.dumps(body),'synthetic',None,'stop')
    monkeypatch.setattr(local,'model_invoke',invoke)
    response=client.post(f'/api/ai/writing/{rid}/execute')
    assert response.status_code == 200, response.text
    assert response.json()['status'] == 'ready'
    assert client.post(f'/api/ai/writing/{rid}/apply',json={'expected_revision':1}).status_code == 200
    assert len(calls) == 1


def test_edit_lost_anchor_keeps_comment_unavailable(api):
    from app.ai.models import AIRequest
    from app.ritual.models import AIComment
    from sqlalchemy import select
    client,db=api
    node,rid=str(uuid4()),str(uuid4())
    doc={'type':'doc','content':[{'type':'paragraph','attrs':{'id':node},
         'content':[{'type':'text','text':'hello world'}]}]}
    journal=client.post('/api/journals',json={'journal_date':'2026-10-30',
        'document_schema_version':1,'content_doc':doc}).json()
    payload={'request_id':rid,'kind':'minds_comments','trigger':'manual',
        'source':{'type':'journal','id':journal['id'],'expected_revision':1},
        'mind_preset_ids':['gentle_reflection'],'scope':'all'}
    assert client.post('/api/ai/writing/prepare',json=payload).status_code==200
    request=db.get(AIRequest,rid)
    request.status='ready'
    request.result={'comments':[{'mind_preset_id':'gentle_reflection','text':'comment',
                                 'anchor':anchor(node,'hello world',0,5)}]}
    db.flush()
    assert client.post(f'/api/ai/writing/{rid}/apply',json={'expected_revision':1}).status_code==200
    saved=client.get(f"/api/journals/{journal['id']}").json()['content_doc']
    saved['content'][0]['content'][0]['text']='changed'
    response=client.patch(f"/api/journals/{journal['id']}",json={'expected_revision':2,
         'document_schema_version':1,'content_doc':saved})
    assert response.status_code==200, response.text
    comment=db.scalar(select(AIComment).where(AIComment.journal_id==journal['id']))
    db.refresh(comment)
    assert comment.anchor_state=='unavailable'
    assert 'marks' not in response.json()['content_doc']['content'][0]['content'][0]


def test_forged_comment_id_is_rejected_on_another_file(api):
    client,_ = api
    node = str(uuid4())
    doc={'type':'doc','content':[{'type':'paragraph','attrs':{'id':node},
         'content':[{'type':'text','text':'synthetic'}]}]}
    journal=client.post('/api/journals',json={'journal_date':'2026-10-30',
        'document_schema_version':1,'content_doc':doc}).json()
    doc['content'][0]['content'][0]['marks']=[{'type':'mindComment',
        'attrs':{'comment_ids':[str(uuid4())]}}]
    result=client.patch(f"/api/journals/{journal['id']}",json={'expected_revision':1,
        'document_schema_version':1,'content_doc':doc})
    assert result.status_code == 422
    assert client.get(f"/api/journals/{journal['id']}").json()['revision'] == 1


def test_comment_id_inside_nonanchorable_code_block_is_rejected(api):
    client,_=api
    doc={'type':'doc','content':[{'type':'codeBlock','attrs':{'id':str(uuid4())},
         'content':[{'type':'text','text':'synthetic'}]}]}
    journal=client.post('/api/journals',json={'journal_date':'2026-10-30',
        'document_schema_version':1,'content_doc':doc}).json()
    doc['content'][0]['content'][0]['marks']=[{'type':'mindComment','attrs':{'comment_ids':[str(uuid4())]}}]
    response=client.patch(f"/api/journals/{journal['id']}",json={'expected_revision':1,
        'document_schema_version':1,'content_doc':doc})
    assert response.status_code==422


def test_unique_comment_anchor_moves_after_prefix_insertion(api):
    from app.ai.models import AIRequest
    from app.ritual.models import AIComment
    from sqlalchemy import select
    client,db=api
    node,rid=str(uuid4()),str(uuid4())
    doc={'type':'doc','content':[{'type':'paragraph','attrs':{'id':node},
         'content':[{'type':'text','text':'hello world'}]}]}
    journal=client.post('/api/journals',json={'journal_date':'2026-10-30',
        'document_schema_version':1,'content_doc':doc}).json()
    payload={'request_id':rid,'kind':'minds_comments','trigger':'manual',
        'source':{'type':'journal','id':journal['id'],'expected_revision':1},
        'mind_preset_ids':['gentle_reflection'],'scope':'all'}
    assert client.post('/api/ai/writing/prepare',json=payload).status_code==200
    request=db.get(AIRequest,rid)
    request.status='ready'
    request.result={'comments':[{'mind_preset_id':'gentle_reflection','text':'comment',
                                 'anchor':anchor(node,'hello world',6,11)}]}
    db.flush()
    assert client.post(f'/api/ai/writing/{rid}/apply',json={'expected_revision':1}).status_code==200
    saved=client.get(f"/api/journals/{journal['id']}").json()['content_doc']
    saved['content'][0]['content'].insert(0,{'type':'text','text':'new '})
    response=client.patch(f"/api/journals/{journal['id']}",json={'expected_revision':2,
        'document_schema_version':1,'content_doc':saved})
    assert response.status_code==200
    comment=db.scalar(select(AIComment).where(AIComment.journal_id==journal['id']))
    db.refresh(comment)
    assert comment.anchor_state=='available' and comment.anchor['start']==10 and comment.anchor['end']==15


def test_automatic_minds_prompt_is_limited_to_supplied_user_range(api, monkeypatch):
    import json
    from app.ai import client as model_client, local, writing_requests
    from app.ai.client import ModelResult
    client,_=api
    node,rid=str(uuid4()),str(uuid4())
    doc={'type':'doc','content':[{'type':'paragraph','attrs':{'id':node},
         'content':[{'type':'text','text':'old and NEW'}]}]}
    journal=client.post('/api/journals',json={'journal_date':'2026-10-30',
        'document_schema_version':1,'content_doc':doc}).json()
    payload={'request_id':rid,'kind':'minds_comments','trigger':'automatic',
        'source':{'type':'journal','id':journal['id'],'expected_revision':1},
        'mind_preset_ids':['gentle_reflection'],'scope':{'node_id':node,'start':8,'end':11}}
    assert client.post('/api/ai/writing/prepare',json=payload).status_code==200
    monkeypatch.setattr(model_client,'is_configured',lambda:True)
    monkeypatch.setattr(writing_requests,'record_round',lambda *args:None)
    captured=[]
    def invoke(messages,**kwargs):
        captured.extend(messages)
        return ModelResult(json.dumps({'comments':[]}),'synthetic',None,'stop')
    monkeypatch.setattr(local,'model_invoke',invoke)
    result=client.post(f'/api/ai/writing/{rid}/execute')
    assert result.status_code==200, result.text
    content=captured[-1]['content']
    assert 'NEW' in content and 'old and' not in content


def test_minds_anchor_removed_then_retyped_stays_unavailable(api):
    from app.ai.models import AIRequest
    from app.ritual.models import AIComment
    from sqlalchemy import select
    from copy import deepcopy
    client,db=api
    node,rid=str(uuid4()),str(uuid4())
    doc={'type':'doc','content':[{'type':'paragraph','attrs':{'id':node},
         'content':[{'type':'text','text':'repeat'}]}]}
    journal=client.post('/api/journals',json={'journal_date':'2026-10-30',
        'document_schema_version':1,'content_doc':doc}).json()
    payload={'request_id':rid,'kind':'minds_comments','trigger':'manual',
        'source':{'type':'journal','id':journal['id'],'expected_revision':1},
        'mind_preset_ids':['gentle_reflection'],'scope':'all'}
    assert client.post('/api/ai/writing/prepare',json=payload).status_code==200
    altered=deepcopy(doc)
    altered['content'][0]['content'][0]['text']='removed'
    assert client.patch(f"/api/journals/{journal['id']}",json={'expected_revision':1,
        'document_schema_version':1,'content_doc':altered}).status_code==200
    assert client.patch(f"/api/journals/{journal['id']}",json={'expected_revision':2,
        'document_schema_version':1,'content_doc':doc}).status_code==200
    request=db.get(AIRequest,rid)
    request.status='ready'
    request.result={'comments':[{'mind_preset_id':'gentle_reflection','text':'comment',
                                 'anchor':anchor(node,'repeat',0,6)}]}
    db.flush()
    assert client.post(f'/api/ai/writing/{rid}/apply',json={'expected_revision':3}).status_code==200
    comment=db.scalar(select(AIComment).where(AIComment.journal_id==journal['id']))
    assert comment.anchor_state=='unavailable'


def test_automatic_multi_node_scope_is_frozen_and_limits_prompt(api, monkeypatch):
    import json
    from app.ai import client as model_client, local, writing_requests
    from app.ai.client import ModelResult
    client,_=api
    first,second,rid=(str(uuid4()) for _ in range(3))
    doc={'type':'doc','content':[{'type':'paragraph','attrs':{'id':n},
        'content':[{'type':'text','text':text}]} for n,text in ((first,'old NEW'),(second,'more OLD'))]}
    journal=client.post('/api/journals',json={'journal_date':'2026-10-30',
        'document_schema_version':1,'content_doc':doc}).json()
    payload={'request_id':rid,'kind':'minds_comments','trigger':'automatic',
        'source':{'type':'journal','id':journal['id'],'expected_revision':1},
        'mind_preset_ids':['gentle_reflection'],'scope':{'ranges':[
            {'node_id':first,'start':4,'end':7},{'node_id':second,'start':0,'end':4}]}}
    response=client.post('/api/ai/writing/prepare',json=payload)
    assert response.status_code==200, response.text
    monkeypatch.setattr(model_client,'is_configured',lambda:True)
    monkeypatch.setattr(writing_requests,'record_round',lambda *args:None)
    messages=[]
    def invoke(value,**kwargs):
        messages.extend(value)
        return ModelResult(json.dumps({'comments':[]}),'synthetic',None,'stop')
    monkeypatch.setattr(local,'model_invoke',invoke)
    assert client.post(f'/api/ai/writing/{rid}/execute').status_code==200
    content=messages[-1]['content']
    assert 'NEW' in content and 'more' in content
    assert 'old ' not in content and ' OLD' not in content


def test_overlapping_multi_node_ranges_rejected(api):
    client,_=api
    node=str(uuid4())
    doc={'type':'doc','content':[{'type':'paragraph','attrs':{'id':node},
         'content':[{'type':'text','text':'synthetic'}]}]}
    journal=client.post('/api/journals',json={'journal_date':'2026-10-30',
        'document_schema_version':1,'content_doc':doc}).json()
    payload={'request_id':str(uuid4()),'kind':'minds_comments','trigger':'automatic',
        'source':{'type':'journal','id':journal['id'],'expected_revision':1},
        'mind_preset_ids':['gentle_reflection'],'scope':{'ranges':[
            {'node_id':node,'start':0,'end':4},{'node_id':node,'start':3,'end':6}]}}
    assert client.post('/api/ai/writing/prepare',json=payload).status_code==422


def test_minds_omitted_scope_and_presets_use_frozen_defaults(api):
    from app.ai.models import AIRequest
    client,db=api
    node,rid=str(uuid4()),str(uuid4())
    doc={'type':'doc','content':[{'type':'paragraph','attrs':{'id':node},
         'content':[{'type':'text','text':'synthetic'}]}]}
    journal=client.post('/api/journals',json={'journal_date':'2026-10-30',
        'document_schema_version':1,'content_doc':doc}).json()
    payload={'request_id':rid,'kind':'minds_comments','trigger':'manual',
        'source':{'type':'journal','id':journal['id'],'expected_revision':1}}
    response=client.post('/api/ai/writing/prepare',json=payload)
    assert response.status_code==200, response.text
    source=db.get(AIRequest,rid).sources[0]
    assert source['scope']=='all' and source['mind_preset_ids']==['gentle_reflection']
