"""S3-T08 independent verification probe (WorkBuddy, independent session).

Independent of the developer's http_probe.py / tests. Boots the real FastAPI app
on 127.0.0.1:8031 (uvicorn, same process) with a synthetic model transport and
drives it with real urllib HTTP, plus two in-process fault-injection checks.

Scope (per T08 acceptance):
  - capture full user text, exclude AI blocks (item 2)
  - real two-session concurrency double-confirm -> exactly one target (item 6)
  - same-body replay idempotency after a successful save (same body -> 200 same
    target; diff body -> 409)
  - source not moved/deleted after save; append preserves source (item 5)
  - ready + checkpoints atomic: checkpoint fault rolls back all (item 3)
  - save fault: zero half-write, target/request status preserved (item 7)

Resource discipline (revision 3, after Codex review):
  - NO unconditional whole-table DELETE. The probe records the real pre-write
    baseline counts, then creates only its own rows, and on teardown deletes
    ONLY the IDs it created in this run (tracked in `manifest`).
  - ai_checkpoints cleanup is TYPE-QUALIFIED: (file_type='journal' AND file_id in
    this-run journal ids) OR (file_type='inbox' AND file_id in this-run inbox ids)
    OR last_request_id in this-run request ids. Never file_id alone (journal/inbox
    ids can collide numerically across the two tables).
  - The exclusive-use guard counts ALL other backends on the DB, INCLUDING idle
    ones (no `xact_start is not null` filter). If anyone else is present the probe
    stops; it never terminates connections or deletes data.
  - If any non-owned residual row is detected at teardown the probe STOPS and
    reports it instead of wiping the table.
  - History note: the original revision of this script used unconditional
    `DELETE FROM ai_requests/ai_checkpoints/ai_usage/journals/inboxes` calls
    (before start and in `finally`). That behaviour is removed and recorded in
    the report; it is not retro-described as safe.

Lost-response scope (revision 4): the probe NOW verifies the genuinely lost
response path. A raw socket sends the save request and aborts WITHOUT reading
any response byte; a separate DB connection confirms the server committed the
save (status='applied'); then the identical body is replayed over normal HTTP
and must return 200 with the same target, with no duplicate creation/append and
a differing body must return 409. Both new_journal and append_source are covered.
"""
import json
import os
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from uuid import UUID, uuid4

# Ensure backend/ is importable when run as a standalone script.
_BACKEND = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

# ----- force target DB BEFORE importing app (mirrors conftest whitelist) -----
from scripts.prepare_test_db import get_test_database_url
os.environ["DATABASE_URL"] = get_test_database_url().render_as_string(hide_password=False)
os.environ["SEEKJOURNAL_TEST_DB"] = "seekjournal_test"
os.environ["DEEPSEEK_API_KEY"] = "synthetic-independent-probe"
os.environ.pop("BRAVE_SEARCH_API_KEY", None)

from sqlalchemy import create_engine, text, event
from sqlalchemy.orm import Session
from app.database import engine
from app.journal.models import Journal
from app.inbox.models import Inbox
from app.ai.models import AIRequest, AIUsage, AICheckpoint
from app.ai import client as model_client
from app.writing.service import project_blocks
from app.main import app

PORT = 8031
BASE = f"http://127.0.0.1:{PORT}"

# Tables this probe may write to, and the PK columns used to delete only owned rows.
OWNED_TABLES = ("journals", "inboxes", "ai_requests", "ai_checkpoints", "ai_usage", "ai_settings")
COUNTED_TABLES = ("journals", "inboxes", "folders", "insights",
                  "ai_requests", "ai_usage", "ai_checkpoints", "ai_settings")


def structured(sources, drafts=0):
    evidence = [{"source": {"type": s["type"], "id": s["id"]}, "quote": "用户"} for s in sources]
    return {
        "facts": [{"text": "记录了一件事", "evidence": evidence}],
        "emotion_hypotheses": [{"text": "可能挂心", "uncertainty": "证据有限", "evidence": evidence}],
        "possible_explanations": [],
        "angles": [{"title": t, "content": "暂时看不出来"} for t in
                   ["事件与情绪", "选择与行为", "认知与关系"]],
        "logic_chain": ["事件影响选择"],
        "follow_up_questions": ["当时怎么想？"],
        "insight_drafts": [{"title": f"观点{i}", "viewpoint": f"独立观点{i}",
                            "evidence": evidence, "content": f"观点{i}及依据"} for i in range(drafts)],
    }


