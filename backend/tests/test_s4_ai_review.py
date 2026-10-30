import json
from datetime import date, timedelta
from uuid import uuid4
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.ai import client, review
from app.ai.client import ModelResult, ModelUsage
from app.ai.models import AICheckpoint, AIUsage
from app.ai.review_save import save_review
from app.ai.schemas import ReviewRequest, ReviewSave
from app.journal.models import Journal
from app.writing.documents import project_document


@pytest.fixture(autouse=True)
def block_network(monkeypatch):
    from app.ai import search
    def blocked(*args, **kwargs):
        raise AssertionError('real model/search calls are forbidden')
    monkeypatch.setattr(client,'invoke',blocked)
    monkeypatch.setattr(search,'search_web',blocked)


def test_review_15_sources_seven_dates_and_save_once(stage3_engine, monkeypatch):
    rid=uuid4()
    with Session(stage3_engine) as db:
        ids=[]
        for i in range(15):
            doc={'type':'doc','content':[{'type':'paragraph','attrs':{'id':str(uuid4())},
                 'content':[{'type':'text','text':'synthetic'}]}]}
            row=Journal(journal_date=date(2038,3,1)+timedelta(days=i%7),
                        content=project_document(doc),content_doc=doc)
            db.add(row)
            db.flush()
            ids.append(row.id)
        db.commit()
    evidence=[{'source':{'type':'journal','id':i},'quote':'synthetic'} for i in ids]
    result={'facts':[{'text':'synthetic fact','evidence':evidence}],
        'emotion_hypotheses':[],'possible_explanations':[],
        'angles':[{'title':title,'content':'synthetic'} for title in ['事件与情绪','选择与行为','认知与关系']],
        'logic_chain':[],'follow_up_questions':[],'insight_drafts':[]}
    calls=[]
    def invoke(*args,**kwargs):
        calls.append(True)
        return ModelResult(json.dumps(result,ensure_ascii=False),'synthetic',ModelUsage(8,4,12),'stop')
    monkeypatch.setattr(client,'is_configured',lambda:True)
    monkeypatch.setattr(client,'invoke',invoke)
    payload=ReviewRequest(request_id=rid,sources=[{'type':'journal','id':i,'expected_revision':1} for i in ids])
    with Session(stage3_engine) as db:
        response,status=review.execute_review(db,payload)
        assert status==200 and response['status']=='ready'
        assert len(calls)==1
        for i in ids:
            assert db.get(AICheckpoint,('journal',i)).consumed_user_text=='synthetic'
        assert len(db.scalars(select(AIUsage).where(AIUsage.request_id==rid)).all())==1
        save=ReviewSave(markdown='synthetic summary',target={'mode':'new_journal','journal_date':'2038-03-08'})
        first,status=save_review(db,rid,save)
        assert status==201 and first['target']['content_doc']['content'][0]['type']=='aiSummary'
        again,status=save_review(db,rid,save)
        assert status==200 and again['target']['id']==first['target']['id']


def test_review_eight_dates_rejected_without_model(stage3_engine, monkeypatch):
    from app.writing.service import WritingError
    monkeypatch.setattr(client,'is_configured',lambda:True)
    sources=[]
    with Session(stage3_engine) as db:
        for i in range(8):
            doc={'type':'doc','content':[{'type':'paragraph','attrs':{'id':str(uuid4())},
                 'content':[{'type':'text','text':'synthetic'}]}]}
            row=Journal(journal_date=date(2038,3,1)+timedelta(days=i),
                        content=project_document(doc),content_doc=doc)
            db.add(row)
            db.flush()
            sources.append({'type':'journal','id':row.id,'expected_revision':1})
        db.commit()
        with pytest.raises(WritingError):
            review.execute_review(db,ReviewRequest(request_id=uuid4(),sources=sources))
