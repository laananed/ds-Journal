"""S3-T03 metering tests: unique subcalls, unknown vs zero, typed file queries."""
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from sqlalchemy import event, select, text

from app.ai.client import ModelUsage
from app.ai.models import AIRequest, AIUsage
from app.ai.usage import CALLS_PAGE_SIZE, call_payload_hash, record_subcall

USAGE_TABLE = "SELECT count(*) FROM ai_usage"
WRITE_KEYWORDS = ("insert", "update", "delete")


def known(prompt=90, completion=18, total=108) -> ModelUsage:
    return ModelUsage(prompt, completion, total)


def ledger(client) -> dict[str, int]:
    """Read the global totals as a baseline.

    The ledger is append-only and shared with other modules that commit real
    rows, so absolute totals would depend on test order. Every assertion below
    compares against a baseline taken at the start of the case; the rows this
    test creates live inside its own rolled-back transaction.
    """
    response = client.get("/api/ai/usage")
    assert response.status_code == 200
    return response.json()


def delta(before: dict[str, int], client) -> dict[str, int]:
    after = ledger(client)
    return {key: after[key] - before[key] for key in before}


def add_request(db, *, kind="local", status="applied", sources=None, request_id=None,
                saved_target=None, created_at=None, result=None, question=None) -> AIRequest:
    request = AIRequest(
        id=request_id or uuid4(),
        kind=kind,
        payload_hash=call_payload_hash({"kind": kind, "sources": sources or []}),
        status=status,
        sources=sources or [],
        settings={"model": "deepseek-flash", "custom_prompt": ""},
        question=question,
        result=result,
        saved_target=saved_target,
        created_at=created_at or datetime.now(timezone.utc),
    )
    db.add(request)
    db.flush()
    return request


def make_journal(client, content="synthetic body", journal_date="2026-10-10") -> dict:
    return client.post("/api/journals",
                       json={"content": content, "journal_date": journal_date}).json()


def make_inbox(client, content="synthetic inbox", inbox_date="2026-10-10") -> dict:
    return client.post("/api/inboxes",
                       json={"content": content, "inbox_date": inbox_date}).json()


def counting_writes(engine):
    """Return ``(statements, stop)`` for real SQL sent to the database."""
    statements: list[str] = []

    def before_cursor_execute(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement.strip())

    event.listen(engine, "before_cursor_execute", before_cursor_execute)
    return statements, lambda: event.remove(engine, "before_cursor_execute",
                                            before_cursor_execute)


def write_statements(statements) -> list[str]:
    return [s for s in statements if s.lower().split()[0] in WRITE_KEYWORDS]


# ---------------------------------------------------------------------------
# Ledger writes
# ---------------------------------------------------------------------------

def test_record_subcall_persists_official_usage_for_one_subcall(api):
    client, db = api
    before = ledger(client)
    request = add_request(db)

    record = record_subcall(db, request_id=request.id, subcall_index=0, usage=known(),
                            response_id="chatcmpl-synthetic", search_requests=0)

    assert record.created is True
    row = db.get(AIUsage, record.usage_id)
    assert (row.prompt_tokens, row.completion_tokens, row.total_tokens) == (90, 18, 108)
    assert row.metering == "known" and row.subcall_index == 0
    assert row.response_id == "chatcmpl-synthetic" and row.search_requests == 0
    assert delta(before, client) == {
        "prompt_tokens": 90, "completion_tokens": 18, "total_tokens": 108,
        "unknown_subcalls": 0, "search_requests": 0,
    }


def test_duplicate_subcall_record_does_not_double_count(api):
    client, db = api
    before = ledger(client)
    request = add_request(db)

    first = record_subcall(db, request_id=request.id, subcall_index=0, usage=known())
    second = record_subcall(db, request_id=request.id, subcall_index=0, usage=known())
    third = record_subcall(db, request_id=request.id, subcall_index=0, usage=known())

    assert (first.created, second.created, third.created) == (True, False, False)
    assert second.usage_id == first.usage_id == third.usage_id
    # Scoped to this request: the ledger is shared with other modules.
    rows = db.scalars(select(AIUsage).where(AIUsage.request_id == request.id)).all()
    assert len(rows) == 1
    assert delta(before, client)["total_tokens"] == 108


