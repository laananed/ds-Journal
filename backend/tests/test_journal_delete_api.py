"""DELETE /api/journals/{id} 硬删除的最小 API 测试。

Stage 1 / Task 7.1。

与创建 / 列表 / 详情 / 修改测试一样，这里使用 FastAPI TestClient 与**真实 PostgreSQL**，
完整走一遍：HTTP → Pydantic → Router → Service → SQLAlchemy → psycopg → PostgreSQL。

共享的 `api` fixture 位于 `tests/conftest.py`：它返回 `(TestClient, 测试 Session)`，
用「外层事务 + savepoint」把所有写入关在事务里，测试结束即回滚。
本文件不复制 fixture、不新建通用测试层，也不创建会偷偷提交的独立 Session。

## 数据库前置条件

conftest 在导入应用之前把 `DATABASE_URL` 切到测试库 `seekjournal_test`，
因此本文件的删除只作用于测试库，不会向开发库 `seekjournal` 发送任何删除。

本文件也不假设测试库为空：

- 删除目标一律是本测试自己创建的合成记录；
- 判断「记录是否真的没了」用**原生 SQL 直接读列值**，不依赖 Session 的 identity map；
- 不存在的 id 从当前事务里真实存在的 id 集合反推，不写死固定值，
  也不假设 id 连续或从 1 开始；
- 检查「有没有影响其它数据」时比较整表六字段的原生 SQL 快照。

## 关于 204

契约规定删除成功返回 `204 No Content`，响应体为空。
因此断言用 `response.content == b""`，而不是去解析 JSON。

## 关于 sequence

PostgreSQL 的 sequence 取值不随事务回滚，所以 `id` 会跳号。
这不代表数据残留，测试也不重置 sequence。
"""

from __future__ import annotations

from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import engine
from app.journal.models import Journal

LIST_URL = "/api/journals"

# 只取固定列、按 id 排序的快照 SQL：绕开 identity map，直接读数据库列值。
_SNAPSHOT_SQL = text(
    "SELECT id, title, content, journal_date, created_at, updated_at "
    "FROM journals ORDER BY id"
)

_ROW_SQL = text(
    "SELECT id, title, content, journal_date, created_at, updated_at "
    "FROM journals WHERE id = :journal_id"
)

# 与其它测试文件刻意错开的业务日期，避免相互干扰。
DAY = date(2026, 5, 20)
OTHER_DAY = date(2026, 5, 21)


def _delete_url(journal_id: object) -> str:
    return f"{LIST_URL}/{journal_id}"


def _delete(client: TestClient, journal_id: object):
    return client.delete(_delete_url(journal_id))


def _make_journal(
    *,
    content: str,
    journal_date: date,
    title: str | None = None,
) -> Journal:
    """构造（未持久化的）Journal 对象。"""
    return Journal(title=title, content=content, journal_date=journal_date)


def _seed(session: Session, journal: Journal) -> Journal:
    """写入一行测试数据并 flush，让 id 生成。"""
    session.add(journal)
    session.flush()
    return journal


def _count_rows_in(session: Session) -> int:
    """在当前 Session 所在的事务里数行数。"""
    return session.execute(text("SELECT count(*) FROM journals")).scalar_one()


def _count_rows_independently() -> int:
    """用一条独立连接数行数（在外层事务之外）。

    独立连接看不到外层事务里未提交的修改，
    因此它数到的就是「真实留在库里」的记录数。
    """
    with engine.connect() as connection:
        return connection.execute(text("SELECT count(*) FROM journals")).scalar_one()


def _existing_ids(session: Session) -> set[int]:
    return set(session.execute(text("SELECT id FROM journals")).scalars().all())


def _id_not_present(session: Session) -> int:
    """返回一个已确认不存在的正整数 id（不写死固定值）。"""
    existing = _existing_ids(session)
    candidate = 1
    while candidate in existing:
        candidate += 1
    return candidate


def _snapshot(session: Session) -> list[tuple]:
    """整表六字段的原生 SQL 快照（按 id 排序）。"""
    return [tuple(row) for row in session.execute(_SNAPSHOT_SQL)]


def _row_if_any(session: Session, journal_id: int) -> tuple | None:
    """按 id 取一行实际列值；不存在时返回 None（原生 SQL，绕开 identity map）。"""
    row = session.execute(_ROW_SQL, {"journal_id": journal_id}).one_or_none()
    return None if row is None else tuple(row)


# ==========================================================================
# A. 正常删除
# ==========================================================================


def test_delete_existing_record_returns_204_with_empty_body(api):
    client, session = api

    journal = _seed(
        session,
        _make_journal(title="将被删除", content="正文", journal_date=DAY),
    )

    response = _delete(client, journal.id)

    assert response.status_code == 204
    # 204 响应体必须完全为空，不能是 null、{} 或成功消息
    assert response.content == b""


