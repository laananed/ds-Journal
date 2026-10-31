"""C01 索引修复定向复测 — 只读数据库侦察（不写任何对象）。"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "backend"))
os.chdir(REPO / "backend")

from dotenv import load_dotenv  # noqa: E402
from sqlalchemy import make_url  # noqa: E402
import psycopg  # noqa: E402

load_dotenv(REPO / "backend" / ".env", override=False)
raw = os.environ["DATABASE_URL"]
base = make_url(raw)

CANDS = ["seekjournal_test", "seekjournal_test_02", "seekjournal_test_03", "seekjournal_test_04"]


def connect(db: str, **kw):
    return psycopg.connect(
        host=base.host, port=base.port, user=base.username,
        password=base.password, dbname=db, connect_timeout=5,
        autocommit=True, **kw,
    )


out = {}
with connect("postgres") as c:
    c.execute("SET default_transaction_read_only = on")
    dbs = [r[0] for r in c.execute(
        "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY 1").fetchall()]
    out["server_databases"] = dbs
    out["server_version"] = c.execute("SHOW server_version").fetchone()[0]

for db in CANDS:
    info = {"exists": db in out["server_databases"]}
    if not info["exists"]:
        out[db] = info
        continue
    try:
        with connect(db) as c:
            c.execute("SET default_transaction_read_only = on")
            info["current_database"] = c.execute("SELECT current_database()").fetchone()[0]
            info["current_schema"] = c.execute("SELECT current_schema()").fetchone()[0]
            info["current_user"] = c.execute("SELECT current_user").fetchone()[0]
            info["search_path"] = c.execute("SHOW search_path").fetchone()[0]
            info["other_connections"] = c.execute(
                "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() "
                "AND pid <> pg_backend_pid()").fetchone()[0]
            info["schemas"] = [r[0] for r in c.execute(
                "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' "
                "AND nspname <> 'information_schema' ORDER BY 1").fetchall()]
            info["public_tables"] = [r[0] for r in c.execute(
                "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1").fetchall()]
            ver = c.execute(
                "SELECT to_regclass('public.alembic_version')").fetchone()[0]
            info["alembic_version"] = None
            if ver is not None:
                info["alembic_version"] = [
                    r[0] for r in c.execute("SELECT version_num FROM public.alembic_version").fetchall()]
            counts = {}
            for t in ("ai_usage", "journals", "schedules"):
                reg = c.execute("SELECT to_regclass(%s)", (f"public.{t}",)).fetchone()[0]
                if reg is not None:
                    counts[t] = c.execute(f'SELECT count(*) FROM public."{t}"').fetchone()[0]
            info["rowcounts"] = counts
            info["schedules_indexes"] = []
            reg = c.execute("SELECT to_regclass('public.schedules')").fetchone()[0]
            if reg is not None:
                info["schedules_indexes"] = [
                    {"name": r[0], "def": r[1]} for r in c.execute(
                        "SELECT indexname, indexdef FROM pg_indexes "
                        "WHERE schemaname='public' AND tablename='schedules' ORDER BY 1").fetchall()]
    except Exception as exc:  # 不回显连接信息
        info["error"] = type(exc).__name__
    out[db] = info

print(json.dumps(out, ensure_ascii=False, indent=2))
