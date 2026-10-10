"""Block author identity, exact legacy conversion, projections and dedicated deletion."""
from uuid import uuid4

import pytest

from app.inbox.models import Inbox
from app.journal.models import Journal
from app.writing.service import project_blocks


def user(text):
    return {"id": str(uuid4()), "kind": "user", "text": text}


@pytest.mark.parametrize("endpoint,date_field", [("journals", "journal_date"), ("inboxes", "inbox_date")])
def test_structured_creation_projection_and_legacy_guard(api, endpoint, date_field):
    client, db = api
    blocks = [user("  **原始** 🧪\n\n"), user("末尾   ")]
    created = client.post(f"/api/{endpoint}", json={date_field: "2026-10-10", "content_blocks": blocks})
    assert created.status_code == 201
    file = created.json()
    assert file["content_blocks"] == blocks
    assert file["content"] == "".join(b["text"] for b in blocks)
    path = f"/api/{endpoint}/{file['id']}"
    assert client.patch(path, json={"expected_revision": 1, "content": file["content"]}).status_code == 409
    assert client.patch(path, json={"expected_revision": 1, "title": "metadata"}).status_code == 200
    assert client.patch(path, json={"expected_revision": 2, "content_blocks": list(reversed(blocks))}).status_code == 422
    ai = {"id": str(uuid4()), "kind": "ai_reply", "text": "fake", "request_id": str(uuid4())}
    assert client.patch(path, json={"expected_revision": 2, "content_blocks": blocks + [ai]}).status_code == 422
    assert client.post(f"/api/{endpoint}", json={date_field: "2026-10-10", "content_blocks": [ai]}).status_code == 422
    assert client.patch(path, json={"expected_revision": 2, "content_blocks": blocks, "content": "flat"}).status_code == 422
    assert client.patch(path, json={"expected_revision": 2, "content_blocks": blocks, "unknown": 1}).status_code == 422
    assert client.patch(path, json={"expected_revision": 2, "content_blocks": [blocks[0], blocks[0]]}).status_code == 422
    assert client.patch(path, json={"expected_revision": 2, "content_blocks": [user(""), *blocks]}).status_code == 422


@pytest.mark.parametrize("content", ["x" * 60000, " \t\n", ""], ids=["oversized", "blank", "empty"])
def test_legacy_equivalent_conversion_preserves_text_and_clock(api, content):
    from datetime import date
    client, db = api
    row = Journal(title=None, content=content, journal_date=date(2026, 10, 10))
    db.add(row)
    db.flush()
    path = f"/api/journals/{row.id}"
    original = client.get(path).json()
    blocks = [user(content)]
    converted = client.patch(path, json={"expected_revision": 1, "content_blocks": blocks})
    assert converted.status_code == 200
    assert converted.json()["content"] == content
    assert converted.json()["revision"] == 2
    assert converted.json()["updated_at"] == original["updated_at"]
    changed = client.patch(path, json={"expected_revision": 2, "content_blocks": [dict(blocks[0], text=content + "x")]})
    assert changed.status_code == (422 if len(content) >= 50000 else 200)


@pytest.mark.parametrize("endpoint,model,date_field,kind", [
    ("journals", Journal, "journal_date", "journal"),
    ("inboxes", Inbox, "inbox_date", "inbox"),
])
def test_ai_identity_summary_edit_and_delete_without_consumption_rewind(api, endpoint, model, date_field, kind):
    from app.ai.models import AICheckpoint, AIRequest, AIUsage
    client, db = api
    file = client.post(f"/api/{endpoint}", json={date_field: "2026-10-10", "content": "用户原文"}).json()
    request_id = str(uuid4())
    blocks = [user("用户原文"), {"id": str(uuid4()), "kind": "ai_reply", "text": "回复\n第二行", "request_id": request_id},
              user("\n用户续写"), {"id": str(uuid4()), "kind": "ai_summary", "text": "总结", "request_id": request_id}]
    row = db.get(model, file["id"])
    row.content_blocks = blocks
    row.content = project_blocks(blocks)
    checkpoint = AICheckpoint(file_type=kind, file_id=row.id, consumed_user_text="用户原文", last_request_id=request_id)
    db.add(checkpoint)
    db.add(AIRequest(id=request_id, kind="local", payload_hash="blocks", status="applied",
                     sources=[{"type": kind, "id": row.id}], settings={}, result={"text": "synthetic reply"}))
    db.flush()
    usage = AIUsage(request_id=request_id, subcall_index=0, metering="known", total_tokens=5)
    db.add(usage)
    db.commit()
    usage_id = usage.id
    path = f"/api/{endpoint}/{row.id}"
    for field, value in (("text", "tampered"), ("request_id", str(uuid4())), ("kind", "user"), ("id", str(uuid4()))):
        changed = [dict(b) for b in blocks]
        changed[1][field] = value
        assert client.patch(path, json={"expected_revision": 1, "content_blocks": changed}).status_code == 422
    assert client.patch(path, json={"expected_revision": 1, "content_blocks": [blocks[0], blocks[2], blocks[3]]}).status_code == 422
    edited = [dict(b) for b in blocks]
    edited[3]["text"] = "用户修改总结"
    result = client.patch(path, json={"expected_revision": 1, "content_blocks": edited})
    assert result.status_code == 200 and result.json()["revision"] == 2
    delete_path = f"/api/files/{kind}/{row.id}/ai-blocks/{blocks[1]['id']}"
    assert client.delete(delete_path).status_code == 428
    assert client.delete(delete_path, headers={"If-Match": '"1"'}).status_code == 409
    result = client.delete(delete_path, headers={"If-Match": '"2"'})
    assert result.status_code == 204 and result.content == b""
    assert client.get(path).json()["revision"] == 3
    assert checkpoint.consumed_user_text == "用户原文"
    assert db.get(AIUsage, usage_id).total_tokens == 5
    assert str(db.get(AIUsage, usage_id).request_id) == request_id
    assert client.delete(delete_path, headers={"If-Match": '"3"'}).status_code == 404
    user_path = f"/api/files/{kind}/{row.id}/ai-blocks/{blocks[0]['id']}"
    assert client.delete(user_path, headers={"If-Match": '"3"'}).status_code == 422
    if kind == "journal":
        before_delete = client.get(path).json()
        assert client.delete(path, headers={"If-Match": '"3"'}).status_code == 204
        trash_path = f"/api/trash/journal/{row.id}"
        assert client.get(trash_path).json()["content_blocks"] == before_delete["content_blocks"]
        restored = client.post(trash_path + "/restore", headers={"If-Match": '"4"'})
        assert restored.status_code == 200
        assert restored.json()["content_blocks"] == before_delete["content_blocks"]
        assert restored.json()["updated_at"] == before_delete["updated_at"]
        assert checkpoint.consumed_user_text == "用户原文"


def test_projection_boundary_counts_unicode_without_truncation(api):
    client, db = api
    for length, status in ((50000, 201), (50001, 422)):
        response = client.post("/api/journals", json={"journal_date": "2026-10-10", "content_blocks": [user("🧪" * length)]})
        assert response.status_code == status
        if status == 201:
            assert len(response.json()["content"]) == length