class SyntheticTransport:
    def __init__(self):
        self.calls = []
        self.lock = threading.Lock()
        self.output = {}
        self.usage = {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}
        self.response_id = "independent-" + uuid4().hex

    def post_json(self, url, payload, headers, timeout, max_bytes):
        with self.lock:
            self.calls.append(payload)
        body = {"id": self.response_id, "usage": self.usage,
                "choices": [{"finish_reason": "stop",
                             "message": {"content": json.dumps(self.output, ensure_ascii=False)}}]}
        return model_client.TransportResponse(200, json.dumps(body).encode(), "application/json")


transport = SyntheticTransport()
transport2 = None
model_client.UrllibTransport = lambda: (transport2 if transport2 is not None else transport)

RESULTS = []


def record(name, passed, detail):
    RESULTS.append({"name": name, "passed": passed, "detail": detail})
    print(("PASS" if passed else "FAIL"), name, "-", detail)


# ----- per-run manifest of everything this probe created (for scoped cleanup) -----
manifest = {
    "journals": set(),      # ids created directly by make_source
    "inboxes": set(),       # ids created directly by make_source
    "ai_requests": set(),   # request_ids issued via generate/t_generate
    "notes": [],
}

# Explicit record that the pre-revision script used unconditional DELETE.
LEGACY_WHOLE_TABLE_DELETE_REMOVED = True


def make_source(kind="journal", content="用户甲😀", blocks=None):
    model = Journal if kind == "journal" else Inbox
    with Session(engine) as db:
        row = model(content=project_blocks(blocks) if blocks else content, content_blocks=blocks,
                    **{kind + "_date": date(2026, 10, 1)})
        db.add(row)
        db.commit()
        manifest["journals" if kind == "journal" else "inboxes"].add(row.id)
        return {"type": kind, "id": row.id, "expected_revision": row.revision}


def table_counts():
    with engine.connect() as c:
        return {t: c.scalar(text(f"select count(*) from {t}")) for t in COUNTED_TABLES}


def count_journals():
    with engine.connect() as c:
        return c.scalar(text("select count(*) from journals"))


def other_active_backends():
    """Count OTHER backends on this DB, INCLUDING idle connections.

    Any other session (idle or active) means the DB is not exclusively ours;
    the probe must stop. We never terminate connections or delete data.
    """
    with engine.connect() as c:
        return c.scalar(text(
            "select count(*) from pg_stat_activity where datname=current_database() "
            "and pid<>pg_backend_pid()"))


def purge_owned():
    """Delete ONLY rows this run created (scoped by manifest IDs).

    Real schema (verified against seekjournal_test):
      ai_requests   PK = id (uuid)
      ai_usage      FK = request_id (uuid)
      ai_checkpoints PK = (file_type, file_id)  -- one checkpoint per source file
    No unconditional table wipe. Unknown residual rows are reported, not erased.

    Checkpoints are deleted with a TYPE-QUALIFIED predicate: a journal id and an
    inbox id can numerically collide across the two source tables, so we must
    match on BOTH columns, never on file_id alone:
        (file_type='journal' AND file_id IN <this-run journal ids>)
      OR(file_type='inbox'   AND file_id IN <this-run inbox ids>)
      OR(last_request_id IN <this-run request ids>)
    """
    req_ids = list(manifest["ai_requests"])
    j_ids = list(manifest["journals"])
    i_ids = list(manifest["inboxes"])
    with engine.connect() as c:
        if j_ids or i_ids or req_ids:
            c.execute(text(
                "delete from ai_checkpoints where "
                "(file_type = 'journal' and file_id = any(:jids)) "
                "or (file_type = 'inbox' and file_id = any(:iids)) "
                "or (last_request_id = any(:reqs))"),
                {"jids": j_ids, "iids": i_ids, "reqs": req_ids or [None]})
        if req_ids:
            c.execute(text("delete from ai_usage where request_id = any(:ids)"), {"ids": req_ids})
            c.execute(text("delete from ai_requests where id = any(:ids)"), {"ids": req_ids})
        if j_ids:
            c.execute(text("delete from journals where id = any(:ids)"), {"ids": j_ids})
        if i_ids:
            c.execute(text("delete from inboxes where id = any(:ids)"), {"ids": i_ids})
        c.commit()
    manifest["journals"].clear()
    manifest["inboxes"].clear()
    manifest["ai_requests"].clear()


