"""GET /api/journals 分页、统一显示标题与软删除的 API 测试。

Stage 2 / S2-T02。

这些测试使用 FastAPI TestClient 与**真实 PostgreSQL**（测试库 `seekjournal_test`），
完整走一遍：HTTP → Pydantic → Router → Service → SQLAlchemy → psycopg → PostgreSQL。

共享的 `api` fixture 位于 `tests/conftest.py`：它返回 `(TestClient, 测试 Session)`，
用「外层事务 + savepoint」把所有写入关在事务里，测试结束即回滚。
因此本文件可以直接用返回的 Session 造数据（`add` + `flush`），不必担心留下残留。

## 这些测试如何在「非空库」上成立

本机测试库里可能已经有既有记录，因此：

- 分页总数断言一律**带 `journal_date` 或 `folder_id` 筛选**，
  只数本用例自己造的数据，不假设整库为空；
- 每个用例使用与其它测试文件错开的业务日期；
- 「不存在的 id」从当前事务里真实存在的 id 集合反推（含已软删除行），不写死固定值。

## 覆盖范围（对应本轮任务书第九节）

0/1/20/21/41 条、非法页码、超范围页、`total` / `has_next`；
日期与 Folder 筛选、并列时间的稳定排序与跨页无重叠；
同日跨页编号、手工 / NULL / 空字符串 / 纯空白标题混合；
新增不改旧号、软删仍占原号；
详情与列表、POST/PATCH 标题一致；
已删除记录在所有普通入口隐藏；
删除前后完整字段快照与 `updated_at` 精确不变；
重复删除、404、204 空体；
空 / 相同值 PATCH、旧值兼容、Folder 原子更新；
写失败 rollback 与 Session 继续可用。

## 关于 sequence

PostgreSQL 的 sequence 取值不随事务回滚，所以 `id` 会跳号，
测试不假设 id 连续，也不重置 sequence。
"""

from __future__ import annotations

from datetime import date, datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.folder.models import Folder
from app.journal import service
from app.journal.models import Journal

LIST_URL = "/api/journals"

# 分页 envelope 的字段（顺序无关）。
PAGE_FIELDS = {"items", "page", "page_size", "total", "has_next"}

# 完整 Journal 响应的字段。
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

PAGE_SIZE = 20

# 与其它测试文件刻意错开的业务日期，避免相互干扰。
BULK_DAY = date(2026, 9, 9)
NUMBERING_DAY = date(2026, 9, 12)
MIXED_DAY = date(2026, 9, 13)
RENUMBER_DAY = date(2026, 9, 14)
DELETE_DAY = date(2026, 9, 15)
POST_DAY = date(2026, 9, 16)
HIDDEN_DAY = date(2026, 9, 17)
FOLDER_DAY = date(2026, 9, 18)
LEGACY_DAY = date(2026, 9, 19)
FAIL_DAY = date(2026, 9, 20)
EMPTY_DAY = date(1999, 1, 1)  # 测试库中不会存在记录的日期

# 只取固定列、按 id 排序的快照 SQL：绕开 identity map，直接读数据库列值。
# 第 8 列是 deleted_at，单独用于「软删除前后」的比较。
_ROW_SQL = text(
    "SELECT id, title, content, journal_date, created_at, updated_at, "
    "folder_id, deleted_at FROM journals WHERE id = :journal_id"
)


# --------------------------------------------------------------------------
# 局部 helper（只属于本文件）
# --------------------------------------------------------------------------


def _utc(day: int, minute: int = 0, month: int = 9) -> datetime:
    """构造 2026 年某月某日带 UTC 时区的时间，便于固定排序与编号。"""
    return datetime(2026, month, day, 0, minute, tzinfo=timezone.utc)


def _add(
    session: Session,
    *,
    content: str,
    journal_date: date,
    title: str | None = None,
    folder_id: int | None = None,
    created_at: datetime | None = None,
    updated_at: datetime | None = None,
) -> Journal:
    """写入一条测试数据并 flush，让 id 生成。"""
    kwargs: dict[str, object] = {
        "title": title,
        "content": content,
        "journal_date": journal_date,
        "folder_id": folder_id,
    }
    if created_at is not None:
        kwargs["created_at"] = created_at
    if updated_at is not None:
        kwargs["updated_at"] = updated_at
    journal = Journal(**kwargs)
    session.add(journal)
    session.flush()
    return journal


