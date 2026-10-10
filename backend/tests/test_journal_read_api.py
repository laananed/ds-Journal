"""GET /api/journals 列表与日期筛选的最小 API 测试。

Stage 1 / Task 5.1；Stage 2 / S2-T02 把数组响应迁移为分页 envelope。

与创建测试一样，这里使用 FastAPI TestClient 与**真实 PostgreSQL**，
完整走一遍：HTTP → Pydantic → Router → Service → SQLAlchemy → psycopg → PostgreSQL。

共享的 `api` fixture 位于 `tests/conftest.py`：它返回 `(TestClient, 测试 Session)`，
并用「外层事务 + savepoint」把所有写入关在事务里，测试结束即回滚。
因此本文件可以直接用返回的 Session 造数据（`add` + `flush`），不必担心留下残留。

## 契约迁移说明（Stage 2 / S2-T02）

原来的数组响应已改为分页 envelope：

```text
{ "items": [...], "page": 1, "page_size": 20, "total": N, "has_next": bool }
```

因此本文件的断言从「响应体就是数组」改为「取响应体的 `items`」，
但**保留原有排序 / 日期筛选 / 404 / 字段真实性等意图**：
判断顺序时仍然只看本用例自己插入的 id 之间的相对次序，
不假设「全库只有我插入的这些记录」。

## 这些测试如何保证排序和筛选真的由数据库完成

- 排序测试**手动提供**明确不同的带时区 `created_at`，并以乱序插入记录；
  如果排序退化为插入顺序或没排序，断言就会失败。
- 跨日期测试刻意让「业务日期较新」的记录「实际创建时间更早」，
  用来证明第一排序键是 `journal_date` 而不是 `created_at`。
- 不使用 `sleep`、不依赖 sequence 大小，也不靠插入顺序推断排序。
- 完整的分页边界（0/1/20/21/41、非法页码、跨页编号）见
  `tests/test_journal_pagination_api.py`。

## 关于 sequence

PostgreSQL 的 sequence 取值**不随事务回滚**，所以每次运行后 `journals_id_seq`
都会前进、`id` 会跳号。这不代表数据残留；测试断言的是「同一批记录之间的顺序」，
不要求 id 连续。
"""

from __future__ import annotations

from datetime import date, datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.journal.models import Journal

LIST_URL = "/api/journals"
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
"revision"}
PAGE_FIELDS = {"items", "page", "page_size", "total", "has_next"}

# 只取固定列、按 id 排序的快照 SQL。
# 用它而不是 ORM 对象，是为了绕开 Session 的 identity map：
# 如果某次请求意外改动了字段，identity map 里的旧对象可能看不出变化，
# 而这条原生查询每次都会从数据库重新读。
_SNAPSHOT_SQL = text(
    "SELECT id, title, content, journal_date, created_at, updated_at, "
    "folder_id, deleted_at FROM journals ORDER BY id"
)


def _count_rows_in(session: Session) -> int:
    """在当前 Session 所在的事务里数行数。"""
    return session.execute(text("SELECT count(*) FROM journals")).scalar_one()


def _utc(day: int, hour: int = 0, minute: int = 0, month: int = 10) -> datetime:
    """构造 2026 年某月某日带 UTC 时区的时间，便于给排序测试固定时间。"""
    return datetime(2026, month, day, hour, minute, tzinfo=timezone.utc)


def _make_journal(
    *,
    content: str,
    journal_date: date,
    title: str | None = None,
    created_at: datetime | None = None,
    updated_at: datetime | None = None,
) -> Journal:
    """构造（未持久化的）Journal 对象。

    `created_at` / `updated_at` 只在显式提供时才写入 kwargs：
    Model 的 default 会在插入时生成时间，显式提供则覆盖 default，
    这样排序测试才能拿到确定的时间值。
    """
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


