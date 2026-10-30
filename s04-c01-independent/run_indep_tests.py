"""C01 独立日程后端的独立测试编排脚本。

只写入 seekjournal_test_03 内本轮自建的唯一临时 schema；public 只做只读快照。
不修改产品代码；HTTP 走真实 uvicorn 进程（测试专用应用，见 c01_test_app.py）。
"""

from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
import sys
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Barrier
from zoneinfo import ZoneInfo

import httpx2 as httpx  # 本项目 venv 内置的 httpx 兼容客户端（starlette TestClient 同源）
import psycopg
from sqlalchemy import create_engine, text

HERE = Path(__file__).resolve().parent
BACKEND = Path(r"C:\Programme\demo\SeekJournal-Work-01\backend")
TEST_DB = "seekjournal_test_03"
SHANGHAI = ZoneInfo("Asia/Shanghai")

os.environ["SEEKJOURNAL_TEST_DB"] = TEST_DB
sys.path.insert(0, str(BACKEND))

RESULTS: list[dict] = []
NOTES: dict[str, object] = {}
STARTED = time.strftime("%Y-%m-%dT%H:%M:%S")


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------


def record(name: str, ok: bool, detail="", *, kind="check") -> None:
    text = str(detail)
    if len(text) > 1200:
        text = "…" + text[-1200:]
    RESULTS.append({"name": name, "status": "PASS" if ok else "FAIL", "detail": text, "kind": kind})
    print(f"[{'PASS' if ok else 'FAIL'}] {name} :: {text[:300]}")


def check(name: str, condition: bool, detail="") -> bool:
    record(name, bool(condition), detail)
    return bool(condition)


def base_url(database: str | None = None, schema: str | None = None) -> str:
    from scripts.prepare_test_db import get_test_database_url

    url = get_test_database_url()
    if database:
        url = url.set(database=database)
    if schema:
        url = url.update_query_dict({"options": f"-csearch_path={schema}"})
    return url.render_as_string(hide_password=False)


def connect(schema: str | None = None, database: str | None = None):
    from scripts.prepare_test_db import get_test_database_url

    url = get_test_database_url()
    if database:
        url = url.set(database=database)
    raw = url.render_as_string(hide_password=False).replace("postgresql+psycopg://", "postgresql://")
    kwargs = {"options": f"-csearch_path={schema}"} if schema else {}
    connection = psycopg.connect(raw, autocommit=True, connect_timeout=5, **kwargs)
    if schema:
        actual = connection.execute("select current_schema()").fetchone()[0]
        assert actual == schema, f"psycopg 连接未进入私有 schema：{actual}"
    return connection


def public_snapshot() -> dict:
    with connect() as connection:
        revision = connection.execute("select version_num from public.alembic_version").fetchone()[0]
        names = [row[0] for row in connection.execute(
            "select tablename from pg_tables where schemaname='public' order by 1").fetchall()]
        counts, digests = {}, {}
        for table in names:
            rows = connection.execute(
                f'select row_to_json(t)::text from public."{table}" t order by row_to_json(t)::text'
            ).fetchall()
            counts[table] = len(rows)
            digests[table] = hashlib.sha256(repr(rows).encode()).hexdigest()
        has_schedules = connection.execute(
            "select to_regclass('public.schedules') is not null"
        ).fetchone()[0]
        schemas = [row[0] for row in connection.execute(
            "select nspname from pg_namespace where nspname not like 'pg_%' "
            "and nspname <> 'information_schema' order by 1").fetchall()]
    return {"revision": revision, "counts": counts, "digests": digests,
            "public_has_schedules": has_schedules, "schemas": schemas, "tables": names}



def run_alembic(schema: str, *args: str) -> str:
    env = os.environ.copy()
    env["DATABASE_URL"] = base_url(schema=schema)
    env["SEEKJOURNAL_TEST_DB"] = TEST_DB
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    probe = subprocess.run(
        [sys.executable, "-B", "-c",
         "from app.database import engine; from sqlalchemy import text; "
         "c=engine.connect(); print(c.execute(text('select current_database(), current_schema()')).one()); c.close()"],
        cwd=str(BACKEND), env=env, capture_output=True, text=True,
    )
    assert probe.returncode == 0, f"probe failed: {probe.stderr[-400:]}"
    assert probe.stdout.strip() == repr((TEST_DB, schema)), f"probe escaped schema: {probe.stdout.strip()}"
    result = subprocess.run([sys.executable, "-B", "-m", "alembic", *args],
                            cwd=str(BACKEND), env=env, capture_output=True, text=True)
    if result.returncode:
        raise AssertionError(f"alembic {' '.join(args)} rc={result.returncode}: {(result.stderr or result.stdout)[-600:]}")
    return (result.stdout or "").strip()


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Server:
    def __init__(self, schema: str):
        self.schema = schema
        self.port = free_port()
        self.proc: subprocess.Popen | None = None
        self.log = open(HERE / f"uvicorn-{self.port}.log", "w", encoding="utf-8")

    def start(self):
        env = os.environ.copy()
        env["DATABASE_URL"] = base_url(schema=self.schema)
        env["SEEKJOURNAL_TEST_DB"] = TEST_DB
        env["PYTHONPATH"] = f"{BACKEND};{HERE}"
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        self.proc = subprocess.Popen(
            [sys.executable, "-B", "-m", "uvicorn", "c01_test_app:app",
             "--host", "127.0.0.1", "--port", str(self.port), "--log-level", "warning"],
            cwd=str(BACKEND), env=env, stdout=self.log, stderr=subprocess.STDOUT,
        )
        deadline = time.time() + 40
        while time.time() < deadline:
            try:
                if httpx.get(f"http://127.0.0.1:{self.port}/__test_only/ping", timeout=2, trust_env=False).status_code == 200:
                    return self
            except Exception:
                time.sleep(0.25)
        raise RuntimeError("test server did not start")

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.log.close()