def _add_folder(session: Session, name: str) -> Folder:
    folder = Folder(name=name)
    session.add(folder)
    session.flush()
    return folder


def _page(client: TestClient, **params) -> dict:
    """请求列表并断言 envelope 形状，返回响应体。"""
    response = client.get(LIST_URL, params=params)
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == PAGE_FIELDS
    return body


def _ids_of(page: dict) -> list[int]:
    return [item["id"] for item in page["items"]]


def _count_all(session: Session) -> int:
    return session.execute(text("SELECT count(*) FROM journals")).scalar_one()


def _row(session: Session, journal_id: int) -> tuple:
    row = session.execute(_ROW_SQL, {"journal_id": journal_id}).one()
    return tuple(row)


def _exists(session: Session, journal_id: int) -> bool:
    return (
        session.execute(
            text("SELECT count(*) FROM journals WHERE id = :journal_id"),
            {"journal_id": journal_id},
        ).scalar_one()
        > 0
    )


def _existing_ids(session: Session) -> set[int]:
    return set(session.execute(text("SELECT id FROM journals")).scalars().all())


def _absent_journal_id(session: Session) -> int:
    """返回一个已确认不存在的正整数 Journal id。"""
    existing = _existing_ids(session)
    candidate = 1
    while candidate in existing:
        candidate += 1
    return candidate


def _absent_folder_id(session: Session) -> int:
    """返回一个已确认不存在的正整数 Folder id。"""
    existing = set(session.execute(text("SELECT id FROM folders")).scalars().all())
    candidate = 1
    while candidate in existing:
        candidate += 1
    return candidate


def _detail_url(journal_id: object) -> str:
    return f"{LIST_URL}/{journal_id}"


# ==========================================================================
# A. 分页 envelope、total / has_next 与页码边界
# ==========================================================================


def test_empty_result_returns_envelope_with_zero_items(api):
    """无匹配时 200 + 空 items，envelope 字段齐全。"""
    client, _session = api

    page = _page(client, journal_date=EMPTY_DAY.isoformat())

    assert page == {
        "items": [],
        "page": 1,
        "page_size": PAGE_SIZE,
        "total": 0,
        "has_next": False,
    }


@pytest.mark.parametrize("count", [0, 1, 20, 21, 41])
def test_total_and_has_next_for_various_totals(api, count):
    """0 / 1 / 20 / 21 / 41 条的 total、本页长度与 has_next。"""
    client, session = api

    for index in range(count):
        _add(
            session,
            content=f"第 {index} 篇",
            journal_date=BULK_DAY,
            created_at=_utc(9, index),
            updated_at=_utc(9, index),
        )

    page = _page(client, journal_date=BULK_DAY.isoformat())

    assert page["total"] == count
    assert page["page"] == 1
    assert page["page_size"] == PAGE_SIZE
    assert len(page["items"]) == min(count, PAGE_SIZE)
    # 全局总数决定 has_next，而不是「本页是否满 20 条」
    assert page["has_next"] is (page["page"] * PAGE_SIZE < count)
    for item in page["items"]:
        assert set(item) == RESPONSE_FIELDS
        assert item["type"] == "journal"
        assert item["deleted_at"] is None


def test_last_page_and_page_beyond_the_end(api):
    """41 条时第 3 页只剩 1 条；第 4 页 200 + 空 items 并保留请求页码。"""
    client, session = api

    for index in range(41):
        _add(
            session,
            content=f"第 {index} 篇",
            journal_date=BULK_DAY,
            created_at=_utc(9, index),
        )

    third = _page(client, journal_date=BULK_DAY.isoformat(), page=3)
    assert len(third["items"]) == 1
    assert third["total"] == 41
    assert third["has_next"] is False

    fourth = _page(client, journal_date=BULK_DAY.isoformat(), page=4)
    assert fourth["items"] == []
    assert fourth["page"] == 4
    assert fourth["has_next"] is False

    far = _page(client, journal_date=BULK_DAY.isoformat(), page=99)
    assert far["items"] == []
    assert far["page"] == 99
    assert far["total"] == 41


