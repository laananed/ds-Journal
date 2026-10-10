"""PATCH /api/journals/{id} 部分更新的最小 API 测试。

Stage 1 / Task 6.2。

与创建 / 列表 / 详情测试一样，这里使用 FastAPI TestClient 与**真实 PostgreSQL**，
完整走一遍：HTTP → Pydantic → Router → Service → SQLAlchemy → psycopg → PostgreSQL。

共享的 `api` fixture 位于 `tests/conftest.py`：它返回 `(TestClient, 测试 Session)`，
用「外层事务 + savepoint」把所有写入关在事务里，测试结束即回滚。
本文件不复制 fixture、不新建通用测试层，也不创建会偷偷提交的独立 Session。

## 这些测试如何在「非空库」上成立

本机 `journals` 表里可能已经有既有记录，因此本文件**不假设空表**：

- 需要检查列表 / 筛选结果时，只在响应里定位自己创建的 id，
  不断言整个列表的内容或长度；
- 需要检查「有没有写入」时，比较**整表六字段的原生 SQL 快照**，
  并只要求既有行保持原样；
- 不存在的 id 从当前事务里真实存在的 id 集合反推，
  不写死固定值，也不假设 id 连续或从 1 开始。

## 为什么用原生 SQL 读断言

ORM 对象可能来自 Session 的 identity map，缓存旧值会掩盖字段变化，
因此所有字段断言都走 `session.execute(text(...))` 直接读列值。

## 时间字段

测试用具成的、明显更早的 `created_at` / `updated_at`（2026-10-02），
因此不需要 sleep，也不依赖时间分辨率：

- 真的发生 UPDATE 时，`onupdate` 会写入「现在」，必然大于 2026-10-02；
- 没有写入时，两个时间必须原样保持。

## 关于 sequence

PostgreSQL 的 sequence 取值不随事务回滚，所以 `id` 会跳号。
这不代表数据残留，测试也不重置 sequence。
"""

from __future__ import annotations

from datetime import date, datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import engine
from app.journal import service
from app.journal.models import Journal
from app.journal.schemas import JournalUpdate

LIST_URL = "/api/journals"

# Stage 2 / S2-T02：完整响应从六字段扩展为十字段。
RESPONSE_FIELDS = {
    "type",
    "id",
    "title",
    "display_title",
    "content",
    "journal_date",
    "folder_id",
    "created_at",
    "updated_at",
    "deleted_at",
"revision", "content_blocks"}

# 只取固定列、按 id 排序的快照 SQL：绕开 identity map，直接读数据库列值。
_SNAPSHOT_SQL = text(
    "SELECT id, title, content, journal_date, created_at, updated_at "
    "FROM journals ORDER BY id"
)

_ROW_SQL = text(
    "SELECT id, title, content, journal_date, created_at, updated_at "
    "FROM journals WHERE id = :journal_id"
)

# 与既有记录刻意错开的业务日期，避免与其它数据相互干扰。
DAY = date(2026, 3, 11)
OTHER_DAY = date(2026, 3, 12)


def _patch_url(journal_id: object) -> str:
    return f"{LIST_URL}/{journal_id}"


def _utc(day: int, hour: int = 0, minute: int = 0) -> datetime:
    """构造 2026-10 某日带 UTC 时区的时间，作为「明显更早」的合成时间。"""
    return datetime(2026, 10, day, hour, minute, tzinfo=timezone.utc)


def _make_journal(
    *,
    content: str,
    journal_date: date,
    title: str | None = None,
    created_at: datetime | None = None,
    updated_at: datetime | None = None,
) -> Journal:
    """构造（未持久化的）Journal 对象，只在显式提供时写入时间字段。"""
    kwargs: dict[str, object] = {
        "title": title,
        "content": content,
        "journal_date": journal_date,
    }
    if created_at is not None:
        kwargs["created_at"] = created_at
    if updated_at is not None:
        kwargs["updated_at"] = updated_at
    return Journal(**kwargs)


def _seed(session: Session, journal: Journal) -> Journal:
    """写入一行带有合成时间的测试数据并 flush，让 id 生成。"""
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