# ---------------------------------------------------------------------------
# 数据工具
# ---------------------------------------------------------------------------


def make_payload(**overrides) -> dict:
    body = {
        "title": "合成日程",
        "starts_at": "2026-10-30T09:00:00+08:00",
        "ends_at": "2026-10-30T10:00:00+08:00",
        "completed": False,
        "client_create_id": str(uuid.uuid4()),
    }
    body.update(overrides)
    return body


def sql(schema: str, statement: str, params=()):
    with connect(schema=schema) as connection:
        cursor = connection.execute(statement, params)
        return cursor.fetchall() if cursor.description else []


def clear_rows(schema: str) -> None:
    sql(schema, "delete from schedules")


def row_state(schema: str, schedule_id: int):
    rows = sql(schema, "select xmin::text, title, starts_at, ends_at, completed, revision, "
                       "updated_at from schedules where id=%s", (schedule_id,))
    return rows[0] if rows else None


def table_stats(schema: str) -> tuple:
    rows = sql(schema, "select n_tup_ins, n_tup_upd, n_tup_del from pg_stat_user_tables "
                       "where schemaname=%s and relname='schedules'", (schema,))
    return rows[0] if rows else (None, None, None)


def table_counts(schema: str, tables) -> dict:
    return {t: sql(schema, f'select count(*) from "{t}"')[0][0] for t in tables}


# ---------------------------------------------------------------------------
# 测试
# ---------------------------------------------------------------------------


def test_schema_structure(schema: str) -> None:
    columns = sql(schema, "select column_name, data_type, is_nullable from information_schema.columns "
                          "where table_schema=%s and table_name='schedules' order by ordinal_position", (schema,))
    shape = {row[0]: (row[1], row[2]) for row in columns}
    expected = {
        "id": ("integer", "NO"), "title": ("text", "NO"), "starts_at": ("timestamp with time zone", "NO"),
        "ends_at": ("timestamp with time zone", "YES"), "completed": ("boolean", "NO"),
        "revision": ("bigint", "NO"), "client_create_id": ("uuid", "NO"),
        "create_payload_hash": ("text", "NO"), "created_at": ("timestamp with time zone", "NO"),
        "updated_at": ("timestamp with time zone", "NO"),
    }
    check("schema.table_shape_matches_contract", shape == expected, json.dumps(shape, ensure_ascii=False))

    constraints = sql(schema, "select conname, contype, pg_get_constraintdef(oid) from pg_constraint "
                              "where conrelid = %s::regclass order by contype, conname",
                      (f"{schema}.schedules",))
    kinds = {row[1] for row in constraints}
    uniqued = any(row[1] == "u" and "client_create_id" in row[2] for row in constraints)
    has_check = any(row[1] == "c" and "ends_at" in row[2] and "starts_at" in row[2] for row in constraints)
    check("schema.pk_and_unique_client_create_id", "p" in kinds and uniqued,
          [row[:3] for row in constraints])
    check("schema.check_end_after_start_present", has_check, [row[2] for row in constraints if row[1] == "c"])
    check("schema.no_foreign_keys", "f" not in kinds, "schedules 无外键即与 Set/End 目标解耦")

    indexes = sql(schema, "select indexname, indexdef from pg_indexes where schemaname=%s and tablename='schedules'",
                  (schema,))
    names = {row[0] for row in indexes}
    check("schema.index_starts_at_id_present", "ix_schedules_starts_at_id" in names, sorted(names))


def test_create(ctx) -> None:
    client, schema = ctx["client"], ctx["schema"]
    clear_rows(schema)
    payload = make_payload()
    response = client.post("/api/schedules", json=payload)
    body = response.json() if response.content else {}
    check("post.create_returns_created", response.status_code in (200, 201), (response.status_code, body))
    check("post.create_shape", set(body) == {"id", "title", "starts_at", "ends_at", "completed",
                                            "revision", "created_at", "updated_at"}, sorted(body))
    check("post.revision_starts_at_1", body.get("revision") == 1, body.get("revision"))

    stored = sql(schema, "select starts_at, ends_at, completed, created_at, updated_at, "
                         "pg_typeof(starts_at)::text from schedules where id=%s", (body["id"],))[0]
    expected_start = datetime(2026, 10, 30, 1, 0, tzinfo=timezone.utc)
    check("post.stored_as_timestamptz", stored[5] == "timestamp with time zone", stored[5])
    check("post.stored_utc_instant", stored[0] == expected_start, (str(stored[0]), str(expected_start)))
    check("post.stored_utc_offset_zero", stored[0].utcoffset() == timedelta(0), str(stored[0].utcoffset()))

    returned_start = datetime.fromisoformat(body["starts_at"])
    check("post.response_time_aware", returned_start.tzinfo is not None, body["starts_at"])
    check("post.asia_shanghai_display", returned_start.astimezone(SHANGHAI).strftime("%Y-%m-%d %H:%M")
          == "2026-10-30 09:00", returned_start.astimezone(SHANGHAI).isoformat())
    check("post.created_at_equals_updated_at",
          datetime.fromisoformat(body["created_at"]) == datetime.fromisoformat(body["updated_at"]),
          (body["created_at"], body["updated_at"]))

    # 不传 ends_at 键（合同把 ends_at 列为可空字段，未说明可省略）
    omitted = {k: v for k, v in make_payload().items() if k != "ends_at"}
    omitted_response = client.post("/api/schedules", json=omitted)
    check("post.ends_at_key_required_when_omitted", omitted_response.status_code == 422,
          (omitted_response.status_code, omitted_response.json()))


