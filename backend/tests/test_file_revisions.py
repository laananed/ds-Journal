"""Initial S3-T01 request tests; no implicit fixture revision injection."""

import pytest
from pydantic import ValidationError

from app.inbox.schemas import InboxUpdate
from app.insight.schemas import InsightUpdate
from app.journal.schemas import JournalUpdate


@pytest.mark.parametrize("schema", [JournalUpdate, InboxUpdate, InsightUpdate])
def test_patch_keeps_explicit_expected_revision(schema):
    request = schema.model_validate({"expected_revision": 7, "title": None})
    assert request.model_dump(exclude_unset=True) == {
        "expected_revision": 7,
        "title": None,
    }


@pytest.mark.parametrize("schema", [JournalUpdate, InboxUpdate, InsightUpdate])
@pytest.mark.parametrize("revision", [None, 0, -1, True, "1", 1.5])
def test_patch_rejects_invalid_explicit_revision(schema, revision):
    with pytest.raises(ValidationError):
        schema.model_validate({"expected_revision": revision})


@pytest.mark.parametrize("schema", [JournalUpdate, InboxUpdate, InsightUpdate])
def test_missing_revision_remains_distinguishable_for_http_428(schema):
    request = schema.model_validate({"title": "changed"})
    assert "expected_revision" not in request.model_fields_set
    # Absence must survive validation so Router/Service can return 428, not 422.
    assert "expected_revision" in schema.model_fields


FILES = [
    ("journals", {"content": "合成原文 🧪", "journal_date": "2026-10-10"}),
    ("inboxes", {"content": "合成原文 🧪", "inbox_date": "2026-10-10"}),
    ("insights", {"content": "合成原文 🧪"}),
]


@pytest.mark.parametrize("endpoint,payload", FILES)
def test_http_revision_noop_conflict_and_preconditions(api, endpoint, payload):
    client, db = api
    original = client.post(f"/api/{endpoint}", json=payload).json()
    path = f"/api/{endpoint}/{original['id']}"
    assert original["revision"] == 1
    assert client.patch(path, json={"title": "other"}).status_code == 428
    for body in ({"expected_revision": 1}, {"expected_revision": 1, "content": payload["content"]}):
        same = client.patch(path, json=body)
        assert same.status_code == 200
        assert same.json() == original
    changed = client.patch(path, json={"expected_revision": 1, "title": "new"})
    assert changed.status_code == 200
    latest = changed.json()
    assert latest["revision"] == 2
    assert latest["updated_at"] != original["updated_at"]
    assert client.patch(path, json={"expected_revision": 1, "title": "lost"}).status_code == 409
    assert client.patch(path, json={"expected_revision": 1, "title": "new"}).json() == latest
    assert client.delete(path).status_code == 428
    assert client.delete(path, headers={"If-Match": "1"}).status_code == 422
    assert client.delete(path, headers={"If-Match": '"1"'}).status_code == 409
    removed = client.delete(path, headers={"If-Match": '"2"'})
    assert removed.status_code == 204 and removed.content == b""
    assert client.get(path).status_code == 404
    if endpoint != "inboxes":
        kind = "journal" if endpoint == "journals" else "insight"
        trash_path = f"/api/trash/{kind}/{original['id']}"
        deleted = client.get(trash_path).json()
        assert deleted["revision"] == 3
        assert deleted["updated_at"] == latest["updated_at"]
        assert client.post(trash_path + "/restore").status_code == 428
        assert client.post(trash_path + "/restore", headers={"If-Match": '"2"'}).status_code == 409
        restored = client.post(trash_path + "/restore", headers={"If-Match": '"3"'})
        assert restored.status_code == 200
        assert restored.json()["revision"] == 4
        assert restored.json()["updated_at"] == latest["updated_at"]


@pytest.mark.parametrize("endpoint,payload", FILES)
def test_read_projection_has_revision_without_blocks(api, endpoint, payload):
    client, db = api
    folder = client.post("/api/folders", json={"name": "T01 projection"}).json()
    original = client.post(f"/api/{endpoint}", json={**payload, "folder_id": folder["id"]}).json()
    for path in (f"/api/{endpoint}", "/api/search?q=合成", f"/api/folders/{folder['id']}/files"):
        response = client.get(path)
        assert response.status_code == 200
        item = next(x for x in response.json()["items"] if x["id"] == original["id"])
        assert item["revision"] == original["revision"]
        assert "content_blocks" not in item


@pytest.mark.parametrize("kind", ["journal", "inbox", "insight"])
def test_two_real_sessions_cas_only_one_different_update_wins(stage3_engine, monkeypatch, kind):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from sqlalchemy import select
    from sqlalchemy.orm import Session
    from app.journal import service as journals
    from app.inbox import service as inboxes
    from app.insight import service as insights
    from app.journal.schemas import JournalCreate
    from app.inbox.schemas import InboxCreate
    from app.insight.schemas import InsightCreate
    from app.journal.models import Journal
    from app.inbox.models import Inbox
    from app.insight.models import Insight
    from app.writing.service import WriteConflict

    service, model, create, update = {
        "journal": (journals, Journal, JournalCreate, JournalUpdate),
        "inbox": (inboxes, Inbox, InboxCreate, InboxUpdate),
        "insight": (insights, Insight, InsightCreate, InsightUpdate),
    }[kind]
    body = {"content": "synthetic original"}
    if kind != "insight":
        body[kind + "_date"] = "2026-10-10"
    with Session(stage3_engine) as db:
        file = getattr(service, "create_" + kind)(db, create(**body))
    getter = "_get_row" if kind == "inbox" else "_get_active_" + kind
    original_get = getattr(service, getter)
    barrier = Barrier(2)
    reads = set()
    def synchronized_get(db, file_id):
        row = original_get(db, file_id)
        if file_id == file.id and id(db) not in reads:
            reads.add(id(db))
            barrier.wait(timeout=10)
        return row
    monkeypatch.setattr(service, getter, synchronized_get)
    def write(title):
        with Session(stage3_engine) as db:
            try:
                result = getattr(service, "update_" + kind)(db, file.id,
                         update(expected_revision=1, title=title))
                return result.revision
            except WriteConflict:
                assert db.scalar(select(model.id).where(model.id == file.id)) == file.id
                return "conflict"
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(write, ["first", "second"]))
    assert results.count(2) == 1 and results.count("conflict") == 1
    with Session(stage3_engine) as db:
        row = db.get(model, file.id)
        assert row.revision == 2 and row.title in {"first", "second"}
