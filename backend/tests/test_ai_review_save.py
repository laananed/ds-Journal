from sqlalchemy.orm import Session
from app.database import engine
from app.journal.models import Journal
from test_ai_review_api import review_env
from app.ai.models import AIRequest,AICheckpoint
from sqlalchemy import select,func,event
from uuid import UUID
import pytest


def test_new_save_replay_and_payload_conflict(review_env):
    _, _, create, generate, save = review_env
    source = create(kind='journal')
    result = generate([source])
    assert result.status_code == 200, result.text
    ident = result.json()['request_id']
    body = {'markdown':'复盘总结😀','target':{'mode':'new_journal','journal_date':'2026-10-12'}}
    first = save(ident,body)
    assert first.status_code == 201, first.text
    replay = save(ident,body)
    assert replay.status_code == 200
    assert replay.json()['target']['id'] == first.json()['target']['id']
    assert save(ident,{**body,'markdown':'另一份'}).status_code == 409
    with Session(engine) as db:
        row = db.get(Journal,first.json()['target']['id'])
        assert row.revision == 1 and row.content_doc['content'][0]['type'] == 'aiSummary'
        assert row.content_doc['content'][1]['type'] == 'paragraph'


def test_append_preserves_source(review_env):
    _, _, create, generate, save = review_env
    source = create()
    result = generate([source])
    assert result.status_code == 200, result.text
    response = save(result.json()['request_id'], {'markdown':'复盘','target':{'mode':'append_source'}})
    assert response.status_code == 200, response.text
    target = response.json()['target']
    assert target['id'] == source['id'] and target['revision'] == 2
    assert target['content'].startswith('用户甲😀\n\n---')
    assert target['content_blocks'][0]['text'] == '用户甲😀'


@pytest.mark.parametrize('field',['content','title','date','folder','delete','summary'])
def test_save_changed_snapshot_no_target(review_env,field):
    _,_,create,generate,save=review_env
    source=create()
    result=generate([source]).json()
    with Session(engine) as db:
        row=db.get(Journal,source['id'])
        if field=='content':row.content='改后'
        if field=='title':row.title='改题'
        if field=='date':
            from datetime import date
            row.journal_date=date(2026,10,12)
        if field=='delete':
            from datetime import datetime,timezone
            row.deleted_at=datetime.now(timezone.utc)
        if field=='folder':
            # Same revision corruption must also be caught; avoid invalid FK.
            result_folder=None
            from app.folder.models import Folder
            folder=Folder(name='t08 save owned');db.add(folder);db.flush()
            row.folder_id=folder.id;result_folder=folder.id
        if field=='summary':
            from app.writing.service import summary_blocks
            row.content_blocks,row.content=summary_blocks('另一总结',UUID(result['request_id']),None,row.content)
        # Intentionally keep revision to prove field-by-field snapshot checks.
        db.commit()
    response=save(result['request_id'],{'markdown':'复盘','target':{'mode':'new_journal','journal_date':'2026-10-12'}})
    assert response.status_code==409,response.text
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(Journal))==1
        request=db.get(AIRequest,UUID(result['request_id']))
        assert request.status=='conflict' and request.result['review']
        if field=='folder':
            from app.folder.models import Folder
            db.get(Journal,source['id']).folder_id=None;db.flush();db.delete(db.get(Folder,result_folder));db.commit()


@pytest.mark.parametrize('case,expected',[('folder',404),('length',422),('blank',422),('title',422),('date',422),('extra',422)])
def test_invalid_save_rolls_back_ready(review_env,case,expected):
    _,_,create,generate,save=review_env
    result=generate([create(kind='journal')]).json()
    with Session(engine) as db:
        before_ids = set(db.scalars(select(Journal.id)))
    target={'mode':'new_journal','journal_date':'2026-10-12'}
    body={'markdown':'复盘','target':target}
    if case=='folder':target['folder_id']=2147483647
    if case=='length':body['markdown']='😀'*50000
    if case=='blank':body['markdown']=' \n\t'
    if case=='title':target['title']='题'*81
    if case=='date':target.pop('journal_date')
    if case=='extra':body['source']={'type':'journal','id':1}
    assert save(result['request_id'],body).status_code==expected
    with Session(engine) as db:
        assert set(db.scalars(select(Journal.id))) == before_ids
        request=db.get(AIRequest,UUID(result['request_id']))
        assert request.status=='ready' and request.saved_target is None and request.save_payload_hash is None


@pytest.mark.parametrize('kind,count',[('inbox',1),('journal',2)])
def test_append_invalid_target(review_env,kind,count):
    _,_,create,generate,save=review_env
    generated=generate([create(kind=kind) for _ in range(count)])
    if kind == 'inbox':
        assert generated.status_code == 422
        return
    result=generated.json()
    assert save(result['request_id'],{'markdown':'复盘','target':{'mode':'append_source'}}).status_code==422


@pytest.mark.parametrize('mode',['new_journal','append_source'])
def test_two_sessions_double_confirm_creates_once(review_env,mode):
    from concurrent.futures import ThreadPoolExecutor
    _,_,create,generate,save=review_env
    source=create(kind='journal')
    result=generate([source]).json()
    body={'markdown':'复盘','target':{'mode':mode}}
    if mode=='new_journal':body['target']['journal_date']='2026-10-12'
    with ThreadPoolExecutor() as pool:
        futures=[pool.submit(save,result['request_id'],body) for _ in range(2)]
        responses=[f.result() for f in futures]
    assert sorted(r.status_code for r in responses)==([200,201] if mode=='new_journal' else [200,200])
    assert len({r.json()['target']['id'] for r in responses})==1
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(Journal))==(2 if mode=='new_journal' else 1)
        if mode=='append_source':
            row=db.get(Journal,source['id'])
            assert row.revision==2 and len([b for b in row.content_blocks if b['kind']=='ai_summary'])==1