def test_title_rules(ctx) -> None:
    client, schema = ctx["client"], ctx["schema"]
    ninety_cjk = "日" * 80
    eighty_one = "日" * 81
    eighty_emoji = "🗓" * 80

    ok80 = client.post("/api/schedules", json=make_payload(title=ninety_cjk))
    check("post.title_80_codepoints_accepted", ok80.status_code in (200, 201), ok80.status_code)
    bad81 = client.post("/api/schedules", json=make_payload(title=eighty_one))
    check("post.title_81_codepoints_rejected", bad81.status_code == 422, bad81.status_code)
    ok_emoji = client.post("/api/schedules", json=make_payload(title=eighty_emoji))
    check("post.title_80_astral_codepoints_counted_by_codepoint",
          ok_emoji.status_code in (200, 201), ok_emoji.status_code)
    emoji81 = client.post("/api/schedules", json=make_payload(title="🗓" * 81))
    check("post.title_81_astral_rejected", emoji81.status_code == 422, emoji81.status_code)

    for label, title in (("blank", "   "), ("empty", ""), ("missing", None)):
        body = make_payload()
        if title is None:
            body.pop("title")
        else:
            body["title"] = title
        response = client.post("/api/schedules", json=body)
        check(f"post.title_{label}_rejected", response.status_code == 422, response.status_code)

    stored = sql(schema, "select title from schedules where id=%s", (ok80.json()["id"],))[0][0]
    check("post.title_roundtrip_unicode", stored == ninety_cjk, len(stored))


def test_time_rules(ctx) -> None:
    client = ctx["client"]
    cases: list[tuple[str, dict, bool]] = [
        ("naive_datetime", {"starts_at": "2026-10-30T09:00:00"}, False),
        ("numeric_epoch", {"starts_at": 1793322000}, False),
        ("garbage_string", {"starts_at": "tomorrow morning"}, False),
        ("missing", {"starts_at": None}, True),
        ("end_equal_start", {"ends_at": "2026-10-30T09:00:00+08:00"}, False),
        ("end_before_start", {"ends_at": "2026-10-30T08:59:59+08:00"}, False),
        ("naive_end", {"ends_at": "2026-10-30T10:00:00"}, False),
    ]
    for label, override, drop in cases:
        body = make_payload()
        if drop:
            body.pop(next(iter(override)), None)
        else:
            body.update(override)
        response = client.post("/api/schedules", json=body)
        check(f"post.time_{label}_rejected_422", response.status_code == 422,
              (response.status_code, response.text[:200]))

    null_end = client.post("/api/schedules", json=make_payload(ends_at=None))
    check("post.time_null_end_accepted", null_end.status_code in (200, 201), null_end.status_code)


def test_create_fields(ctx) -> None:
    client = ctx["client"]
    cases = [
        ("completed_string", {"completed": "false"}),
        ("completed_int", {"completed": 0}),
        ("extra_field", {"colour": "red"}),
        ("bad_uuid", {"client_create_id": "not-a-uuid"}),
        ("title_int", {"title": 123}),
    ]
    for label, override in cases:
        response = client.post("/api/schedules", json=make_payload(**override))
        check(f"post.field_{label}_rejected_422", response.status_code == 422, response.status_code)
    missing_completed = make_payload()
    missing_completed.pop("completed")
    check("post.missing_completed_rejected", client.post("/api/schedules", json=missing_completed).status_code == 422)
    missing_key = make_payload()
    missing_key.pop("client_create_id")
    check("post.missing_client_create_id_rejected",
          client.post("/api/schedules", json=missing_key).status_code == 422)


