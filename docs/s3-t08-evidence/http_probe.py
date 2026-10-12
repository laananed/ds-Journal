"""Standalone TCP probe, run from backend; no pytest concurrently.

Owns only the IDs in manifest.json and only its child server on 8031.
No real upstream transport is installed in the child.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from uuid import UUID,uuid4

BACKEND=Path(__file__).resolve().parents[2]/'backend'
sys.path.insert(0,str(BACKEND))
OUT=Path(__file__).resolve().parent


def server():
    from app.ai import client
    from app.main import app
    from app.database import engine
    from sqlalchemy import event
    class Mock:
        def post_json(self,url,payload,headers,timeout,max_bytes):
            sources=json.loads(payload['messages'][-1]['content'].split('\n',1)[1])
            evidence=[{'source':{'type':s['type'],'id':s['id']},'quote':'用户'} for s in sources]
            review={'facts':[{'text':'用户记录','evidence':evidence}],
                    'emotion_hypotheses':[],'possible_explanations':[],
                    'angles':[{'title':t,'content':'暂时看不出来'} for t in
                              ['事件与情绪','选择与行为','认知与关系']],
                    'logic_chain':[],'follow_up_questions':[],'insight_drafts':[]}
            body={'id':'t08-http-'+str(uuid4()),'usage':{'prompt_tokens':10,'completion_tokens':2,'total_tokens':12},
                  'choices':[{'finish_reason':'stop','message':{'content':json.dumps(review,ensure_ascii=False)}}]}
            return client.TransportResponse(200,json.dumps(body).encode(),'application/json')
    client.UrllibTransport=Mock
    pending=[False];injected=[False]
    def fault(connection,cursor,statement,parameters,context,many):
        if statement.startswith('INSERT INTO journals') and 'T08 injected fault' in str(parameters):
            pending[0]=True
        if pending[0] and not injected[0] and statement.startswith('UPDATE ai_requests'):
            injected[0]=True;pending[0]=False
            cursor.execute('SELECT 1/0')
    event.listen(engine,'before_cursor_execute',fault)
    import uvicorn
    uvicorn.run(app,host='127.0.0.1',port=8031,log_level='critical',access_log=False)


def probe():
    from scripts.prepare_test_db import get_test_database_url,BUSINESS_TABLES
    from sqlalchemy import create_engine,text,delete,select
    from sqlalchemy.orm import Session
    # Import models only after supplying the selected isolated URL.
    url=get_test_database_url()
    assert url.database=='seekjournal_test'
    os.environ['DATABASE_URL']=url.render_as_string(hide_password=False)
    from app.ai.models import AIRequest,AIUsage,AICheckpoint
    from app.journal.models import Journal
    from app.inbox.models import Inbox
    engine=create_engine(url)
    def snapshot():
        with engine.connect() as c:
            return {'database':c.scalar(text('select current_database()')),
                    'revision':c.scalar(text('select version_num from alembic_version')),
                    'other_connections':c.scalar(text('select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()')),
                    'tables':{t:c.scalar(text('select count(*) from '+t)) for t in BUSINESS_TABLES}}
    before=snapshot()
    assert before['revision']=='3aa16300a58a' and before['other_connections']==0
    assert all(v==0 for v in before['tables'].values())
    engine.dispose()
    with socket.socket() as s:s.bind(('127.0.0.1',8031))
    manifest={'inboxes':[],'journals':[],'requests':[]}
    evidence={'before':before,'checks':[]}
    def remember(): (OUT/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    def request(method,path,payload=None):
        body=json.dumps(payload).encode() if payload is not None else None
        req=urllib.request.Request('http://127.0.0.1:8031'+path,data=body,method=method,
                                   headers={'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(req,timeout=15) as r:
                raw=r.read();return r.status,json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            raw=e.read()
            try:result=json.loads(raw)
            except ValueError:result={'detail':'server error'}
            return e.code,result
    env=dict(os.environ);env['DEEPSEEK_API_KEY']='synthetic-http-key';env['BRAVE_SEARCH_API_KEY']=''
    env['PYTHONDONTWRITEBYTECODE']='1'
    log=open(OUT/'http-server.log','w',encoding='utf-8')
    process=subprocess.Popen([sys.executable,'-B',str(Path(__file__).resolve()),'--server'],
            cwd=BACKEND,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT)
    try:
        for _ in range(100):
            assert process.poll() is None,'owned server exited'
            try:
                if request('GET','/api/health')[0]==200:break
            except OSError:time.sleep(.1)
        else:raise AssertionError('server readiness timeout')
        def generate():
            status,source=request('POST','/api/inboxes',{'content':'用户HTTP合成文本😀','inbox_date':'2026-10-12'})
            assert status==201
            manifest['inboxes'].append(source['id']);remember()
            ident=str(uuid4());manifest['requests'].append(ident);remember()
            status,result=request('POST','/api/ai/reviews',{'request_id':ident,'sources':[
                {'type':'inbox','id':source['id'],'expected_revision':source['revision']}]})
            assert status==200 and result['status']=='ready'
            with Session(engine) as db:
                assert db.get(AICheckpoint,('inbox',source['id'])).consumed_user_text==source['content']
                assert db.get(Inbox,source['id']).content==source['content']
            engine.dispose()
            return ident
        ident=generate()
        body={'markdown':'真实HTTP复盘😀','target':{'mode':'new_journal','journal_date':'2026-10-12'}}
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(2) as pool:
            futures=[pool.submit(request,'POST',f'/api/ai/reviews/{ident}/save',body) for _ in range(2)]
            responses=[f.result() for f in futures]
        assert sorted(r[0] for r in responses)==[200,201]
        ids={r[1]['target']['id'] for r in responses};assert len(ids)==1
        manifest['journals'].extend(ids);remember()
        # Discard prior success responses, then query and retry the same body.
        status,replay=request('POST',f'/api/ai/reviews/{ident}/save',body)
        assert status==200 and replay['target']['id'] in ids
        assert request('GET','/api/ai/requests/'+ident)[1]['status']=='applied'
        with Session(engine) as db:
            row=db.get(Journal,next(iter(ids)));r=db.get(AIRequest,UUID(ident))
            assert row.content_blocks[0]['text']==body['markdown'] and row.revision==1
            assert r.saved_target['id']==row.id and r.save_payload_hash
        engine.dispose()
        evidence['checks'].append({'double_confirm_statuses':sorted(r[0] for r in responses),
                                   'same_target':True,'lost_response_replay':200,'db_atomic_applied':True})
        failed_id=generate()
        fault_body={'markdown':'故障事务总结','target':{'mode':'new_journal',
                    'journal_date':'2026-10-12','title':'T08 injected fault'}}
        status,_=request('POST',f'/api/ai/reviews/{failed_id}/save',fault_body);assert status==500
        with Session(engine) as db:
            assert not list(db.scalars(select(Journal.id).where(Journal.title=='T08 injected fault')))
            row=db.get(AIRequest,UUID(failed_id));assert row.status=='ready' and row.saved_target is None and row.save_payload_hash is None
        engine.dispose()
        status,retry=request('POST',f'/api/ai/reviews/{failed_id}/save',fault_body)
        assert status==201;manifest['journals'].append(retry['target']['id']);remember()
        evidence['checks'].append({'actual_postgres_fault_http':500,'zero_half_write':True,'same_body_retry':201})
    finally:
        process.terminate()
        try:process.wait(timeout=10)
        except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
        log.close()
        with Session(engine) as db:
            ids=[UUID(r) for r in manifest['requests']]
            rows=db.scalars(select(AIRequest).where(AIRequest.id.in_(ids))).all()
            manifest['journals']=list(set(manifest['journals'])|{r.saved_target['id'] for r in rows if r.saved_target})
            remember()
            db.execute(delete(AIUsage).where(AIUsage.request_id.in_(ids)))
            db.execute(delete(AIRequest).where(AIRequest.id.in_(ids)))
            db.execute(delete(AICheckpoint).where(AICheckpoint.file_type=='inbox',AICheckpoint.file_id.in_(manifest['inboxes'])))
            db.execute(delete(Journal).where(Journal.id.in_(manifest['journals'])))
            db.execute(delete(Inbox).where(Inbox.id.in_(manifest['inboxes'])))
            db.commit()
        engine.dispose()
        after=snapshot();engine.dispose()
        evidence['after']=after;evidence['server_exit']=process.returncode
        assert after==before
        with socket.socket() as s:s.bind(('127.0.0.1',8031))
        evidence['port_8031_released']=True
        (OUT/'http-db-evidence.json').write_text(json.dumps(evidence,indent=2),encoding='utf-8')
    print(json.dumps(evidence))


if __name__=='__main__':
    if '--server' in sys.argv:server()
    else:probe()