@pytest.mark.parametrize('mode',['new_journal','append_source'])
def test_actual_postgres_fault_zero_half_write(review_env,mode):
    _,_,create,generate,save=review_env
    source=create();result=generate([source]).json()
    target={'mode':mode}
    if mode=='new_journal':target['journal_date']='2026-10-12'
    def fail_request_update(connection,cursor,statement,parameters,context,executemany):
        if statement.startswith('UPDATE ai_requests'):
            # Actual server SQL error after target INSERT/UPDATE has been sent.
            cursor.execute('SELECT 1/0')
    event.listen(engine,'before_cursor_execute',fail_request_update)
    try:
        response=save(result['request_id'],{'markdown':'复盘','target':target})
        assert response.status_code==500,response.text
    finally:event.remove(engine,'before_cursor_execute',fail_request_update)
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(Journal))==1
        row=db.get(Journal,source['id']);assert row.content=='用户甲😀' and row.revision==1
        request=db.get(AIRequest,UUID(result['request_id']))
        assert request.status=='ready' and request.saved_target is None and request.save_payload_hash is None
    assert save(result['request_id'],{'markdown':'复盘','target':target}).status_code==(201 if mode=='new_journal' else 200)


def test_summary_then_new_user_incremental(review_env):
    http,transport,create,generate,save=review_env
    source=create();result=generate([source]).json()
    target=save(result['request_id'],{'markdown':'复盘总结','target':{'mode':'append_source'}}).json()['target']
    blocks=target['content_blocks'];blocks[-1]['text']='新增用户'
    patched=http.patch('/api/journals/'+str(source['id']),json={'content_blocks':blocks,'expected_revision':target['revision']})
    assert patched.status_code==200,patched.text
    transport.output='简短回复'
    local=http.post('/api/ai/local',json={'request_id':str(__import__('uuid').uuid4()),
        'source':{**source,'expected_revision':patched.json()['revision']}})
    assert local.status_code==200,local.text
    messages=str(transport.calls[-1]['messages'])
    assert '新增用户' in messages and '用户甲😀' not in messages and '复盘总结' not in messages
    # Own the local request so the fixture also removes its snapshots/ledger.
    with Session(engine) as db:
        request=db.get(AIRequest,UUID(local.json()['request_id']))
        from sqlalchemy import delete
        from app.ai.models import AIUsage
        db.execute(delete(AIUsage).where(AIUsage.request_id==request.id));db.delete(request);db.commit()


@pytest.mark.parametrize('status',['pending','failed','conflict','unknown'])
def test_nonready_save_rejected(review_env,status):
    _,_,create,generate,save=review_env
    result=generate([create()]).json()
    with Session(engine) as db:
        db.get(AIRequest,UUID(result['request_id'])).status=status;db.commit()
    assert save(result['request_id'],{'markdown':'复盘','target':{'mode':'append_source'}}).status_code==409


def test_projection_limit_exact_codepoints_and_old_source_no_truncation(review_env):
    _,transport,create,generate,save=review_env
    from app.writing.documents import project_document
    from uuid import uuid4
    skeleton={'type':'doc','content':[{'type':'aiSummary','attrs':{'id':str(uuid4()),'request_id':str(uuid4())},
        'content':[{'type':'paragraph','content':[{'type':'text','text':'x'}]}]},
        {'type':'paragraph','attrs':{'id':str(uuid4())}}]}
    overhead=len(project_document(skeleton))-1
    result=generate([create(kind='journal')]).json()
    response=save(result['request_id'],{'markdown':'😀'*(50000-overhead),
            'target':{'mode':'new_journal','journal_date':'2026-10-12'}})
    assert response.status_code==201 and len(response.json()['target']['content'])==50000
    source=create(content='用户'+'x'*49998)
    transport.output={}
    result=generate([source]).json()
    assert save(result['request_id'],{'markdown':'复盘','target':{'mode':'append_source'}}).status_code==422
    with Session(engine) as db:
        row=db.get(Journal,source['id']);assert len(row.content)==50000 and row.content_blocks is None


def test_new_summary_edit_stays_ai_and_noop_until_user_continues(review_env):
    http,transport,create,generate,save=review_env
    result=generate([create(kind='journal')]).json()
    target=save(result['request_id'],{'markdown':'AI总结','target':{'mode':'new_journal',
                                            'journal_date':'2026-10-12'}}).json()['target']
    doc=target['content_doc'];doc['content'][0]['content'][0]['content'][0]['text']='用户编辑的AI总结'
    response=http.patch('/api/journals/'+str(target['id']),json={'expected_revision':1,'content_doc':doc,'document_schema_version':1})
    assert response.status_code==200,response.text
    from uuid import uuid4
    payload={'request_id':str(uuid4()),'kind':'go_deeper','trigger':'manual',
             'source':{'type':'journal','id':target['id'],'expected_revision':2}}
    assert http.post('/api/ai/writing/prepare',json=payload).json()['status']=='noop'
    assert len(transport.calls)==1
    with Session(engine) as db:
        assert db.get(Journal,target['id']).content_doc['content'][0]['type']=='aiSummary'
        assert db.get(AICheckpoint,('journal',target['id'])) is None