def _row_of(session: Session, journal_id: int) -> tuple:
    """按 id 取一行实际列值（原生 SQL，绕开 identity map）。"""
    row = session.execute(_ROW_SQL, {"journal_id": journal_id}).one_or_none()
    assert row is not None, f"记录 {journal_id} 应该存在于数据库中"
    return tuple(row)


def _assert_matches_row(item: dict, row: tuple) -> None:
    """逐字段比较响应与数据库实际列值。

    除六个数据库列外，还检查两个投影字段：
    `type` 恒为 `"journal"`，普通入口的 `deleted_at` 恒为 `null`。
    """
    assert item["id"] == row[0]
    assert item["title"] == row[1]
    assert item["content"] == row[2]
    assert item["journal_date"] == row[3].isoformat()
    assert datetime.fromisoformat(item["created_at"]) == row[4]
    assert datetime.fromisoformat(item["updated_at"]) == row[5]
    assert item["type"] == "journal"
    assert item["deleted_at"] is None


def _seed_via_api(client: TestClient, **payload) -> dict:
    """用 POST 建一条记录，返回响应体。

    失败路径用例不能用 `session.add()` + `flush()` 造数据：
    `Session.rollback()` 会回滚到 Session 自己的 savepoint，
    连测试刚 flush 但还没 release 的行一起撤销，于是「字段是否恢复」就无从验证。
    走一次 POST 会 RELEASE SAVEPOINT，把该行留在外层事务里（仍未提交），
    之后的 rollback 只会撤销这次失败的 UPDATE。
    """
    response = client.post(
        LIST_URL,
        json={"title": None, "content": "原始正文", "journal_date": DAY.isoformat(), **payload},
    )
    assert response.status_code == 201
    return response.json()


def _patch(client: TestClient, journal_id: object, **payload):
    return client.patch(_patch_url(journal_id), json={"expected_revision": 1, **payload})


def _list_ids(client: TestClient, **params) -> list[int]:
    """通过 GET /api/journals 拿到 id 列表（分页 envelope）。"""
    response = client.get(LIST_URL, params=params)
    assert response.status_code == 200
    return [item["id"] for item in response.json()["items"]]


# ==========================================================================
# A. 正常更新
# ==========================================================================


def test_patch_title_returns_200_with_the_full_response(api):
    client, session = api

    journal = _seed(session, _make_journal(content="原始正文", journal_date=DAY))

    response = _patch(client, journal.id, title="新的标题")

    assert response.status_code == 200
    body = response.json()
    assert set(body) == RESPONSE_FIELDS

    assert body["id"] == journal.id
    assert body["title"] == "新的标题"
    # 有手工标题：display_title 就是原 title
    assert body["display_title"] == "新的标题"
    # 未提交的字段保持原值
    assert body["content"] == "原始正文"
    assert body["journal_date"] == DAY.isoformat()

    _assert_matches_row(body, _row_of(session, journal.id))


def test_patch_content_keeps_the_other_fields(api):
    client, session = api

    journal = _seed(
        session,
        _make_journal(title="原标题", content="原始正文", journal_date=DAY),
    )

    body = _patch(client, journal.id, content="修改后的正文").json()

    assert body["content"] == "修改后的正文"
    assert body["title"] == "原标题"
    assert body["journal_date"] == DAY.isoformat()

    _assert_matches_row(body, _row_of(session, journal.id))


def test_patch_journal_date_keeps_the_other_fields(api):
    client, session = api

    journal = _seed(
        session,
        _make_journal(title="原标题", content="原始正文", journal_date=DAY),
    )

    body = _patch(client, journal.id, journal_date=OTHER_DAY.isoformat()).json()

    assert body["journal_date"] == OTHER_DAY.isoformat()
    assert body["title"] == "原标题"
    assert body["content"] == "原始正文"

    _assert_matches_row(body, _row_of(session, journal.id))


def test_patch_multiple_fields_together(api):
    client, session = api

    journal = _seed(
        session,
        _make_journal(title="原标题", content="原始正文", journal_date=DAY),
    )

    body = _patch(
        client,
        journal.id,
        title="新标题",
        content="新正文",
        journal_date=OTHER_DAY.isoformat(),
    ).json()

    assert body["title"] == "新标题"
    assert body["content"] == "新正文"
    assert body["journal_date"] == OTHER_DAY.isoformat()

    _assert_matches_row(body, _row_of(session, journal.id))


