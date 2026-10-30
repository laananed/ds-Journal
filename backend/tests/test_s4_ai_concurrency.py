from concurrent.futures import ThreadPoolExecutor
from datetime import date
from threading import Event, Barrier
from uuid import uuid4
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.ai import client, local, writing_requests
from app.ai.client import ModelResult, ModelUsage
from app.ai.models import AIUsage
from app.ai.schemas import WritingPrepare
from app.journal.models import Journal
from app.writing.documents import project_document
import pytest


@pytest.fixture(autouse=True)
def block_real_model_and_search(monkeypatch):
    from app.ai import search
    def blocked(*args, **kwargs):
        raise AssertionError('real model/search calls are forbidden in this test')
    monkeypatch.setattr(client, 'invoke', blocked)
    monkeypatch.setattr(search, 'search_web', blocked)


def test_two_sessions_claim_once_without_lock_during_model(stage3_engine, monkeypatch):
    entered, release = Event(), Event()
    called = []
    monkeypatch.setattr(client, 'is_configured', lambda: True)
    def invoke(*args, **kwargs):
        called.append(True)
        entered.set()
        assert release.wait(10)
        return ModelResult('synthetic answer', 'synthetic', ModelUsage(7, 3, 10), 'stop')
    monkeypatch.setattr(local, 'model_invoke', invoke)
    doc = {'type':'doc','content':[{'type':'paragraph','attrs':{'id':str(uuid4())},
                                      'content':[{'type':'text','text':'synthetic'}]}]}
    rid = uuid4()
    with Session(stage3_engine) as db:
        row = Journal(journal_date=date(2038,3,3),content=project_document(doc),content_doc=doc)
        db.add(row)
        db.commit()
        journal_id = row.id
        writing_requests.prepare(db, WritingPrepare(request_id=rid,kind='go_deeper',trigger='manual',
            source={'type':'journal','id':journal_id,'expected_revision':1}))
    def invoke_first():
        with Session(stage3_engine) as db:
            return writing_requests.execute(db, rid)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            future = pool.submit(invoke_first)
            assert entered.wait(10)
            with Session(stage3_engine) as second:
                result, status = writing_requests.execute(second, rid)
                assert status == 202 and result['status'] == 'pending'
                row = second.get(Journal, journal_id)
                from copy import deepcopy
                from app.journal.schemas import JournalUpdate
                from app.journal.service import update_journal
                current = deepcopy(row.content_doc)
                current['content'][-1]['content'] = [{'type':'text','text':'continued while waiting'}]
                assert update_journal(second, journal_id, JournalUpdate(expected_revision=2,
                    document_schema_version=1, content_doc=current)).revision == 3
            release.set()
            assert future.result(timeout=10)[0]['status'] == 'ready'
        assert len(called) == 1
        with Session(stage3_engine) as db:
            ledger = db.scalars(select(AIUsage).where(AIUsage.request_id == rid)).all()
            assert len(ledger) == 1 and ledger[0].total_tokens == 10
            assert writing_requests.apply(db,rid,3)['status'] == 'applied'
            from app.ai.models import AICheckpoint
            assert db.get(AICheckpoint,('journal',journal_id)).consumed_user_text == 'synthetic'
            assert db.get(Journal,journal_id).content_doc['content'][-1]['content'][0]['text'] == 'continued while waiting'
    finally:
        release.set()


def test_automatic_two_sessions_create_only_one_request(stage3_engine):
    from sqlalchemy import func
    from app.ai.models import AIRequest
    barrier = Barrier(2)
    doc = {'type':'doc','content':[{'type':'paragraph','attrs':{'id':str(uuid4())},
                                      'content':[{'type':'text','text':'synthetic'}]}]}
    with Session(stage3_engine) as db:
        row = Journal(journal_date=date(2038,3,3),content=project_document(doc),content_doc=doc)
        db.add(row)
        db.commit()
        journal_id = row.id
    def prepare(_):
        payload = WritingPrepare(request_id=uuid4(),kind='go_deeper',trigger='automatic',
                source={'type':'journal','id':journal_id,'expected_revision':1})
        with Session(stage3_engine) as db:
            barrier.wait(timeout=10)
            return writing_requests.prepare(db,payload)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(prepare, range(2)))
    assert results[0]['request_id'] == results[1]['request_id']
    with Session(stage3_engine) as db:
        assert db.scalar(select(func.count()).select_from(AIRequest)) == 1
        assert db.get(Journal,journal_id).revision == 2


def test_late_model_result_after_soft_delete_preserves_usage_without_attachment(stage3_engine, monkeypatch):
    from app.ai.models import AIRequest, AICheckpoint
    from app.journal.service import delete_journal
    entered, release = Event(), Event()
    monkeypatch.setattr(client, 'is_configured', lambda: True)
    def invoke(*args, **kwargs):
        entered.set()
        assert release.wait(10)
        return ModelResult('late result', 'synthetic', ModelUsage(7,3,10), 'stop')
    monkeypatch.setattr(local, 'model_invoke', invoke)
    doc={'type':'doc','content':[{'type':'paragraph','attrs':{'id':str(uuid4())},
          'content':[{'type':'text','text':'synthetic'}]}]}
    rid=uuid4()
    with Session(stage3_engine) as db:
        row=Journal(journal_date=date(2038,3,3),content=project_document(doc),content_doc=doc)
        db.add(row)
        db.commit()
        journal_id=row.id
        writing_requests.prepare(db,WritingPrepare(request_id=rid,kind='go_deeper',trigger='manual',
            source={'type':'journal','id':journal_id,'expected_revision':1}))
    def run():
        with Session(stage3_engine) as db:
            return writing_requests.execute(db,rid)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            future=pool.submit(run)
            assert entered.wait(10)
            with Session(stage3_engine) as db:
                assert delete_journal(db,journal_id,2)
            release.set()
            assert future.result(timeout=10)[0]['status']=='conflict'
        with Session(stage3_engine) as db:
            request=db.get(AIRequest,rid)
            assert request.result['reply']=='late result'
            assert db.get(AICheckpoint,('journal',journal_id)) is None
            ledger=db.scalars(select(AIUsage).where(AIUsage.request_id==rid)).all()
            assert len(ledger)==1 and ledger[0].total_tokens==10
    finally:
        release.set()


