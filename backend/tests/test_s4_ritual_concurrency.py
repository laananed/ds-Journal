"""Real two-session slot race; cleanup is limited to this test's creation keys."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import Session

from app.database import engine
from app.journal.models import Journal
from app.journal.schemas import JournalCreate
from app.journal.service import create_journal, RitualSlotConflict


def test_two_sessions_compete_for_one_ritual_slot():
    keys = [uuid4(), uuid4()]  # Exact manifest for this test run.
    barrier = Barrier(2)
    with engine.connect() as connection:
        assert connection.scalar(text('select current_database()')) == 'seekjournal_test_04'
        assert connection.scalar(select(func.count()).select_from(Journal)) == 0

    def create(key):
        payload = JournalCreate(journal_kind='set', journal_date='2038-03-03',
            draft_started_at='2038-03-03T04:00:00+08:00', content='synthetic concurrent',
            client_create_id=key)
        with Session(engine) as db:
            barrier.wait(timeout=5)
            try:
                return ('created', create_journal(db, payload).id)
            except RitualSlotConflict:
                return ('conflict', None)

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(create, keys))
        assert sorted(result[0] for result in outcomes) == ['conflict', 'created']
    finally:
        with engine.begin() as connection:
            connection.execute(delete(Journal).where(Journal.client_create_id.in_(keys)))
        with engine.connect() as connection:
            assert connection.scalar(select(func.count()).select_from(Journal)) == 0