def test_pages_do_not_overlap_or_skip(api):
    """41 条翻三页：并集为全部 id，两两不重叠。"""
    client, session = api

    ids = {
        _add(session, content=f"第 {index} 篇", journal_date=BULK_DAY, created_at=_utc(9, index)).id
        for index in range(41)
    }

    pages = [
        _ids_of(_page(client, journal_date=BULK_DAY.isoformat(), page=number))
        for number in (1, 2, 3)
    ]

    assert all(len(page_ids) == PAGE_SIZE for page_ids in pages[:2])
    assert len(pages[2]) == 1
    assert set().union(*map(set, pages)) == ids
    assert set(pages[0]).isdisjoint(pages[1])
    assert set(pages[1]).isdisjoint(pages[2])


@pytest.mark.parametrize("raw_page", ["0", "-1", "abc", "1.5", "", "true"])
def test_invalid_page_returns_422(api, raw_page):
    """page 必须是 >=1 的整数；非法值返回标准 422 且不写库。"""
    client, session = api

    before = _count_all(session)

    response = client.get(LIST_URL, params={"page": raw_page})

    assert response.status_code == 422
    assert _count_all(session) == before


def test_invalid_folder_id_returns_422(api):
    client, session = api

    before = _count_all(session)
    response = client.get(LIST_URL, params={"folder_id": "abc"})

    assert response.status_code == 422
    assert _count_all(session) == before


# ==========================================================================
# B. 排序稳定性与筛选
# ==========================================================================


def test_tied_created_at_is_broken_by_id_desc(api):
    """created_at 完全相同时按 id DESC，避免并列项顺序随机。"""
    client, session = api

    same_instant = _utc(9, 30)
    ids = [
        _add(
            session,
            content=f"并列 {index}",
            journal_date=BULK_DAY,
            created_at=same_instant,
        ).id
        for index in range(3)
    ]

    mine = [
        item["id"]
        for item in _page(client, journal_date=BULK_DAY.isoformat())["items"]
        if item["id"] in set(ids)
    ]

    assert mine == sorted(ids, reverse=True)


def test_tied_rows_do_not_shift_between_pages(api):
    """21 条 created_at 相同：跨页无重叠、无遗漏，且两页各自 id 递减。"""
    client, session = api

    same_instant = _utc(9, 30)
    ids = {
        _add(
            session,
            content=f"并列 {index}",
            journal_date=BULK_DAY,
            created_at=same_instant,
        ).id
        for index in range(21)
    }

    first = _ids_of(_page(client, journal_date=BULK_DAY.isoformat(), page=1))
    second = _ids_of(_page(client, journal_date=BULK_DAY.isoformat(), page=2))

    assert set(first).isdisjoint(second)
    assert set(first) | set(second) == ids
    assert first == sorted(first, reverse=True)
    assert second == sorted(second, reverse=True)


def test_folder_filter_returns_only_that_folder(api):
    client, session = api

    first_folder = _add_folder(session, "项目思考")
    second_folder = _add_folder(session, "生活")
    in_first = _add(
        session, content="A", journal_date=FOLDER_DAY, folder_id=first_folder.id
    )
    in_second = _add(
        session, content="B", journal_date=FOLDER_DAY, folder_id=second_folder.id
    )
    no_folder = _add(session, content="C", journal_date=FOLDER_DAY)

    page = _page(client, folder_id=first_folder.id)
    assert page["total"] == 1
    assert _ids_of(page) == [in_first.id]
    assert page["items"][0]["folder_id"] == first_folder.id

    all_on_day = _page(client, journal_date=FOLDER_DAY.isoformat())
    assert {item["id"] for item in all_on_day["items"]} == {
        in_first.id,
        in_second.id,
        no_folder.id,
    }


def test_date_filter_also_paginates(api):
    """日期筛选后仍分页：21 条同日记录第 1 页 20 条、第 2 页 1 条。"""
    client, session = api

    day = date(2026, 9, 21)
    for index in range(21):
        _add(session, content=f"同日 {index}", journal_date=day, created_at=_utc(21, index))
    # 另一天不应该被计入
    _add(session, content="另一天", journal_date=date(2026, 9, 22))

    first = _page(client, journal_date=day.isoformat(), page=1)
    second = _page(client, journal_date=day.isoformat(), page=2)

    assert first["total"] == 21
    assert len(first["items"]) == PAGE_SIZE
    assert first["has_next"] is True
    assert len(second["items"]) == 1
    assert second["has_next"] is False
    assert all(item["journal_date"] == day.isoformat() for item in first["items"])


