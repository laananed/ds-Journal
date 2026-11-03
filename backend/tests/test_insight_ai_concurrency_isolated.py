"""Synthetic multi-session tests; runner must use its own disposable schema."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event
from uuid import uuid4
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session
import pytest

from app.ai import client, local, search, writing_requests
from app.ai.client import ModelResult, ModelUsage
from app.ai.models import AIRequest, AICheckpoint, AIUsage
from app.ai.schemas import WritingPrepare
from app.database import engine
from app.insight.models import Insight
from app.insight.service import delete_insight
from app.writing.documents import project_document


@pytest.fixture(autouse=True)
def block_network(monkeypatch):
    with engine.connect() as connection:
        dbname, schema = connection.execute(text('select current_database(), current_schema()')).one()
        assert dbname == 'seekjournal_test_03' and schema.startswith('codex_ai_') and len(schema) == 41
    def blocked(*args, **kwargs):
        raise AssertionError('real model/search calls are forbidden')
    monkeypatch.setattr(client, 'invoke', blocked)
    monkeypatch.setattr(search, 'search_web', blocked)


def new_insight():
    document = {'type': 'doc', 'content': [{'type': 'paragraph', 'attrs': {'id': str(uuid4())},
                'content': [{'type': 'text', 'text': 'synthetic concurrency'}]}]}
    with Session(engine) as db:
        row = Insight(content=project_document(document), content_doc=document)
        db.add(row)
        db.commit()
        return row.id


def test_insight_automatic_same_snapshot_race_deduplicates():
    barrier = Barrier(2)
    file_id = new_insight()
    def prepare(_):
        payload = WritingPrepare(request_id=uuid4(), kind='go_deeper', trigger='automatic',
            source={'type': 'insight', 'id': file_id, 'expected_revision': 1})
        with Session(engine) as db:
            barrier.wait(timeout=10)
            return writing_requests.prepare(db, payload)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(prepare, range(2)))
    assert results[0]['request_id'] == results[1]['request_id']
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(AIRequest).where(
            AIRequest.sources.contains([{'type': 'insight', 'id': file_id}]))) == 1
        assert db.get(Insight, file_id).revision == 2


def test_insight_late_result_after_soft_delete_keeps_usage_not_attachment(monkeypatch):
    entered, release = Event(), Event()
    monkeypatch.setattr(client, 'is_configured', lambda: True)
    def invoke(*args, **kwargs):
        entered.set()
        assert release.wait(10)
        return ModelResult('synthetic late reply', 'synthetic', ModelUsage(7, 3, 10), 'stop')
    monkeypatch.setattr(local, 'model_invoke', invoke)
    file_id, rid = new_insight(), uuid4()
    with Session(engine) as db:
        writing_requests.prepare(db, WritingPrepare(request_id=rid, kind='go_deeper', trigger='manual',
            source={'type': 'insight', 'id': file_id, 'expected_revision': 1}))
    def run():
        with Session(engine) as db:
            return writing_requests.execute(db, rid)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(run)
            assert entered.wait(10)
            with Session(engine) as db:
                assert delete_insight(db, file_id, 2)
            release.set()
            assert future.result(timeout=10)[0]['status'] == 'conflict'
        with Session(engine) as db:
            request = db.get(AIRequest, rid)
            assert request.result['reply'] == 'synthetic late reply'
            assert db.get(AICheckpoint, ('insight', file_id)) is None
            assert db.scalar(select(func.count()).select_from(AIUsage).where(AIUsage.request_id == rid)) == 1
            assert all(node['type'] != 'aiReply' for node in db.get(Insight, file_id).content_doc['content'])
    finally:
        release.set()