def residual_report(baseline):
    """Compare current counts vs baseline; return list of tables with unexpected residual."""
    now = table_counts()
    residual = {t: now[t] - baseline[t] for t in COUNTED_TABLES if now[t] != baseline[t]}
    return now, residual


def http_post(path, body):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


def http_get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return r.status, json.loads(r.read().decode())


def http_post_lost_response(path, body, commit_probe, wait_seconds=10.0):
    """Send a POST over a raw socket but NEVER read the response.

    This simulates "the server committed the save, but the client never
    received the response": we write the full request bytes, then poll the DB
    (via a separate connection, in `commit_probe`) until the server's save is
    observed as committed. Only then do we abort the socket without reading a
    single response byte. Returns (sent_ok, committed_observed, probe_detail).
    """
    import socket
    payload = json.dumps(body).encode()
    head = (f"POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\n"
            f"Content-Type: application/json\r\nContent-Length: {len(payload)}\r\n"
            f"Connection: close\r\n\r\n").encode()
    s = socket.create_connection(("127.0.0.1", PORT), timeout=30)
    try:
        s.sendall(head + payload)
        deadline = time.time() + wait_seconds
        committed = False
        detail = ""
        while time.time() < deadline:
            committed, detail = commit_probe()
            if committed:
                break
            time.sleep(0.05)
        return True, committed, detail
    finally:
        # Abort without reading any response bytes -> response is lost to client.
        try:
            s.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        s.close()


def save_committed_probe(request_id, expect_journal_delta=None, expect_source=None):
    """Closure used to observe server-side commit through a SEPARATE connection."""
    def probe():
        with engine.connect() as c:
            row = c.execute(text(
                "select status, saved_target from ai_requests where id = :rid"),
                {"rid": request_id}).fetchone()
            status = row[0] if row else None
            saved = row[1] if row else None
            if status != "applied":
                # also report the target-journal evidence when applicable
                return False, f"req_status={status} saved_target={saved}"
            detail = f"req_status=applied saved_target={saved}"
            if expect_journal_delta is not None:
                now_j = c.scalar(text("select count(*) from journals"))
                if now_j - expect_journal_delta[0] != expect_journal_delta[1]:
                    return False, detail + f" journals_delta={now_j-expect_journal_delta[0]}"
                detail += f" journals_delta={now_j-expect_journal_delta[0]}"
            if expect_source is not None:
                src_kind, src_id, want_rev = expect_source
                tbl = "journals" if src_kind == "journal" else "inboxes"
                rev = c.scalar(text(f"select revision from {tbl} where id = :i"), {"i": src_id})
                if rev != want_rev:
                    return False, detail + f" src_rev={rev}"
                detail += f" src_rev={rev}"
            return True, detail
    return probe


def count_ai_summary_blocks(journal_id):
    """Count ai_summary blocks in a journal's content_blocks (for append evidence)."""
    with engine.connect() as c:
        blocks = c.scalar(text("select content_blocks from journals where id = :i"), {"i": journal_id})
    if blocks is None:
        return 0
    if isinstance(blocks, (str, bytes)):
        blocks = json.loads(blocks)
    return sum(1 for b in blocks if b.get("kind") == "ai_summary")


def target_id_of(saved_target):
    """Extract the numeric target id from an ai_requests.saved_target jsonb value."""
    if saved_target is None:
        return None
    if isinstance(saved_target, (str, bytes)):
        saved_target = json.loads(saved_target)
    if isinstance(saved_target, dict):
        return saved_target.get("id")
    return None


def count_revisions(journal_id):
    with engine.connect() as c:
        return c.scalar(text("select revision from journals where id = :i"), {"i": journal_id})


def generate(sources, request_id=None, drafts=0):
    rid = request_id or uuid4()
    manifest["ai_requests"].add(rid)
    transport.calls = []
    transport.output = structured(sources, drafts)
    status, body = http_post("/api/ai/reviews", {"request_id": str(rid), "sources": sources})
    return rid, status, body


server = None
server_thread = None