def test_deleted_row_is_gone_in_the_current_transaction(api):
    """用原生 SQL 确认该 id 在本次测试事务里已经不存在。"""
    client, session = api

    journal = _seed(
        session,
        _make_journal(title="将被删除", content="正文", journal_date=DAY),
    )
    journal_id = journal.id
    assert _row_if_any(session, journal_id) is not None

    assert _delete(client, journal_id).status_code == 204

    # 不依赖 Session 的 identity map：直接读数据库列值
    assert _row_if_any(session, journal_id) is None
    assert journal_id not in _existing_ids(session)


def test_delete_removes_only_the_target_row(api):
    client, session = api

    target = _seed(
        session,
        _make_journal(title="目标记录", content="正文 A", journal_date=DAY),
    )
    keeper = _seed(
        session,
        _make_journal(title="另一篇记录", content="正文 B", journal_date=OTHER_DAY),
    )
    snapshot_before = _snapshot(session)
    assert len(snapshot_before) >= 2

    assert _delete(client, target.id).status_code == 204

    after = _snapshot(session)
    # 刚好少一行
    assert len(after) == len(snapshot_before) - 1
    # 少的那一行正是目标记录
    assert [row for row in after if row[0] == target.id] == []
    # 其余行逐字段原样保留
    assert after == [row for row in snapshot_before if row[0] != target.id]
    assert _row_if_any(session, keeper.id) is not None


def test_second_delete_returns_404(api):
    """同一记录删两次：第二次因为记录已不存在而返回 404。"""
    client, session = api

    journal = _seed(
        session,
        _make_journal(title="只删一次", content="正文", journal_date=DAY),
    )
    journal_id = journal.id

    assert _delete(client, journal_id).status_code == 204
    assert _delete(client, journal_id).status_code == 404
    assert _row_if_any(session, journal_id) is None


def test_delete_reduces_the_row_count_by_one(api):
    client, session = api

    _seed(session, _make_journal(content="待删除", journal_date=DAY))
    journal = _seed(session, _make_journal(content="待删除之二", journal_date=DAY))

    before = _count_rows_in(session)

    assert _delete(client, journal.id).status_code == 204

    assert _count_rows_in(session) == before - 1


# ==========================================================================
# B. 404
# ==========================================================================


def test_absent_id_returns_404(api):
    client, session = api

    absent = _id_not_present(session)
    assert absent not in _existing_ids(session)

    response = _delete(client, absent)

    assert response.status_code == 404
    # 404 不会顺手创建任何东西
    assert absent not in _existing_ids(session)


def test_absent_id_404_does_not_change_the_data(api):
    client, session = api

    _seed(session, _make_journal(content="不该被动", journal_date=DAY))
    snapshot_before = _snapshot(session)
    count_before = _count_rows_in(session)

    assert _delete(client, _id_not_present(session)).status_code == 404

    assert _snapshot(session) == snapshot_before
    assert _count_rows_in(session) == count_before


def test_404_body_is_plain(api):
    client, session = api

    body = _delete(client, _id_not_present(session)).json()

    assert set(body) == {"detail"}
    assert isinstance(body["detail"], str)


@pytest.mark.parametrize("raw_id", ["0", "-1"])
def test_zero_and_negative_ids_return_404(api, raw_id):
    """契约没有规定 gt=0，因此 0 与负数属于「合法整数但不存在」。"""
    client, session = api

    candidate = int(raw_id)
    assert candidate not in _existing_ids(session)

    assert _delete(client, candidate).status_code == 404


# ==========================================================================
# C. 422
# ==========================================================================


@pytest.mark.parametrize(
    "raw_id",
    ["abc", "12abc", "1.5", "null", "true", "2026-10-02"],
)
def test_non_integer_id_returns_422(api, raw_id):
    client, session = api

    before = _snapshot(session)

    response = _delete(client, raw_id)

    assert response.status_code == 422
    assert _snapshot(session) == before


def test_404_and_422_leave_the_data_untouched(api):
    client, session = api

    journal = _seed(
        session,
        _make_journal(title="保持原样", content="正文", journal_date=DAY),
    )
    snapshot_before = _snapshot(session)
    count_before = _count_rows_in(session)

    assert _delete(client, _id_not_present(session)).status_code == 404
    assert _delete(client, "abc").status_code == 422
    assert _delete(client, "1.5").status_code == 422

    assert _snapshot(session) == snapshot_before
    assert _count_rows_in(session) == count_before
    assert _row_if_any(session, journal.id) is not None


# ==========================================================================
# D. 事务隔离与回归
# ==========================================================================


def test_delete_is_not_committed_to_the_database(api):
    """独立连接看不到任何变化：删除只存在于被回滚的外层事务里。"""
    client, session = api

    committed_before = _count_rows_independently()

    journal = _seed(
        session,
        _make_journal(title="临时创建的", content="正文", journal_date=DAY),
    )

    assert _delete(client, journal.id).status_code == 204

    # 本次事务里该行确实已被删除
    assert _row_if_any(session, journal.id) is None
    # 但独立连接看到的已提交行数没有变化：删除没有真正提交
    assert _count_rows_independently() == committed_before


def test_health_endpoint_is_unchanged(api):
    client, _session = api

    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert response.headers["content-type"].startswith("application/json")
