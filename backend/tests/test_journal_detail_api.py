"""GET /api/journals/{id} 单篇详情的最小 API 测试。

Stage 1 / Task 5.2。

与创建 / 列表测试一样，这里使用 FastAPI TestClient 与**真实 PostgreSQL**，
完整走一遍：HTTP → Pydantic → Router → Service → SQLAlchemy → psycopg → PostgreSQL。

共享的 `api` fixture 位于 `tests/conftest.py`：它返回 `(TestClient, 测试 Session)`，
并用「外层事务 + savepoint」把所有写入关在事务里，测试结束即回滚。
因此本文件可以直接用返回的 Session 造数据（`add` + `flush`），不必担心留下残留。

## 这些测试如何保证「确实按主键查一篇」

- 同日多篇的用例先插入若干天相同的记录，再逐个按 id 请求，
  断言每次返回的正文/标题都是「那一篇」的，不会混淆；
- 断言用**原生 SQL 快照**而不是 ORM 对象，避免 Session 的 identity map
  缓存旧值掩盖字段变化。

## 不存在的 id 从哪来

不写死 `999` 之类的固定值，也不假设 sequence 起始值或 id 连续：
先从当前事务里真实存在的 id 集合出发，挑一个**确认不在集合内**的值。
这样无论测试库基线是空库还是已有用户数据，都能拿到一个确实不存在的 id。

## 关于 sequence

PostgreSQL 的 sequence 取值**不随事务回滚**，所以每次运行后 `journals_id_seq`
都会前进、`id` 会跳号。这不代表数据残留。
"""

from __future__ import annotations

from datetime import date, datetime, timezone

import pytest
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.journal.models import Journal

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
}

# 只取固定列、按 id 排序的快照 SQL。
# 用它而不是 ORM 对象，是为了绕开 Session 的 identity map：
# 如果某次请求意外改动了字段，identity map 里的旧对象可能看不出变化，
# 而这条原生查询每次都会从数据库重新读。
_SNAPSHOT_SQL = text(
    "SELECT id, title, content, journal_date, created_at, updated_at "
    "FROM journals ORDER BY id"
)


def _detail_url(journal_id: object) -> str:
    return f"{LIST_URL}/{journal_id}"


def _utc(day: int, hour: int = 0, minute: int = 0) -> datetime:
    """构造 2026-10 某日带 UTC 时区的时间，便于让同日记录有确定顺序。"""
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


def _add_and_flush(session: Session, journals: list[Journal]) -> None:
    """写入测试数据并 flush，让 id 生成。"""
    session.add_all(journals)
    session.flush()


def _count_rows_in(session: Session) -> int:
    """在当前 Session 所在的事务里数行数。"""
    return session.execute(text("SELECT count(*) FROM journals")).scalar_one()


def _existing_ids(session: Session) -> set[int]:
    """当前事务内真实存在的全部 id。"""
    return set(session.execute(select(Journal.id)).scalars().all())


def _id_not_present(session: Session) -> int:
    """返回一个已确认不存在的正整数 id。

    从真实存在的 id 集合反推：候选值只需不在集合里，就确定不存在，
    因此不依赖 sequence 起始值，也不假设 id 连续。
    """
    existing = _existing_ids(session)
    candidate = 1
    while candidate in existing:
        candidate += 1
    return candidate


def _snapshot(session: Session) -> list[tuple]:
    """返回 journals 六字段的原生 SQL 快照（按 id 排序）。"""
    return [tuple(row) for row in session.execute(_SNAPSHOT_SQL)]


def _row_of(session: Session, journal_id: int) -> tuple:
    """按 id 取一行实际列值（原生 SQL，绕开 identity map）。"""
    row = session.execute(
        text(
            "SELECT id, title, content, journal_date, created_at, updated_at "
            "FROM journals WHERE id = :journal_id"
        ),
        {"journal_id": journal_id},
    ).one_or_none()
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


# --------------------------------------------------------------------------
# 1. 存在：200 与完整字段（Stage 2 / S2-T02 起为十字段）
# --------------------------------------------------------------------------


def test_existing_id_returns_200_with_exactly_the_full_fields(api):
    client, session = api

    journal = _make_journal(
        title="广州动物园复盘",
        content="今天去了广州动物园……",
        journal_date=date(2026, 10, 2),
    )
    _add_and_flush(session, [journal])

    response = client.get(_detail_url(journal.id))

    assert response.status_code == 200
    body = response.json()
    assert set(body) == RESPONSE_FIELDS
    # 有手工标题：display_title 就是原 title，不生成日期编号。
    assert body["display_title"] == "广州动物园复盘"
    assert body["folder_id"] is None