def test_idempotent_create(ctx) -> None:
    client, schema = ctx["client"], ctx["schema"]
    clear_rows(schema)
    payload = make_payload(title="replay")
    first = client.post("/api/schedules", json=payload)
    first_body = first.json()
    replay = client.post("/api/schedules", json=payload)
    replay_body = replay.json()
    check("post.replay_same_key_resolves_to_same_resource", replay_body.get("id") == first_body["id"],
          (replay.status_code, replay_body.get("id"), first_body["id"]))
    check("post.replay_does_not_bump_revision",
          replay_body.get("revision") == first_body["revision"] == 1, replay_body.get("revision"))
    check("post.replay_does_not_change_updated_at",
          replay_body.get("updated_at") == first_body.get("updated_at"),
          (replay_body.get("updated_at"), first_body.get("updated_at")))
    check("post.replay_single_row", sql(schema, "select count(*) from schedules")[0][0] == 1,
          sql(schema, "select count(*) from schedules")[0][0])
    NOTES["replay_status_code"] = replay.status_code

    equivalent = dict(payload, starts_at="2026-10-30T01:00:00Z", ends_at="2026-10-30T02:00:00Z")
    equivalent_response = client.post("/api/schedules", json=equivalent)
    check("post.replay_equivalent_instant_different_offset_same_row",
          equivalent_response.json().get("id") == first_body["id"],
          (equivalent_response.status_code, equivalent_response.json().get("id")))

    conflict = client.post("/api/schedules", json=dict(payload, title="replay changed"))
    check("post.replay_different_payload_409", conflict.status_code == 409, conflict.status_code)
    check("post.replay_conflict_no_extra_row", sql(schema, "select count(*) from schedules")[0][0] == 1)

    # 删除后再用同一 client_create_id：合同未定义，记录实际行为
    deleted = client.delete(f"/api/schedules/{first_body['id']}", headers={"If-Match": '"1"'})
    after = client.post("/api/schedules", json=payload)
    after_body = after.json() if after.content else {}
    NOTES["reuse_after_delete"] = {"delete_status": deleted.status_code, "post_status": after.status_code,
                                   "new_id": after_body.get("id"), "old_id": first_body["id"],
                                   "revision": after_body.get("revision")}
    record("post.reuse_after_delete_observed", True,
           f"删除后同键 POST 状态 {after.status_code}，id {after_body.get('id')}（原 {first_body['id']}）",
           kind="observation")


def test_get(ctx) -> None:
    client, schema = ctx["client"], ctx["schema"]
    clear_rows(schema)
    created = client.post("/api/schedules", json=make_payload()).json()
    path = f"/api/schedules/{created['id']}"

    detail = client.get(path)
    check("get.detail_matches_created", detail.status_code == 200 and detail.json()["id"] == created["id"],
          detail.status_code)
    check("get.detail_404_unknown", client.get("/api/schedules/99999999").status_code == 404)
    check("get.detail_422_non_integer_id", client.get("/api/schedules/abc").status_code == 422)

    before_state = row_state(schema, created["id"])
    before_stats = table_stats(schema)
    client.get(path)
    client.get("/api/schedules?page=1")
    client.get("/api/schedules/99999999")
    client.get("/api/schedules?page=2")
    after_state = row_state(schema, created["id"])
    after_stats = table_stats(schema)
    check("get.detail_and_list_zero_write_xmin", before_state[0] == after_state[0],
          (before_state[0], after_state[0]))
    check("get.zero_write_row_stats", before_stats == after_stats, (before_stats, after_stats))
    check("get.zero_write_updated_at", before_state[6] == after_state[6], (str(before_state[6]), str(after_state[6])))


