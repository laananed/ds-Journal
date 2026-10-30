"""检查已存在的测试库非空保护，再运行 Alembic 迁移。

Stage 2 / S2-T01 起，本脚本的「非空拒绝」检查覆盖**所有已存在的业务表**，
不再只看 journals。升级前部分新表可能还不存在，因此逐一用 `to_regclass`
判断，表不存在就跳过，不会因此报错，也**不会**创建表（建表只由 Alembic 负责）。

S3-T06 起支持多个隔离测试库并行，当前登记四个：`seekjournal_test`、
`seekjournal_test_02`、`seekjournal_test_03`、`seekjournal_test_04`。三个
Agent 并行开发时推荐分配 `_02` / `_03` / `_04`；`seekjournal_test` 仍是旧
revision（`3aa16300a58a`、9 张表），暂不参与并行开发。库名只来自进程环境
`SEEKJOURNAL_TEST_DB`：

- 未指定时保持既有行为，默认 `seekjournal_test`；
- 只允许下面 `ALLOWED_TEST_DATABASES` 白名单，个人库 `seekjournal`、
  任意库名、管理库或带附加内容的取值一律直接拒绝，不连接、不降级回退。

这里只做选库，不引入新的配置层，也不改变应用业务 `DATABASE_URL`。
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

#: 选择隔离测试库的进程环境变量；未指定时用默认值。
TEST_DATABASE_ENV = "SEEKJOURNAL_TEST_DB"
DEFAULT_TEST_DATABASE_NAME = "seekjournal_test"
#: 只有下列登记库可用于 pytest/迁移；个人库与任意库名都不在列。
ALLOWED_TEST_DATABASES = ("seekjournal_test", "seekjournal_test_02", "seekjournal_test_03", "seekjournal_test_04")

# 当前阶段的全部业务表。新增业务表时同步这个元组。
BUSINESS_TABLES = ("folders", "journals", "inboxes", "insights", "ai_requests", "ai_checkpoints", "ai_usage", "ai_settings", "ritual_templates", "ritual_goal_links", "ritual_copies", "ai_comments")


def get_test_database_name() -> str:
    """解析本轮要用的隔离测试库名；非法取值直接拒绝。

    纯逻辑函数：只读环境变量，不连接、不建库、不改任何配置。
    """
    raw = (os.environ.get(TEST_DATABASE_ENV) or "").strip()
    if not raw:
        return DEFAULT_TEST_DATABASE_NAME
    if raw not in ALLOWED_TEST_DATABASES:
        # 不回显取值：它可能是误粘贴的连接串，也可能指向个人库。
        raise RuntimeError(
            f"{TEST_DATABASE_ENV} 只允许 {' / '.join(ALLOWED_TEST_DATABASES)}；"
            "当前取值不在白名单，已拒绝连接"
        )
    return raw


def get_test_database_url() -> URL:
    """沿用本机连接凭据，只替换库名；不打印或写入配置。"""
    load_dotenv(BACKEND_DIR / ".env", override=False)
    raw_url = os.environ.get("DATABASE_URL")
    if not raw_url:
        raise RuntimeError("未找到 DATABASE_URL")
    url = make_url(raw_url)
    if url.drivername not in ("postgres", "postgresql", "postgresql+psycopg"):
        raise RuntimeError("测试库只支持 PostgreSQL / psycopg")
    return url.set(drivername="postgresql+psycopg", database=get_test_database_name())


def _connection_url(url: URL, database: str) -> str:
    return url.set(drivername="postgresql", database=database).render_as_string(
        hide_password=False
    )


def main() -> int:
    test_url = get_test_database_url()
    database_name = get_test_database_name()
    # 仅只读核实固定测试库存在；缺失时不自动建库。
    with psycopg.connect(
        _connection_url(test_url, "postgres"), autocommit=True, connect_timeout=5
    ) as connection:
        exists = connection.execute(
            "SELECT 1 FROM pg_database WHERE datname = %s", (database_name,)
        ).fetchone()
        if not exists:
            raise RuntimeError(f"{database_name} 不存在；本轮不自动新建数据库")

    with psycopg.connect(
        _connection_url(test_url, database_name), connect_timeout=5
    ) as connection:
        actual = connection.execute("SELECT current_database()").fetchone()[0]
        if actual != database_name:
            raise RuntimeError(f"实际数据库不是 {database_name}")
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
    print(f"PASS: {database_name} 已准备，开发库未执行迁移或数据操作")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, psycopg.Error) as exc:
        # psycopg 错误可能包含连接信息，避免输出凭据。
        print(f"FAIL: {exc if isinstance(exc, RuntimeError) else type(exc).__name__}")
        sys.exit(1)