def test_detail_fields_match_the_actual_database_row(api):
    client, session = api

    journal = _make_journal(
        title="有标题的一篇",
        content="正文与数据库逐字段比对。",
        journal_date=date(2026, 10, 2),
    )
    _add_and_flush(session, [journal])

    body = client.get(_detail_url(journal.id)).json()

    _assert_matches_row(body, _row_of(session, journal.id))


def test_title_null_is_returned_as_null(api):
    client, session = api

    journal = _make_journal(
        title=None, content="没有标题", journal_date=date(2026, 10, 2)
    )
    _add_and_flush(session, [journal])

    body = client.get(_detail_url(journal.id)).json()

    assert body["title"] is None
    assert body["id"] == journal.id


def test_untitled_detail_display_title_is_the_date(api):
    """无标题（title 为 null）的详情：display_title 回退为业务日期，title 仍为 null。"""
    client, session = api

    journal = _make_journal(
        title=None, content="无标题正文", journal_date=date(2026, 10, 2)
    )
    _add_and_flush(session, [journal])

    body = client.get(_detail_url(journal.id)).json()

    assert body["title"] is None
    assert body["display_title"] == "2026-10-02"


def test_created_at_and_updated_at_are_timezone_aware(api):
    client, session = api

    journal = _make_journal(content="检查时间字段", journal_date=date(2026, 10, 2))
    _add_and_flush(session, [journal])

    body = client.get(_detail_url(journal.id)).json()

    assert datetime.fromisoformat(body["created_at"]).tzinfo is not None
    assert datetime.fromisoformat(body["updated_at"]).tzinfo is not None


# --------------------------------------------------------------------------
# 2. 按主键精确命中：同日多篇不混淆
# --------------------------------------------------------------------------


def test_same_day_journals_are_returned_by_their_own_id(api):
    """同一天多篇：每次请求只返回该 id 对应的那一篇。"""
    client, session = api

    day = date(2026, 10, 2)
    first = _make_journal(
        title="第一篇", content="正文一", journal_date=day,
        created_at=_utc(2, 1), updated_at=_utc(2, 1),
    )
    second = _make_journal(
        title=None, content="正文二", journal_date=day,
        created_at=_utc(2, 3), updated_at=_utc(2, 3),
    )
    third = _make_journal(
        title="第三篇", content="正文三", journal_date=day,
        created_at=_utc(2, 5), updated_at=_utc(2, 5),
    )

    # 乱序插入，确保命中靠的是主键而不是插入顺序。
    _add_and_flush(session, [second, third, first])

    assert len({first.id, second.id, third.id}) == 3

    expectations = [
        (first, "第一篇", "正文一"),
        (second, None, "正文二"),
        (third, "第三篇", "正文三"),
    ]
    for journal, expected_title, expected_content in expectations:
        body = client.get(_detail_url(journal.id)).json()
        assert body["id"] == journal.id
        assert body["title"] == expected_title
        assert body["content"] == expected_content
        assert body["journal_date"] == day.isoformat()
        _assert_matches_row(body, _row_of(session, journal.id))


def test_detail_does_not_return_a_sibling_from_the_same_day(api):
    """同日两篇：请求其中一篇时，返回的正文不能是另一篇的。"""
    client, session = api

    day = date(2026, 10, 2)
    mine = _make_journal(content="我要的是这一篇", journal_date=day)
    sibling = _make_journal(content="这是同一天的另一篇", journal_date=day)
    _add_and_flush(session, [mine, sibling])

    body = client.get(_detail_url(mine.id)).json()

    assert body["id"] == mine.id
    assert body["content"] == "我要的是这一篇"
    assert body["content"] != sibling.content


# --------------------------------------------------------------------------
# 3. 不存在：404
# --------------------------------------------------------------------------


def test_absent_id_returns_404(api):
    client, session = api

    _add_and_flush(
        session,
        [_make_journal(content="只放一篇作为对照", journal_date=date(2026, 10, 2))],
    )

    absent = _id_not_present(session)
    # 请求前先确认这个 id 确实不存在，而不是写死某个固定值。
    assert absent not in _existing_ids(session)

    response = client.get(_detail_url(absent))

    assert response.status_code == 404
    # 请求之后这个 id 仍然不存在：404 不会顺手创建任何东西。
    assert absent not in _existing_ids(session)


def test_404_detail_is_plain(api):
    """404 只使用标准 detail 字段，不自定义错误包装。"""
    client, session = api

    absent = _id_not_present(session)
    body = client.get(_detail_url(absent)).json()

    assert set(body) == {"detail"}
    assert isinstance(body["detail"], str)


