"""Write failures must roll back actual PostgreSQL changes and leave Session usable."""
import pytest
from sqlalchemy import event, select, text

from app.inbox.models import Inbox


@pytest.mark.parametrize('operation', ['create', 'update', 'delete'])
def test_write_failure_rolls_back_and_session_can_continue(api, monkeypatch, operation):
    client, session = api
    response = client.post('/api/inboxes', json={'content': 'S2T04 original', 'inbox_date': '2034-03-03'})
    assert response.status_code == 201
    original = response.json()
    before = session.execute(text('SELECT * FROM inboxes WHERE id=:id'), {'id': original['id']}).one()
    commit = session.commit
    def fail_after_flush():
        session.flush()
        raise RuntimeError('S2T04 synthetic commit failure')
    monkeypatch.setattr(session, 'commit', fail_after_flush)
    if operation == 'create':
        failed = client.post('/api/inboxes', json={'content': 'should rollback', 'inbox_date': '2034-03-03'})
    elif operation == 'update':
        failed = client.patch(f"/api/inboxes/{original['id']}", json={'title': 'changed', 'content': 'changed'})
    else:
        failed = client.delete(f"/api/inboxes/{original['id']}")
    assert failed.status_code == 500
    monkeypatch.setattr(session, 'commit', commit)
    assert session.scalar(text('SELECT 1')) == 1
    assert session.execute(text('SELECT * FROM inboxes WHERE id=:id'), {'id': original['id']}).one() == before
    assert session.scalar(select(Inbox.id).where(Inbox.content == 'should rollback')) is None
    assert client.get(f"/api/inboxes/{original['id']}").json() == original
    assert client.patch(f"/api/inboxes/{original['id']}", json={'content': 'valid after failure'}).status_code == 200


def test_other_integrity_error_is_not_mislabeled_as_daily_conflict(api):
    client, session = api
    def force_invalid_fk(session, flush_context, instances):
        for row in session.new:
            if isinstance(row, Inbox):
                row.folder_id = 10**9
    event.listen(session, 'before_flush', force_invalid_fk)
    try:
        response = client.post('/api/inboxes', json={'content': 'S2T04 FK failure', 'inbox_date': '2034-03-03', 'is_daily': True})
        assert response.status_code == 500
    finally:
        event.remove(session, 'before_flush', force_invalid_fk)
    assert session.scalar(text('SELECT 1')) == 1
    assert client.post('/api/inboxes', json={'content': 'S2T04 after FK failure', 'inbox_date': '2034-03-03', 'is_daily': True}).status_code == 201