def test_missing_official_usage_is_unknown_and_never_zero(api):
    client, db = api
    before = ledger(client)
    request = add_request(db)

    record = record_subcall(db, request_id=request.id, subcall_index=0, usage=None)

    row = db.get(AIUsage, record.usage_id)
    assert row.metering == "unknown"
    assert row.prompt_tokens is None and row.completion_tokens is None
    assert row.total_tokens is None
    assert delta(before, client) == {
        "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0,
        "unknown_subcalls": 1, "search_requests": 0,
    }


def test_unknown_subcall_never_subtracts_from_confirmed_totals(api):
    client, db = api
    before = ledger(client)
    metered = add_request(db)

    record_subcall(db, request_id=metered.id, subcall_index=0, usage=known(10, 5, 15))
    record_subcall(db, request_id=metered.id, subcall_index=1, usage=None)

    change = delta(before, client)
    assert change["total_tokens"] == 15 and change["unknown_subcalls"] == 1


def test_zero_token_usage_is_known_and_distinct_from_unknown(api):
    client, db = api
    before = ledger(client)
    request = add_request(db)

    record = record_subcall(db, request_id=request.id, subcall_index=0,
                            usage=ModelUsage(0, 0, 0, cache_hit_tokens=0, cache_miss_tokens=0))

    row = db.get(AIUsage, record.usage_id)
    assert row.metering == "known" and row.total_tokens == 0
    change = delta(before, client)
    assert change["unknown_subcalls"] == 0 and change["total_tokens"] == 0


def test_search_requests_are_counted_on_their_own_axis(api):
    client, db = api
    before = ledger(client)
    request = add_request(db, kind="review")

    record_subcall(db, request_id=request.id, subcall_index=0, usage=known(), search_requests=2)

    change = delta(before, client)
    assert change["search_requests"] == 2
    assert change["total_tokens"] == 108
    assert change["unknown_subcalls"] == 0


def test_search_requests_survive_without_official_usage(api):
    client, db = api
    before = ledger(client)
    request = add_request(db, kind="review")

    record_subcall(db, request_id=request.id, subcall_index=0, usage=None, search_requests=1)

    change = delta(before, client)
    assert change["search_requests"] == 1 and change["unknown_subcalls"] == 1


def test_global_total_sums_every_subcall_of_one_request(api):
    client, db = api
    before = ledger(client)
    request = add_request(db)

    record_subcall(db, request_id=request.id, subcall_index=0, usage=known(10, 5, 15),
                   search_requests=1)
    record_subcall(db, request_id=request.id, subcall_index=1, usage=known(20, 7, 27))

    assert delta(before, client) == {
        "prompt_tokens": 30, "completion_tokens": 12, "total_tokens": 42,
        "unknown_subcalls": 0, "search_requests": 1,
    }


def test_usage_without_a_request_is_still_counted_anonymously(api):
    client, db = api
    before = ledger(client)

    record_subcall(db, request_id=None, subcall_index=0, usage=known(7, 3, 10))

    assert delta(before, client)["total_tokens"] == 10


def test_deleting_the_source_keeps_anonymous_totals(api):
    client, db = api
    before = ledger(client)
    source = make_journal(client)
    request = add_request(db, kind="review",
                          sources=[{"type": "journal", "id": source["id"], "revision": 1,
                                    "user_text": "private snapshot"}])
    record_subcall(db, request_id=request.id, subcall_index=0, usage=known(11, 4, 15),
                   search_requests=1)
    usage_id = db.scalar(select(AIUsage.id).where(AIUsage.request_id == request.id))

    # Mirrors the T01 permanent-delete path: private request rows go, metering stays.
    from app.writing.service import cleanup_private_ai
    request_id = request.id
    cleanup_private_ai(db, "journal", source["id"])
    db.commit()

    assert db.get(AIRequest, request_id) is None
    # The row survives with its numbers, but its link to the deleted request is gone.
    surviving = db.get(AIUsage, usage_id)
    assert surviving is not None
    assert surviving.request_id is None and surviving.total_tokens == 15
    assert delta(before, client) == {
        "prompt_tokens": 11, "completion_tokens": 4, "total_tokens": 15,
        "unknown_subcalls": 0, "search_requests": 1,
    }


def test_global_usage_issues_no_write_statement(api):
    client, db = api
    statements, stop = counting_writes(db.get_bind())
    try:
        assert client.get("/api/ai/usage").status_code == 200
    finally:
        stop()

    assert write_statements(statements) == []