def test_timeout_records_unknown_once_and_does_not_retry(stage3_engine, monkeypatch):
    from app.ai.local import LocalError
    from app.ai.models import AIRequest
    monkeypatch.setattr(client, 'is_configured', lambda: True)
    calls=[]
    def invoke(*args, **kwargs):
        calls.append(True)
        raise client.UpstreamTimeout('synthetic timeout')
    monkeypatch.setattr(local,'model_invoke',invoke)
    doc={'type':'doc','content':[{'type':'paragraph','attrs':{'id':str(uuid4())},
          'content':[{'type':'text','text':'synthetic'}]}]}
    rid=uuid4()
    with Session(stage3_engine) as db:
        row=Journal(journal_date=date(2038,3,3),content=project_document(doc),content_doc=doc)
        db.add(row)
        db.commit()
        writing_requests.prepare(db,WritingPrepare(request_id=rid,kind='go_deeper',trigger='manual',
            source={'type':'journal','id':row.id,'expected_revision':1}))
    with Session(stage3_engine) as db:
        try:
            writing_requests.execute(db,rid)
            assert False, 'timeout must report a transport failure'
        except LocalError as error:
            assert error.status_code==504
        result,status=writing_requests.execute(db,rid)
        assert status==200 and result['status']=='failed'
        assert len(calls)==1
        ledger=db.scalars(select(AIUsage).where(AIUsage.request_id==rid)).all()
        assert len(ledger)==1 and ledger[0].metering=='unknown'
        assert db.get(AIRequest,rid).error_category=='timeout'


def test_recovered_unknown_keeps_late_result_and_updates_same_ledger(stage3_engine, monkeypatch):
    from app.ai.models import AIRequest, AICheckpoint
    from app.ai.requests import recover_pending
    entered,release=Event(),Event()
    monkeypatch.setattr(client,'is_configured',lambda:True)
    def invoke(*args,**kwargs):
        entered.set()
        assert release.wait(10)
        return ModelResult('late','synthetic',ModelUsage(7,3,10),'stop')
    monkeypatch.setattr(local,'model_invoke',invoke)
    doc={'type':'doc','content':[{'type':'paragraph','attrs':{'id':str(uuid4())},
          'content':[{'type':'text','text':'synthetic'}]}]}
    rid=uuid4()
    with Session(stage3_engine) as db:
        row=Journal(journal_date=date(2038,3,3),content=project_document(doc),content_doc=doc)
        db.add(row)
        db.commit()
        journal_id=row.id
        writing_requests.prepare(db,WritingPrepare(request_id=rid,kind='go_deeper',trigger='manual',
            source={'type':'journal','id':journal_id,'expected_revision':1}))
    def run():
        with Session(stage3_engine) as db:
            return writing_requests.execute(db,rid)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            future=pool.submit(run)
            assert entered.wait(10)
            with Session(stage3_engine) as db:
                assert recover_pending(db,restart=True)==1
            release.set()
            assert future.result(timeout=10)[0]['status']=='unknown'
        with Session(stage3_engine) as db:
            request=db.get(AIRequest,rid)
            assert request.result['reply']=='late'
            assert db.get(AICheckpoint,('journal',journal_id)) is None
            ledger=db.scalars(select(AIUsage).where(AIUsage.request_id==rid)).all()
            assert len(ledger)==1 and ledger[0].metering=='known' and ledger[0].total_tokens==10
    finally:
        release.set()


def test_apply_storage_failure_rolls_back_to_ready(stage3_engine, monkeypatch):
    from app.ai.models import AIRequest, AICheckpoint
    import pytest
    doc={'type':'doc','content':[{'type':'paragraph','attrs':{'id':str(uuid4())},
          'content':[{'type':'text','text':'synthetic'}]}]}
    rid=uuid4()
    with Session(stage3_engine) as db:
        row=Journal(journal_date=date(2038,3,3),content=project_document(doc),content_doc=doc)
        db.add(row)
        db.commit()
        journal_id=row.id
        writing_requests.prepare(db,WritingPrepare(request_id=rid,kind='go_deeper',trigger='manual',
            source={'type':'journal','id':journal_id,'expected_revision':1}))
        request=db.get(AIRequest,rid)
        request.status='ready'
        request.result={'reply':'already stored'}
        db.commit()
    with Session(stage3_engine) as db:
        monkeypatch.setattr(db,'commit',lambda: (_ for _ in ()).throw(RuntimeError('synthetic commit failure')))
        with pytest.raises(RuntimeError):
            writing_requests.apply(db,rid,2)
        db.rollback()
    with Session(stage3_engine) as db:
        request=db.get(AIRequest,rid)
        assert request.status=='ready' and request.result['reply']=='already stored'
        assert db.get(AICheckpoint,('journal',journal_id)) is None
        assert db.get(Journal,journal_id).revision==2