@pytest.mark.parametrize(
    "payload",
    [
        {"title": "只改标题"},
        {"content": "只改正文"},
        {"journal_date": "2026-03-12"},
    ],
)
def test_each_patch_response_matches_the_database_row(api, payload):
    client, session = api

    journal = _seed(
        session,
        _make_journal(title="原标题", content="原始正文", journal_date=DAY),
    )

    response = _patch(client, journal.id, **payload)

    assert response.status_code == 200
    _assert_matches_row(response.json(), _row_of(session, journal.id))


def test_title_null_clears_the_title(api):
    client, session = api

    journal = _seed(
        session,
        _make_journal(title="会被清空的标题", content="正文", journal_date=DAY),
    )

    body = _patch(client, journal.id, title=None).json()

    assert body["title"] is None
    # 显式 null 不能丢：数据库里的 title 必须真的变成 NULL
    assert _row_of(session, journal.id)[1] is None


@pytest.mark.parametrize(
    "content",
    ["", " ", "\t", "\n", "\u3000", "\xa0"],
)
def test_blank_content_patch_is_rejected(api, content):
    """Stage 1.5 / S1.5-T2：纯空白正文不再是合法输入（旧规则曾允许空字符串）。"""
    client, session = api

    journal = _seed(
        session, _make_journal(content="原始正文", journal_date=DAY)
    )
    before = _row_of(session, journal.id)

    response = _patch(client, journal.id, content=content)

    assert response.status_code == 422
    assert _row_of(session, journal.id) == before


def test_patch_does_not_touch_the_sibling_on_the_same_day(api):
    client, session = api

    mine = _seed(
        session,
        _make_journal(
            title="我要改的", content="正文 A", journal_date=DAY,
            created_at=_utc(2, 1), updated_at=_utc(2, 1),
        ),
    )
    sibling = _seed(
        session,
        _make_journal(
            title="同一天的另一篇", content="正文 B", journal_date=DAY,
            created_at=_utc(2, 2), updated_at=_utc(2, 2),
        ),
    )

    sibling_before = _row_of(session, sibling.id)

    _patch(client, mine.id, title="改过了", content="正文 A2")

    assert _row_of(session, mine.id)[1] == "改过了"
    # 同一天的另一篇六个字段完全没动
    assert _row_of(session, sibling.id) == sibling_before


def test_patch_does_not_create_a_default_title_or_numbering(api):
    """清空标题后不生成日期标题，也不写同日编号，只是 title 为空。

    `display_title` 是读取投影：它回退为业务日期，但数据库里的 `title` 仍是 NULL。
    """
    client, session = api

    journal = _seed(
        session,
        _make_journal(title="原标题", content="正文", journal_date=DAY),
    )
    _seed(session, _make_journal(content="同一天的另一篇无标题记录", journal_date=DAY))

    body = _patch(client, journal.id, title=None).json()

    assert body["title"] is None
    assert DAY.isoformat() not in (body["title"] or "")
    assert "(" not in (body["title"] or "")
    # 数据库里的 title 没有被写入日期或编号
    assert _row_of(session, journal.id)[1] is None
    # display_title 只是投影：这篇 created_at 更早，是当天的第 1 篇
    assert body["display_title"] == DAY.isoformat()


# ==========================================================================
# B. 系统字段与时间
# ==========================================================================


def test_id_and_created_at_are_unchanged_after_a_real_change(api):
    client, session = api

    journal = _seed(
        session,
        _make_journal(
            title="原标题", content="原始正文", journal_date=DAY,
            created_at=_utc(2, 1), updated_at=_utc(2, 1),
        ),
    )
    before = _row_of(session, journal.id)

    body = _patch(client, journal.id, content="真的改了").json()

    after = _row_of(session, journal.id)

    assert after[0] == before[0] == journal.id  # id
    assert after[4] == before[4] == _utc(2, 1)  # created_at 原样保持
    assert datetime.fromisoformat(body["created_at"]) == _utc(2, 1)