def test_list(ctx) -> None:
    client, schema = ctx["client"], ctx["schema"]
    clear_rows(schema)
    empty = client.get("/api/schedules?page=1")
    check("list.empty_shape", empty.status_code == 200 and empty.json() == {"items": [], "page": 1, "has_next": False},
          empty.json())

    base = datetime(2026, 10, 31, 0, 0, tzinfo=timezone.utc)
    ids = []
    for index in range(21):
        starts = base + timedelta(minutes=(index // 2) * 5)  # 成对相同 starts_at，检验 id 次排序
        payload = make_payload(title=f"page {index}", starts_at=starts.isoformat(),
                               ends_at=(starts + timedelta(minutes=30)).isoformat())
        ids.append(client.post("/api/schedules", json=payload).json()["id"])

    page1 = client.get("/api/schedules?page=1").json()
    page2 = client.get("/api/schedules?page=2").json()
    check("list.page_size_20", len(page1["items"]) == 20, len(page1["items"]))
    check("list.page1_has_next", page1["has_next"] is True, page1["has_next"])
    check("list.page2_remainder", len(page2["items"]) == 1 and page2["has_next"] is False,
          (len(page2["items"]), page2["has_next"]))
    key_page1 = [(item["starts_at"], item["id"]) for item in page1["items"]]
    key_page2 = [(item["starts_at"], item["id"]) for item in page2["items"]]
    check("list.order_by_starts_at_then_id", key_page1 + key_page2 == sorted(key_page1 + key_page2),
          key_page1[:3])
    seen = [item["id"] for item in page1["items"] + page2["items"]]
    check("list.no_duplicates_across_pages", len(seen) == len(set(seen)) == 21, len(set(seen)))
    beyond = client.get("/api/schedules?page=99").json()
    check("list.page_beyond_last", beyond["items"] == [] and beyond["has_next"] is False, beyond)
    for bad in ("0", "-1", "abc", "1.5"):
        check(f"list.page_{bad}_rejected", client.get(f"/api/schedules?page={bad}").status_code == 422,
              client.get(f"/api/schedules?page={bad}").status_code)

    clear_rows(schema)
    for index in range(20):
        client.post("/api/schedules", json=make_payload(title=f"exact {index}"))
    exact = client.get("/api/schedules?page=1").json()
    check("list.exactly_20_rows_has_next_false", len(exact["items"]) == 20 and exact["has_next"] is False,
          (len(exact["items"]), exact["has_next"]))


def test_patch(ctx) -> None:
    client, schema = ctx["client"], ctx["schema"]
    clear_rows(schema)
    created = client.post("/api/schedules", json=make_payload(completed=False)).json()
    path = f"/api/schedules/{created['id']}"

    check("patch.missing_expected_revision_428",
          client.patch(path, json={"completed": True}).status_code == 428)
    for label, body in (("null", {"expected_revision": None, "completed": True}),
                        ("zero", {"expected_revision": 0, "completed": True}),
                        ("string", {"expected_revision": "1", "completed": True}),
                        ("huge", {"expected_revision": 9223372036854775808, "completed": True})):
        check(f"patch.expected_revision_{label}_422", client.patch(path, json=body).status_code == 422,
              client.patch(path, json=body).status_code)

    before = row_state(schema, created["id"])
    stats_before = table_stats(schema)
    noop = client.patch(path, json={"expected_revision": 1, "completed": False})
    after = row_state(schema, created["id"])
    stats_after = table_stats(schema)
    check("patch.no_change_200", noop.status_code == 200, noop.status_code)
    check("patch.no_change_revision_stable", noop.json()["revision"] == 1, noop.json()["revision"])
    check("patch.no_change_updated_at_stable",
          noop.json()["updated_at"] == created["updated_at"],
          (noop.json()["updated_at"], created["updated_at"]))
    check("patch.no_change_issued_no_update_xmin", before[0] == after[0], (before[0], after[0]))
    check("patch.no_change_row_stats_stable", stats_before[1] == stats_after[1],
          (stats_before, stats_after))

    # 时间字段"同值重发"不应增版（含同一时刻不同偏移的等价写法）
    same_time = client.patch(path, json={"expected_revision": 1, "title": "合成日程",
                                         "starts_at": "2026-10-30T09:00:00+08:00",
                                         "ends_at": "2026-10-30T10:00:00+08:00"})
    check("patch.same_title_and_times_no_bump",
          same_time.status_code == 200 and same_time.json()["revision"] == 1,
          (same_time.status_code, same_time.json().get("revision")))
    same_instant = client.patch(path, json={"expected_revision": 1, "starts_at": "2026-10-30T01:00:00Z",
                                           "ends_at": "2026-10-30T02:00:00Z"})
    check("patch.equivalent_instant_offset_no_bump",
          same_instant.status_code == 200 and same_instant.json()["revision"] == 1,
          (same_instant.status_code, same_instant.json().get("revision")))

    changed = client.patch(path, json={"expected_revision": 1, "completed": True})
    check("patch.actual_change_bumps_revision", changed.status_code == 200 and changed.json()["revision"] == 2,
          (changed.status_code, changed.json().get("revision")))
    check("patch.actual_change_updates_updated_at",
          datetime.fromisoformat(changed.json()["updated_at"]) > datetime.fromisoformat(created["updated_at"]),
          (changed.json()["updated_at"], created["updated_at"]))
    check("patch.actual_change_persisted", sql(schema, "select completed from schedules where id=%s",
                                               (created["id"],))[0][0] is True)

    stale = client.patch(path, json={"expected_revision": 1, "title": "stale"})
    check("patch.stale_revision_409", stale.status_code == 409, stale.status_code)
    check("patch.stale_does_not_overwrite",
          sql(schema, "select title from schedules where id=%s", (created["id"],))[0][0] == "合成日程")

    cleared = client.patch(path, json={"expected_revision": 2, "ends_at": None})
    check("patch.clear_ends_at_null", cleared.status_code == 200 and cleared.json()["ends_at"] is None
          and cleared.json()["revision"] == 3, (cleared.status_code, cleared.json().get("revision")))

    boundary = [
        ("end_equal_start", {"ends_at": "2026-10-30T09:00:00+08:00"}),
        ("end_before_start", {"ends_at": "2026-10-30T08:00:00+08:00"}),
    ]
    for label, override in boundary:
        response = client.patch(path, json={"expected_revision": 3, **override})
        check(f"patch.boundary_{label}_422", response.status_code == 422, response.status_code)

    # ends_at 已被清空，先恢复一个结束时间，再验证"把 starts_at 推到 ends_at 之后"被拒绝
    set_end = client.patch(path, json={"expected_revision": 3, "ends_at": "2026-10-30T10:30:00+08:00"})
    check("patch.set_end_after_clear", set_end.status_code == 200 and set_end.json()["revision"] == 4,
          (set_end.status_code, set_end.json().get("revision")))
    push_start = client.patch(path, json={"expected_revision": 4, "starts_at": "2026-10-30T11:00:00+08:00"})
    check("patch.boundary_start_after_end_422", push_start.status_code == 422, push_start.status_code)
    check("patch.boundary_rejected_row_unchanged",
          sql(schema, "select revision from schedules where id=%s", (created["id"],))[0][0] == 4)

    illegal = [("unknown_field", {"expected_revision": 4, "colour": "red", "title": "x"}),
               ("empty_body", {"expected_revision": 4}),
               ("title_null", {"expected_revision": 4, "title": None}),
               ("title_too_long", {"expected_revision": 4, "title": "日" * 81}),
               ("title_blank", {"expected_revision": 4, "title": "  "}),
               ("completed_string", {"expected_revision": 4, "completed": "yes"})]
    for label, body in illegal:
        check(f"patch.illegal_{label}_422", client.patch(path, json=body).status_code == 422,
              client.patch(path, json=body).status_code)

    check("patch.unknown_id_404",
          client.patch("/api/schedules/99999999", json={"expected_revision": 1, "title": "x"}).status_code == 404)


def test_patch_concurrency(ctx) -> None:
    client, schema = ctx["client"], ctx["schema"]
    clear_rows(schema)
    created = client.post("/api/schedules", json=make_payload()).json()
    path = f"/api/schedules/{created['id']}"
    barrier = Barrier(2)

    def attempt(index: int) -> int:
        with httpx.Client(base_url=ctx["server"].url, timeout=20, trust_env=False) as own:
            barrier.wait(timeout=10)
            return own.patch(path, json={"expected_revision": 1, "title": f"concurrent {index}"}).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        codes = sorted(pool.map(attempt, range(2)))
    check("patch.concurrent_cas_one_wins_one_409", codes == [200, 409], codes)
    check("patch.concurrent_cas_single_bump",
          sql(schema, "select revision from schedules where id=%s", (created["id"],))[0][0] == 2,
          sql(schema, "select revision from schedules where id=%s", (created["id"],))[0][0])


def test_concurrent_create(ctx) -> None:
    client, schema = ctx["client"], ctx["schema"]
    clear_rows(schema)

    key_same = str(uuid.uuid4())
    payload = make_payload(client_create_id=key_same, title="same key")
    barrier = Barrier(2)

    def post_same(_):
        with httpx.Client(base_url=ctx["server"].url, timeout=20, trust_env=False) as own:
            barrier.wait(timeout=10)
            response = own.post("/api/schedules", json=payload)
            return response.status_code, response.json().get("id")

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(post_same, range(2)))
    ids = {item[1] for item in results}
    check("create.concurrent_same_key_same_payload_same_row", len(ids) == 1, results)
    check("create.concurrent_same_key_same_payload_single_row",
          sql(schema, "select count(*) from schedules")[0][0] == 1,
          sql(schema, "select count(*) from schedules")[0][0])

    clear_rows(schema)
    key_diff = str(uuid.uuid4())
    barrier = Barrier(2)

    def post_diff(index: int):
        body = make_payload(client_create_id=key_diff, title=f"diff {index}")
        with httpx.Client(base_url=ctx["server"].url, timeout=20, trust_env=False) as own:
            barrier.wait(timeout=10)
            return own.post("/api/schedules", json=body).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        codes = sorted(pool.map(post_diff, range(2)))
    check("create.concurrent_same_key_diff_payload_one_conflict", codes == [201, 409], codes)
    check("create.concurrent_same_key_diff_payload_single_row",
          sql(schema, "select count(*) from schedules")[0][0] == 1,
          sql(schema, "select count(*) from schedules")[0][0])


def test_delete(ctx) -> None:
    client, schema = ctx["client"], ctx["schema"]
    clear_rows(schema)
    keep = client.post("/api/schedules", json=make_payload(title="keep")).json()
    target = client.post("/api/schedules", json=make_payload(title="target")).json()
    path = f"/api/schedules/{target['id']}"

    check("delete.missing_if_match_428", client.delete(path).status_code == 428)
    for label, header in (("unquoted", "1"), ("garbage", "abc"), ("zero", '"0"'), ("empty", "")):
        check(f"delete.if_match_{label}_422",
              client.delete(path, headers={"If-Match": header}).status_code == 422,
              client.delete(path, headers={"If-Match": header}).status_code)
    check("delete.stale_revision_409", client.delete(path, headers={"If-Match": '"5"'}).status_code == 409)
    check("delete.stale_row_intact", sql(schema, "select count(*) from schedules where id=%s",
                                        (target["id"],))[0][0] == 1)
    check("delete.unknown_id_404",
          client.delete("/api/schedules/99999999", headers={"If-Match": '"1"'}).status_code == 404)

    gone = client.delete(path, headers={"If-Match": '"1"'})
    check("delete.success_204", gone.status_code == 204, gone.status_code)
    check("delete.204_empty_body", gone.content == b"", gone.content[:80])
    check("delete.hard_delete_row_absent",
          sql(schema, "select count(*) from schedules where id=%s", (target["id"],))[0][0] == 0)
    check("delete.keeps_other_rows",
          sql(schema, "select count(*) from schedules where id=%s", (keep["id"],))[0][0] == 1)
    check("delete.second_time_404", client.delete(path, headers={"If-Match": '"1"'}).status_code == 404)
    soft_columns = sql(schema, "select column_name from information_schema.columns where table_schema=%s "
                               "and table_name='schedules' and column_name in ('deleted_at','is_deleted')", (schema,))
    check("delete.no_soft_delete_column", soft_columns == [], soft_columns)


def test_independence(ctx) -> None:
    client, schema = ctx["client"], ctx["schema"]
    watch = ["journals", "insights", "folders", "ritual_templates", "ritual_goal_links",
             "ritual_copies", "ai_requests", "ai_usage", "ai_comments"]
    before = table_counts(schema, watch)
    created = client.post("/api/schedules", json=make_payload(title="independent")).json()
    path = f"/api/schedules/{created['id']}"
    client.patch(path, json={"expected_revision": 1, "completed": True})
    client.patch(path, json={"expected_revision": 2, "title": "independent edited"})
    client.get("/api/schedules?page=1")
    client.delete(path, headers={"If-Match": '"3"'})
    after = table_counts(schema, watch)
    check("independence.no_writes_to_set_end_tables", before == after, {"before": before, "after": after})

    foreign_keys = sql(schema, "select conname from pg_constraint where contype='f' "
                               "and conrelid=%s::regclass", (f"{schema}.schedules",))
    check("independence.no_fk_to_goals", foreign_keys == [], foreign_keys)

    source = "\n".join(
        (BACKEND / "app" / "schedule" / name).read_text(encoding="utf-8")
        for name in ("models.py", "service.py", "router.py", "schemas.py")
    )
    imported = [token for token in ("ritual", "journal", "goal", "writing.service") if f"app.{token}" in source]
    check("independence.schedule_module_has_no_goal_import",
          all(token not in source for token in ("app.ritual", "app.journal", "app.link")),
          imported)


def test_persistence(schema: str) -> None:
    with connect(schema=schema) as connection:
        rows = connection.execute("select id, title, revision from schedules order by id").fetchall()
    with connect(schema=schema) as connection:
        again = connection.execute("select id, title, revision from schedules order by id").fetchall()
    check("persistence.visible_on_new_connection", rows == again, len(rows))


def test_downgrade(schema: str) -> None:
    clear_rows(schema)
    client_rows = sql(schema, "select count(*) from schedules")[0][0]
    check("migration.downgrade_blocked_by_rows_setup", client_rows == 0)
    sql(schema, "insert into schedules (title, starts_at, completed, revision, client_create_id, "
                "create_payload_hash, created_at, updated_at) values "
                "('downgrade guard', now(), false, 1, gen_random_uuid(), 'x', now(), now())")
    try:
        run_alembic(schema, "downgrade", "4f8e1a3c9d02")
        blocked = False
    except AssertionError as error:
        blocked = "refusing downgrade" in str(error) or "schedules exist" in str(error)
    check("migration.downgrade_refuses_with_rows", blocked, "有数据时 downgrade 被拒绝")

    clear_rows(schema)
    run_alembic(schema, "downgrade", "4f8e1a3c9d02")
    left = sql(schema, "select to_regclass(%s)", (f"{schema}.schedules",))[0][0]
    check("migration.downgrade_drops_table_when_empty", left is None, left)
    run_alembic(schema, "upgrade", "head")
    back = sql(schema, "select to_regclass(%s)", (f"{schema}.schedules",))[0][0]
    check("migration.reupgrade_head_restores_table", back is not None, back)


def test_public_entry() -> None:
    code = (
        "import json;"
        "from app.main import app;"
        "paths=sorted({getattr(r,'path',None) for r in app.routes} - {None});"
        "print(json.dumps({'schedule_paths':[p for p in paths if 'schedule' in p],"
        "'total':len(paths)}))"
    )
    env = os.environ.copy()
    env["DATABASE_URL"] = base_url()  # public search_path；导入不连接
    result = subprocess.run([sys.executable, "-B", "-c", code], cwd=str(BACKEND), env=env,
                            capture_output=True, text=True)
    check("public_entry.main_import_ok", result.returncode == 0, result.stderr[-400:])
    if result.returncode == 0:
        payload = json.loads(result.stdout.strip().splitlines()[-1])
        check("public_entry.no_schedule_route_registered", payload["schedule_paths"] == [], payload)
        NOTES["main_route_count"] = payload["total"]

    openapi_code = (
        "import json;"
        "from app.main import app;"
        "print(json.dumps(sorted(p for p in app.openapi().get('paths',{}) if 'schedule' in p)))"
    )
    openapi_result = subprocess.run([sys.executable, "-B", "-c", openapi_code], cwd=str(BACKEND),
                                    env=env, capture_output=True, text=True)
    check("public_entry.openapi_has_no_schedule_path",
          openapi_result.returncode == 0 and openapi_result.stdout.strip().endswith("[]"),
          openapi_result.stdout.strip()[-200:] + openapi_result.stderr[-200:])



def main() -> int:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    token = uuid.uuid4().hex[:8]
    schema = f"c01it_{token}"
    mg_schema = f"c01mg_{token}"
    manifest = {"db": TEST_DB, "test_schema": schema, "migration_schema": mg_schema,
                "created_by": "C01 独立测试（WorkBuddy 新对话）", "started": STARTED}

    preflight = public_snapshot()
    with connect() as connection:
        info = connection.execute("select current_database(), current_schema()").fetchone()
        connections = connection.execute(
            "select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()"
        ).fetchone()[0]
        existing = connection.execute(
            "select nspname from pg_namespace where nspname like 'c01%'").fetchall()
    check("preflight.target_database_is_seekjournal_test_03", info[0] == TEST_DB, info)
    check("preflight.no_other_connections_on_target_db", connections == 0, f"其他连接数={connections}")
    check("preflight.no_previous_c01_schema", existing == [], existing)
    check("preflight.public_has_no_schedules_table", preflight["public_has_schedules"] is False,
          preflight["public_has_schedules"])
    check("preflight.ai_usage_row_present", preflight["counts"].get("ai_usage") == 1,
          preflight["counts"].get("ai_usage"))
    NOTES["preflight"] = {"revision": preflight["revision"], "ai_usage_rows": preflight["counts"].get("ai_usage"),
                          "other_connections": connections}

    server = None
    try:
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        config = Config(str(BACKEND / "alembic.ini"))
        config.set_main_option("script_location", str(BACKEND / "alembic"))
        script = ScriptDirectory.from_config(config)
        heads = script.get_heads()
        chain = [rev.revision for rev in script.walk_revisions()]
        check("migration.single_head", heads == ["c01a7e421b50"], heads)
        check("migration.linear_chain_from_pinned_base",
              chain == ["c01a7e421b50", "4f8e1a3c9d02", "9e7a6c42d011", "3aa16300a58a",
                        "18ecf7e09da6", "a8d98342e603", "52c8e94a365c", "3a70890ddb10"], chain)

        with connect() as connection:
            connection.execute(f"create schema {schema}")
        run_alembic(schema, "upgrade", "head")
        with connect(schema=schema) as connection:
            here = connection.execute("select current_database(), current_schema()").fetchone()
            current = connection.execute("select version_num from alembic_version").fetchone()[0]
        check("migration.child_process_stayed_in_private_schema", here == (TEST_DB, schema), here)
        check("migration.upgraded_to_head_in_private_schema", current == "c01a7e421b50", current)
        check("migration.private_schema_isolated_from_public",
              public_snapshot()["public_has_schedules"] is False, "public 未出现 schedules")

        test_schema_structure(schema)
        test_public_entry()

        server = Server(schema).start()
        ctx = {"schema": schema, "server": server,
               "client": httpx.Client(base_url=server.url, timeout=30, trust_env=False)}
        try:
            test_create(ctx)
            test_title_rules(ctx)
            test_time_rules(ctx)
            test_create_fields(ctx)
            test_idempotent_create(ctx)
            test_get(ctx)
            test_list(ctx)
            test_patch(ctx)
            test_patch_concurrency(ctx)
            test_concurrent_create(ctx)
            test_delete(ctx)
            test_independence(ctx)
        finally:
            ctx["client"].close()

        test_persistence(schema)

        # 进程重启后的持久化：停旧进程、起新进程、重新读取
        seeded = httpx.post(f"{server.url}/api/schedules", json=make_payload(title="restart survivor"),
                            timeout=20, trust_env=False).json()
        server.stop()
        server = Server(schema).start()
        survived = httpx.get(f"{server.url}/api/schedules/{seeded['id']}", timeout=20, trust_env=False)
        check("persistence.survives_process_restart",
              survived.status_code == 200 and survived.json()["title"] == "restart survivor",
              (survived.status_code, survived.text[:120]))
        server.stop()

        with connect() as connection:
            connection.execute(f"create schema {mg_schema}")
        try:
            run_alembic(mg_schema, "upgrade", "head")
            test_downgrade(mg_schema)
        finally:
            if server and server.proc and server.proc.poll() is None:
                server.stop()
            with connect() as connection:
                connection.execute(f"drop schema if exists {mg_schema} cascade")
            gone = connect().execute("select count(*) from pg_namespace where nspname=%s", (mg_schema,)).fetchone()[0]
            check("cleanup.migration_schema_dropped", gone == 0, gone)
    except Exception:
        record("harness.unexpected_error", False, traceback.format_exc()[-1500:])
    finally:
        if server and server.proc and server.proc.poll() is None:
            server.stop()
        try:
            with connect() as connection:
                connection.execute(f"drop schema if exists {schema} cascade")
            with connect() as connection:
                left = connection.execute("select count(*) from pg_namespace where nspname like 'c01%'").fetchone()[0]
            check("cleanup.test_schema_dropped", left == 0, f"残留 c01* schema 数={left}")
        except Exception:
            record("cleanup.drop_schema_failed", False, traceback.format_exc()[-800:])
        after = public_snapshot()
        check("cleanup.public_snapshot_unchanged",
              after["revision"] == preflight["revision"] and after["digests"] == preflight["digests"],
              f"revision {after['revision']}；ai_usage 行数 {after['counts'].get('ai_usage')}")
        check("cleanup.ai_usage_preserved", after["counts"].get("ai_usage") == 1
              and after["digests"].get("ai_usage") == preflight["digests"].get("ai_usage"),
              "ai_usage 唯一行内容散列未变")

    summary = {
        "started": STARTED, "finished": time.strftime("%Y-%m-%dT%H:%M:%S"), "manifest": manifest,
        "notes": NOTES,
        "totals": {"pass": sum(1 for r in RESULTS if r["status"] == "PASS"),
                   "fail": sum(1 for r in RESULTS if r["status"] == "FAIL")},
        "results": RESULTS,
    }
    (HERE / f"c01-independent-results-{stamp}.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    print(json.dumps(summary["totals"], ensure_ascii=False))
    return 0 if summary["totals"]["fail"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
