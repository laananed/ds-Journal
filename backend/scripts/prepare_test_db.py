"""准备独立测试库：只创建 seekjournal_test，并运行已有 Alembic 迁移。"""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys

from dotenv import load_dotenv
import psycopg
from psycopg import sql
from sqlalchemy import URL, make_url

BACKEND_DIR = Path(__file__).resolve().parent.parent
TEST_DATABASE_NAME = "seekjournal_test"


def get_test_database_url() -> URL:
    """沿用本机连接凭据，只替换库名；不打印或写入配置。"""
    load_dotenv(BACKEND_DIR / ".env", override=False)
    raw_url = os.environ.get("DATABASE_URL")
    if not raw_url:
        raise RuntimeError("未找到 DATABASE_URL")
    url = make_url(raw_url)
    if url.drivername not in ("postgres", "postgresql", "postgresql+psycopg"):
        raise RuntimeError("测试库只支持 PostgreSQL / psycopg")
    return url.set(drivername="postgresql+psycopg", database=TEST_DATABASE_NAME)


def _connection_url(url: URL, database: str) -> str:
    return url.set(drivername="postgresql", database=database).render_as_string(
        hide_password=False
    )


def main() -> int:
    test_url = get_test_database_url()
    # CREATE DATABASE 不能处于事务内；只在 postgres 管理库创建固定名称的测试库。
    with psycopg.connect(
        _connection_url(test_url, "postgres"), autocommit=True, connect_timeout=5
    ) as connection:
        exists = connection.execute(
            "SELECT 1 FROM pg_database WHERE datname = %s", (TEST_DATABASE_NAME,)
        ).fetchone()
        if not exists:
            connection.execute(
                sql.SQL("CREATE DATABASE {}").format(sql.Identifier(TEST_DATABASE_NAME))
            )

    with psycopg.connect(
        _connection_url(test_url, TEST_DATABASE_NAME), connect_timeout=5
    ) as connection:
        has_journals = connection.execute(
            "SELECT to_regclass('public.journals')"
        ).fetchone()[0]
        if has_journals and connection.execute(
            "SELECT count(*) FROM journals"
        ).fetchone()[0]:
            raise RuntimeError("测试库已有记录；不会清空，请先确认其来源")

    migration_env = os.environ.copy()
    migration_env["DATABASE_URL"] = test_url.render_as_string(hide_password=False)
    migration_env["PYTHONDONTWRITEBYTECODE"] = "1"
    result = subprocess.run(
        [sys.executable, "-B", "-m", "alembic", "upgrade", "head"],
        cwd=BACKEND_DIR,
        env=migration_env,
        capture_output=True,
    )
    if result.returncode:
        raise RuntimeError(f"测试库 Alembic upgrade 失败，退出码 {result.returncode}")
    print("PASS: seekjournal_test 已准备，开发库未执行迁移或数据操作")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, psycopg.Error) as exc:
        # psycopg 错误可能包含连接信息，避免输出凭据。
        print(f"FAIL: {exc if isinstance(exc, RuntimeError) else type(exc).__name__}")
        sys.exit(1)