def test_updated_at_is_refreshed_when_a_field_actually_changes(api):
    client, session = api

    journal = _seed(
        session,
        _make_journal(
            title="原标题", content="原始正文", journal_date=DAY,
            created_at=_utc(2, 1), updated_at=_utc(2, 1),
        ),
    )

    body = _patch(client, journal.id, content="真的改了").json()

    updated_at = datetime.fromisoformat(body["updated_at"])
    # 合成时间是 2026-10-02，真实修改后必须更晚，且与数据库一致。
    assert updated_at > _utc(2, 1)
    assert _row_of(session, journal.id)[5] == updated_at


def test_client_cannot_control_system_fields(api):
    client, session = api

    journal = _seed(
        session,
        _make_journal(
            title="原标题", content="原始正文", journal_date=DAY,
            created_at=_utc(2, 1), updated_at=_utc(2, 1),
        ),
    )

    body = _patch(
        client,
        journal.id,
        title="新的标题",
        id=999,
        created_at="2020-01-01T00:00:00Z",
        updated_at="2020-01-01T00:00:00Z",
    ).json()

    assert body["title"] == "新的标题"
    assert body["id"] == journal.id != 999
    # 客户端提交的 2020 年时间没有生效：created_at 保持原值。
    assert datetime.fromisoformat(body["created_at"]) == _utc(2, 1)
    assert _row_of(session, journal.id)[4] == _utc(2, 1)


def test_empty_patch_returns_the_current_record_without_writing(api):
    """{} 在记录存在时返回 200 与当前记录，六个字段（含 updated_at）都不变。"""
    client, session = api

    journal = _seed(
        session,
        _make_journal(
            title="原标题", content="原始正文", journal_date=DAY,
            created_at=_utc(2, 1), updated_at=_utc(2, 1),
        ),
    )
    before = _row_of(session, journal.id)
    snapshot_before = _snapshot(session)

    response = client.patch(_patch_url(journal.id), json={"expected_revision": 1, **{}})

    assert response.status_code == 200
    body = response.json()
    assert set(body) == RESPONSE_FIELDS

    # 整表快照不变：既没有改动，也没有新增
    assert _snapshot(session) == snapshot_before
    assert _row_of(session, journal.id) == before
    # 特别是 updated_at 没有被刷新
    assert datetime.fromisoformat(body["updated_at"]) == before[5]
    # 响应与数据库实际列值逐字段一致
    _assert_matches_row(body, before)


@pytest.mark.parametrize(
    "payload",
    [
        {"id": 999},
        {"created_at": "2020-01-01T00:00:00Z"},
        {"updated_at": "2020-01-01T00:00:00Z"},
        {"id": 999, "created_at": "2020-01-01T00:00:00Z", "updated_at": "2020-01-01T00:00:00Z"},
        {"author": "someone"},
        {"tags": ["a", "b"]},
    ],
)
def test_payload_without_update_fields_is_an_empty_update(api, payload):
    """只提交被忽略的额外字段 / 系统字段时，验证后的更新数据是空集合。"""
    client, session = api

    journal = _seed(
        session,
        _make_journal(
            title="原标题", content="原始正文", journal_date=DAY,
            created_at=_utc(2, 1), updated_at=_utc(2, 1),
        ),
    )
    before = _row_of(session, journal.id)

    response = client.patch(_patch_url(journal.id), json={"expected_revision": 1, **payload})

    assert response.status_code == 200
    body = response.json()
    assert set(body) == RESPONSE_FIELDS
    assert body["title"] == "原标题"
    # 与空更新同一条路径：不写入，updated_at 不变
    assert _row_of(session, journal.id) == before
    assert datetime.fromisoformat(body["updated_at"]) == before[5]


def test_same_value_patch_does_not_force_a_timestamp_change(api):
    """提交与原值相同的字段：沿用 SQLAlchemy 的无变化处理，不强制刷新 updated_at。

    这里刻意不把「提交相同值」当成「实际字段修改」：
    只要求业务字段与 created_at 不变，updated_at 不做强制要求，
    而是由 SQLAlchemy 决定（当前行为见下面的断言）。
    """
    client, session = api

    journal = _seed(
        session,
        _make_journal(
            title="一样的标题", content="一样的正文", journal_date=DAY,
            created_at=_utc(2, 1), updated_at=_utc(2, 1),
        ),
    )
    before = _row_of(session, journal.id)

    response = _patch(client, journal.id, title="一样的标题", content="一样的正文")

    assert response.status_code == 200
    after = _row_of(session, journal.id)

    # 业务字段与 created_at、id 不变
    assert after[:3] == before[:3]
    assert after[4] == before[4]
    # 值没有真正变化时不额外强制刷新时间戳。
    assert after[5] == before[5]