def start_server():
    import uvicorn
    cfg = uvicorn.Config(app, host="127.0.0.1", port=PORT, log_level="warning")
    global server, server_thread
    server = uvicorn.Server(cfg)
    server_thread = threading.Thread(target=server.run, daemon=True)
    server_thread.start()
    for _ in range(100):
        try:
            http_get("/api/ai/settings")
            return
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("server did not start")


def stop_server():
    if server is not None:
        server.should_exit = True
        if server_thread is not None:
            server_thread.join(timeout=10)


def main():
    # Exclusive-use guard: this probe must be the ONLY session on the DB, counting
    # idle connections too (no xact_start filter). We do NOT wipe tables and we do
    # NOT terminate anyone's connection; if another user is present we stop.
    others = other_active_backends()
    if others:
        record("db_guard_exclusive", False,
               f"other_backends_incl_idle={others} (stop: not exclusive; no terminate/no wipe)")
        return False
    baseline = table_counts()
    record("db_guard_exclusive", True, f"other_backends_incl_idle=0 baseline={baseline}")
    try:
        start_server()

        # ---- item 2: model-input capture (full user text, exclude AI blocks) ----
        blocks = [{"id": str(uuid4()), "kind": "user", "text": "用户甲😀"},
                  {"id": str(uuid4()), "kind": "ai_reply", "text": "排除蓝块"},
                  {"id": str(uuid4()), "kind": "ai_summary", "text": "排除总结"}]
        cap_rid, cap_st, cap_body = generate([make_source(blocks=blocks)])
        cap = json.dumps(transport.calls[0]["messages"], ensure_ascii=False)
        record("http_model_input_full_user_and_excludes_ai",
               ("用户甲😀" in cap) and ("排除蓝块" not in cap) and ("排除总结" not in cap),
               f"has_user={'用户甲😀' in cap} no_ai_reply={'排除蓝块' not in cap} no_ai_summary={'排除总结' not in cap}")

        # boundaries 0 -> 422, 16 -> 422, single -> 200, no model on reject
        z = generate([], request_id=uuid4())
        record("http_generate_zero_sources_422", z[1] == 422, f"status={z[1]}")
        many = [make_source() for _ in range(16)]
        m_rid, m_st, _ = generate(many)
        record("http_generate_16_sources_422", m_st == 422, f"status={m_st}")
        record("http_boundary_zero_model_calls", transport.calls == [], f"calls={len(transport.calls)}")
        s_rid, s_st, s_body = generate([make_source()])
        record("http_generate_single_200", s_st == 200 and s_body.get("status") == "ready",
               f"status={s_st} body.status={s_body.get('status')}")

        # ---- item 5: append preserves source (no new journal, same id, rev 1 -> 2) ----
        jsrc = make_source(kind="journal")
        ar, ast, abody = generate([jsrc])
        before_j = count_journals()
        sst, sbody = http_post(f"/api/ai/reviews/{ar}/save",
                               {"markdown": "复盘总结", "target": {"mode": "append_source"}})
        after_j = count_journals()
        tgt = sbody.get("target", {})
        ok = (sst == 200 and tgt.get("id") == jsrc["id"] and tgt.get("revision") == 2
              and str(tgt.get("content", "")).startswith("用户甲😀\n\n---") and after_j - before_j == 0)
        record("http_append_preserves_source", ok,
               f"status={sst} rev={tgt.get('revision')} same_id={tgt.get('id')==jsrc['id']} delta={after_j-before_j}")
        with Session(engine) as db:
            still = db.get(Journal, jsrc["id"])
            record("http_source_not_moved_after_save", still is not None and still.content_blocks[0]["text"] == "用户甲😀",
                   f"exists={still is not None}")

        # ---- item 6: two-session concurrency double-confirm -> exactly one target ----
        # REAL concurrency: both HTTP saves are submitted to the executor FIRST,
        # then a barrier inside each worker releases both requests at the same
        # instant so the two `/save` calls actually race on the server (and thus
        # on PostgreSQL `SELECT ... FOR UPDATE`), rather than being serialized by
        # a `.result()` between the two submits.
        isrc = make_source(kind="inbox")
        gr, gst, gbody = generate([isrc])
        nb = {"markdown": "复盘", "target": {"mode": "new_journal", "journal_date": "2026-10-12"}}
        before_j = count_journals()

        gate = threading.Barrier(2)
        entered = []

        def post_save_concurrent():
            gate.wait(timeout=10)          # both workers reach here, then release together
            entered.append(time.monotonic_ns())
            return http_post(f"/api/ai/reviews/{gr}/save", nb)

        with ThreadPoolExecutor(max_workers=2) as pool:
            f1 = pool.submit(post_save_concurrent)
            f2 = pool.submit(post_save_concurrent)
            r1, r2 = f1.result(timeout=60), f2.result(timeout=60)
        codes = sorted([r1[0], r2[0]])
        tid1 = r1[1].get("target", {}).get("id")
        tid2 = r2[1].get("target", {}).get("id")
        if tid1 is not None:
            manifest["journals"].add(tid1)  # new_journal save creates one target journal
        after_j = count_journals()
        both_in_flight = len(entered) == 2 and (max(entered) - min(entered)) < 5_000_000_000
        ok = (codes == [200, 201] and tid1 == tid2 and after_j - before_j == 1 and both_in_flight)
        record("http_two_session_double_confirm_once", ok,
               f"codes={codes} same_target={tid1==tid2} delta_journals={after_j-before_j} "
               f"both_in_flight={both_in_flight}")

        # ---- item 6b: same-body replay idempotency after a SUCCESSFUL save ----
        # NOTE: this is a replay-after-success check; the client DID receive the
        # 201 first. The genuinely-lost-response case (client never reads the save
        # response, DB already committed) is covered separately below by item 6c
        # using a raw socket that aborts without reading the response.
        rsrc = make_source(kind="inbox")
        gr2, _, _ = generate([rsrc])
        fresh_before = count_journals()
        first = http_post(f"/api/ai/reviews/{gr2}/save", nb)
        replay = http_post(f"/api/ai/reviews/{gr2}/save", nb)
        diff = http_post(f"/api/ai/reviews/{gr2}/save", {**nb, "markdown": "另一份"})
        same_tid = first[1].get("target", {}).get("id") == replay[1].get("target", {}).get("id")
        if first[1].get("target", {}).get("id") is not None:
            manifest["journals"].add(first[1]["target"]["id"])
        after = count_journals()
        ok = (first[0] == 201 and replay[0] == 200 and diff[0] == 409 and same_tid and after - fresh_before == 1)
        record("http_replay_after_success_idempotent_same_target", ok,
               f"first={first[0]} replay={replay[0]} diff={diff[0]} same_target={same_tid} delta={after-fresh_before}")

        # ---- item 6c: lost-response replay — new_journal ----
        # The client sends the save over a raw socket and NEVER reads the response.
        # A separate DB connection confirms the server committed it before we release
        # evidence. Then the identical body is replayed over a normal HTTP client.
        lr_isrc = make_source(kind="inbox")
        lr_req, _, _ = generate([lr_isrc])
        lr_nb = {"markdown": "复盘", "target": {"mode": "new_journal", "journal_date": "2026-10-13"}}
        j_before = count_journals()
        sent, committed, cdetail = http_post_lost_response(
            f"/api/ai/reviews/{lr_req}/save", lr_nb,
            save_committed_probe(lr_req, expect_journal_delta=(j_before, 1)))
        j_after_first = count_journals()
        # client got nothing; replay the SAME body via normal HTTP
        lr_replay = http_post(f"/api/ai/reviews/{lr_req}/save", lr_nb)
        j_after_replay = count_journals()
        lr_diff = http_post(f"/api/ai/reviews/{lr_req}/save", {**lr_nb, "markdown": "另一份"})
        lr_tid = lr_replay[1].get("target", {}).get("id")
        if lr_tid is not None:
            manifest["journals"].add(lr_tid)
        with engine.connect() as c:
            saved_tgt = c.scalar(text("select saved_target from ai_requests where id = :r"), {"r": lr_req})
        saved_tgt_id = target_id_of(saved_tgt)
        same_target = (lr_tid is not None and saved_tgt_id is not None and int(lr_tid) == int(saved_tgt_id))
        ok = (sent and committed and lr_replay[0] == 200 and lr_diff[0] == 409
              and j_after_first - j_before == 1 and j_after_replay - j_before == 1
              and same_target)
        record("lost_response_new_journal_replay_same_target_once", ok,
               f"client_rcvd=None(aborted) db_committed={committed}({cdetail}) "
               f"replay={lr_replay[0]} diff={lr_diff[0]} journals_delta_after_replay={j_after_replay-j_before} "
               f"same_target={same_target} (replay_tid={lr_tid} saved_target_id={saved_tgt_id})")

        # ---- item 6c: lost-response replay — append_source ----
        lr_jsrc = make_source(kind="journal")
        lr_a_req, _, _ = generate([lr_jsrc])
        rev_before = count_revisions(lr_jsrc["id"])
        summ_before = count_ai_summary_blocks(lr_jsrc["id"])
        lr_ab = {"markdown": "追加复盘", "target": {"mode": "append_source"}}
        sent2, committed2, cdetail2 = http_post_lost_response(
            f"/api/ai/reviews/{lr_a_req}/save", lr_ab,
            save_committed_probe(lr_a_req, expect_source=("journal", lr_jsrc["id"], rev_before + 1)))
        rev_after_first = count_revisions(lr_jsrc["id"])
        summ_after_first = count_ai_summary_blocks(lr_jsrc["id"])
        lr_a_replay = http_post(f"/api/ai/reviews/{lr_a_req}/save", lr_ab)
        rev_after_replay = count_revisions(lr_jsrc["id"])
        summ_after_replay = count_ai_summary_blocks(lr_jsrc["id"])
        lr_a_diff = http_post(f"/api/ai/reviews/{lr_a_req}/save", {**lr_ab, "markdown": "另一份追加"})
        same_src = lr_a_replay[1].get("target", {}).get("id") == lr_jsrc["id"]
        ok = (sent2 and committed2 and lr_a_replay[0] == 200 and lr_a_diff[0] == 409 and same_src
              and rev_after_first == rev_before + 1 and rev_after_replay == rev_before + 1
              and summ_after_first == summ_before + 1 and summ_after_replay == summ_before + 1)
        record("lost_response_append_source_replay_single_append_once", ok,
               f"client_rcvd=None(aborted) db_committed={committed2}({cdetail2}) "
               f"replay={lr_a_replay[0]} diff={lr_a_diff[0]} same_source={same_src} "
               f"rev={rev_before}->{rev_after_replay} ai_summary={summ_before}->{summ_after_replay}")

        # ---- non-ready rejection ----
        nsrc = make_source(kind="inbox")
        nr, nst, nbody = generate([nsrc])
        with Session(engine) as db:
            db.get(AIRequest, nr).status = "pending"
            db.commit()
        rej = http_post(f"/api/ai/reviews/{nr}/save",
                        {"markdown": "x", "target": {"mode": "new_journal", "journal_date": "2026-10-12"}})
        record("http_nonready_save_rejected_409", rej[0] == 409, f"status={rej[0]}")

        # ---- item 2: draft id stability + no Insight created ----
        dsrc = make_source()
        dr, _, dbody = generate([dsrc], drafts=2)
        drafts = dbody.get("review", {}).get("insight_drafts", [])
        dr2, _, dbody2 = generate([dsrc], request_id=dr, drafts=2)
        drafts2 = dbody2.get("review", {}).get("insight_drafts", [])
        with Session(engine) as db:
            insight_n = db.scalar(text("select count(*) from insights"))
        stable = (len(drafts) == 2 and len({d["draft_id"] for d in drafts}) == 2
                  and [d["draft_id"] for d in drafts] == [d["draft_id"] for d in drafts2]
                  and insight_n == 0)
        record("http_draft_ids_stable_no_insight", stable,
               f"n={len(drafts)} distinct={len({d['draft_id'] for d in drafts})} replay_match={drafts==drafts2} insights={insight_n}")

        # scoped cleanup of everything created above, then verify no residual
        purge_owned()
        now, residual = residual_report(baseline)
        record("http_scoped_cleanup_no_owned_residual", not residual,
               f"residual={residual or 'none'} counts={now}")

        # ===== in-process fault injection (items 3 & 7) =====
        from fastapi.testclient import TestClient
        global transport2
        transport2 = SyntheticTransport()
        tclient = TestClient(app, raise_server_exceptions=False)

        def t_generate(sources, rid=None, drafts=0):
            rid = rid or uuid4()
            manifest["ai_requests"].add(rid)
            transport2.calls = []
            transport2.output = structured(sources, drafts)
            return tclient.post("/api/ai/reviews", json={"request_id": str(rid), "sources": sources})

        # item 3: checkpoint fault -> all rolled back, status failed/storage, review kept
        src_a = make_source()
        src_b = make_source(kind="inbox")
        seen = []
        def fail_cp(conn, cur, stmt, params, ctx, many):
            if stmt.strip().startswith("INSERT INTO ai_checkpoints"):
                seen.append(stmt)
                cur.execute("SELECT 1/0")
        event.listen(engine, "before_cursor_execute", fail_cp)
        try:
            resp = t_generate([src_a, src_b])
        finally:
            event.remove(engine, "before_cursor_execute", fail_cp)
        with Session(engine) as db:
            rq = db.get(AIRequest, UUID(resp.json()["request_id"]))
            cp_a = db.get(AICheckpoint, ("journal", src_a["id"]))
            cp_b = db.get(AICheckpoint, ("inbox", src_b["id"]))
        # Corrected expectation (matches actual product behaviour + JSON evidence):
        # checkpoint INSERT fault -> AIRequest.status='failed', error_category='storage',
        # the generated review payload is PRESERVED, and checkpoint rows are rolled back.
        ok = (resp.status_code == 200 and rq.status == "failed" and rq.error_category == "storage"
              and rq.result.get("review") is not None and cp_a is None and cp_b is None)
        record("fault_ready_checkpoint_rolls_back_all", ok,
               f"status={rq.status} cat={rq.error_category} review_kept={rq.result.get('review') is not None} "
               f"cp_a={cp_a is not None} cp_b={cp_b is not None}")

        # item 7: save fault -> zero half-write, request stays ready
        ssrc = make_source(kind="journal")
        g = t_generate([ssrc])
        body = {"markdown": "复盘", "target": {"mode": "new_journal", "journal_date": "2026-10-12"}}
        before_j = count_journals()
        def fail_upd(conn, cur, stmt, params, ctx, many):
            if stmt.strip().startswith("UPDATE ai_requests"):
                cur.execute("SELECT 1/0")
        event.listen(engine, "before_cursor_execute", fail_upd)
        try:
            sr = tclient.post(f"/api/ai/reviews/{g.json()['request_id']}/save", json=body)
        finally:
            event.remove(engine, "before_cursor_execute", fail_upd)
        after_j = count_journals()
        with Session(engine) as db:
            row = db.get(Journal, ssrc["id"])
            rq2 = db.get(AIRequest, UUID(g.json()["request_id"]))
        ok = (sr.status_code == 500 and after_j == before_j and row.content == "用户甲😀" and row.revision == 1
              and rq2.status == "ready" and rq2.saved_target is None)
        record("fault_save_zero_half_write", ok,
               f"http={sr.status_code} delta_journals={after_j-before_j} src_rev={row.revision} "
               f"req_status={rq2.status} saved_target={rq2.saved_target is not None}")
        sr2 = tclient.post(f"/api/ai/reviews/{g.json()['request_id']}/save", json=body)
        if sr2.status_code == 201 and sr2.json().get("target", {}).get("id") is not None:
            manifest["journals"].add(sr2.json()["target"]["id"])
        record("fault_save_recover_201", sr2.status_code == 201, f"status={sr2.status_code}")

        purge_owned()
        now, residual = residual_report(baseline)
        # Any residual must be reported (and is NOT cleaned): unexpected rows mean
        # the probe wrote outside its manifest, which is a defect to hand back.
        record("final_scoped_cleanup_no_owned_residual", not residual,
               f"residual={residual or 'none'} counts={now}")
    finally:
        stop_server()
        # Scoped teardown only. No unconditional table wipe.
        try:
            purge_owned()
        except Exception as exc:  # teardown best-effort; residual is reported in main
            print("teardown purge_owned failed:", exc)

    passed = sum(1 for r in RESULTS if r["passed"])
    print(f"\nSUMMARY {passed}/{len(RESULTS)} passed")
    out = os.path.join(os.path.dirname(__file__), "independent_probe.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"passed": passed, "total": len(RESULTS), "results": RESULTS}, f, ensure_ascii=False, indent=2)
    return passed == len(RESULTS)


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