@pytest.mark.parametrize("raw_id", ["0", "-1"])
def test_zero_and_negative_ids_return_404(api, raw_id):
    """契约没有规定 gt=0，因此 0 与负数同样是「合法整数但不存在」。"""
    client, session = api

    candidate = int(raw_id)
    assert candidate not in _existing_ids(session)

    response = client.get(_detail_url(candidate))

    assert response.status_code == 404


# --------------------------------------------------------------------------
# 4. 非整数路径参数：422
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw_id",
    [
        "abc",  # 完全不是数字
        "12abc",  # 数字前缀但整体不是整数
        "1.5",  # 小数
        "null",  # 字面量字符串
        "true",  # 字面量字符串
        "2026-10-02",  # 看起来像日期
    ],
)
def test_non_integer_id_returns_422(api, raw_id):
    client, session = api

    before = _snapshot(session)

    response = client.get(_detail_url(raw_id))

    assert response.status_code == 422
    # 参数校验失败不会碰到数据
    assert _snapshot(session) == before


# --------------------------------------------------------------------------
# 5. 详情请求不修改任何记录
# --------------------------------------------------------------------------


def test_detail_does_not_modify_any_row(api):
    """成功、404、422 三种请求之后，六字段实际列值与请求前完全一致。"""
    client, session = api

    day = date(2026, 10, 2)
    hit = _make_journal(
        title="会被成功读取", content="正文 A", journal_date=day,
        created_at=_utc(2, 1), updated_at=_utc(2, 1),
    )
    other = _make_journal(
        title=None, content="正文 B", journal_date=day,
        created_at=_utc(2, 2), updated_at=_utc(2, 2),
    )
    _add_and_flush(session, [hit, other])

    before = _snapshot(session)
    count_before = _count_rows_in(session)
    assert len(before) >= 2

    assert client.get(_detail_url(hit.id)).status_code == 200
    assert client.get(_detail_url(_id_not_present(session))).status_code == 404
    assert client.get(_detail_url("abc")).status_code == 422

    after = _snapshot(session)

    # 逐字段比较整体快照：既能发现记录被增删，也能发现字段被改写
    # （包括 updated_at 被 onupdate 意外刷新）。
    assert after == before
    assert _count_rows_in(session) == count_before


def test_reading_detail_twice_is_stable(api):
    """连续两次读取同一篇，结果完全一致（读操作没有副作用）。"""
    client, session = api

    journal = _make_journal(
        title="稳定", content="正文稳定", journal_date=date(2026, 10, 2)
    )
    _add_and_flush(session, [journal])

    first = client.get(_detail_url(journal.id))
    second = client.get(_detail_url(journal.id))

    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()


# --------------------------------------------------------------------------
# 6. 创建之后再读详情：两份响应一致
# --------------------------------------------------------------------------


def test_created_journal_can_be_read_back_through_detail(api):
    """POST 的响应与随后 GET 详情的响应完全一致。"""
    client, session = api

    payload = {
        "title": "广州动物园复盘",
        "content": "今天去了广州动物园……",
        "journal_date": "2026-10-02",
    }

    created = client.post(LIST_URL, json=payload)
    assert created.status_code == 201
    created_body = created.json()

    detail = client.get(_detail_url(created_body["id"]))
    assert detail.status_code == 200
    detail_body = detail.json()

    assert detail_body == created_body
    assert set(detail_body) == RESPONSE_FIELDS

    # 而且与数据库里的实际记录一致
    _assert_matches_row(detail_body, _row_of(session, created_body["id"]))


def test_created_journal_without_title_reads_back_with_null(api):
    client, session = api

    created = client.post(
        LIST_URL,
        json={"content": "没有标题的一篇", "journal_date": "2026-10-05"},
    )
    assert created.status_code == 201

    detail = client.get(_detail_url(created.json()["id"]))

    assert detail.status_code == 200
    assert detail.json() == created.json()
    assert detail.json()["title"] is None


# --------------------------------------------------------------------------
# 7. 与列表接口一致（不是互相替代，但应对同一记录给出同样的字段值）
# --------------------------------------------------------------------------


def test_detail_matches_the_same_record_in_the_list(api):
    client, session = api

    journal = _make_journal(
        title="列表与详情应一致",
        content="同一篇记录。",
        journal_date=date(2026, 10, 2),
    )
    _add_and_flush(session, [journal])

    body = client.get(LIST_URL).json()["items"]
    in_list = [item for item in body if item["id"] == journal.id]
    assert len(in_list) == 1

    in_detail = client.get(_detail_url(journal.id)).json()

    assert in_detail == in_list[0]
