"""Initial S3-T01 creation key input tests, with synthetic payloads only."""

from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.inbox.schemas import InboxCreate
from app.insight.schemas import InsightCreate
from app.journal.schemas import JournalCreate


CREATES = [
    (JournalCreate, {"content": "  合成 **Markdown** 🧪\n", "journal_date": "2026-10-10"}),
    (InboxCreate, {"content": "  合成 **Markdown** 🧪\n", "inbox_date": "2026-10-10"}),
    (InsightCreate, {"content": "  合成 **Markdown** 🧪\n"}),
]


@pytest.mark.parametrize("schema,payload", CREATES)
def test_creation_retains_uuid_key_and_original_content(schema, payload):
    key = uuid4()
    request = schema.model_validate({**payload, "client_create_id": str(key)})
    assert request.model_dump().get("client_create_id") == key
    assert request.content == payload["content"]


@pytest.mark.parametrize("schema,payload", CREATES)
def test_creation_rejects_invalid_uuid_key(schema, payload):
    with pytest.raises(ValidationError):
        schema.model_validate({**payload, "client_create_id": "not-a-uuid"})


@pytest.mark.parametrize("endpoint,payload", [
    ("journals", CREATES[0][1]), ("inboxes", CREATES[1][1]), ("insights", CREATES[2][1]),
])
def test_http_replays_original_create_after_later_edit(api, endpoint, payload):
    client, db = api
    body = {**payload, "client_create_id": str(uuid4())}
    first = client.post(f"/api/{endpoint}", json=body)
    assert first.status_code == 201
    original = first.json()
    path = f"/api/{endpoint}/{original['id']}"
    edited = client.patch(path, json={"expected_revision": 1, "content": "later edit"})
    assert edited.status_code == 200
    replay = client.post(f"/api/{endpoint}", json=body)
    assert replay.status_code == 200
    assert replay.json() == edited.json()
    conflict = client.post(f"/api/{endpoint}", json={**body, "content": "different first payload"})
    assert conflict.status_code == 409
    assert client.get(f"/api/{endpoint}").json()["total"] == 1


@pytest.mark.parametrize("kind", ["journal", "inbox", "insight"])
def test_concurrent_create_same_key_only_one_row(stage3_engine, kind):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from sqlalchemy import func, select
    from sqlalchemy.orm import Session
    from app.journal import service as journals
    from app.inbox import service as inboxes
    from app.insight import service as insights
    from app.journal.models import Journal
    from app.inbox.models import Inbox
    from app.insight.models import Insight

    service, model, schema, payload = {
        "journal": (journals, Journal, CREATES[0][0], CREATES[0][1]),
        "inbox": (inboxes, Inbox, CREATES[1][0], CREATES[1][1]),
        "insight": (insights, Insight, CREATES[2][0], CREATES[2][1]),
    }[kind]
    barrier = Barrier(2)
    class RacingSession(Session):
        def commit(self):
            barrier.wait(timeout=10)
            super().commit()
    key = uuid4()
    def create(_):
        with RacingSession(stage3_engine) as db:
            result = getattr(service, "create_" + kind)(db,
                         schema(**payload, client_create_id=key))
            return result.id, result._creation_replayed
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(create, [0, 1]))
    assert results[0][0] == results[1][0]
    assert sorted(replay for _, replay in results) == [False, True]
    with Session(stage3_engine) as db:
        assert db.scalar(select(func.count()).select_from(model)) == 1


@pytest.mark.parametrize("endpoint,payload", [("journals", CREATES[0][1]), ("insights", CREATES[2][1])])
def test_replay_key_of_soft_deleted_file_does_not_return_server_error(api, endpoint, payload):
    client, db = api
    body = {**payload, "client_create_id": str(uuid4())}
    first = client.post(f"/api/{endpoint}", json=body).json()
    assert client.delete(f"/api/{endpoint}/{first['id']}", headers={"If-Match": '"1"'}).status_code == 204
    # Deleted creation keys need not remain usable; they must not resurrect data.
    assert client.post(f"/api/{endpoint}", json=body).status_code == 409