# ---------------------------------------------------------------------------
# Per-file call listing
# ---------------------------------------------------------------------------

def test_file_calls_list_only_that_typed_identity(api):
    client, db = api
    journal = make_journal(client)
    inbox = make_inbox(client)
    mine = add_request(db, sources=[{"type": "journal", "id": journal["id"], "revision": 2}])
    theirs = add_request(db, sources=[{"type": "inbox", "id": inbox["id"], "revision": 1}])
    record_subcall(db, request_id=mine.id, subcall_index=0, usage=known(3, 4, 7))
    record_subcall(db, request_id=theirs.id, subcall_index=0, usage=known(100, 100, 200))

    page = client.get(f"/api/files/journal/{journal['id']}/ai-calls").json()

    assert page["total"] == 1 and page["page_size"] == CALLS_PAGE_SIZE
    assert page["has_next"] is False
    assert [item["request_id"] for item in page["items"]] == [str(mine.id)]
    assert page["items"][0]["total_tokens"] == 7
    # Same numeric id in the other table must not leak in (no shared id space).
    other = client.get(f"/api/files/inbox/{inbox['id']}/ai-calls").json()
    assert [item["request_id"] for item in other["items"]] == [str(theirs.id)]


def test_multi_source_call_appears_in_every_source_but_counts_once_globally(api):
    client, db = api
    before = ledger(client)
    first = make_journal(client, content="one")
    second = make_journal(client, content="two", journal_date="2026-10-09")
    request = add_request(db, kind="review", sources=[
        {"type": "journal", "id": first["id"], "revision": 1, "user_text": "one"},
        {"type": "journal", "id": second["id"], "revision": 1, "user_text": "two"},
    ])
    record_subcall(db, request_id=request.id, subcall_index=0, usage=known(50, 25, 75))

    one = client.get(f"/api/files/journal/{first['id']}/ai-calls").json()
    two = client.get(f"/api/files/journal/{second['id']}/ai-calls").json()

    assert [i["request_id"] for i in one["items"]] == [str(request.id)]
    assert [i["request_id"] for i in two["items"]] == [str(request.id)]
    assert [s["id"] for s in one["items"][0]["sources"]] == [first["id"], second["id"]]
    # One ledger row, so the global total counts it once.
    assert delta(before, client)["total_tokens"] == 75


def test_file_calls_do_not_expose_private_request_content(api):
    client, db = api
    journal = make_journal(client)
    secret_question = "为什么我总担心做不好？"
    request = add_request(db, sources=[{"type": "journal", "id": journal["id"], "revision": 3,
                                        "user_text": "private user snapshot"}],
                          question=secret_question,
                          result={"facts": ["private model output"]})
    record_subcall(db, request_id=request.id, subcall_index=0, usage=known())

    body = client.get(f"/api/files/journal/{journal['id']}/ai-calls").text

    assert secret_question not in body
    assert "private user snapshot" not in body
    assert "private model output" not in body
    item = client.get(f"/api/files/journal/{journal['id']}/ai-calls").json()["items"][0]
    assert item["sources"] == [{"type": "journal", "id": journal["id"], "revision": 3}]
    assert "question" not in item and "result" not in item and "settings" not in item


def test_file_calls_include_saved_target_only_when_well_formed(api):
    client, db = api
    journal = make_journal(client)
    target = make_journal(client, content="saved summary", journal_date="2026-10-08")
    saved = add_request(db, kind="review", sources=[{"type": "journal", "id": journal["id"]}],
                        saved_target={"type": "journal", "id": target["id"]})
    broken = add_request(db, kind="review", sources=[{"type": "journal", "id": journal["id"]}],
                         saved_target={"type": "inbox", "id": 3})

    page = client.get(f"/api/files/journal/{journal['id']}/ai-calls").json()
    by_id = {item["request_id"]: item for item in page["items"]}

    assert by_id[str(saved.id)]["saved_target"] == {"type": "journal", "id": target["id"]}
    # An unusable stored target is omitted rather than reported as a target.
    assert "saved_target" not in by_id[str(broken.id)]


def test_label_free_source_entries_are_dropped_from_identities(api):
    client, db = api
    journal = make_journal(client)
    add_request(db, sources=[{"type": "journal", "id": journal["id"]},
                             {"type": "insight", "id": 5},
                             {"type": "journal", "id": "7"},
                             "not-a-source"])

    item = client.get(f"/api/files/journal/{journal['id']}/ai-calls").json()["items"][0]

    assert item["sources"] == [{"type": "journal", "id": journal["id"]}]