def _snapshot(session: Session) -> list[tuple]:
    """返回 journals 的原生 SQL 快照（按 id 排序，含 folder_id / deleted_at）。"""
    return [tuple(row) for row in session.execute(_SNAPSHOT_SQL)]


def _page(client: TestClient, **params) -> dict:
    """请求列表，断言 envelope 形状并返回响应体。"""
    response = client.get(LIST_URL, params=params)
    assert response.status_code == 200
    body = response.json()
    assert set(body) == PAGE_FIELDS
    return body


def _items(client: TestClient, **params) -> list[dict]:
    return _page(client, **params)["items"]


def _ids_of(items: list[dict]) -> list[int]:
    return [item["id"] for item in items]


# --------------------------------------------------------------------------
# 1. 基本形状与空列表
# --------------------------------------------------------------------------


def test_empty_database_returns_200_and_empty_items(api):
    """空库基线下的默认列表。

    该用例要求测试环境基线为空库，因此先显式断言基线。
    基线不为 0 时应当停下来确认环境，
    而不是删除、清空任何已有数据。
    """
    client, session = api

    baseline = _count_rows_in(session)
    assert baseline == 0, (
        f"该用例需要空库基线，当前 journals 已有 {baseline} 条记录；"
        "不得删除用户数据，请先确认测试环境。"
    )

    page = _page(client)

    assert page["items"] == []
    assert page["page"] == 1
    assert page["page_size"] == 20
    assert page["total"] == 0
    assert page["has_next"] is False


def test_list_returns_200_with_items_carrying_the_complete_field_set(api):
    client, session = api

    session.add_all(
        [
            _make_journal(
                title="广州动物园复盘",
                content="今天去了广州动物园……",
                journal_date=date(2026, 10, 2),
            ),
            _make_journal(
                title=None,
                content="晚上又补了一点。",
                journal_date=date(2026, 10, 3),
            ),
        ]
    )
    session.flush()

    page = _page(client)

    assert page["total"] == 2
    assert page["has_next"] is False
    assert len(page["items"]) == 2

    for item in page["items"]:
        assert set(item) == RESPONSE_FIELDS
        assert item["type"] == "journal"
        assert item["folder_id"] is None
        assert item["deleted_at"] is None

    # 每个字段的值都与数据库里的实际记录一致。
    rows = {row[0]: row for row in _snapshot(session)}
    for item in page["items"]:
        row = rows[item["id"]]
        assert item["title"] == row[1]
        assert item["content"] == row[2]
        assert item["journal_date"] == row[3].isoformat()
        assert datetime.fromisoformat(item["created_at"]) == row[4]
        assert datetime.fromisoformat(item["updated_at"]) == row[5]
        assert item["folder_id"] == row[6]
        assert item["deleted_at"] == row[7]


def test_title_null_falls_back_to_the_date_as_display_title(api):
    client, session = api

    session.add(_make_journal(title=None, content="没有标题", journal_date=date(2026, 10, 2)))
    session.flush()

    items = _items(client)

    assert items[0]["title"] is None
    assert items[0]["display_title"] == "2026-10-02"


def test_manual_title_is_shown_verbatim_as_display_title(api):
    client, session = api

    session.add(
        _make_journal(title="  手工标题  ", content="正文", journal_date=date(2026, 10, 2))
    )
    session.flush()

    items = _items(client)

    assert items[0]["title"] == "  手工标题  "
    # 手工标题不 trim、不加编号
    assert items[0]["display_title"] == "  手工标题  "


# --------------------------------------------------------------------------
# 2. 默认排序：journal_date DESC，同日 created_at DESC
# --------------------------------------------------------------------------


