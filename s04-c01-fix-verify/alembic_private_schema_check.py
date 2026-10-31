"""C01 索引修复 — 私有 schema 内真实 Alembic 复核（只写自建 schema）。

流程：公共 schema 快照 → 建 c01fx_* 私有 schema（写入 manifest）→ 子进程
alembic upgrade head → 核对实际 current_database/current_schema → 检查
私有 schema 内 schedules 索引 → 子进程 alembic check（记录退出码与全文）
→ finally 只 DROP 自建 schema → 复核公共 schema 快照一致。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import uuid
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BACKEND = REPO / "backend"
EVID = REPO / "s04-c01-fix-verify"
DB = "seekjournal_test_03"
PREFIX = "c01fx"
SCHEMA = f"{PREFIX}_{uuid.uuid4().hex[:8]}"

sys.path.insert(0, str(BACKEND))
os.chdir(BACKEND)

from dotenv import load_dotenv  # noqa: E402
from sqlalchemy import make_url  # noqa: E402

load_dotenv(BACKEND / ".env", override=False)
base = make_url(os.environ["DATABASE_URL"])


def url_with_schema(schema: str) -> str:
    return base.set(database=DB).update_query_dict(
        {"options": f"-csearch_path={schema}"}).render_as_string(hide_password=False)


def url_db(db: str) -> str:
    return base.set(database=db).render_as_string(hide_password=False)


import psycopg  # noqa: E402


def conn(schema: str | None = None):
    opts = f"-csearch_path={schema}" if schema else None
    return psycopg.connect(host=base.host, port=base.port, user=base.username,
                           password=base.password, dbname=DB, connect_timeout=5,
                           autocommit=True, options=opts)


def public_snapshot():
    with conn() as c:
        c.execute("SET default_transaction_read_only = on")
        snap = {
            "database": c.execute("SELECT current_database()").fetchone()[0],
            "schema": c.execute("SELECT current_schema()").fetchone()[0],
            "revision": [r[0] for r in c.execute(
                "SELECT version_num FROM public.alembic_version").fetchall()]
            if c.execute("SELECT to_regclass('public.alembic_version')").fetchone()[0] else None,
            "tables": [r[0] for r in c.execute(
                "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1").fetchall()],
            "schemas": [r[0] for r in c.execute(
                "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' "
                "AND nspname <> 'information_schema' ORDER BY 1").fetchall()],
        }
        for t in ("ai_usage", "journals", "insights", "ritual_copies", "schedules"):
            reg = c.execute("SELECT to_regclass(%s)", (f"public.{t}",)).fetchone()[0]
            snap[f"{t}_rows"] = (c.execute(f'SELECT count(*) FROM public."{t}"').fetchone()[0]
                                 if reg is not None else None)
            snap[f"{t}_digest"] = (c.execute(
                f"SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), 'empty') "
                f'FROM public."{t}" t').fetchone()[0] if reg is not None else None)
    return snap


def run(cmd, env_extra, log_name):
    env = os.environ.copy()
    env.update(env_extra)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env.pop("SEEKJOURNAL_TEST_DB", None)
    p = subprocess.run(cmd, cwd=str(BACKEND), capture_output=True, text=True, env=env)
    (EVID / log_name).write_text(
        f"$ {' '.join(cmd)}\nexit={p.returncode}\n--- stdout ---\n{p.stdout}\n--- stderr ---\n{p.stderr}\n",
        encoding="utf-8")
    return p


manifest = {
    "round": "C01 model/migration index fix — independent targeted retest",
    "started_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    "database": DB,
    "database_verified_by": "current_database()",
    "public_writes": "none (all DDL confined to " + SCHEMA + ")",
    "created_objects": [f"schema {SCHEMA}"],
    "services_started": [],
}
results = {"schema": SCHEMA}
before = public_snapshot()
results["public_before"] = before

alembic_url = url_with_schema(SCHEMA)
env_url = alembic_url  # 子进程通过 DATABASE_URL 的 options 参数切换 search_path

try:
    with conn() as c:
        assert c.execute("SELECT current_database()").fetchone()[0] == DB, "目标库不符"
        others = c.execute("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() "
                           "AND pid<>pg_backend_pid()").fetchone()[0]
        results["other_connections_at_start"] = others
        assert others == 0, "测试库存在其他连接，非独占"
        c.execute(f'CREATE SCHEMA "{SCHEMA}"')
        results["schema_created"] = True

    # 子进程能否真正进入私有 schema
    probe = run([sys.executable, "-B", "-c",
                 "from app.database import engine\n"
                 "from sqlalchemy import text\n"
                 "with engine.connect() as c:\n"
                 "    print(c.execute(text('select current_database(), current_schema()')).one())"],
                {"DATABASE_URL": env_url}, "alembic-child-schema-probe.log")
    results["child_schema_probe_stdout"] = probe.stdout.strip()
    results["child_schema_probe_ok"] = (probe.returncode == 0
                                        and repr((DB, SCHEMA)) in probe.stdout.strip())
    if not results["child_schema_probe_ok"]:
        raise RuntimeError("子进程未进入私有 schema，停止写入")

    up = run([sys.executable, "-B", "-m", "alembic", "upgrade", "head"],
             {"DATABASE_URL": env_url}, "alembic-upgrade-head.log")
    results["upgrade_exit"] = up.returncode
    results["upgrade_stdout"] = up.stdout.strip()[-1500:]

    with conn(SCHEMA) as c:
        results["private_current_schema"] = c.execute("SELECT current_schema()").fetchone()[0]
        results["private_revision"] = [r[0] for r in c.execute(
            'SELECT version_num FROM alembic_version').fetchall()]
        results["private_schedules_indexes"] = [
            {"name": r[0], "def": r[1]} for r in c.execute(
                "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname=%s "
                "AND tablename='schedules' ORDER BY 1", (SCHEMA,)).fetchall()]

    public_index_written = False
    with conn() as c:
        public_index_written = c.execute(
            "SELECT to_regclass('public.schedules')").fetchone()[0] is not None
    results["public_got_schedules_table"] = public_index_written

    chk = run([sys.executable, "-B", "-m", "alembic", "check"],
              {"DATABASE_URL": env_url}, "alembic-check.log")
    results["alembic_check_exit"] = chk.returncode
    results["alembic_check_stdout"] = chk.stdout
    results["alembic_check_stderr"] = chk.stderr
    results["alembic_check_mentions_ix_schedules"] = bool(
        re.search(r"ix_schedules_starts_at_id", chk.stdout + chk.stderr))

    cur = run([sys.executable, "-B", "-m", "alembic", "current"],
              {"DATABASE_URL": env_url}, "alembic-current.log")
    results["alembic_current_exit"] = cur.returncode
    results["alembic_current_stdout"] = cur.stdout.strip()
finally:
    manifest["finished_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
    try:
        with conn() as c:
            exists = c.execute("SELECT 1 FROM pg_namespace WHERE nspname=%s", (SCHEMA,)).fetchone()
            if exists and SCHEMA.startswith(PREFIX + "_"):
                c.execute(f'DROP SCHEMA "{SCHEMA}" CASCADE')
            results["schema_dropped"] = c.execute(
                "SELECT 1 FROM pg_namespace WHERE nspname=%s", (SCHEMA,)).fetchone() is None
    except Exception as exc:
        results["cleanup_error"] = type(exc).__name__
    after = public_snapshot()
    results["public_after"] = after
    results["public_unchanged"] = before == after
    manifest["cleanup"] = {"dropped_schema": SCHEMA, "public_unchanged": results.get("public_unchanged")}
    (EVID / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    (EVID / "alembic-verify-results.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")

print(json.dumps({k: results.get(k) for k in (
    "schema", "other_connections_at_start", "child_schema_probe_stdout", "child_schema_probe_ok",
    "upgrade_exit", "private_current_schema", "private_revision", "private_schedules_indexes",
    "public_got_schedules_table", "alembic_check_exit", "alembic_check_stdout",
    "alembic_check_stderr", "alembic_check_mentions_ix_schedules", "alembic_current_stdout",
    "schema_dropped", "public_unchanged")}, ensure_ascii=False, indent=2))
