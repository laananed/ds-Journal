"""Ritual lifecycle safeguards, using rollback-isolated synthetic records."""
from uuid import uuid4
import pytest
from app.ritual.models import RitualGoalLink


def create(client, kind='set', day='2026-10-30'):
    response = client.post('/api/journals', json={
        'journal_kind': kind, 'journal_date': day,
        'draft_started_at': '2026-10-30T04:00:00+08:00', 'content': 'synthetic',
    })
    assert response.status_code == 201
    return response.json()


@pytest.mark.parametrize('invalid', [1793318400, True, '2026-10-30T00:00:00Z'])
def test_ritual_date_rejects_non_date_input(api, invalid):
    client, _ = api
    response = client.post('/api/journals', json={
        'journal_kind': 'set', 'journal_date': invalid,
        'draft_started_at': '2026-10-30T04:00:00+08:00', 'content': 'synthetic',
    })
    assert response.status_code == 422


def test_restore_conflicting_slot_is_409_without_changes(api):
    client, _ = api
    source = create(client)
    assert client.delete(f"/api/journals/{source['id']}", headers={'If-Match': '"1"'}).status_code == 204
    target = create(client)
    response = client.post(f"/api/trash/journal/{source['id']}/restore", headers={'If-Match': '"2"'})
    assert response.status_code == 409
    assert response.json()['code'] == 'ritual_slot_conflict'
    assert client.get(f"/api/journals/{target['id']}").json()['revision'] == 1


def test_delete_rejects_existing_goal_link(api):
    client, db = api
    source, target = create(client), create(client, 'end')
    db.add(RitualGoalLink(id=uuid4(), set_journal_id=source['id'], end_journal_id=target['id'],
                          goal_id=uuid4(), end_node_id=uuid4()))
    db.flush()
    response = client.delete(f"/api/journals/{source['id']}", headers={'If-Match': '"1"'})
    assert response.status_code == 428
    response = client.request('DELETE', f"/api/journals/{source['id']}", headers={'If-Match': '"1"'},
                              json={'related_revisions': [{'type': 'journal', 'id': target['id'], 'revision': 1}]})
    assert response.status_code == 409
    assert response.json()['code'] == 'related_files_changed'
    assert client.get(f"/api/journals/{source['id']}").json()['revision'] == 1


@pytest.mark.parametrize(('stamp', 'day'), [
    ('2026-10-30T03:59:59+08:00', '2026-10-29'),
    ('2026-10-30T04:00:00+08:00', '2026-10-30'),
    ('2024-03-01T03:59:59+08:00', '2024-02-29'),
    ('2027-01-01T03:59:59+08:00', '2026-12-31'),
    ('2026-10-29T20:00:00Z', '2026-10-30'),
])
def test_draft_captured_business_day(api, stamp, day):
    client, _ = api
    payload = {'journal_kind': 'set', 'journal_date': day,
               'draft_started_at': stamp, 'content': 'synthetic'}
    response = client.post('/api/journals', json=payload)
    assert response.status_code == 201
    assert response.json()['journal_date'] == day
    assert client.patch('/api/journals/' + str(response.json()['id']), json={
        'expected_revision': 1, 'journal_date': '2026-01-01',
    }).status_code == 422