def test_list_is_ordered_by_journal_date_desc(api):
    """业务日期新的在前 —— 即使它的实际创建时间更早。"""
    client, session = api

    newer_day = _make_journal(
        content="业务日期 2026-10-03，但创建时间更早（10-01）",
        journal_date=date(2026, 10, 3),
        created_at=_utc(1, 9),
        updated_at=_utc(1, 9),
    )
    older_day = _make_journal(
        content="业务日期 2026-10-01，但创建时间更晚（10-05）",
        journal_date=date(2026, 10, 1),
        created_at=_utc(5, 9),
        updated_at=_utc(5, 9),
    )

    # 先插入业务日期较旧的那篇：
    # 若排序退化成插入顺序，得到的结果就会反过来。
    session.add_all([older_day, newer_day])
    session.flush()

    body = _items(client)

    mine = [item for item in body if item["id"] in {newer_day.id, older_day.id}]
    assert _ids_of(mine) == [newer_day.id, older_day.id]
    assert [item["journal_date"] for item in mine] == ["2026-10-03", "2026-10-01"]


def test_list_orders_same_day_by_created_at_desc(api):
    """同一天内，后创建的在前；用乱序插入证明排序由查询决定。"""
    client, session = api

    day = date(2026, 10, 2)
    early = _make_journal(
        content="最早创建", journal_date=day, created_at=_utc(2, 1), updated_at=_utc(2, 1)
    )
    middle = _make_journal(
        content="中间创建", journal_date=day, created_at=_utc(2, 3), updated_at=_utc(2, 3)
    )
    late = _make_journal(
        content="最晚创建", journal_date=day, created_at=_utc(2, 5), updated_at=_utc(2, 5)
    )

    session.add_all([middle, late, early])  # 乱序插入
    session.flush()
    mine_ids = {early.id, middle.id, late.id}  # flush 之后 id 才生成

    body = _items(client)

    mine = [item for item in body if item["id"] in mine_ids]
    assert _ids_of(mine) == [late.id, middle.id, early.id]
    assert [item["journal_date"] for item in mine] == ["2026-10-02"] * 3


# --------------------------------------------------------------------------
# 3. 日期筛选
# --------------------------------------------------------------------------


def test_filter_returns_only_the_requested_day(api):
    """精确匹配：只返回该 journal_date，不含相邻日期。"""
    client, session = api

    target = date(2026, 10, 2)
    before_day = _make_journal(
        content="前一天", journal_date=date(2026, 10, 1), created_at=_utc(1, 8), updated_at=_utc(1, 8)
    )
    on_day_a = _make_journal(
        content="当天第一篇", journal_date=target, created_at=_utc(2, 1), updated_at=_utc(2, 1)
    )
    on_day_b = _make_journal(
        content="当天第二篇", journal_date=target, created_at=_utc(2, 5), updated_at=_utc(2, 5)
    )
    after_day = _make_journal(
        content="后一天", journal_date=date(2026, 10, 3), created_at=_utc(3, 8), updated_at=_utc(3, 8)
    )
    session.add_all([before_day, on_day_a, on_day_b, after_day])
    session.flush()

    page = _page(client, journal_date="2026-10-02")
    body = page["items"]

    # 返回的所有记录都属于该日期（相邻日期被排除）
    assert {item["journal_date"] for item in body} == {"2026-10-02"}
    # total 与筛选一致
    assert page["total"] == 2

    returned = set(_ids_of(body))
    assert {on_day_a.id, on_day_b.id} <= returned
    assert before_day.id not in returned
    assert after_day.id not in returned


def test_filter_keeps_created_at_desc_within_the_day(api):
    """同一天多篇全部返回，并仍按 created_at DESC。"""
    client, session = api

    day = date(2026, 10, 2)
    first = _make_journal(
        content="当天最早", journal_date=day, created_at=_utc(2, 1), updated_at=_utc(2, 1)
    )
    second = _make_journal(
        content="当天中间", journal_date=day, created_at=_utc(2, 3), updated_at=_utc(2, 3)
    )
    third = _make_journal(
        content="当天最晚", journal_date=day, created_at=_utc(2, 6), updated_at=_utc(2, 6)
    )
    other_day = _make_journal(
        content="另一天", journal_date=date(2026, 10, 4), created_at=_utc(4, 6), updated_at=_utc(4, 6)
    )

    session.add_all([second, other_day, third, first])
    session.flush()
    mine_ids = {first.id, second.id, third.id}  # flush 之后 id 才生成

    body = _items(client, journal_date="2026-10-02")

    mine = [item for item in body if item["id"] in mine_ids]
    assert _ids_of(mine) == [third.id, second.id, first.id]
    assert other_day.id not in _ids_of(body)


