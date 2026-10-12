"""Real committed PostgreSQL; synthetic upstream only, owned-row cleanup."""
import json
from datetime import date, timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select, text
from sqlalchemy.orm import Session

from app.ai import client as model_client
from app.ai.models import AIRequest, AIUsage, AICheckpoint
from app.database import engine
from app.journal.models import Journal
from app.inbox.models import Inbox
from app.main import app
from test_ai_local_api import MockTransport


def structured(sources, drafts=0):
    evidence = [{'source': {'type': s['type'], 'id': s['id']}, 'quote': '用户'} for s in sources]
    return {'facts': [{'text': '记录了一件事', 'evidence': evidence}],
            'emotion_hypotheses': [{'text': '可能挂心', 'uncertainty': '证据有限', 'evidence': evidence}],
            'possible_explanations': [],
            'angles': [{'title': title, 'content': '暂时看不出来'} for title in
                       ['事件与情绪', '选择与行为', '认知与关系']],
            'logic_chain': ['事件影响选择'], 'follow_up_questions': ['当时怎么想？'],
            'insight_drafts': [{'title': f'观点{i}', 'viewpoint': f'独立观点{i}',
                                'evidence': evidence, 'content': f'观点{i}及依据'} for i in range(drafts)]}


@pytest.fixture
def review_env(monkeypatch):
    from scripts.prepare_test_db import BUSINESS_TABLES
    def counts():
        with engine.connect() as c:
            return {t: c.scalar(text('select count(*) from ' + t)) for t in BUSINESS_TABLES}
    before = counts()
    owned = []
    requests = set()
    targets = set()
    transport = MockTransport()
    transport.output = {}
    transport.on_call = None
    def post_json(url, payload, headers, timeout, max_bytes):
        transport.calls.append(payload)
        transport.entered.set()
        if transport.on_call:
            transport.on_call()
        if transport.block:
            assert transport.release.wait(10)
        if transport.error:
            raise transport.error
        body = {'id': transport.response_id, 'choices': [{'finish_reason': transport.finish,
                'message': {'content': transport.output if isinstance(transport.output, str)
                            else json.dumps(transport.output, ensure_ascii=False)}}]}
        if transport.usage is not None:
            body['usage'] = transport.usage
        return model_client.TransportResponse(200, json.dumps(body).encode(), 'application/json')
    monkeypatch.setenv('DEEPSEEK_API_KEY', 'synthetic-mock-key')
    monkeypatch.delenv('BRAVE_SEARCH_API_KEY', raising=False)
    monkeypatch.setattr(model_client, 'UrllibTransport', lambda: transport)
    monkeypatch.setattr(transport, 'post_json', post_json)
    def create(kind='journal', day=0, content='用户甲😀', blocks=None):
        from app.writing.service import project_blocks
        model = Journal if kind == 'journal' else Inbox
        with Session(engine) as db:
            row = model(content=project_blocks(blocks) if blocks else content, content_blocks=blocks,
                        **{kind + '_date': date(2026, 10, 1) + timedelta(days=day)})
            db.add(row)
            db.commit()
            owned.append((kind, row.id))
            return {'type': kind, 'id': row.id, 'expected_revision': row.revision}
    http = TestClient(app, raise_server_exceptions=False)
    def generate(sources, request_id=None):
        ident = str(request_id or uuid4())
        requests.add(ident)
        if transport.output == {}:
            transport.output = structured(sources)
        return http.post('/api/ai/reviews', json={'request_id': ident, 'sources': sources})
    def save(request_id, body):
        response = http.post(f'/api/ai/reviews/{request_id}/save', json=body)
        if response.status_code in (200, 201):
            targets.add(response.json()['target']['id'])
        return response
    try:
        yield http, transport, create, generate, save
    finally:
        transport.release.set()
        http.close()
        with Session(engine) as db:
            from uuid import UUID
            ids = [UUID(r) for r in requests]
            rows = db.scalars(select(AIRequest).where(AIRequest.id.in_(ids))).all()
            targets.update(r.saved_target['id'] for r in rows if r.saved_target)
            db.execute(delete(AIUsage).where((AIUsage.request_id.in_(ids)) |
                                             (AIUsage.response_id == transport.response_id)))
            db.execute(delete(AIRequest).where(AIRequest.id.in_(ids)))
            for kind, ident in owned:
                db.execute(delete(AICheckpoint).where(AICheckpoint.file_type == kind,
                                                      AICheckpoint.file_id == ident))
                model = Journal if kind == 'journal' else Inbox
                db.execute(delete(model).where(model.id == ident))
            db.execute(delete(Journal).where(Journal.id.in_(targets)))
            db.commit()
        assert counts() == before


@pytest.mark.parametrize('count,dates,expected', [(1,1,200),(15,7,200),(15,1,200),(16,7,422),(8,8,422),(0,0,422)])
def test_boundaries(review_env, count, dates, expected):
    _, transport, create, generate, _ = review_env
    sources = [create(kind='inbox' if i % 2 else 'journal', day=i % dates) for i in range(count)]
    response = generate(sources)
    assert response.status_code == expected, response.text
    assert len(transport.calls) == (1 if expected == 200 else 0)
    if expected == 200:
        assert response.json()['status'] == 'ready'
        with Session(engine) as db:
            for s in sources:
                assert db.get(AICheckpoint, (s['type'], s['id'])).consumed_user_text == '用户甲😀'


