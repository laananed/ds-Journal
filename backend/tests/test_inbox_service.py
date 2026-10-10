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
        failed = client.patch(f"/api/inboxes/{original['id']}", json={"expected_revision": 1, **{'title': 'changed', 'content': 'changed'}})
    else:
        failed = client.delete(f"/api/inboxes/{original['id']}", headers={"If-Match": '"1"'})
    assert failed.status_code == 500
    monkeypatch.setattr(session, 'commit', commit)
    assert session.scalar(text('SELECT 1')) == 1
    assert session.execute(text('SELECT * FROM inboxes WHERE id=:id'), {'id': original['id']}).one() == before
    assert session.scalar(select(Inbox.id).where(Inbox.content == 'should rollback')) is None
    assert client.get(f"/api/inboxes/{original['id']}").json() == original
    assert client.patch(f"/api/inboxes/{original['id']}", json={"expected_revision": 1, **{'content': 'valid after failure'}}).status_code == 200


def test_other_integrity_error_is_not_mislabeled_as_daily_conflict(api):
    """S2-T04 原意图：FK 类 IntegrityError 不得被误标为 Daily 冲突（409）。

    S2-T07 起契约细化：这里的合成故障恰好是「Folder 引用冲突」
    （before_flush 里强行写入不存在的 folder_id=10**9），
    按新契约应映射为 404 Folder not found，而不是裸 500；
    关键不变量仍然成立——它**不是** 409，也不是 DailyInboxConflictError。
    """
    client, session = api
    def force_invalid_fk(session, flush_context, instances):
        for row in session.new:
            if isinstance(row, Inbox):
                row.folder_id = 10**9
    event.listen(session, 'before_flush', force_invalid_fk)
    try:
        response = client.post('/api/inboxes', json={'content': 'S2T04 FK failure', 'inbox_date': '2034-03-03', 'is_daily': True})
        assert response.status_code == 404
        assert response.json()['detail'] == 'Folder not found'
    finally:
        event.remove(session, 'before_flush', force_invalid_fk)
    assert session.scalar(text('SELECT 1')) == 1
    assert client.post('/api/inboxes', json={'content': 'S2T04 after FK failure', 'inbox_date': '2034-03-03', 'is_daily': True}).status_code == 201