def test_filter_without_match_returns_200_and_empty_items(api):
    client, session = api

    session.add(
        _make_journal(content="只有这一篇", journal_date=date(2026, 10, 2))
    )
    session.flush()

    # 1999-01-01 不在测试数据中，基线里也不存在该日期的记录。
    page = _page(client, journal_date="1999-01-01")

    assert page["items"] == []
    assert page["total"] == 0
    assert page["has_next"] is False


# --------------------------------------------------------------------------
# 4. 非法查询参数 → 422
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw",
    [
        "2026-02-30",  # 2 月没有 30 号
        "2026-02-29",  # 2026 不是闰年
        "2026-13-01",  # 没有 13 月
        "2026/10/02",  # 分隔符不对
        "02-10-2026",  # 顺序不对
        "2026-10-2",  # 补零不完整
        "not-a-date",  # 无法解析
        "",  # 空值
    ],
)
def test_invalid_journal_date_query_returns_422(api, raw):
    client, session = api

    before = _count_rows_in(session)

    response = client.get(LIST_URL, params={"journal_date": raw})

    assert response.status_code == 422
    # 查询请求不写入任何记录
    assert _count_rows_in(session) == before


def test_datetime_like_query_value_is_truncated_to_date_by_builtin_parser(api):
    """记录当前边界行为，不做收紧。

    Router 的查询参数沿用 Pydantic 内置的 `date` 解析，
    Task 5.1 明确不增加正则、strict 模式或自定义解析器，
    因此 "2026-10-02T00:00:00" 会被截断成 2026-10-02 而不会被拒绝。

    这与 `tests/test_journal_schemas.py` 中请求体的同一边界行为一致，
    结论不扩大到其他情况：非法日历日期与无法解析的字符串仍然返回 422。
    """
    client, session = api

    session.add(
        _make_journal(content="带时间后缀会被截断", journal_date=date(2026, 10, 2))
    )
    session.flush()

    response = client.get(LIST_URL, params={"journal_date": "2026-10-02T00:00:00"})

    assert response.status_code == 200
    assert {item["journal_date"] for item in response.json()["items"]} == {"2026-10-02"}


# --------------------------------------------------------------------------
# 5. GET 不修改任何记录
# --------------------------------------------------------------------------


def test_get_does_not_modify_any_row(api):
    """发出列表与筛选请求后，实际列值与请求前完全一致。"""
    client, session = api

    session.add_all(
        [
            _make_journal(
                title="有标题", content="正文 A", journal_date=date(2026, 10, 2),
                created_at=_utc(2, 1), updated_at=_utc(2, 1),
            ),
            _make_journal(
                title=None, content="正文 B", journal_date=date(2026, 10, 2),
                created_at=_utc(2, 2), updated_at=_utc(2, 2),
            ),
            _make_journal(
                title="另一天", content="正文 C", journal_date=date(2026, 10, 1),
                created_at=_utc(1, 3), updated_at=_utc(1, 3),
            ),
        ]
    )
    session.flush()

    before = _snapshot(session)
    assert len(before) >= 3

    assert _page(client)["total"] >= 3
    assert _page(client, journal_date="2026-10-02")["total"] >= 2
    assert _page(client, journal_date="1999-01-01")["total"] == 0
    assert _page(client, page=2)["page"] == 2

    after = _snapshot(session)

    # 逐字段比较整体快照：既能发现记录被增删，也能发现字段被改写
    # （包括 updated_at 被 onupdate 意外刷新）。
    assert after == before