# ==========================================================================
# C. 错误路径
# ==========================================================================


def test_absent_id_returns_404(api):
    client, session = api

    absent = _id_not_present(session)
    assert absent not in _existing_ids(session)

    response = _patch(client, absent, title="不会写进去")

    assert response.status_code == 404
    # 404 不会顺手创建任何东西
    assert absent not in _existing_ids(session)


def test_absent_id_empty_patch_returns_404(api):
    """空 PATCH 在记录不存在时同样返回 404，而不是 200。"""
    client, session = api

    absent = _id_not_present(session)
    snapshot_before = _snapshot(session)

    response = client.patch(_patch_url(absent), json={"expected_revision": 1, **{}})

    assert response.status_code == 404
    assert absent not in _existing_ids(session)
    assert _snapshot(session) == snapshot_before


def test_404_body_is_plain(api):
    client, session = api

    body = client.patch(_patch_url(_id_not_present(session)), json={"expected_revision": 1, **{}}).json()

    assert set(body) == {"detail"}
    assert isinstance(body["detail"], str)


@pytest.mark.parametrize("raw_id", ["0", "-1"])
def test_zero_and_negative_ids_return_404(api, raw_id):
    """契约没有规定 gt=0，因此 0 与负数同样是「合法整数但不存在」。"""
    client, session = api

    candidate = int(raw_id)
    assert candidate not in _existing_ids(session)

    assert client.patch(_patch_url(candidate), json={"expected_revision": 1, **{}}).status_code == 404


@pytest.mark.parametrize(
    "raw_id",
    ["abc", "12abc", "1.5", "null", "true", "2026-10-02"],
)
def test_non_integer_id_returns_422(api, raw_id):
    client, session = api

    before = _snapshot(session)

    response = _patch(client, raw_id, title="不会写进去")

    assert response.status_code == 422
    assert _snapshot(session) == before


@pytest.mark.parametrize(
    "payload",
    [
        {"content": None},  # content 不可空
        {"journal_date": None},  # journal_date 不可空
        {"journal_date": "2026-02-30"},  # 2 月没有 30 号
        {"journal_date": "2026-02-29"},  # 2026 不是闰年
        {"journal_date": "2026-13-01"},  # 没有 13 月
        {"journal_date": "2026/03/11"},
        {"journal_date": "not-a-date"},
        {"journal_date": ""},
        {"content": 123},  # 类型错误
        {"journal_date": 123},  # 类型错误
        # Stage 1.5 / S1.5-T2：长度与空白新规则
        {"title": "标" * 81},
        {"title": "🧭" * 81},
        {"content": ""},
        {"content": "   "},
        {"content": "\u3000"},
        {"content": "a" * 50_001},
        {"content": " " * 50_000 + "x"},
    ],
)
def test_invalid_payload_returns_422_without_writing(api, payload):
    client, session = api

    journal = _seed(
        session,
        _make_journal(
            title="原标题", content="原始正文", journal_date=DAY,
            created_at=_utc(2, 1), updated_at=_utc(2, 1),
        ),
    )
    before = _row_of(session, journal.id)

    response = client.patch(_patch_url(journal.id), json={"expected_revision": 1, **payload})

    assert response.status_code == 422
    assert _row_of(session, journal.id) == before


def test_404_and_422_leave_the_data_untouched(api):
    client, session = api

    journal = _seed(
        session,
        _make_journal(
            title="原标题", content="原始正文", journal_date=DAY,
            created_at=_utc(2, 1), updated_at=_utc(2, 1),
        ),
    )

    snapshot_before = _snapshot(session)
    count_before = _count_rows_in(session)
    assert len(snapshot_before) >= 1

    assert client.patch(_patch_url(_id_not_present(session)), json={"expected_revision": 1, **{}}).status_code == 404
    assert _patch(client, journal.id, content=None).status_code == 422
    assert _patch(client, "abc", title="x").status_code == 422
    assert _patch(client, journal.id, journal_date="2026-02-30").status_code == 422

    assert _snapshot(session) == snapshot_before
    assert _count_rows_in(session) == count_before