# ==========================================================================
# C. 统一显示标题（编号）
# ==========================================================================


def test_same_day_numbering_is_continuous_across_pages(api):
    """同日 21 篇无标题：编号在完整日期集合上计算，第 2 页仍是 `(1)` 而不是重新从 1 开始。"""
    client, session = api

    for index in range(21):
        _add(
            session,
            content=f"第 {index} 篇",
            journal_date=NUMBERING_DAY,
            created_at=_utc(12, index),
        )

    day = NUMBERING_DAY.isoformat()
    first = _page(client, journal_date=day, page=1)
    second = _page(client, journal_date=day, page=2)

    # 列表按 created_at DESC，所以第 1 页是编号最大的一批
    assert [item["display_title"] for item in first["items"]] == [
        f"{day} ({number})" for number in range(21, 1, -1)
    ]
    # 第 2 页只剩编号 1，显示日期本身
    assert [item["display_title"] for item in second["items"]] == [day]


def test_manual_null_empty_and_whitespace_titles(api):
    """手工标题与纯空白原样显示、不占编号；NULL 与空字符串才编号。"""
    client, session = api

    manual = _add(
        session, title="手工标题", content="x", journal_date=MIXED_DAY, created_at=_utc(13, 1)
    )
    whitespace = _add(
        session, title="   ", content="x", journal_date=MIXED_DAY, created_at=_utc(13, 2)
    )
    null_title = _add(
        session, title=None, content="x", journal_date=MIXED_DAY, created_at=_utc(13, 3)
    )
    empty_title = _add(
        session, title="", content="x", journal_date=MIXED_DAY, created_at=_utc(13, 4)
    )

    by_id = {
        item["id"]: item
        for item in _page(client, journal_date=MIXED_DAY.isoformat())["items"]
    }
    day = MIXED_DAY.isoformat()

    assert by_id[manual.id]["display_title"] == "手工标题"
    assert by_id[whitespace.id]["display_title"] == "   "  # 纯空白是手工标题，原样显示
    assert by_id[null_title.id]["display_title"] == day
    assert by_id[empty_title.id]["display_title"] == f"{day} (2)"

    # 原始 title 没有被改写：NULL 仍是 NULL，空字符串仍是空字符串
    assert by_id[null_title.id]["title"] is None
    assert by_id[empty_title.id]["title"] == ""
    assert _row(session, null_title.id)[1] is None
    assert _row(session, empty_title.id)[1] == ""


def test_adding_a_later_record_does_not_renumber_older_ones(api):
    client, session = api

    day = RENUMBER_DAY.isoformat()
    first = _add(session, content="一", journal_date=RENUMBER_DAY, created_at=_utc(14, 1))
    second = _add(session, content="二", journal_date=RENUMBER_DAY, created_at=_utc(14, 2))
    third = _add(session, content="三", journal_date=RENUMBER_DAY, created_at=_utc(14, 3))

    before = {
        item["id"]: item["display_title"]
        for item in _page(client, journal_date=day)["items"]
    }
    assert before[first.id] == day
    assert before[second.id] == f"{day} (2)"
    assert before[third.id] == f"{day} (3)"

    fourth = _add(session, content="四", journal_date=RENUMBER_DAY, created_at=_utc(14, 4))

    after = {
        item["id"]: item["display_title"]
        for item in _page(client, journal_date=day)["items"]
    }

    for journal in (first, second, third):
        assert after[journal.id] == before[journal.id]
    assert after[fourth.id] == f"{day} (4)"


def test_soft_deleted_record_still_occupies_its_number(api):
    """软删除仍占用原编号：其余现存记录的编号不变。"""
    client, session = api

    day = DELETE_DAY.isoformat()
    first = _add(session, content="一", journal_date=DELETE_DAY, created_at=_utc(15, 1))
    second = _add(session, content="二", journal_date=DELETE_DAY, created_at=_utc(15, 2))
    third = _add(session, content="三", journal_date=DELETE_DAY, created_at=_utc(15, 3))

    assert client.delete(_detail_url(second.id)).status_code == 204

    page = _page(client, journal_date=day)
    by_id = {item["id"]: item["display_title"] for item in page["items"]}

    assert second.id not in by_id
    assert by_id[first.id] == day  # 仍然是编号 1
    assert by_id[third.id] == f"{day} (3)"  # 仍然是编号 3，没有顶到 (2)


