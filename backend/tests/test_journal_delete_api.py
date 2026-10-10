"""DELETE /api/journals/{id} **软删除**的最小 API 测试。

Stage 1 / Task 7.1（原为硬删除）→ Stage 2 / S2-T02 改为软删除。

与创建 / 列表 / 详情 / 修改测试一样，这里使用 FastAPI TestClient 与**真实 PostgreSQL**，
完整走一遍：HTTP → Pydantic → Router → Service → SQLAlchemy → psycopg → PostgreSQL。

共享的 `api` fixture 位于 `tests/conftest.py`：它返回 `(TestClient, 测试 Session)`，
用「外层事务 + savepoint」把所有写入关在事务里，测试结束即回滚。
本文件不复制 fixture、不新建通用测试层，也不创建会偷偷提交的独立 Session。

## Stage 2 的删除语义

普通删除进入回收箱（`docs/stage2-api.md` §3）：

- 成功返回 `204` 与空响应体；
- **数据库行保留**，只把 `deleted_at` 置为当前时间；
- 原六字段、`folder_id` 与 `updated_at` **逐字段不变**——
  `updated_at` 的 `onupdate` 必须在同一个 UPDATE 里被显式抵消，
  否则「删除」会被误记成一次内容修改；
- 已删除 / 不存在的目标返回 404，重复删除不再改写原来的 `deleted_at`；
- 普通列表、日期 / Folder 筛选、详情、PATCH 与再次 DELETE 都不能访问已删除目标。

恢复、永久删除与回收箱列表属于 S2-T09，本文件不覆盖。

## 数据库前置条件

conftest 在导入应用之前把 `DATABASE_URL` 切到测试库 `seekjournal_test`，
因此本文件的删除只作用于测试库，不会向开发库 `seekjournal` 发送任何写入。

本文件也不假设测试库为空：

- 删除目标一律是本测试自己创建的合成记录；
- 判断「记录是否还在 / 字段有没有被改」用**原生 SQL 直接读列值**，
  不依赖 Session 的 identity map；
- 不存在的 id 从当前事务里真实存在的 id 集合反推，不写死固定值，
  也不假设 id 连续或从 1 开始；
- 检查「有没有影响其它数据」时比较整表**完整列**的原生 SQL 快照。

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
from app.journal import service
from app.journal.models import Journal

LIST_URL = "/api/journals"

# 包含 `folder_id` 与 `deleted_at` 的完整列快照：
# 软删除只会改动 `deleted_at`，其它列都必须逐字段原样保留。
_COLUMNS = (
    "id, title, content, journal_date, folder_id, created_at, updated_at, deleted_at"
)

_SNAPSHOT_SQL = text(f"SELECT {_COLUMNS} FROM journals ORDER BY id")

_ROW_SQL = text(f"SELECT {_COLUMNS} FROM journals WHERE id = :journal_id")

# 与其它测试文件刻意错开的业务日期，避免相互干扰。
DAY = date(2026, 5, 20)
OTHER_DAY = date(2026, 5, 21)


def _delete_url(journal_id: object) -> str:
    return f"{LIST_URL}/{journal_id}"


def _delete(client: TestClient, journal_id: object):
    return client.delete(_delete_url(journal_id), headers={"If-Match": '"1"'})


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
    """整表完整列的原生 SQL 快照（按 id 排序）。"""
    return [tuple(row) for row in session.execute(_SNAPSHOT_SQL)]


def _row_if_any(session: Session, journal_id: int) -> tuple | None:
    """按 id 取一行实际列值；不存在时返回 None（原生 SQL，绕开 identity map）。"""
    row = session.execute(_ROW_SQL, {"journal_id": journal_id}).one_or_none()
    return None if row is None else tuple(row)


def _is_soft_deleted(session: Session, journal_id: int) -> bool:
    """该行是否存在且 `deleted_at` 非空。"""
    row = _row_if_any(session, journal_id)
    return row is not None and row[7] is not None


def _list_ids(client: TestClient, **params) -> list[int]:
    """通过 GET /api/journals 拿到 id 列表（分页 envelope，可选筛选参数）。"""
    response = client.get(LIST_URL, params=params)
    assert response.status_code == 200
    return [item["id"] for item in response.json()["items"]]


def _seed_via_api(client: TestClient, **payload) -> dict:
    """用 POST 建一条记录，返回响应体。

    失败路径用例不能用 `session.add()` + `flush()` 造数据：
    `Session.rollback()` 会回滚到 Session 自己的 savepoint，
    连测试刚 flush 但还没 release 的行一起撤销，
    于是「删除失败后记录是否恢复」就无从验证。
    走一次 POST 会 RELEASE SAVEPOINT，把该行留在外层事务里（仍未提交），
    之后的 rollback 只会撤销这次失败的 DELETE。
    """
    response = client.post(
        LIST_URL,
        json={
            "title": None,
            "content": "原始正文",
            "journal_date": DAY.isoformat(),
            **payload,
        },
    )
    assert response.status_code == 201
    return response.json()


# ==========================================================================
# A. 正常删除（软删除：行保留、只有 deleted_at 变化）
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


def test_deleted_row_is_kept_but_marked_in_the_current_transaction(api):
    """用原生 SQL 确认：行仍在，只是 `deleted_at` 被置为当前时间。"""
    client, session = api

    journal = _seed(
        session,
        _make_journal(title="将被删除", content="正文", journal_date=DAY),
    )
    journal_id = journal.id
    before = _row_if_any(session, journal_id)
    assert before is not None
    assert before[7] is None  # 删除前 deleted_at 为空

    assert _delete(client, journal_id).status_code == 204

    after = _row_if_any(session, journal_id)
    # 行没有被物理删除
    assert after is not None
    assert journal_id in _existing_ids(session)
    # 只有 deleted_at 由 NULL 变成非 NULL，其余列逐字段不变
    assert before[7] is None
    assert after[7] is not None
    assert after[:7] == before[:7]


def test_soft_delete_keeps_the_row_so_row_count_is_unchanged(api):
    client, session = api

    _seed(session, _make_journal(content="待删除", journal_date=DAY))
    journal = _seed(session, _make_journal(content="待删除之二", journal_date=DAY))

    before = _count_rows_in(session)

    assert _delete(client, journal.id).status_code == 204

    # 软删除不减少物理行数；该行仍存在，只是被标记为已删除。
    assert _count_rows_in(session) == before
    assert _is_soft_deleted(session, journal.id)


def test_delete_changes_only_the_target_row(api):
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
    # 物理行数不变
    assert len(after) == len(snapshot_before)
    # 目标之外的所有行逐字段原样保留
    assert [row for row in after if row[0] != target.id] == [
        row for row in snapshot_before if row[0] != target.id
    ]
    # 目标行：除 deleted_at 外全部不变
    before_row = next(row for row in snapshot_before if row[0] == target.id)
    after_row = next(row for row in after if row[0] == target.id)
    assert after_row[:7] == before_row[:7]
    assert before_row[7] is None and after_row[7] is not None
    # 另一篇完全没被牵连
    assert _row_if_any(session, keeper.id) == next(
        row for row in snapshot_before if row[0] == keeper.id
    )


def test_delete_preserves_updated_at_exactly(api):
    """软删除是状态变化，不是内容修改：`updated_at` 必须原样保持。"""
    client, session = api

    journal = _seed(
        session,
        _make_journal(title="不该刷新时间", content="正文", journal_date=DAY),
    )
    before = _row_if_any(session, journal.id)
    assert before is not None

    assert _delete(client, journal.id).status_code == 204

    after = _row_if_any(session, journal.id)
    assert after is not None
    # updated_at 是第 7 列（索引 6），必须与删除前完全相同
    assert after[6] == before[6]


def test_second_delete_returns_404_and_does_not_rewrite_deleted_at(api):
    """同一记录删两次：第二次 404，且原来的 `deleted_at` 不被改写。"""
    client, session = api

    journal = _seed(
        session,
        _make_journal(title="只删一次", content="正文", journal_date=DAY),
    )
    journal_id = journal.id

    assert _delete(client, journal_id).status_code == 204
    first_deleted_at = _row_if_any(session, journal_id)[7]
    assert first_deleted_at is not None

    assert _delete(client, journal_id).status_code == 404
    # 行仍在，且 deleted_at 未被第二次删除覆盖
    assert _row_if_any(session, journal_id)[7] == first_deleted_at


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
    """独立连接看不到任何变化：软删除只存在于被回滚的外层事务里。"""
    client, session = api

    committed_before = _count_rows_independently()

    journal = _seed(
        session,
        _make_journal(title="临时创建的", content="正文", journal_date=DAY),
    )

    assert _delete(client, journal.id).status_code == 204

    # 本次事务里该行确实已被标记为已删除
    assert _is_soft_deleted(session, journal.id)
    # 但独立连接看到的已提交行数没有变化：删除没有真正提交
    assert _count_rows_independently() == committed_before


def test_health_endpoint_is_unchanged(api):
    client, _session = api

    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert response.headers["content-type"].startswith("application/json")


# ==========================================================================
# E. 删除失败与回滚（正式验证真实 UPDATE 被撤销）
# ==========================================================================


def test_service_delete_commit_failure_rolls_back_and_restores_the_row(api, monkeypatch):
    """受控 commit 故障：先真实 flush 出 UPDATE，再抛异常。

    `flush()` 让 UPDATE 真正发送到 PostgreSQL，因此这不是「commit 前直接抛异常」
    的假故障：能验证已经发出的软删除被 `rollback` 撤销、记录恢复原值。

    目标记录先用 POST 建好（已 RELEASE SAVEPOINT，位于外层事务内），
    所以失败后的 rollback 只撤销那次 UPDATE，能真正检查记录是否恢复。
    """
    client, session = api

    created = _seed_via_api(client, title="要删但不该删掉", content="必须保留的正文")
    target_id = created["id"]
    other = _seed_via_api(
        client, title="另一行", content="也要保留", journal_date=OTHER_DAY.isoformat()
    )
    other_id = other["id"]
    before = _row_if_any(session, target_id)
    assert before is not None
    snapshot_before = _snapshot(session)

    def failing_commit(self):
        self.flush()  # 让 UPDATE 真的发到 PostgreSQL
        raise RuntimeError("受控的 commit 故障")

    monkeypatch.setattr(Session, "commit", failing_commit)

    with pytest.raises(RuntimeError):
        service.delete_journal(session, target_id, expected_revision=1)

    # 没有半截软删除：目标行恢复（deleted_at 回到 NULL），且与失败前逐字段一致
    assert _row_if_any(session, target_id) == before
    assert _row_if_any(session, target_id)[7] is None
    # 其它行也没被牵连，整表快照回到失败前
    assert _snapshot(session) == snapshot_before
    assert _row_if_any(session, other_id) is not None
    # rollback 之后 Session 已回到可用状态
    assert session.execute(text("SELECT 1")).scalar_one() == 1


def test_service_normal_delete_succeeds_after_recovering_from_fault(api, monkeypatch):
    """确认 rollback 之后 Session 仍然可用：撤掉故障后正常删除能成功。"""
    client, session = api

    created = _seed_via_api(client, title="最终要删掉", content="正文")
    target_id = created["id"]

    real_commit = Session.commit

    def failing_commit(self):
        self.flush()
        raise RuntimeError("受控的 commit 故障")

    monkeypatch.setattr(Session, "commit", failing_commit)
    with pytest.raises(RuntimeError):
        service.delete_journal(session, target_id, expected_revision=1)
    # 失败后记录仍是有效的
    assert not _is_soft_deleted(session, target_id)

    # 恢复真实的 commit，再删一次：应当成功
    monkeypatch.setattr(Session, "commit", real_commit)

    assert service.delete_journal(session, target_id, expected_revision=1) is True
    # 软删除成功：行保留但已标记
    assert _is_soft_deleted(session, target_id)


def test_delete_commit_failure_returns_500_not_204_and_keeps_the_row(api, monkeypatch):
    """HTTP 层：真实 UPDATE + 受控提交失败时返回 500，绝不是 204 / 404。

    与 Service 层用例使用同一种故障注入：先真实 flush 出 UPDATE，再抛异常，
    因此能证明「已经发到数据库的软删除被回滚，HTTP 报 500」。
    """
    client, session = api

    created = _seed_via_api(client, title="不会真的删掉", content="必须保留")
    target_id = created["id"]
    before = _row_if_any(session, target_id)
    assert before is not None

    def failing_commit(self):
        self.flush()
        raise RuntimeError("受控的 commit 故障")

    monkeypatch.setattr(Session, "commit", failing_commit)

    response = _delete(client, target_id)

    assert response.status_code == 500
    assert response.status_code not in (204, 404)
    # 原生 SQL 确认目标记录仍然有效，且与失败前完全一致
    assert _row_if_any(session, target_id) == before
    assert _row_if_any(session, target_id)[7] is None
    # Session 仍可查询
    assert session.execute(text("SELECT 1")).scalar_one() == 1


# ==========================================================================
# F. 同日其它记录不受影响
# ==========================================================================


def test_delete_does_not_affect_same_day_siblings_or_other_days(api):
    """软删除一个明确目标后：同日的另一篇（含 title=null）与其他日期的记录都不变。"""
    client, session = api

    target = _seed(
        session,
        _make_journal(title="要删的", content="正文 T", journal_date=DAY),
    )
    sibling_null = _seed(
        session,
        _make_journal(title=None, content="同日的无标题记录", journal_date=DAY),
    )
    sibling_named = _seed(
        session,
        _make_journal(title="同日的另一篇", content="正文 B", journal_date=DAY),
    )
    other_day = _seed(
        session,
        _make_journal(title="另一天", content="正文 C", journal_date=OTHER_DAY),
    )

    before = {
        jid: _row_if_any(session, jid)
        for jid in (sibling_null.id, sibling_named.id, other_day.id)
    }
    snapshot_before = _snapshot(session)

    assert _delete(client, target.id).status_code == 204

    # 物理行数不变（软删除不删行）
    assert len(_snapshot(session)) == len(snapshot_before)
    # 目标自己被标记为已删除，其它列不变
    assert _is_soft_deleted(session, target.id)
    # 同日两篇与其他日期记录的完整列逐字段不变
    for jid, row in before.items():
        assert _row_if_any(session, jid) == row
    # 整表除目标外逐行一致
    after = _snapshot(session)
    assert [r for r in after if r[0] != target.id] == [
        r for r in snapshot_before if r[0] != target.id
    ]


# ==========================================================================
# G. 删除后的查询联动（普通入口隐藏已删除目标）
# ==========================================================================


def test_deleted_record_disappears_from_detail_list_and_filter(api):
    """软删除后：详情 404、列表与日期筛选都不再包含该 id，二次删除 404 且数据不变。"""
    client, session = api

    target = _seed(
        session,
        _make_journal(title="会被删的", content="正文 T", journal_date=DAY),
    )
    _seed(
        session,
        _make_journal(title=None, content="同日的另一篇", journal_date=DAY),
    )
    target_id = target.id

    # 删除前：目标出现在详情、列表与日期筛选中
    assert client.get(_delete_url(target_id)).status_code == 200
    assert target_id in _list_ids(client)
    assert target_id in _list_ids(client, journal_date=DAY.isoformat())

    response = _delete(client, target_id)
    assert response.status_code == 204
    assert response.content == b""

    # 删除后：详情 404
    assert client.get(_delete_url(target_id)).status_code == 404
    # 列表与日期筛选都不再包含目标（不断言整体为空：库里可能有其它数据）
    assert target_id not in _list_ids(client)
    assert target_id not in _list_ids(client, journal_date=DAY.isoformat())
    # 但行仍然留在数据库里，只是被标记为已删除
    assert _is_soft_deleted(session, target_id)

    # 二次删除返回 404，且不会改动其余数据
    snapshot_before_second = _snapshot(session)
    assert _delete(client, target_id).status_code == 404
    assert _snapshot(session) == snapshot_before_second


def test_deleted_record_is_not_patchable(api):
    """已软删除的记录：PATCH 返回 404，且不写任何字段（含 deleted_at）。"""
    client, session = api

    target = _seed(
        session,
        _make_journal(title="原标题", content="正文", journal_date=DAY),
    )
    assert _delete(client, target.id).status_code == 204

    before = _row_if_any(session, target.id)
    response = client.patch(_delete_url(target.id), json={"expected_revision": 1, **{"title": "改不动"}})

    assert response.status_code == 404
    assert _row_if_any(session, target.id) == before


def test_same_day_sibling_and_other_day_record_stay_readable(api):
    """目标软删除后：同日另一篇仍在详情与日期筛选里，另一日期记录仍可正常读取。"""
    client, session = api

    target = _seed(
        session,
        _make_journal(title="要删的", content="正文 T", journal_date=DAY),
    )
    sibling = _seed(
        session,
        _make_journal(title="同日的另一篇", content="正文 B", journal_date=DAY),
    )
    other = _seed(
        session,
        _make_journal(title="另一天", content="正文 C", journal_date=OTHER_DAY),
    )

    assert _delete(client, target.id).status_code == 204

    # 同日另一篇：详情可读，且仍出现在同日筛选里
    sibling_detail = client.get(_delete_url(sibling.id))
    assert sibling_detail.status_code == 200
    assert sibling_detail.json()["id"] == sibling.id
    assert sibling.id in _list_ids(client, journal_date=DAY.isoformat())

    # 另一日期记录：详情可读，且出现在它自己的日期筛选里
    other_detail = client.get(_delete_url(other.id))
    assert other_detail.status_code == 200
    assert other_detail.json()["id"] == other.id
    assert other.id in _list_ids(client, journal_date=OTHER_DAY.isoformat())
    # 它没有跑到被删记录那一天
    assert other.id not in _list_ids(client, journal_date=DAY.isoformat())