# ==========================================================================
# D. 失败回滚
# ==========================================================================


def test_write_failure_rolls_back_and_restores_the_row(api):
    """真实数据库约束失败：绕过 Pydantic 构造 content=None，触发 NOT NULL 违反。

    `model_construct()` 跳过校验但仍然把 content 记入本次提交字段，
    因此 UPDATE 真的会被 PostgreSQL 拒绝，
    从而验证 Service 的 rollback 分支与 Session 清理。

    这里的记录先用 POST 建好（已 RELEASE SAVEPOINT，位于外层事务内），
    所以失败后的 rollback 只撤销那次 UPDATE，能真正检查字段是否恢复。
    """
    client, session = api

    created = _seed_via_api(client, title="原标题", content="必须保留的正文")
    journal_id = created["id"]
    before = _row_of(session, journal_id)
    assert before[2] == "必须保留的正文"

    invalid = JournalUpdate.model_construct(content=None, expected_revision=1)

    with pytest.raises(IntegrityError):
        service.update_journal(session, journal_id, invalid)

    # 没有半截更新：六个字段与失败前完全一致
    assert _row_of(session, journal_id) == before
    # Session 已回到可用状态
    assert session.execute(text("SELECT 1")).scalar_one() == 1


def test_commit_failure_returns_500_and_leaves_no_partial_update(api, monkeypatch):
    """受控 commit 故障：先真实 flush 出 UPDATE，再抛异常。

    用于验证 HTTP 层：写入失败返回 500，数据库里不会留下半截修改。
    """
    client, session = api

    created = _seed_via_api(client, title="原标题", content="原始正文")
    journal_id = created["id"]
    before = _row_of(session, journal_id)

    def failing_commit(self):
        self.flush()  # 让 UPDATE 真的发到 PostgreSQL
        raise RuntimeError("受控的 commit 故障")

    monkeypatch.setattr(Session, "commit", failing_commit)

    response = _patch(client, journal_id, content="这次修改不会留下")

    assert response.status_code == 500
    assert _row_of(session, journal_id) == before
    # Session 可以继续使用
    assert session.execute(text("SELECT 1")).scalar_one() == 1


# ==========================================================================
# E. 联动与回归
# ==========================================================================


def test_patched_record_can_be_read_back_through_detail(api):
    client, session = api

    journal = _seed(
        session,
        _make_journal(title="原标题", content="原始正文", journal_date=DAY),
    )

    patched = _patch(client, journal.id, title="改过之后", content="新正文")
    assert patched.status_code == 200

    detail = client.get(_patch_url(journal.id))
    assert detail.status_code == 200

    assert detail.json() == patched.json()
    _assert_matches_row(detail.json(), _row_of(session, journal.id))


def test_changed_date_moves_the_record_between_filters(api):
    client, session = api

    journal = _seed(
        session, _make_journal(title="要换日期的", content="正文", journal_date=DAY)
    )

    assert journal.id in _list_ids(client, journal_date=DAY.isoformat())

    _patch(client, journal.id, journal_date=OTHER_DAY.isoformat())

    assert journal.id in _list_ids(client, journal_date=OTHER_DAY.isoformat())
    # 旧日期不再包含该记录（不断言整个结果为空：库里可能有其它数据）
    assert journal.id not in _list_ids(client, journal_date=DAY.isoformat())


def test_list_reflects_the_new_field_values(api):
    client, session = api

    journal = _seed(
        session,
        _make_journal(title="原标题", content="原始正文", journal_date=DAY),
    )

    _patch(client, journal.id, title="列表里应看到新标题", content="新正文")

    listed = [
        item
        for item in client.get(
            LIST_URL, params={"journal_date": DAY.isoformat()}
        ).json()["items"]
        if item["id"] == journal.id
    ]
    assert len(listed) == 1
    assert listed[0]["title"] == "列表里应看到新标题"
    assert listed[0]["content"] == "新正文"