def test_detail_and_list_use_the_same_display_title(api):
    client, session = api

    day = POST_DAY.isoformat()
    first = client.post(
        LIST_URL, json={"content": "一", "journal_date": day}
    ).json()
    client.post(LIST_URL, json={"content": "二", "journal_date": day})
    third = client.post(LIST_URL, json={"content": "三", "journal_date": day}).json()

    assert first["display_title"] == day
    assert third["display_title"] == f"{day} (3)"

    listed = {
        item["id"]: item["display_title"]
        for item in _page(client, journal_date=day)["items"]
    }
    for created in (first, third):
        detail = client.get(_detail_url(created["id"]))
        assert detail.status_code == 200
        assert detail.json()["display_title"] == created["display_title"]
        assert listed[created["id"]] == created["display_title"]


def test_post_and_patch_display_titles_follow_the_same_projection(api):
    """POST / PATCH 的 display_title 与随后列表、详情一致。"""
    client, session = api

    day = date(2026, 9, 23).isoformat()
    manual = client.post(
        LIST_URL, json={"title": "手工标题", "content": "手工正文", "journal_date": day}
    ).json()
    assert manual["display_title"] == "手工标题"

    # 把手工标题清空 → 成为无标题，参与编号。
    # 它的 created_at 最早，因此在新编号空间里排第 1（这正是 P3 允许的「改标题可能重编号」）。
    client.post(LIST_URL, json={"content": "无标题一", "journal_date": day})
    client.post(LIST_URL, json={"content": "无标题二", "journal_date": day})

    patched = client.patch(_detail_url(manual["id"]), json={"title": None})
    assert patched.status_code == 200
    patched_body = patched.json()
    assert patched_body["title"] is None
    assert patched_body["display_title"] == day

    listed = {
        item["id"]: item["display_title"]
        for item in _page(client, journal_date=day)["items"]
    }
    detail = client.get(_detail_url(manual["id"])).json()

    assert listed[manual["id"]] == patched_body["display_title"]
    assert detail["display_title"] == patched_body["display_title"]


# ==========================================================================
# D. 软删除：隐藏、字段与时间保留、重复删除
# ==========================================================================


def test_deleted_record_is_hidden_from_every_normal_entry(api):
    client, session = api

    folder = _add_folder(session, "被软删的 Folder")
    victim = _add(
        session,
        title="要软删的",
        content="正文",
        journal_date=HIDDEN_DAY,
        folder_id=folder.id,
        created_at=_utc(17, 1),
    )
    keeper = _add(
        session,
        title="保留的",
        content="正文",
        journal_date=HIDDEN_DAY,
        folder_id=folder.id,
        created_at=_utc(17, 2),
    )

    assert client.delete(_detail_url(victim.id)).status_code == 204

    # 列表 / 日期筛选 / Folder 筛选都不再包含它
    assert victim.id not in _ids_of(_page(client))
    assert victim.id not in _ids_of(_page(client, journal_date=HIDDEN_DAY.isoformat()))
    assert victim.id not in _ids_of(_page(client, folder_id=folder.id))

    # 详情、PATCH（含空 PATCH）、DELETE 一律 404
    assert client.get(_detail_url(victim.id)).status_code == 404
    assert client.patch(_detail_url(victim.id), json={"title": "不该写进去"}).status_code == 404
    assert client.patch(_detail_url(victim.id), json={}).status_code == 404
    assert client.delete(_detail_url(victim.id)).status_code == 404

    # 同 Folder 的另一篇仍然可读、仍在筛选结果里
    assert client.get(_detail_url(keeper.id)).status_code == 200
    assert keeper.id in _ids_of(_page(client, journal_date=HIDDEN_DAY.isoformat()))
    assert keeper.id in _ids_of(_page(client, folder_id=folder.id))

    # 数据库行仍在
    assert _exists(session, victim.id)
    assert _row(session, victim.id)[7] is not None


