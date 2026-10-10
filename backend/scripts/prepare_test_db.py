"""检查已存在的 seekjournal_test 非空保护，再运行 Alembic 迁移。

Stage 2 / S2-T01 起，本脚本的「非空拒绝」检查覆盖**所有已存在的业务表**，
不再只看 journals。升级前部分新表可能还不存在，因此逐一用 `to_regclass`
判断，表不存在就跳过，不会因此报错，也**不会**创建表（建表只由 Alembic 负责）。
"""

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

# 当前阶段的全部业务表。新增业务表时同步这个元组。
BUSINESS_TABLES = ("folders", "journals", "inboxes", "insights", "ai_requests", "ai_checkpoints", "ai_usage", "ai_settings")


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
    # 仅只读核实固定测试库存在；缺失时不自动建库。
    with psycopg.connect(
        _connection_url(test_url, "postgres"), autocommit=True, connect_timeout=5
    ) as connection:
        exists = connection.execute(
            "SELECT 1 FROM pg_database WHERE datname = %s", (TEST_DATABASE_NAME,)
        ).fetchone()
        if not exists:
            raise RuntimeError("seekjournal_test 不存在；本轮不自动新建数据库")

    with psycopg.connect(
        _connection_url(test_url, TEST_DATABASE_NAME), connect_timeout=5
    ) as connection:
        actual = connection.execute("SELECT current_database()").fetchone()[0]
        if actual != TEST_DATABASE_NAME:
            raise RuntimeError("实际数据库不是 seekjournal_test")
        others = connection.execute(
            "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() "
            "AND pid<>pg_backend_pid()"
        ).fetchone()[0]
        if others:
            raise RuntimeError("测试库还有其他连接；需要独占 prepare/迁移窗口")
        # 只检查「已经存在的业务表」是否有数据。
        # 升级前的新表还不存在时 to_regclass 返回 NULL，直接跳过；
        # 这里绝不 create_all / drop_all / 清空任何表。
        non_empty: list[tuple[str, int]] = []
        for table in BUSINESS_TABLES:
            exists = connection.execute(
                "SELECT to_regclass(%s)", (f"public.{table}",)
            ).fetchone()[0]
            if exists is None:
                continue
            count = connection.execute(
                sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier(table))
            ).fetchone()[0]
            if count:
                non_empty.append((table, count))
        if non_empty:
            summary = ", ".join(f"{table}={count}" for table, count in non_empty)
            raise RuntimeError(
                f"测试库已有业务记录（{summary}）；不会清空，请先确认其来源"
            )

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
