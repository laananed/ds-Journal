"""Insight Service edge cases that the HTTP layer alone cannot prove.

Three behaviours are load-bearing for S2-T06 and are pinned here directly against
the Service/Session (not through the Router):

1. a failed write rolls back the real PostgreSQL change and leaves the Session usable;
2. soft-deleted rows are hidden by an explicit ``deleted_at IS NULL`` query,
   so a stale object sitting in the Session identity map cannot resurrect them;
3. soft delete keeps ``created_at`` and ``updated_at`` byte-for-byte unchanged.
"""
from datetime import datetime, timezone

import pytest
from sqlalchemy import select, text, update

from app.insight import service
from app.insight.models import Insight
from app.insight.schemas import InsightUpdate


def _seed(client, session, content='S2T06 service'):
    response = client.post('/api/insights', json={'content': content})
    assert response.status_code == 201
    return session.get(Insight, response.json()['id'])


@pytest.mark.parametrize('operation', ['create', 'update', 'delete'])
def test_write_failure_rolls_back_and_session_can_continue(api, monkeypatch, operation):
    client, session = api
    response = client.post('/api/insights', json={'content': 'S2T06 original'})
    assert response.status_code == 201
    original = response.json()
    before = session.execute(text('SELECT * FROM insights WHERE id=:id'), {'id': original['id']}).one()

    commit = session.commit

    def fail_after_flush():
        session.flush()
        raise RuntimeError('S2T06 synthetic commit failure')

    monkeypatch.setattr(session, 'commit', fail_after_flush)
    if operation == 'create':
        failed = client.post('/api/insights', json={'content': 'should rollback'})
    elif operation == 'update':
        failed = client.patch(f"/api/insights/{original['id']}", json={"expected_revision": 1, **{'title': 'changed', 'content': 'changed'}})
    else:
        failed = client.delete(f"/api/insights/{original['id']}", headers={"If-Match": '"1"'})
    assert failed.status_code == 500

    monkeypatch.setattr(session, 'commit', commit)
    assert session.scalar(text('SELECT 1')) == 1
    assert session.execute(text('SELECT * FROM insights WHERE id=:id'), {'id': original['id']}).one() == before
    assert session.scalar(select(Insight.id).where(Insight.content == 'should rollback')) is None
    assert client.get(f"/api/insights/{original['id']}").json() == original
    assert client.patch(f"/api/insights/{original['id']}", json={"expected_revision": 1, **{'content': 'valid after failure'}}).status_code == 200


def test_soft_deleted_object_in_identity_map_is_still_hidden(api):
    client, session = api
    row = _seed(client, session)
    identity = row.id

    # Soft delete through the Session while the object stays loaded (no expiry yet).
    session.execute(
        update(Insight)
        .where(Insight.id == identity, Insight.deleted_at.is_(None))
        .values(deleted_at=datetime.now(timezone.utc), updated_at=Insight.updated_at)
        .execution_options(synchronize_session=False)
    )
    session.flush()

    # The identity map still holds a stale object that looks active.
    assert session.get(Insight, identity).deleted_at is None
    # The Service must not be fooled: it filters in SQL, not via the identity map.
    assert service.get_insight(session, identity) is None
    assert service.update_insight(session, identity, InsightUpdate(content='resurrected', expected_revision=1)) is None
    assert service.delete_insight(session, identity, expected_revision=1) is False


def test_soft_delete_keeps_created_and_updated_at_exactly(api):
    client, session = api
    row = _seed(client, session)
    identity = row.id
    before = session.execute(
        text('SELECT created_at, updated_at FROM insights WHERE id=:id'),
        {'id': identity},
    ).one()

    assert service.delete_insight(session, identity, expected_revision=1) is True

    after = session.execute(
        text('SELECT created_at, updated_at, deleted_at FROM insights WHERE id=:id'),
        {'id': identity},
    ).one()
    assert after.created_at == before.created_at
    assert after.updated_at == before.updated_at
    assert after.deleted_at is not None


def test_real_update_advances_updated_at_but_not_created_at(api):
    client, session = api
    row = _seed(client, session)
    identity = row.id
    before = service.get_insight(session, identity)
    assert service.update_insight(session, identity, InsightUpdate(content='S2T06 changed', expected_revision=1)) is not None
    after = service.get_insight(session, identity)
    assert after.content == 'S2T06 changed'
    assert after.created_at == before.created_at
    assert after.updated_at != before.updated_at
