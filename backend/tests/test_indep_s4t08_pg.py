"""Independent S04-T08 PG tests on a private schema with real multi-session access.

Synthetic data only. The fixture provides an Alembic-upgraded private schema in
seekjournal_test_03 and drops it afterwards; public tables are snapshot-checked.
Model/search transports are blocked; individual tests install fakes.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from threading import Event, Barrier
from uuid import UUID, uuid4

import pytest

from app.ai import client, local, review, search, writing_requests
from app.ai.client import ModelResult, ModelUsage
from app.ai.models import AIRequest, AIUsage, AICheckpoint
from app.ai.schemas import WritingPrepare
from app.journal.models import Journal
from app.ritual.models import AIComment
from app.writing.documents import project_document
from sqlalchemy import func, select
from sqlalchemy.orm import Session


@pytest.fixture(autouse=True)
def block_real_transports(monkeypatch):
    def blocked(*args, **kwargs):
        raise AssertionError('real model/search transport is forbidden in independent tests')

    monkeypatch.setattr(client, 'invoke', blocked)
    monkeypatch.setattr(local, 'model_invoke', blocked)
    monkeypatch.setattr(search, 'search_web', blocked)


def make_row(db, text='synthetic'):
    doc = {'type': 'doc', 'content': [
        {'type': 'paragraph', 'attrs': {'id': str(uuid4())},
         'content': [{'type': 'text', 'text': text}]}]}
    row = Journal(journal_date=date(2038, 3, 3), content=project_document(doc), content_doc=doc)
    db.add(row)
    db.commit()
    return row.id


def prepare(db, journal_id, revision=1, rid=None, **extra):
    return writing_requests.prepare(db, WritingPrepare(
        request_id=rid or uuid4(), kind='go_deeper', trigger='manual',
        source={'type': 'journal', 'id': journal_id, 'expected_revision': revision}, **extra))


def fake_model(monkeypatch, text='synthetic answer', usage=(7, 3, 10)):
    calls = []

    def invoke(*args, **kwargs):
        calls.append(args)
        return ModelResult(text, 'synthetic-response',
                           ModelUsage(*usage) if usage else None, 'stop')

    monkeypatch.setattr(client, 'is_configured', lambda: True)
    monkeypatch.setattr(local, 'model_invoke', invoke)
    return calls


def test_two_sessions_claim_once_and_editing_continues_during_model_wait(stage3_engine, monkeypatch):
    entered, release = Event(), Event()
    monkeypatch.setattr(client, 'is_configured', lambda: True)

    def invoke(*args, **kwargs):
        entered.set()
        assert release.wait(15)
        return ModelResult('synthetic answer', 'rid', ModelUsage(7, 3, 10), 'stop')

    monkeypatch.setattr(local, 'model_invoke', invoke)
    with Session(stage3_engine) as db:
        jid = make_row(db)
        result = prepare(db, jid)
        rid = UUID(result["request_id"])
    assert result['status'] == 'prepared'

    def run():
        with Session(stage3_engine) as session:
            return writing_requests.execute(session, rid)

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            future = pool.submit(run)
            assert entered.wait(15), 'model was never reached'
            with Session(stage3_engine) as second:
                replay, status = writing_requests.execute(second, rid)
                assert status == 202 and replay['status'] == 'pending'
                # The upstream call holds no database lock: editing proceeds.
                row = second.get(Journal, jid)
                from copy import deepcopy
                from app.journal.schemas import JournalUpdate
                from app.journal.service import update_journal
                document = deepcopy(row.content_doc)
                document['content'][-1]['content'] = [{'type': 'text', 'text': 'typed while waiting'}]
                assert update_journal(second, jid, JournalUpdate(
                    expected_revision=2, document_schema_version=1,
                    content_doc=document)).revision == 3
            release.set()
            outcome, status = future.result(timeout=15)
            assert status == 200 and outcome['status'] == 'ready'
        with Session(stage3_engine) as db:
            ledger = db.scalars(select(AIUsage).where(AIUsage.request_id == rid)).all()
            assert len(ledger) == 1 and ledger[0].total_tokens == 10
            assert writing_requests.apply(db, rid, 3)['status'] == 'applied'
            saved = db.get(Journal, jid)
            assert saved.content_doc['content'][-1]['content'][0]['text'] == 'typed while waiting'
            assert saved.content_doc['content'][-2]['type'] == 'aiReply'
            assert db.get(AICheckpoint, ('journal', jid)).consumed_user_text == 'synthetic'
    finally:
        release.set()


def test_concurrent_applies_attach_exactly_once(stage3_engine, monkeypatch):
    fake_model(monkeypatch)
    with Session(stage3_engine) as db:
        jid = make_row(db)
        result = prepare(db, jid)
        rid = UUID(result["request_id"])
        assert writing_requests.execute(db, rid)[0]['status'] == 'ready'
    barrier = Barrier(2)
    errors = []

    def run(_):
        with Session(stage3_engine) as session:
            barrier.wait(timeout=10)
            try:
                return writing_requests.apply(session, rid, 2)
            except Exception as error:  # noqa: BLE001 - recorded below
                errors.append(error)
                return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(run, range(2)))
    with Session(stage3_engine) as db:
        saved = db.get(Journal, jid)
        replies = [item for item in saved.content_doc['content'] if item['type'] == 'aiReply']
        assert len(replies) == 1, 'double apply must not insert a second reply'
        assert saved.revision == 3
        assert db.get(AICheckpoint, ('journal', jid)).consumed_user_text == 'synthetic'
        applied = [item for item in outcomes if item is not None]
        assert len(applied) >= 1 and len(errors) <= 1
        assert all(item['status'] == 'applied' for item in applied)


def test_over_limit_returns_429_and_keeps_prepared(stage3_engine, monkeypatch):
    from app.ai.local import LocalError, _slots
    fake_model(monkeypatch)
    with Session(stage3_engine) as db:
        jid = make_row(db)
        result = prepare(db, jid)
        rid = UUID(result["request_id"])
    assert _slots.acquire() and _slots.acquire()
    try:
        with Session(stage3_engine) as db:
            try:
                writing_requests.execute(db, rid)
                raise AssertionError('over-limit must fail')
            except LocalError as error:
                assert error.status_code == 429
        with Session(stage3_engine) as db:
            assert db.get(AIRequest, rid).status == 'prepared'
            assert db.scalar(select(func.count()).select_from(AIUsage)) == 0
    finally:
        _slots.release()
        _slots.release()


def test_model_timeout_records_single_unknown_subcall(stage3_engine, monkeypatch):
    fake_model(monkeypatch)
    calls = []

    def invoke(*args, **kwargs):
        calls.append(args)
        raise client.UpstreamTimeout('synthetic timeout')

    monkeypatch.setattr(local, 'model_invoke', invoke)
    with Session(stage3_engine) as db:
        jid = make_row(db)
        result = prepare(db, jid)
        rid = UUID(result["request_id"])
        try:
            writing_requests.execute(db, rid)
            raise AssertionError('timeout must surface as a transport failure')
        except local.LocalError as error:
            assert error.status_code == 504
        assert db.get(AIRequest, rid).status == 'failed'
        assert db.get(AIRequest, rid).error_category == 'timeout'
        ledger = db.scalars(select(AIUsage).where(AIUsage.request_id == rid)).all()
        assert len(ledger) == 1 and ledger[0].metering == 'unknown'
        assert ledger[0].total_tokens is None
        # Replay queries the stored failure without a second upstream attempt.
        result, status = writing_requests.execute(db, rid)
        assert status == 200 and result['status'] == 'failed'
        assert len(calls) == 1
        assert len(db.scalars(select(AIUsage).where(AIUsage.request_id == rid)).all()) == 1


def test_storage_failure_after_ready_keeps_result_without_checkpoint(stage3_engine, monkeypatch):
    fake_model(monkeypatch)
    with Session(stage3_engine) as db:
        jid = make_row(db)
        result = prepare(db, jid)
        rid = UUID(result["request_id"])
        assert writing_requests.execute(db, rid)[0]['status'] == 'ready'
    with Session(stage3_engine) as db:
        def broken_commit():
            raise RuntimeError('synthetic storage failure')

        db.commit = broken_commit  # type: ignore[method-assign]
        try:
            writing_requests.apply(db, rid, 2)
            raise AssertionError('storage failure must surface')
        except RuntimeError:
            db.rollback()
    with Session(stage3_engine) as db:
        request = db.get(AIRequest, rid)
        assert request.status == 'ready' and request.result['reply'] == 'synthetic answer'
        assert db.get(Journal, jid).revision == 2
        assert db.get(AICheckpoint, ('journal', jid)) is None
        assert writing_requests.apply(db, rid, 2)['status'] == 'applied'
        assert db.get(Journal, jid).revision == 3


def test_restart_marks_pending_unknown_without_new_call_or_usage(stage3_engine, monkeypatch):
    from datetime import datetime, timedelta, timezone
    from app.ai.requests import recover_pending
    calls = fake_model(monkeypatch)
    with Session(stage3_engine) as db:
        jid = make_row(db)
        result = prepare(db, jid)
        rid = UUID(result["request_id"])
        other = make_row(db, 'untouched synthetic')
        other_result = prepare(db, other)
        other_rid = UUID(other_result["request_id"])
        request = db.get(AIRequest, rid)
        request.status = 'pending'
        request.started_at = datetime.now(timezone.utc) - timedelta(seconds=121)
        db.commit()
        assert recover_pending(db, restart=True) == 1
        assert db.get(AIRequest, rid).status == 'unknown'
        assert db.get(AIRequest, other_rid).status == 'prepared', 'prepared must not be touched'
        outcome, status = writing_requests.execute(db, rid)
        assert status == 200 and outcome['status'] == 'unknown'
        assert len(calls) == 0
        # Recovery reserves the possibly-consumed subcall as an unknown ledger slot.
        ledger = db.scalars(select(AIUsage).where(AIUsage.request_id == rid)).all()
        assert len(ledger) == 1 and ledger[0].metering == 'unknown'
        assert ledger[0].total_tokens is None
        assert db.get(AICheckpoint, ('journal', jid)) is None


def test_late_result_after_soft_delete_is_conflict_but_keeps_usage(stage3_engine, monkeypatch):
    from app.journal.service import delete_journal
    entered, release = Event(), Event()
    monkeypatch.setattr(client, 'is_configured', lambda: True)

    def invoke(*args, **kwargs):
        entered.set()
        assert release.wait(15)
        return ModelResult('late synthetic answer', 'rid', ModelUsage(7, 3, 10), 'stop')

    monkeypatch.setattr(local, 'model_invoke', invoke)
    with Session(stage3_engine) as db:
        jid = make_row(db)
        result = prepare(db, jid)
        rid = UUID(result["request_id"])

    def run():
        with Session(stage3_engine) as session:
            return writing_requests.execute(session, rid)

    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(run)
            assert entered.wait(15)
            with Session(stage3_engine) as db:
                assert delete_journal(db, jid, 2)
            release.set()
            outcome, status = future.result(timeout=15)
            assert status == 200 and outcome['status'] == 'conflict'
        with Session(stage3_engine) as db:
            request = db.get(AIRequest, rid)
            assert request.status == 'conflict'
            assert request.result['reply'] == 'late synthetic answer'
            assert db.get(AICheckpoint, ('journal', jid)) is None
            ledger = db.scalars(select(AIUsage).where(AIUsage.request_id == rid)).all()
            assert len(ledger) == 1 and ledger[0].total_tokens == 10
    finally:
        release.set()


def test_purge_turns_usage_anonymous_once_without_deleting_the_ledger(stage3_engine, monkeypatch):
    from app.journal.service import delete_journal
    from app.trash.service import purge_trash
    fake_model(monkeypatch)
    with Session(stage3_engine) as db:
        jid = make_row(db)
        result = prepare(db, jid)
        rid = UUID(result["request_id"])
        assert writing_requests.execute(db, rid)[0]['status'] == 'ready'
        before = {
            'total': db.scalar(select(func.coalesce(func.sum(AIUsage.total_tokens), 0))),
            'unknown': db.scalar(select(func.count()).select_from(AIUsage)
                                 .where(AIUsage.metering == 'unknown')),
            'rows': db.scalar(select(func.count()).select_from(AIUsage)),
        }
    with Session(stage3_engine) as db:
        assert delete_journal(db, jid, 2)
        assert purge_trash(db, 'journal', jid, 3)
    with Session(stage3_engine) as db:
        ledger = db.scalars(select(AIUsage)).all()
        assert len(ledger) == 1 and ledger[0].request_id is None
        assert ledger[0].total_tokens == 10
        assert db.get(AIRequest, rid) is None
        assert db.get(AICheckpoint, ('journal', jid)) is None
        after = {
            'total': db.scalar(select(func.coalesce(func.sum(AIUsage.total_tokens), 0))),
            'unknown': db.scalar(select(func.count()).select_from(AIUsage)
                                 .where(AIUsage.metering == 'unknown')),
            'rows': db.scalar(select(func.count()).select_from(AIUsage)),
        }
        assert after == before, 'purge must not clear or duplicate the anonymous ledger'


def test_concurrent_automatic_preparations_create_one_request(stage3_engine):
    barrier = Barrier(2)
    with Session(stage3_engine) as db:
        jid = make_row(db)

    def run(_):
        payload = WritingPrepare(request_id=uuid4(), kind='go_deeper', trigger='automatic',
                                 source={'type': 'journal', 'id': jid, 'expected_revision': 1})
        with Session(stage3_engine) as db:
            barrier.wait(timeout=10)
            return writing_requests.prepare(db, payload)

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(run, range(2)))
    assert outcomes[0]['request_id'] == outcomes[1]['request_id']
    with Session(stage3_engine) as db:
        assert db.scalar(select(func.count()).select_from(AIRequest)) == 1
        row = db.get(Journal, jid)
        assert row.revision == 2
        assert len([item for item in row.content_doc['content']
                    if item['type'] == 'aiPlaceholder']) == 1


def test_minds_execute_and_apply_roundtrip_with_real_ledger(stage3_engine, monkeypatch):
    import json as json_module
    fake_model(monkeypatch)
    with Session(stage3_engine) as db:
        doc = {'type': 'doc', 'content': [
            {'type': 'paragraph', 'attrs': {'id': str(uuid4())},
             'content': [{'type': 'text', 'text': 'synthetic minds text'}]}]}
        row = Journal(journal_date=date(2038, 3, 3), content=project_document(doc), content_doc=doc)
        db.add(row)
        db.commit()
        jid = row.id
        node_id = doc['content'][0]['attrs']['id']
        payload = WritingPrepare(request_id=uuid4(), kind='minds_comments', trigger='manual',
            source={'type': 'journal', 'id': jid, 'expected_revision': 1},
            mind_preset_ids=['gentle_reflection'],
            scope={'node_id': node_id, 'start': 0, 'end': 9})
        result = writing_requests.prepare(db, payload)
        rid = UUID(result["request_id"])
        assert result['status'] == 'prepared'
        assert result['files'] == [] and result['effects'] == []
        assert db.get(Journal, jid).revision == 1, 'Minds must not touch the document'
        db.get(AIRequest, rid)
        db.expire_all()
        frozen = db.get(AIRequest, rid).sources[0]
        assert frozen['scope']['quote'] == 'synthetic'
    from app.ai import comments as comments_module
    import hashlib as _hashlib
    anchor = {'node_id': node_id, 'start': 0, 'end': 9, 'quote': 'synthetic',
              'quote_sha256': _hashlib.sha256('synthetic'.encode()).hexdigest()}
    monkeypatch.setattr(comments_module, 'parse_comments', lambda raw, source: [
        {'mind_preset_id': 'gentle_reflection', 'text': 'synthetic note', 'anchor': anchor}])
    with Session(stage3_engine) as db:
        outcome, status = writing_requests.execute(db, rid)
        assert status == 200 and outcome['status'] == 'ready'
        assert len(db.scalars(select(AIUsage).where(AIUsage.request_id == rid)).all()) == 1
        applied = writing_requests.apply(db, rid, 1)
        assert applied['status'] == 'applied'
        assert applied['comments'][0]['anchor_state'] == 'available'
        assert applied['effects'][0]['ops'] == [{'kind': 'comment_marks'}]
        saved = db.get(Journal, jid)
        assert saved.revision == 2
        marked = saved.content_doc['content'][0]['content'][0]
        assert marked['text'] == 'synthetic'
        assert marked['marks'][0]['type'] == 'mindComment'
        assert db.get(AICheckpoint, ("journal", jid)) is None
        listing = db.scalars(select(AIComment).where(AIComment.journal_id == jid)).all()
        assert len(listing) == 1 and listing[0].quote == 'synthetic'
    # Replaying execute/apply changes nothing further.
    with Session(stage3_engine) as db:
        replay, status = writing_requests.execute(db, rid)
        assert status == 200 and replay['status'] == 'applied'
        assert writing_requests.apply(db, rid, 2)['files'] == []
        assert db.get(Journal, jid).revision == 2