def test_soft_delete_preserves_every_field_and_updated_at(api):
    client, session = api

    journal = _add(
        session,
        title="软删快照",
        content="正文快照",
        journal_date=DELETE_DAY,
        created_at=_utc(15, 9),
        updated_at=_utc(15, 9),
    )
    before = _row(session, journal.id)

    assert client.delete(_detail_url(journal.id)).status_code == 204

    after = _row(session, journal.id)

    # 原六字段 + folder_id 逐字段完全一致
    assert after[:7] == before[:7]
    # 只有 deleted_at 从 NULL 变成有值
    assert before[7] is None
    assert after[7] is not None
    # updated_at（第 6 列）精确不变：软删除不是内容修改
    assert after[5] == before[5] == _utc(15, 9)
    # 行没有被物理删除
    assert _exists(session, journal.id)


def test_repeat_delete_returns_404_and_keeps_the_first_deleted_at(api):
    client, session = api

    journal = _add(session, content="只软删一次", journal_date=DELETE_DAY)
    assert client.delete(_detail_url(journal.id)).status_code == 204
    first_deleted_at = _row(session, journal.id)[7]
    assert first_deleted_at is not None

    second = client.delete(_detail_url(journal.id))

    assert second.status_code == 404
    assert _row(session, journal.id)[7] == first_deleted_at
    assert _exists(session, journal.id)


def test_delete_returns_204_with_empty_body(api):
    client, session = api

    journal = _add(session, content="204 用例", journal_date=DELETE_DAY)

    response = client.delete(_detail_url(journal.id))

    assert response.status_code == 204
    assert response.content == b""


def test_delete_of_absent_id_returns_404_without_writing(api):
    client, session = api

    absent = _absent_journal_id(session)
    assert not _exists(session, absent)

    response = client.delete(_detail_url(absent))

    assert response.status_code == 404
    assert not _exists(session, absent)


# ==========================================================================
# E. PATCH：空更新、相同值、Folder 原子更新
# ==========================================================================


def test_empty_patch_does_not_write_or_refresh_updated_at(api):
    client, session = api

    journal = _add(
        session, content="原始正文", journal_date=FAIL_DAY, updated_at=_utc(20, 1)
    )
    before = _row(session, journal.id)

    response = client.patch(_detail_url(journal.id), json={})

    assert response.status_code == 200
    assert _row(session, journal.id) == before
    # updated_at 没有被刷新：响应里的值与数据库原值一致
    assert datetime.fromisoformat(response.json()["updated_at"]) == before[5]


def test_same_value_patch_does_not_force_a_timestamp_change(api):
    client, session = api

    journal = _add(
        session,
        title="一样的",
        content="一样的正文",
        journal_date=FAIL_DAY,
        updated_at=_utc(20, 2),
    )
    before = _row(session, journal.id)

    response = client.patch(
        _detail_url(journal.id), json={"title": "一样的", "content": "一样的正文"}
    )

    assert response.status_code == 200
    assert _row(session, journal.id) == before


def test_patch_moves_a_journal_into_and_out_of_a_folder(api):
    client, session = api

    folder = _add_folder(session, "移动目标")
    journal = _add(session, content="正文", journal_date=FOLDER_DAY)

    moved = client.patch(_detail_url(journal.id), json={"folder_id": folder.id})
    assert moved.status_code == 200
    assert moved.json()["folder_id"] == folder.id
    assert journal.id in _ids_of(_page(client, folder_id=folder.id))

    removed = client.patch(_detail_url(journal.id), json={"folder_id": None})
    assert removed.status_code == 200
    assert removed.json()["folder_id"] is None
    assert journal.id not in _ids_of(_page(client, folder_id=folder.id))


