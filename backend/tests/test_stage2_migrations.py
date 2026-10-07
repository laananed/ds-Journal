"""Stage 2 / S2-T01：M1 / M2 迁移与旧 Journal 保留验证。

本文件**不碰**开发库 `seekjournal`，也**不碰**共享测试库 `seekjournal_test`：
它在每次运行时创建一个**一次性隔离迁移验证库**（名字带进程号），
从 Stage 1 的初始 revision 开始，用**旧六字段 SQL** 合成历史数据，
再逐步 `alembic upgrade` 到 M1、M2，每一步都逐行比对原有六字段。

## 为什么需要独立库

pytest 里其他 API 测试用的 `api` fixture 是「外层事务 + savepoint」，
它永远看不到 `alembic upgrade` 产生的 DDL，也回滚不了 DDL。
迁移验证必须真的执行迁移，所以只能在真正的库里做。
用独立库还有一个好处：完全不依赖 `seekjournal_test` 当前是空还是已有数据。

## 安全约束

- 库名固定前缀 + 进程号；创建前确认不存在，结束时只 `DROP` 这个库；
- 绝不 drop 其它数据库，也不清空任何表；
- 迁移子进程通过**独立 `DATABASE_URL` 环境变量**启动，
  因此 `alembic/env.py` → `app/database.py` 在子进程里新建的 Engine
  指向这个临时库，**不会**复用当前测试进程里已经创建的 Engine；
- 断言信息里只出现表名、行数、id 与 digest，不输出任何正文内容与连接密码。
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
import re
import subprocess
import sys

import psycopg
from psycopg import sql
import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.database import Base
from app.folder.models import Folder
from app.inbox.models import Inbox
from app.insight.models import Insight
from scripts.prepare_test_db import get_test_database_url

BACKEND_DIR = Path(__file__).resolve().parent.parent

# 验证库名字前缀：只用于本轮一次性验证，用后即删。
CHECK_DB_PREFIX = "seekjournal_s2t01_migcheck"

# Stage 1 的初始 revision（文档中记录的实际值）。
STAGE1_REVISION = "3a70890ddb10"

# 原六字段，顺序与 Stage 1 建表时一致。
SIX_FIELDS = ("id", "title", "content", "journal_date", "created_at", "updated_at")

# 本阶段预期存在的业务表（外加 alembic_version）。
EXPECTED_TABLES = {"journals", "folders", "inboxes", "insights"}


# ---------------------------------------------------------------------------
# 连接 / 建库 / 删库
# ---------------------------------------------------------------------------


def _sqlalchemy_url(dbname: str) -> str:
    """给 SQLAlchemy 用的 URL（postgresql+psycopg 驱动）。"""
    return get_test_database_url().set(database=dbname).render_as_string(
        hide_password=False
    )


def _psycopg_url(dbname: str) -> str:
    """给 psycopg.connect 用的 URL（不带 SQLAlchemy 驱动后缀）。"""
    return (
        get_test_database_url()
        .set(drivername="postgresql", database=dbname)
        .render_as_string(hide_password=False)
    )


def _admin_connection() -> psycopg.Connection:
    """连到 postgres 管理库；CREATE / DROP DATABASE 必须在这里做。"""
    return psycopg.connect(_psycopg_url("postgres"), autocommit=True, connect_timeout=5)


def _database_exists(dbname: str) -> bool:
    with _admin_connection() as connection:
        found = connection.execute(
            "SELECT 1 FROM pg_database WHERE datname = %s", (dbname,)
        ).fetchone()
    return found is not None


def _create_database(dbname: str) -> None:
    with _admin_connection() as connection:
        connection.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(dbname)))


def _drop_database(dbname: str) -> None:
    """只删除显式传入的这一个库；WITH (FORCE) 用来踢掉可能残留的连接。"""
    with _admin_connection() as connection:
        connection.execute(
            sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(dbname))
        )


# ---------------------------------------------------------------------------
# Alembic：读 revision 链 / 在临时库上执行迁移
# ---------------------------------------------------------------------------


def _linear_revision_chain() -> list[str]:
    """按 base → head 返回线性 revision 链；不是单链时直接失败。"""
    config = Config(str(BACKEND_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    script = ScriptDirectory.from_config(config)

    heads = script.get_heads()
    assert len(heads) == 1, f"迁移必须只有一个 head，实际得到 {heads}"

    chain: list[str] = []
    revision = script.get_revision(heads[0])
    while revision is not None:
        chain.append(revision.revision)
        down = revision.down_revision
        assert not isinstance(down, (tuple, list)), "本阶段不接受分支合并"
        revision = script.get_revision(down) if down else None

    chain.reverse()

    # 每条 revision 的 down_revision 必须正好是它的前一条（线性）。
    for previous, current in zip(chain, chain[1:]):
        assert script.get_revision(current).down_revision == previous

    return chain


def _sanitize(output: str) -> str:
    """去掉可能出现的连接串，避免把凭据写进断言信息。"""
    return re.sub(r"\S+://\S+", "<url>", output)


def _run_alembic(dbname: str, *args: str) -> None:
    """在临时库上执行 alembic 子命令。

    关键是 `DATABASE_URL` 通过**子进程环境变量**传入：
    Alembic 的 env.py 会重新导入 `app.database`，
    因此子进程里新建的 Engine 指向临时库，而不是当前测试进程的 Engine。
    """
    env = os.environ.copy()
    env["DATABASE_URL"] = _sqlalchemy_url(dbname)
    env["PYTHONDONTWRITEBYTECODE"] = "1"

    result = subprocess.run(
        [sys.executable, "-B", "-m", "alembic", *args],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        raise AssertionError(
            f"alembic {' '.join(args)} 退出码 {result.returncode}；"
            f"stderr 末尾：{_sanitize(result.stderr)[-400:]}"
        )


# ---------------------------------------------------------------------------
# 旧数据：用旧六字段 SQL 合成，不用新 Model
# ---------------------------------------------------------------------------


def _utc(*args: int) -> datetime:
    return datetime(*args, tzinfo=timezone.utc)


# (title, content, journal_date, created_at, updated_at)
#
# 覆盖任务要求的全部旧数据形态：
# NULL / 空字符串 / 纯空白标题；同日多篇；空白正文；空字符串正文；
# 超长标题（>80 码点）；超长正文（>50,000 码点）；不同日期；历史时间戳。
# 内容全部是合成文本，不含任何真实日记。
LEGACY_ROWS: list[tuple[str | None, str, date, datetime, datetime]] = [
    (
        None,
        "S2T01 LEGACY 01 普通正文",
        date(2026, 9, 30),
        _utc(2020, 1, 2, 3, 4, 5),
        _utc(2020, 1, 2, 3, 4, 5),
    ),
    (
        "",
        "S2T01 LEGACY 02 空字符串标题",
        date(2026, 9, 30),
        _utc(2026, 9, 30, 1, 0, 0),
        _utc(2026, 9, 30, 1, 0, 0),
    ),
    (
        "   ",
        "S2T01 LEGACY 03 纯空白手工标题\n\n  - 保留缩进\n  保留尾随空格   ",
        date(2026, 9, 30),
        _utc(2026, 9, 30, 2, 0, 0),
        _utc(2026, 9, 30, 2, 0, 0),
    ),
    (
        None,
        "",
        date(2026, 9, 30),
        _utc(2026, 9, 30, 3, 0, 0),
        _utc(2026, 9, 30, 3, 0, 0),
    ),
    (
        "S2T01 旧超长标题 " + "T" * 120,
        "S2T01 LEGACY 05 超长标题的正文",
        date(2026, 10, 1),
        _utc(2026, 10, 1, 1, 0, 0),
        _utc(2026, 10, 1, 1, 0, 0),
    ),
    (
        "S2T01 正常标题 06",
        "   ",
        date(2026, 10, 1),
        _utc(2026, 10, 1, 2, 0, 0),
        _utc(2026, 10, 1, 2, 0, 0),
    ),
    (
        "S2T01 Emoji 标题 🐟🧪 07",
        "x" * 60_000,
        date(2026, 10, 2),
        _utc(2026, 10, 2, 1, 0, 0),
        _utc(2026, 10, 2, 1, 0, 0),
    ),
    (
        None,
        "S2T01 LEGACY 08 多行正文\n第二行\n\n  缩进行\n末行   ",
        date(2026, 10, 2),
        _utc(2026, 10, 2, 2, 0, 0),
        _utc(2026, 10, 2, 2, 0, 0),
    ),
]

_INSERT_LEGACY = text(
    """
    INSERT INTO journals (title, content, journal_date, created_at, updated_at)
    VALUES (:title, :content, :journal_date, :created_at, :updated_at)
    """
)


def _seed_legacy_rows(engine: Engine) -> None:
    """用旧六字段 INSERT 写入合成数据（此时表还没有新增两列）。

    刻意不走 ORM：新 Model 已经带了 folder_id / deleted_at，
    用它向旧表插入会让“旧数据”带上新列的值，验证就不纯粹了。
    """
    with engine.begin() as connection:
        connection.execute(
            _INSERT_LEGACY,
            [
                {
                    "title": title,
                    "content": content,
                    "journal_date": journal_date,
                    "created_at": created_at,
                    "updated_at": updated_at,
                }
                for title, content, journal_date, created_at, updated_at in LEGACY_ROWS
            ],
        )


def _snapshot_six_fields(engine: Engine) -> list[dict]:
    """逐行读取原六字段（升级前后用同一个函数，保证可比）。"""
    with engine.connect() as connection:
        rows = connection.execute(
            text(
                "SELECT id, title, content, journal_date, created_at, updated_at "
                "FROM journals ORDER BY id"
            )
        ).all()
    return [dict(zip(SIX_FIELDS, row)) for row in rows]


def _digest_rows(rows: list[dict]) -> list[str]:
    """给每行生成 id + 六字段摘要，用于报告里“逐行记录”又不暴露正文。"""
    digests = []
    for row in rows:
        payload = "|".join(
            "~NULL~" if row[name] is None else str(row[name]) for name in SIX_FIELDS
        )
        digests.append(f"id={row['id']} md5={hashlib.md5(payload.encode()).hexdigest()}")
    return digests


# ---------------------------------------------------------------------------
# fixture：一次性验证库 + 逐步升级
# ---------------------------------------------------------------------------


@dataclass
class MigrationCheck:
    """一次迁移验证的全部证据（不含任何正文）。"""

    dbname: str
    engine: Engine
    chain: list[str]
    baseline: list[dict] = field(default_factory=list)
    # revision -> 升级到该 revision 之后的六字段快照
    snapshots: dict[str, list[dict]] = field(default_factory=dict)

    @property
    def seeded_revision(self) -> str:
        """合成旧数据时所处的 revision（= 链上第一个）。"""
        return self.chain[0]

    @property
    def upgraded_revisions(self) -> list[str]:
        return self.chain[1:]


@pytest.fixture(scope="module")
def migration_check() -> MigrationCheck:
    dbname = f"{CHECK_DB_PREFIX}_{os.getpid()}"

    if _database_exists(dbname):
        pytest.fail(
            f"验证库 {dbname} 已存在；拒绝复用或删除来源不明的库，请先人工确认"
        )

    _create_database(dbname)
    engine: Engine | None = None
    try:
        chain = _linear_revision_chain()

        # 1. 先升到 Stage 1 revision（旧表结构），再用旧六字段 SQL 合成数据。
        _run_alembic(dbname, "upgrade", chain[0])

        engine = create_engine(_sqlalchemy_url(dbname))
        _seed_legacy_rows(engine)
        baseline = _snapshot_six_fields(engine)

        check = MigrationCheck(dbname=dbname, engine=engine, chain=chain, baseline=baseline)

        # 2. 逐个 revision 升级；每升一次就重新读一遍原六字段。
        for revision in chain[1:]:
            _run_alembic(dbname, "upgrade", revision)
            # 迁移在子进程里改了结构，这里丢掉旧连接重新取，保证读到新结构。
            engine.dispose()
            check.snapshots[revision] = _snapshot_six_fields(engine)

        print(
            f"[migration_check] db={dbname} chain={chain} "
            f"legacy_rows={len(baseline)}"
        )
        for line in _digest_rows(baseline):
            print(f"[migration_check] base    {STAGE1_REVISION} {line}")
        for revision, rows in check.snapshots.items():
            print(f"[migration_check] after {revision}: rows={len(rows)}")
            for line in _digest_rows(rows):
                print(f"[migration_check] upgrade {revision} {line}")

        yield check
    finally:
        if engine is not None:
            engine.dispose()
        _drop_database(dbname)


# ---------------------------------------------------------------------------
# 测试
# ---------------------------------------------------------------------------


def test_revision_chain_is_single_head_and_unchanged_base(migration_check):
    """一条线性链、只有一个 head，且起点仍是 Stage 1 的初始 revision。"""
    chain = migration_check.chain

    assert chain[0] == STAGE1_REVISION, "初始迁移不能改，链的起点必须仍是 Stage 1 revision"
    # 本阶段只有 M1、M2 两份迁移，没有 M3。
    assert len(chain) == 3, f"本阶段应只有 base + M1 + M2，实际 {chain}"


def test_only_expected_tables_exist(migration_check):
    """升级后只多出 folders / inboxes / insights，没有意外表。"""
    with migration_check.engine.connect() as connection:
        tables = {
            row[0]
            for row in connection.execute(
                text(
                    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
                )
            )
        }

    assert tables - {"alembic_version"} == EXPECTED_TABLES, f"实际表：{sorted(tables)}"


def test_legacy_six_fields_survive_every_upgrade(migration_check):
    """核心断言：M1、M2 前后，原有六字段逐行完全一致。"""
    baseline = migration_check.baseline

    assert len(baseline) == len(LEGACY_ROWS), "合成旧数据行数与预期不一致"

    for revision, rows in migration_check.snapshots.items():
        assert len(rows) == len(baseline), f"{revision} 之后行数发生变化"
        assert rows == baseline, (
            f"{revision} 之后原六字段发生变化；"
            f"升级前：{_digest_rows(baseline)}；升级后：{_digest_rows(rows)}"
        )

    # 逐行摘要（供报告对照，不含正文）
    for line in _digest_rows(baseline):
        assert line.startswith("id=")


def test_journal_new_columns_are_null_for_all_legacy_rows(migration_check):
    """新增的 folder_id / deleted_at 对全部旧记录都是 NULL。"""
    with migration_check.engine.connect() as connection:
        total, folder_null, deleted_null = connection.execute(
            text(
                "SELECT count(*), "
                "count(*) FILTER (WHERE folder_id IS NULL), "
                "count(*) FILTER (WHERE deleted_at IS NULL) "
                "FROM journals"
            )
        ).one()

    assert total == len(LEGACY_ROWS)
    assert folder_null == total
    assert deleted_null == total


def test_journal_keeps_original_columns_and_adds_exactly_two(migration_check):
    """原六字段仍在最前且顺序不变，只追加两个可空列（没有重建表）。"""
    inspector = inspect(migration_check.engine)
    columns = inspector.get_columns("journals")
    names = [column["name"] for column in columns]

    assert tuple(names[:6]) == SIX_FIELDS, f"原六字段顺序被改变：{names}"
    assert names[6:] == ["folder_id", "deleted_at"]

    by_name = {column["name"]: column for column in columns}
    assert by_name["folder_id"]["nullable"] is True
    assert by_name["deleted_at"]["nullable"] is True

    # 原有六字段的可空性没有被改动
    assert by_name["id"]["nullable"] is False
    assert by_name["title"]["nullable"] is True
    assert by_name["content"]["nullable"] is False
    assert by_name["journal_date"]["nullable"] is False
    assert by_name["created_at"]["nullable"] is False
    assert by_name["updated_at"]["nullable"] is False


def test_foreign_keys_are_no_action(migration_check):
    """三张表的 folder_id 外键都指向 folders.id，且不 cascade / 不 SET NULL。"""
    inspector = inspect(migration_check.engine)

    for table in ("journals", "inboxes", "insights"):
        foreign_keys = inspector.get_foreign_keys(table)
        assert len(foreign_keys) == 1, f"{table} 的外键数量异常：{foreign_keys}"
        fk = foreign_keys[0]
        assert fk["constrained_columns"] == ["folder_id"]
        assert fk["referred_table"] == "folders"
        assert fk["referred_columns"] == ["id"]
        ondelete = (fk.get("options") or {}).get("ondelete")
        assert ondelete in (None, "NO ACTION"), f"{table} 外键 ondelete={ondelete}"


def test_inboxes_and_insights_structure(migration_check):
    """inboxes / insights 的列、可空性与 is_daily 默认值与文档一致。"""
    inspector = inspect(migration_check.engine)

    inbox_columns = {c["name"]: c for c in inspector.get_columns("inboxes")}
    assert list(inbox_columns) == [
        "id",
        "title",
        "content",
        "inbox_date",
        "is_daily",
        "folder_id",
        "created_at",
        "updated_at",
        "deleted_at",
    ]
    assert inbox_columns["title"]["nullable"] is True
    assert inbox_columns["content"]["nullable"] is False
    assert inbox_columns["inbox_date"]["nullable"] is False
    assert inbox_columns["is_daily"]["nullable"] is False
    assert inbox_columns["folder_id"]["nullable"] is True
    assert inbox_columns["deleted_at"]["nullable"] is True
    # 数据库层默认值 false（同时 Model 侧也有 Python 默认值）
    assert "false" in str(inbox_columns["is_daily"]["default"]).lower()

    insight_columns = {c["name"]: c for c in inspector.get_columns("insights")}
    assert list(insight_columns) == [
        "id",
        "title",
        "content",
        "folder_id",
        "created_at",
        "updated_at",
        "deleted_at",
    ]
    assert insight_columns["title"]["nullable"] is True
    assert insight_columns["content"]["nullable"] is False
    assert insight_columns["folder_id"]["nullable"] is True
    assert insight_columns["deleted_at"]["nullable"] is True

    # folders 只有两个字段
    folder_columns = {c["name"]: c for c in inspector.get_columns("folders")}
    assert list(folder_columns) == ["id", "name"]
    assert folder_columns["name"]["nullable"] is False

    # 原 journals 索引必须保留
    index_names = {index["name"] for index in inspector.get_indexes("journals")}
    assert "ix_journals_journal_date" in index_names


def test_database_matches_model_metadata(migration_check):
    """实际表结构与 SQLAlchemy metadata 一致（列名 + 可空性）。"""
    assert set(Base.metadata.tables) == EXPECTED_TABLES

    inspector = inspect(migration_check.engine)
    for table_name in sorted(EXPECTED_TABLES):
        expected = [
            (column.name, bool(column.nullable))
            for column in Base.metadata.tables[table_name].columns
        ]
        actual = [
            (column["name"], bool(column["nullable"]))
            for column in inspector.get_columns(table_name)
        ]
        assert actual == expected, f"{table_name} 的列与 Model 不一致"


def test_new_tables_are_writable_via_orm_in_isolated_transaction(migration_check):
    """三张新表能在隔离事务里通过 ORM 读写，并随回滚一起消失。"""
    engine = migration_check.engine

    with engine.connect() as connection:
        outer = connection.begin()
        session = Session(bind=connection, join_transaction_mode="create_savepoint")
        try:
            folder = Folder(name="S2T01 临时分类")
            session.add(folder)
            session.flush()

            inbox = Inbox(
                content="S2T01 临时 Inbox 正文",
                inbox_date=date(2026, 10, 7),
                folder_id=folder.id,
            )
            insight = Insight(
                content="S2T01 临时 Insight 正文",
                folder_id=folder.id,
            )
            session.add_all([inbox, insight])
            session.flush()
            session.commit()

            read_inbox = session.get(Inbox, inbox.id)
            assert read_inbox is not None
            assert read_inbox.content == "S2T01 临时 Inbox 正文"
            assert read_inbox.inbox_date == date(2026, 10, 7)
            # Python 侧默认值生效：没有显式传 is_daily 时是 False
            assert read_inbox.is_daily is False
            assert read_inbox.folder_id == folder.id
            assert read_inbox.deleted_at is None
            assert read_inbox.created_at is not None

            read_insight = session.get(Insight, insight.id)
            assert read_insight is not None
            assert read_insight.title is None
            assert read_insight.folder_id == folder.id

            # 外键真的生效：指向不存在的 folder 会被数据库拒绝
            session.rollback()
            with pytest.raises(Exception):
                session.add(
                    Inbox(
                        content="S2T01 孤儿 Inbox",
                        inbox_date=date(2026, 10, 7),
                        folder_id=10**9,
                    )
                )
                session.flush()
            session.rollback()
        finally:
            session.close()
            outer.rollback()

    # 回滚之后：三张新表都是空的，journals 仍只剩合成旧数据
    # —— 证明 ORM 写入只存在于被回滚的隔离事务里。
    with engine.connect() as connection:
        counts = {
            table: connection.execute(text(f"SELECT count(*) FROM {table}")).scalar_one()
            for table in sorted(EXPECTED_TABLES)
        }
    assert counts["folders"] == 0, f"folders 有残留：{counts}"
    assert counts["inboxes"] == 0, f"inboxes 有残留：{counts}"
    assert counts["insights"] == 0, f"insights 有残留：{counts}"
    assert counts["journals"] == len(LEGACY_ROWS), f"旧数据被改动：{counts}"
