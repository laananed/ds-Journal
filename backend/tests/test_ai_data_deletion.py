"""Source deletion clears private multi-source snapshots, keeps usage and saved work."""
from uuid import uuid4

import pytest
from sqlalchemy import select, text

from app.ai.models import AICheckpoint, AIRequest, AIUsage


@pytest.mark.parametrize("kind", ["journal", "inbox", "insight"])
def test_hard_delete_clears_multi_source_request_but_keeps_usage_and_saved_result(api, kind):
    client, db = api
    paths = {"journal": "journals", "inbox": "inboxes", "insight": "insights"}
    body = {"content": "synthetic source"}
    if kind != "insight":
        body[kind + "_date"] = "2026-10-10"
    source = client.post("/api/" + paths[kind], json=body).json()
    other = client.post("/api/inboxes", json={"content": "other source", "inbox_date": "2026-10-09"}).json()
    saved = client.post("/api/journals", json={"content": "independent saved result", "journal_date": "2026-10-10"}).json()
    request_id = uuid4()
    request = AIRequest(id=request_id, kind="review", payload_hash="test", status="applied",
                        sources=[{"type": kind, "id": source["id"], "revision": 1, "user_text": "synthetic source"},
                                 {"type": "inbox", "id": other["id"], "revision": 1}],
                        settings={}, question="synthetic question", result={"text": "private result"},
                        saved_target={"type": "journal", "id": saved["id"]})
    db.add(request)
    db.flush()
    usage = AIUsage(request_id=request_id, subcall_index=0, response_id="synthetic-response", metering="known",
                    prompt_tokens=3, completion_tokens=2, total_tokens=5, search_requests=1)
    db.add(usage)
    if kind != "insight":
        db.add(AICheckpoint(file_type=kind, file_id=source["id"], consumed_user_text="synthetic snapshot", last_request_id=request_id))
    db.add(AICheckpoint(file_type="inbox", file_id=other["id"], consumed_user_text="other snapshot", last_request_id=request_id))
    db.flush()
    usage_id = usage.id
    path = f"/api/{paths[kind]}/{source['id']}"
    result = client.delete(path, headers={"If-Match": '"1"'})
    assert result.status_code == 204
    if kind != "inbox":
        # Soft deletion preserves private snapshots and ledger association.
        assert db.get(AIRequest, request_id) is not None
        assert client.get(f"/api/trash/{kind}/{source['id']}").json()["revision"] == 2
        result = client.delete(f"/api/trash/{kind}/{source['id']}", headers={"If-Match": '"2"'})
        assert result.status_code == 204
    assert db.get(AIRequest, request_id) is None
    remaining = db.get(AIUsage, usage_id)
    assert remaining.request_id is None and remaining.total_tokens == 5 and remaining.search_requests == 1
    assert db.get(AICheckpoint, (kind, source["id"])) is None
    assert db.get(AICheckpoint, ("inbox", other["id"])) is not None
    assert client.get(f"/api/journals/{saved['id']}").status_code == 200


def test_gets_do_not_change_any_business_table_digest(api):
    import hashlib
    from scripts.prepare_test_db import BUSINESS_TABLES
    client, db = api
    file = client.post("/api/journals", json={"content": "read-only synthetic", "journal_date": "2026-10-10"}).json()
    def snapshot():
        return {t: hashlib.sha256(repr(db.execute(text(f"select row_to_json(t)::text from {t} t")).all()).encode()).hexdigest()
                for t in BUSINESS_TABLES}
    before = snapshot()
    for path in (f"/api/journals/{file['id']}", "/api/journals", "/api/inboxes", "/api/insights",
                 "/api/search?q=synthetic", "/api/trash", "/api/inboxes/daily?inbox_date=2026-10-10"):
        assert client.get(path).status_code == 200
    assert snapshot() == before


def test_file_gets_never_flush_or_commit_pending_state(api, monkeypatch):
    client, db = api
    file = client.post("/api/journals", json={"content": "synthetic GET", "journal_date": "2026-10-10"}).json()
    def forbidden(*args, **kwargs):
        raise AssertionError("GET attempted flush or commit")
    with monkeypatch.context() as patch:
        patch.setattr(db, "flush", forbidden)
        patch.setattr(db, "commit", forbidden)
        for path in (f"/api/journals/{file['id']}", "/api/journals", "/api/inboxes", "/api/insights",
                     "/api/inboxes/daily?inbox_date=2026-10-10"):
            assert client.get(path).status_code == 200


def test_delete_database_failure_restores_private_data_and_session(api, monkeypatch):
    client, db = api
    source = client.post("/api/inboxes", json={"content": "synthetic rollback source", "inbox_date": "2026-10-10"}).json()
    request_id = uuid4()
    db.add(AIRequest(id=request_id, kind="local", payload_hash="rollback", status="applied",
                     sources=[{"type": "inbox", "id": source["id"]}], settings={}, result={"text": "synthetic"}))
    db.flush()
    usage = AIUsage(request_id=request_id, subcall_index=0, total_tokens=5, metering="known")
    db.add(usage)
    db.add(AICheckpoint(file_type="inbox", file_id=source["id"], consumed_user_text="snapshot", last_request_id=request_id))
    db.commit()
    usage_id = usage.id
    execute = db.execute
    def database_failure():
        execute(text("SELECT 1 / 0"))
    with monkeypatch.context() as patch:
        patch.setattr(db, "commit", database_failure)
        response = client.delete(f"/api/inboxes/{source['id']}", headers={"If-Match": '"1"'})
        assert response.status_code == 500
    assert db.scalar(text("SELECT 1")) == 1
    assert client.get(f"/api/inboxes/{source['id']}").status_code == 200
    assert db.get(AIRequest, request_id) is not None
    assert db.get(AICheckpoint, ("inbox", source["id"])) is not None
    assert db.get(AIUsage, usage_id).request_id == request_id