def test_file_calls_report_per_call_metering_including_unknown(api):
    client, db = api
    journal = make_journal(client)
    known_call = add_request(db, sources=[{"type": "journal", "id": journal["id"]}])
    unknown_call = add_request(db, sources=[{"type": "journal", "id": journal["id"]}])
    record_subcall(db, request_id=known_call.id, subcall_index=0, usage=known(12, 6, 18),
                   search_requests=1)
    record_subcall(db, request_id=unknown_call.id, subcall_index=0, usage=None)

    items = {item["request_id"]: item
             for item in client.get(f"/api/files/journal/{journal['id']}/ai-calls").json()["items"]}

    assert items[str(known_call.id)]["total_tokens"] == 18
    assert items[str(known_call.id)]["unknown_subcalls"] == 0
    assert items[str(known_call.id)]["search_requests"] == 1
    assert items[str(unknown_call.id)]["unknown_subcalls"] == 1
    assert items[str(unknown_call.id)]["total_tokens"] == 0
    assert items[str(unknown_call.id)]["subcalls"] == 1


def test_file_calls_paginate_newest_first_and_are_bounded(api):
    client, db = api
    journal = make_journal(client)
    base = datetime.now(timezone.utc)
    requests = [
        add_request(db, sources=[{"type": "journal", "id": journal["id"]}],
                    created_at=base - timedelta(minutes=offset))
        for offset in range(CALLS_PAGE_SIZE + 1)
    ]

    first = client.get(f"/api/files/journal/{journal['id']}/ai-calls").json()
    second = client.get(f"/api/files/journal/{journal['id']}/ai-calls?page=2").json()
    beyond = client.get(f"/api/files/journal/{journal['id']}/ai-calls?page=3").json()

    assert first["total"] == CALLS_PAGE_SIZE + 1 and first["has_next"] is True
    assert len(first["items"]) == CALLS_PAGE_SIZE
    assert first["items"][0]["request_id"] == str(requests[0].id)  # newest first
    assert second["has_next"] is False and len(second["items"]) == 1
    assert second["items"][0]["request_id"] == str(requests[-1].id)
    assert beyond["items"] == [] and beyond["total"] == CALLS_PAGE_SIZE + 1


def test_file_calls_validate_identity_and_ignore_other_files(api):
    client, db = api
    journal = make_journal(client)
    other = make_journal(client, content="other", journal_date="2026-10-09")
    add_request(db, sources=[{"type": "journal", "id": other["id"]}])

    assert client.get(f"/api/files/journal/{journal['id']}/ai-calls").json()["items"] == []
    assert client.get("/api/files/journal/999999/ai-calls").status_code == 404
    assert client.get("/api/files/inbox/999999/ai-calls").status_code == 404
    assert client.get("/api/files/insight/1/ai-calls").status_code == 422
    assert client.get(f"/api/files/journal/{journal['id']}/ai-calls?page=0").status_code == 422


def test_soft_deleted_source_entry_is_not_usable(api):
    client, db = api
    journal = make_journal(client)
    add_request(db, sources=[{"type": "journal", "id": journal["id"]}])

    assert client.delete(f"/api/journals/{journal['id']}",
                         headers={"If-Match": '"1"'}).status_code == 204

    assert client.get(f"/api/files/journal/{journal['id']}/ai-calls").status_code == 404


def test_file_calls_page_issues_no_write_statement(api):
    client, db = api
    journal = make_journal(client)
    add_request(db, sources=[{"type": "journal", "id": journal["id"]}])
    statements, stop = counting_writes(db.get_bind())
    try:
        assert client.get(f"/api/files/journal/{journal['id']}/ai-calls").status_code == 200
    finally:
        stop()

    assert write_statements(statements) == []


def test_call_payload_hash_is_stable_and_order_independent():
    first = call_payload_hash({"request_id": "a", "sources": [{"type": "journal", "id": 1}]})
    second = call_payload_hash({"sources": [{"type": "journal", "id": 1}], "request_id": "a"})
    third = call_payload_hash({"request_id": "a", "sources": [{"type": "journal", "id": 2}]})

    assert first == second and first != third and len(first) == 64
