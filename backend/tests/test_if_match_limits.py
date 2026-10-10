"""S3-T01-IT-01: reject oversized revision headers without changing data."""
from uuid import uuid4

import pytest
from sqlalchemy import text

from app.ai.models import AICheckpoint, AIRequest, AIUsage
from app.journal.models import Journal
from app.writing.router import matched_revision
from app.writing.service import PreconditionRequired, WritingError, project_blocks
from scripts.prepare_test_db import BUSINESS_TABLES


INVALID_HEADERS = [
    pytest.param('"9223372036854775808"', id="bigint-plus-one"),
    pytest.param('"' + "9" * 20 + '"', id="20-digits"),
    pytest.param('"' + "9" * 4300 + '"', id="4300-digits"),
    pytest.param('"' + "9" * 4301 + '"', id="4301-digits"),
    pytest.param('"' + "9" * 4500 + '"', id="4500-digits"),
    pytest.param("1", id="unquoted"),
    pytest.param('"-1"', id="negative"),
    pytest.param('"0"', id="zero"),
    pytest.param('"abc"', id="non-numeric"),
]


@pytest.mark.parametrize("header,revision", [('"1"', 1), ('"9223372036854775807"', 9223372036854775807)])
def test_valid_revision_header_parses(header, revision):
    assert matched_revision(header) == revision


@pytest.mark.parametrize("header", INVALID_HEADERS)
def test_invalid_revision_header_raises_writing_error_422(header):
    with pytest.raises(WritingError) as error:
        matched_revision(header)
    assert error.value.status_code == 422


def test_missing_revision_header_raises_428():
    with pytest.raises(PreconditionRequired) as error:
        matched_revision(None)
    assert error.value.status_code == 428


@pytest.mark.parametrize("entry", ["journal", "inbox", "insight", "restore", "purge", "ai-block"])
def test_rejected_revision_headers_leave_all_business_data_unchanged(api, entry):
    client, db = api
    source = client.post("/api/journals", json={"journal_date": "2026-10-10", "content": "合成用户原文 🧪"}).json()
    inbox = client.post("/api/inboxes", json={"inbox_date": "2026-10-10", "content": "合成 Inbox"}).json()
    insight = client.post("/api/insights", json={"content": "合成 Insight"}).json()
    source_id = source["id"]
    request_id = uuid4()
    reply_id = uuid4()
    blocks = [
        {"id": str(uuid4()), "kind": "user", "text": source["content"]},
        {"id": str(reply_id), "kind": "ai_reply", "text": "合成回复", "request_id": str(request_id)},
    ]
    row = db.get(Journal, source_id)
    row.content_blocks = blocks
    row.content = project_blocks(blocks)
    db.add(AIRequest(id=request_id, kind="local", payload_hash="header-test", status="applied",
                     sources=[{"type": "journal", "id": source_id}], settings={}, result={"text": "synthetic"}))
    db.flush()
    db.add(AICheckpoint(file_type="journal", file_id=source_id, consumed_user_text=source["content"], last_request_id=request_id))
    db.add(AIUsage(request_id=request_id, subcall_index=0, total_tokens=7, search_requests=1, metering="known"))
    db.commit()
    if entry in ("restore", "purge"):
        assert client.delete(f"/api/journals/{source_id}", headers={"If-Match": '"1"'}).status_code == 204
    method, path = {
        "journal": ("DELETE", f"/api/journals/{source_id}"),
        "inbox": ("DELETE", f"/api/inboxes/{inbox['id']}"),
        "insight": ("DELETE", f"/api/insights/{insight['id']}"),
        "restore": ("POST", f"/api/trash/journal/{source_id}/restore"),
        "purge": ("DELETE", f"/api/trash/journal/{source_id}"),
        "ai-block": ("DELETE", f"/api/files/journal/{source_id}/ai-blocks/{reply_id}"),
    }[entry]

    def snapshot():
        return {table: db.execute(text(f"SELECT row_to_json(t)::text FROM {table} t ORDER BY row_to_json(t)::text")).all()
                for table in BUSINESS_TABLES}

    before = snapshot()
    # Labels avoid embedding thousands of digits in pytest IDs or assertion logs.
    for header, expected in [(None, 428), *[(case.values[0], 422) for case in INVALID_HEADERS]]:
        headers = {} if header is None else {"If-Match": header}
        response = client.request(method, path, headers=headers)
        assert snapshot() == before, "Rejected revision header changed business data"
        assert response.status_code == expected, f"{entry}: header length {len(header or '')}"