def test_patch_does_not_commit_anything_to_the_database(api):
    """独立连接看不到任何变化：本次修改只存在于被回滚的外层事务里。"""
    client, session = api

    committed_before = _count_rows_independently()
    snapshot_before = _snapshot(session)

    created = client.post(
        LIST_URL,
        json={"title": "临时创建的", "content": "正文", "journal_date": DAY.isoformat()},
    )
    assert created.status_code == 201
    created_id = created.json()["id"]

    assert _patch(client, created_id, title="临时改过的").status_code == 200
    assert _patch(client, created_id, title=None, expected_revision=2).status_code == 200

    # 独立连接仍然看不到这条记录，也没有任何新增
    assert _count_rows_independently() == committed_before
    # 既有行的快照保持原样（只有本次新建的行出现在 Session 侧）
    after = _snapshot(session)
    assert len(after) == len(snapshot_before) + 1
    assert [row for row in after if row[0] != created_id] == snapshot_before
    assert [row for row in after if row[0] == created_id][0][0] == created_id


# ==========================================================================
# F. 旧数据兼容（Stage 1.5 / S1.5-T2）
#
# 收紧后的 POST 已经无法伪造「旧非法数据」，因此这里一律用 ORM 直接写入：
# Schema 校验只作用于请求，不作用于数据库里已经存在的行。
# ==========================================================================


def _seed_legacy(session: Session, **kwargs) -> Journal:
    """用 ORM 直接造一条「历史遗留」记录（绕过请求 Schema 校验）。"""
    return _seed(session, _make_journal(**kwargs))


def test_legacy_blank_and_oversized_records_are_still_readable(api):
    """旧的空白正文 / 超长标题 / 超长正文记录，列表与详情都必须能正常读。"""
    client, session = api

    blank = _seed_legacy(session, content="   ", journal_date=DAY)
    oversized_title = _seed_legacy(
        session, title="旧" * 200, content="正文", journal_date=DAY
    )
    oversized_content = _seed_legacy(
        session, content="旧" * 60_000, journal_date=DAY
    )

    by_id = {
        item["id"]: item
        for item in client.get(
            LIST_URL, params={"journal_date": DAY.isoformat()}
        ).json()["items"]
    }
    assert by_id[blank.id]["content"] == "   "
    assert by_id[oversized_title.id]["title"] == "旧" * 200
    assert len(by_id[oversized_content.id]["content"]) == 60_000

    for journal in (blank, oversized_title, oversized_content):
        detail = client.get(_patch_url(journal.id))
        assert detail.status_code == 200
        _assert_matches_row(detail.json(), _row_of(session, journal.id))


def test_legacy_blank_content_can_be_left_untouched_while_editing_title(api):
    """旧正文空白，但本次只提交合法标题：请求体里没有 content，必须放行且不清洗旧正文。"""
    client, session = api

    legacy = _seed_legacy(session, title="旧标题", content="   ", journal_date=DAY)
    before = _row_of(session, legacy.id)

    response = _patch(client, legacy.id, title="只改标题")

    assert response.status_code == 200
    body = response.json()
    assert body["title"] == "只改标题"
    assert body["content"] == "   "  # 旧空白正文原样保留，没有被「顺手清洗」

    after = _row_of(session, legacy.id)
    assert after[1] == "只改标题"
    assert after[2] == "   "
    assert after[4] == before[4]  # created_at 不变


def test_legacy_oversized_title_can_be_left_untouched_while_editing_content(api):
    """旧标题超长，但本次只提交合法正文：未提交的超长标题保持原样。"""
    client, session = api

    legacy = _seed_legacy(
        session, title="旧" * 200, content="旧正文", journal_date=DAY
    )

    response = _patch(client, legacy.id, content="新的合法正文")

    assert response.status_code == 200
    body = response.json()
    assert body["content"] == "新的合法正文"
    assert body["title"] == "旧" * 200


def test_resubmitting_a_legacy_illegal_field_is_rejected(api):
    """真的把旧非法值重新提交时，仍按新规则拒绝，且不改动目标任何字段。"""
    client, session = api

    legacy = _seed_legacy(session, title="旧" * 200, content="   ", journal_date=DAY)
    before = _row_of(session, legacy.id)

    assert _patch(client, legacy.id, title="旧" * 200).status_code == 422
    assert _patch(client, legacy.id, content="   ").status_code == 422

    assert _row_of(session, legacy.id) == before


def test_health_endpoint_is_unchanged(api):
    client, _session = api

    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert response.headers["content-type"].startswith("application/json")
