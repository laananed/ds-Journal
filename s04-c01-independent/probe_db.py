"""C01 独立测试：测试库只读探针（不写、不迁移）。

输出内容全部为结构性信息：库名、schema、迁移版本、表名与行数、连接归属。
不输出连接串、密码或个人正文。
"""

from __future__ import annotations

import json
import os
import sys

import psycopg

BACKEND = r"C:\Programme\demo\SeekJournal-Work-01\backend"
sys.path.insert(0, BACKEND)


def connection_url() -> str:
    from scripts.prepare_test_db import get_test_database_url

    url = get_test_database_url()
    return url.set(drivername="postgresql").render_as_string(hide_password=False)


def main() -> int:
    target = os.environ.get("SEEKJOURNAL_TEST_DB")
    url = connection_url()
    out: dict[str, object] = {"selected_db": target}
    with psycopg.connect(url, autocommit=True, connect_timeout=5) as connection:
        row = connection.execute(
            "select current_database(), current_user, current_schema(), version()"
        ).fetchone()
        out["current_database"] = row[0]
        out["current_user"] = row[1]
        out["current_schema"] = row[2]
        out["server_version"] = row[3].split(",")[0]

        out["schemas"] = [
            r[0]
            for r in connection.execute(
                "select nspname from pg_namespace where nspname not like 'pg_%' "
                "and nspname <> 'information_schema' order by 1"
            ).fetchall()
        ]

        out["public_tables"] = [
            r[0]
            for r in connection.execute(
                "select tablename from pg_tables where schemaname='public' order by 1"
            ).fetchall()
        ]

        try:
            out["public_alembic_revision"] = connection.execute(
                "select version_num from public.alembic_version"
            ).fetchone()[0]
        except Exception as error:  # noqa: BLE001
            out["public_alembic_revision"] = f"<error: {type(error).__name__}>"

        counts = {}
        for table in out["public_tables"]:
            counts[table] = connection.execute(
                f'select count(*) from public."{table}"'
            ).fetchone()[0]
        out["public_row_counts"] = counts

        out["connections"] = [
            {"pid": r[0], "user": r[1], "db": r[2], "state": r[3], "app": r[4],
             "client": r[5], "backend_start": str(r[6])}
            for r in connection.execute(
                "select pid, usename, datname, state, coalesce(application_name,''), "
                "coalesce(host(client_addr)::text,'local'), backend_start "
                "from pg_stat_activity where datname = current_database() order by pid"
            ).fetchall()
        ]

        out["db_size"] = connection.execute(
            "select pg_size_pretty(pg_database_size(current_database()))"
        ).fetchone()[0]

    print(json.dumps(out, ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