def test_patch_with_missing_folder_is_atomic_404(api):
    """指定不存在 Folder：404，且同一请求里的其它字段也不写入。"""
    client, session = api

    journal = _add(
        session, title="原标题", content="原始正文", journal_date=FOLDER_DAY
    )
    before = _row(session, journal.id)
    absent_folder = _absent_folder_id(session)

    response = client.patch(
        _detail_url(journal.id),
        json={"content": "不应写入的正文", "folder_id": absent_folder},
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Folder not found"
    # 没有半截更新：正文与 Folder 都没变
    assert _row(session, journal.id) == before


def test_create_with_missing_folder_404_and_no_write(api):
    client, session = api

    absent_folder = _absent_folder_id(session)
    before = _count_all(session)

    response = client.post(
        LIST_URL,
        json={
            "title": "不该创建",
            "content": "正文",
            "journal_date": FOLDER_DAY.isoformat(),
            "folder_id": absent_folder,
        },
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Folder not found"
    assert _count_all(session) == before


# ==========================================================================
# F. 旧值兼容：响应不套用新的请求限制
# ==========================================================================


def test_legacy_illegal_records_are_readable_in_the_new_envelope(api):
    client, session = api

    blank = _add(session, content="   ", journal_date=LEGACY_DAY, created_at=_utc(19, 1))
    oversized_title = _add(
        session, title="旧" * 200, content="正文", journal_date=LEGACY_DAY, created_at=_utc(19, 2)
    )
    oversized_content = _add(
        session, content="旧" * 60_000, journal_date=LEGACY_DAY, created_at=_utc(19, 3)
    )

    by_id = {
        item["id"]: item
        for item in _page(client, journal_date=LEGACY_DAY.isoformat())["items"]
    }

    assert by_id[blank.id]["content"] == "   "
    assert by_id[blank.id]["display_title"] == LEGACY_DAY.isoformat()
    assert by_id[oversized_title.id]["title"] == "旧" * 200
    assert by_id[oversized_title.id]["display_title"] == "旧" * 200
    assert len(by_id[oversized_content.id]["content"]) == 60_000
    # 超长标题是手工标题、不占编号，因此这条无标题记录是当天的第 2 篇
    assert by_id[oversized_content.id]["display_title"] == f"{LEGACY_DAY.isoformat()} (2)"

    for journal in (blank, oversized_title, oversized_content):
        detail = client.get(_detail_url(journal.id))
        assert detail.status_code == 200
        assert set(detail.json()) == RESPONSE_FIELDS


# ==========================================================================
# G. 写失败 rollback 与 Session 继续可用
# ==========================================================================


def test_delete_commit_failure_rolls_back_and_session_stays_usable(api, monkeypatch):
    """受控 commit 故障：真实发出软删除 UPDATE 后失败，必须回滚且不留删除痕迹。"""
    client, session = api

    created = client.post(
        LIST_URL,
        json={"title": "不该被软删", "content": "正文", "journal_date": FAIL_DAY.isoformat()},
    ).json()
    journal_id = created["id"]
    before = _row(session, journal_id)

    def failing_commit(self):
        self.flush()  # 让 UPDATE 真的发到 PostgreSQL
        raise RuntimeError("受控的 commit 故障")

    monkeypatch.setattr(Session, "commit", failing_commit)

    with pytest.raises(RuntimeError):
        service.delete_journal(session, journal_id)

    after = _row(session, journal_id)
    assert after == before
    assert after[7] is None  # deleted_at 回到 NULL
    # rollback 之后 Session 已回到可用状态
    assert session.execute(text("SELECT 1")).scalar_one() == 1


def test_patch_commit_failure_rolls_back(api, monkeypatch):
    client, session = api

    created = client.post(
        LIST_URL,
        json={"title": "原标题", "content": "原始正文", "journal_date": FAIL_DAY.isoformat()},
    ).json()
    journal_id = created["id"]
    before = _row(session, journal_id)

    def failing_commit(self):
        self.flush()
        raise RuntimeError("受控的 commit 故障")

    monkeypatch.setattr(Session, "commit", failing_commit)

    response = client.patch(_detail_url(journal_id), json={"content": "不应留下"})

    assert response.status_code == 500
    assert _row(session, journal_id) == before
    assert session.execute(text("SELECT 1")).scalar_one() == 1


def test_page_requests_do_not_modify_any_row(api):
    """列表 / 详情请求不写入：整表快照保持不变。"""
    client, session = api

    journal = _add(
        session, content="只读用例", journal_date=FAIL_DAY, created_at=_utc(20, 9)
    )

    before = session.execute(
        text(
            "SELECT id, title, content, journal_date, created_at, updated_at, "
            "folder_id, deleted_at FROM journals ORDER BY id"
        )
    ).all()

    assert client.get(LIST_URL).status_code == 200
    assert client.get(LIST_URL, params={"journal_date": FAIL_DAY.isoformat()}).status_code == 200
    assert client.get(_detail_url(journal.id)).status_code == 200

    after = session.execute(
        text(
            "SELECT id, title, content, journal_date, created_at, updated_at, "
            "folder_id, deleted_at FROM journals ORDER BY id"
        )
    ).all()

    assert after == before