@pytest.mark.parametrize('case,expected', [('duplicate',422),('insight',422),('missing',404),('stale',409),('deleted',404)])
def test_invalid_source_zero_model(review_env, case, expected):
    _, transport, create, generate, _ = review_env
    source = create()
    sources = [source]
    if case == 'duplicate': sources *= 2
    if case == 'insight': source['type'] = 'insight'
    if case == 'missing': source['id'] = 2147483647
    if case == 'stale': source['expected_revision'] += 1
    if case == 'deleted':
        from datetime import datetime, timezone
        with Session(engine) as db:
            db.get(Journal, source['id']).deleted_at = datetime.now(timezone.utc)
            db.commit()
    assert generate(sources).status_code == expected
    assert transport.calls == []


def test_request_replay_and_changed_payload(review_env):
    http,transport,create,generate,_=review_env
    source=create()
    ident=uuid4()
    first=generate([source],ident)
    assert first.status_code==200
    assert generate([source],ident).json()==first.json()
    assert generate([create()],ident).status_code==409
    assert len(transport.calls)==1
    with Session(engine) as db:
        before=db.scalar(select(text('count(*)')).select_from(AIRequest))
    assert http.get('/api/ai/requests/'+str(ident)).status_code==200
    with Session(engine) as db:
        assert db.scalar(select(text('count(*)')).select_from(AIRequest))==before


def test_two_sessions_pending_and_no_transaction_during_http(review_env):
    from concurrent.futures import ThreadPoolExecutor
    http,transport,create,generate,_=review_env
    sources=[create(),create(kind='inbox')]
    transport.output=structured(sources)
    transport.block=True
    ident=uuid4()
    with ThreadPoolExecutor() as pool:
        future=pool.submit(generate,sources,ident)
        try:
            assert transport.entered.wait(5)
            with Session(engine) as db:
                assert db.scalar(text("select count(*) from pg_stat_activity where datname=current_database() "
                                      "and pid<>pg_backend_pid() and xact_start is not null"))==0
                db.execute(text('SET LOCAL lock_timeout = \'500ms\''))
                for source in sources:
                    model=Journal if source['type']=='journal' else Inbox
                    assert db.scalar(select(model).where(model.id==source['id']).with_for_update())
            assert generate(sources,ident).status_code==202
            assert generate([sources[1]]).status_code==409
            assert http.post('/api/ai/local',json={'request_id':str(uuid4()),'source':sources[0],
                                                  'question':'为何'}).status_code==409
            assert len(transport.calls)==1
        finally: transport.release.set()
        assert future.result().json()['status']=='ready'


@pytest.mark.parametrize('field', ['content','title','date','folder','delete'])
def test_generation_source_change_preserves_preview_no_c(review_env,field):
    from concurrent.futures import ThreadPoolExecutor
    http,transport,create,generate,_=review_env
    sources=[create(),create(kind='inbox')]
    transport.output=structured(sources)
    transport.block=True
    with ThreadPoolExecutor() as pool:
        future=pool.submit(generate,sources)
        try:
            assert transport.entered.wait(5)
            with Session(engine) as db:
                row=db.get(Journal,sources[0]['id'])
                if field=='content': row.content='已改正文'
                if field=='title': row.title='改题'
                if field=='date': row.journal_date=date(2026,10,12)
                if field=='folder':
                    from app.folder.models import Folder
                    folder=Folder(name='t08 owned')
                    db.add(folder);db.flush();row.folder_id=folder.id
                if field=='delete':
                    from datetime import datetime,timezone
                    row.deleted_at=datetime.now(timezone.utc)
                row.revision+=1
                db.commit()
        finally: transport.release.set()
        result=future.result().json()
    assert result['status']=='conflict' and result['review'] is not None
    with Session(engine) as db:
        for s in sources: assert db.get(AICheckpoint,(s['type'],s['id'])) is None
        if field=='folder':
            from app.folder.models import Folder
            row=db.get(Journal,sources[0]['id']);ident=row.folder_id;row.folder_id=None
            db.flush();db.execute(delete(Folder).where(Folder.id==ident));db.commit()


@pytest.mark.parametrize('error,expected', [('timeout',504),('invalid',502)])
def test_upstream_error_replay_unknown_or_known_metering(review_env,error,expected):
    from app.ai.client import UpstreamTimeout,UpstreamResponseError
    _,transport,create,generate,_=review_env
    transport.error=UpstreamTimeout('safe') if error=='timeout' else UpstreamResponseError('safe')
    ident=uuid4();source=create()
    first=generate([source],ident)
    assert first.status_code==expected
    if error=='invalid':
        assert 'reduce selected sources' in first.json()['detail']
    response=generate([source],ident).json()
    assert response['status']=='failed' and response['usage']['unknown_subcalls']==1
    assert len(transport.calls)==1
