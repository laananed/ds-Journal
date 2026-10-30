"""Real independent PostgreSQL sessions; cleanup uses only this test's keys."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from threading import Barrier
from uuid import uuid4

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.database import engine
from app.journal.models import Journal
from app.ritual.goals import create_links, update_goal
from app.ritual.models import RitualGoalLink
from app.ritual.schemas import GoalLinkCreate, GoalUpdate
from app.writing.documents import project_document
from app.writing.service import WriteConflict
from test_s4_goal_sync import goal_document


def test_two_sessions_same_goal_cas_has_one_winner():
    keys = [uuid4(), uuid4()]
    goal_id = uuid4()
    day = date(2040, 1, 1) + timedelta(days=uuid4().int % 10000)
    ids = []
    try:
        with Session(engine) as db:
            assert db.scalar(select(Journal.id).where(Journal.journal_date == day,
                Journal.journal_kind.in_(['set', 'end']), Journal.deleted_at.is_(None))) is None
            set_doc = goal_document(str(goal_id))
            end_doc = {'type': 'doc', 'content': [{'type': 'paragraph',
                'content': [{'type': 'text', 'text': 'synthetic'}]}]}
            rows = [Journal(journal_date=day, journal_kind=kind, client_create_id=key,
                            content_doc=doc, content=project_document(doc))
                    for kind, key, doc in [('set', keys[0], set_doc), ('end', keys[1], end_doc)]]
            db.add_all(rows)
            db.commit()
            ids = [row.id for row in rows]
            create_links(db, GoalLinkCreate(source_set_id=ids[0], goal_ids=[goal_id],
                expected_set_revision=1, end_id=ids[1], expected_end_revision=1))
        barrier = Barrier(2)
        def worker(value):
            with Session(engine) as db:
                barrier.wait(timeout=10)
                try:
                    update_goal(db, ids[0], goal_id, GoalUpdate(expected_set_revision=1,
                        expected_end_revision=2, text=value))
                    return 'ok'
                except WriteConflict:
                    return 'conflict'
        with ThreadPoolExecutor(max_workers=2) as pool:
            assert sorted(pool.map(worker, ['alpha', 'beta'])) == ['conflict', 'ok']
        with Session(engine) as db:
            source, end = db.get(Journal, ids[0]), db.get(Journal, ids[1])
            goal = source.content_doc['content'][0]['attrs']
            review = end.content_doc['content'][-1]['attrs']
            assert goal['text'] == review['goal_snapshot']
            assert source.revision == 2 and end.revision == 3
    finally:
        with Session(engine) as db:
            own_ids = list(db.scalars(select(Journal.id).where(Journal.client_create_id.in_(keys))))
            db.execute(delete(RitualGoalLink).where(RitualGoalLink.end_journal_id.in_(own_ids)))
            db.execute(delete(Journal).where(Journal.client_create_id.in_(keys)))
            db.commit()
            assert not db.scalars(select(Journal.id).where(Journal.client_create_id.in_(keys))).all()


def test_delete_races_goal_sync_without_half_write():
    from app.journal.service import delete_journal
    from app.ritual.schemas import RelatedRevisionsBody
    keys = [uuid4(), uuid4()]
    goal_id = uuid4()
    day = date(2070, 1, 1) + timedelta(days=uuid4().int % 10000)
    ids = []
    try:
        with Session(engine) as db:
            assert db.scalar(select(Journal.id).where(Journal.journal_date == day,
                Journal.journal_kind.in_(['set', 'end']), Journal.deleted_at.is_(None))) is None
            set_doc = goal_document(str(goal_id))
            end_doc = {'type': 'doc', 'content': [{'type': 'paragraph',
                'content': [{'type': 'text', 'text': 'synthetic'}]}]}
            rows = [Journal(journal_date=day, journal_kind=kind, client_create_id=key,
                            content_doc=doc, content=project_document(doc))
                    for kind, key, doc in [('set', keys[0], set_doc), ('end', keys[1], end_doc)]]
            db.add_all(rows)
            db.commit()
            ids = [row.id for row in rows]
            create_links(db, GoalLinkCreate(source_set_id=ids[0], goal_ids=[goal_id],
                expected_set_revision=1, end_id=ids[1], expected_end_revision=1))
        barrier = Barrier(2)
        def worker(action):
            with Session(engine) as db:
                barrier.wait(timeout=10)
                try:
                    if action == 'delete':
                        delete_journal(db, ids[0], 1, RelatedRevisionsBody(related_revisions=[
                            {'type': 'journal', 'id': ids[1], 'revision': 2}]))
                    else:
                        update_goal(db, ids[0], goal_id, GoalUpdate(expected_set_revision=1,
                            expected_end_revision=2, text='changed'))
                    return action
                except WriteConflict:
                    return 'conflict'
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(worker, ['delete', 'update']))
        assert outcomes.count('conflict') == 1
        with Session(engine) as db:
            source, end = db.get(Journal, ids[0]), db.get(Journal, ids[1])
            link = db.scalar(select(RitualGoalLink).where(RitualGoalLink.end_journal_id == ids[1]))
            review = end.content_doc['content'][-1]
            if source.deleted_at is not None:
                assert link.set_journal_id is None and review['attrs']['link_id'] is None
                assert review['attrs']['goal_snapshot'] == 'one'
            else:
                assert link.set_journal_id == source.id and review['attrs']['link_id'] == str(link.id)
                assert review['attrs']['goal_snapshot'] == source.content_doc['content'][0]['attrs']['text'] == 'changed'
    finally:
        with Session(engine) as db:
            own_ids = list(db.scalars(select(Journal.id).where(Journal.client_create_id.in_(keys))))
            db.execute(delete(RitualGoalLink).where(RitualGoalLink.end_journal_id.in_(own_ids)))
            db.execute(delete(Journal).where(Journal.client_create_id.in_(keys)))
            db.commit()
            assert not db.scalars(select(Journal.id).where(Journal.client_create_id.in_(keys))).all()
