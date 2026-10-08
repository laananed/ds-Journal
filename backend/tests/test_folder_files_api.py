"""Folder 混合内容列表 `GET /api/folders/{id}/files` 测试（S2-T07）。

使用共享的 `api` fixture（savepoint 隔离）。重点：

- Folder 不存在 404；存在但无有效内容返回标准空分页；
- 三类有效文件**统一**分页（21 条跨类型翻页、total、has_next、超范围页）；
- 排序 `updated_at DESC, 类型 Journal→Inbox→Insight, id DESC` 作用于整体集合；
- 三张表相同数字 id 不去重，以 (type, id) 区分；
- Journal/Insight 软删除记录从列表与 total 中隐藏，Inbox 现存行照常出现；
- Journal 的 display_title 来自完整业务日期编号空间
  （含其他 Folder 与软删除记录），不是 Folder 内或页内重新编号。
"""

from __future__ import annotations

from datetime import date, datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.inbox.models import Inbox
from app.insight.models import Insight
from app.journal.models import Journal

DAY = date(2026, 10, 8)
# 固定时间戳，保证排序断言确定。
T1 = datetime(2026, 10, 8, 1, 0, tzinfo=timezone.utc)
T2 = datetime(2026, 10, 8, 2, 0, tzinfo=timezone.utc)
T3 = datetime(2026, 10, 8, 3, 0, tzinfo=timezone.utc)


def _create_folder(client: TestClient, name: str) -> dict:
    response = client.post("/api/folders", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def _add_journal(
    session: Session,
    *,
    folder_id: int | None,
    title: str | None = None,
    journal_date: date = DAY,
    created_at: datetime = T1,
    updated_at: datetime | None = None,
    deleted_at: datetime | None = None,
    id_: int | None = None,
) -> Journal:
    journal = Journal(
        id=id_,
        title=title,
        content=f"journal-{id_ or 'x'}",
        journal_date=journal_date,
        folder_id=folder_id,
        created_at=created_at,
        updated_at=updated_at or created_at,
        deleted_at=deleted_at,
    )
    session.add(journal)
    session.flush()
    return journal


def _add_inbox(
    session: Session,
    *,
    folder_id: int | None,
    created_at: datetime = T1,
    updated_at: datetime | None = None,
    id_: int | None = None,
) -> Inbox:
    inbox = Inbox(
        id=id_,
        title=None,
        content=f"inbox-{id_ or 'x'}",
        inbox_date=DAY,
        folder_id=folder_id,
        created_at=created_at,
        updated_at=updated_at or created_at,
    )
    session.add(inbox)
    session.flush()
    return inbox


def _add_insight(
    session: Session,
    *,
    folder_id: int | None,
    created_at: datetime = T1,
    updated_at: datetime | None = None,
    deleted_at: datetime | None = None,
    id_: int | None = None,
) -> Insight:
    insight = Insight(
        id=id_,
        title=None,
        content=f"insight-{id_ or 'x'}",
        folder_id=folder_id,
        created_at=created_at,
        updated_at=updated_at or created_at,
        deleted_at=deleted_at,
    )
    session.add(insight)
    session.flush()
    return insight


def _items(client: TestClient, folder_id: int, page: int = 1) -> list[dict]:
    response = client.get(f"/api/folders/{folder_id}/files", params={"page": page})
    assert response.status_code == 200, response.text
    return response.json()["items"]


# ---------------------------------------------------------------------------
# 404 与空分页
# ---------------------------------------------------------------------------


class TestMissingAndEmpty:
    def test_missing_folder_returns_404(self, api):
        client, _ = api
        response = client.get("/api/folders/999999/files")
        assert response.status_code == 404

    def test_noninteger_page_returns_422(self, api):
        client, session = api
        folder = _create_folder(client, "页码")
        _add_journal(session, folder_id=folder["id"])
        response = client.get(f"/api/folders/{folder['id']}/files", params={"page": 0})
        assert response.status_code == 422
        response = client.get(f"/api/folders/{folder['id']}/files", params={"page": "x"})
        assert response.status_code == 422

    def test_empty_folder_standard_empty_page(self, api):
        client, _ = api
        folder = _create_folder(client, "空")
        response = client.get(f"/api/folders/{folder['id']}/files")
        assert response.status_code == 200
        body = response.json()
        assert body["items"] == []
        assert body["page"] == 1
        assert body["page_size"] == 20
        assert body["total"] == 0
        assert body["has_next"] is False

    def test_files_of_folder_with_only_foreign_content_is_empty(self, api):
        client, session = api
        folder = _create_folder(client, "别人的")
        _add_journal(session, folder_id=None)
        _add_inbox(session, folder_id=None)
        _add_insight(session, folder_id=None)
        response = client.get(f"/api/folders/{folder['id']}/files")
        body = response.json()
        assert body["items"] == []
        assert body["total"] == 0


# ---------------------------------------------------------------------------
# 混合排序：updated_at DESC → 类型 Journal→Inbox→Insight → id DESC
# ---------------------------------------------------------------------------


class TestMixedOrdering:
    def test_order_updated_at_desc_across_types(self, api):
        client, session = api
        folder = _create_folder(client, "时间排序")
        journal = _add_journal(session, folder_id=folder["id"], created_at=T1)
        inbox = _add_inbox(session, folder_id=folder["id"], created_at=T3)
        insight = _add_insight(session, folder_id=folder["id"], created_at=T2)
        items = _items(client, folder["id"])
        assert [(item["type"], item["id"]) for item in items] == [
            ("inbox", inbox.id),
            ("insight", insight.id),
            ("journal", journal.id),
        ]

    def test_equal_updated_at_uses_type_order_then_id_desc(self, api):
        client, session = api
        folder = _create_folder(client, "类型排序")
        journal_low = _add_journal(session, folder_id=folder["id"], id_=990101, created_at=T1)
        journal_high = _add_journal(session, folder_id=folder["id"], id_=990102, created_at=T1)
        inbox = _add_inbox(session, folder_id=folder["id"], id_=990101, created_at=T1)
        insight = _add_insight(session, folder_id=folder["id"], id_=990101, created_at=T1)
        items = _items(client, folder["id"])
        assert [(item["type"], item["id"]) for item in items] == [
            ("journal", journal_high.id),   # 同类型先按 id DESC
            ("journal", journal_low.id),
            ("inbox", inbox.id),            # 类型顺序 Journal → Inbox → Insight
            ("insight", insight.id),
        ]

    def test_same_numeric_id_not_deduplicated(self, api):
        """三张表相同数字 id 各自出现一次，以 (type, id) 区分。"""
        client, session = api
        folder = _create_folder(client, "相同id")
        same_id = 700001
        journal = _add_journal(session, folder_id=folder["id"], id_=same_id, created_at=T1)
        inbox = _add_inbox(session, folder_id=folder["id"], id_=same_id, created_at=T1)
        insight = _add_insight(session, folder_id=folder["id"], id_=same_id, created_at=T1)
        items = _items(client, folder["id"])
        assert len(items) == 3
        assert {(item["type"], item["id"]) for item in items} == {
            ("journal", journal.id),
            ("inbox", inbox.id),
            ("insight", insight.id),
        }

    def test_item_shapes_are_type_specific(self, api):
        client, session = api
        folder = _create_folder(client, "字段形状")
        _add_journal(session, folder_id=folder["id"], id_=990810, created_at=T3)
        _add_inbox(session, folder_id=folder["id"], id_=990810, created_at=T2)
        _add_insight(session, folder_id=folder["id"], id_=990810, created_at=T1)
        items = _items(client, folder["id"])
        by_type = {item["type"]: item for item in items}
        assert by_type["journal"]["journal_date"] == DAY.isoformat()
        assert "inbox_date" not in by_type["journal"]
        assert by_type["inbox"]["inbox_date"] == DAY.isoformat()
        assert by_type["inbox"]["is_daily"] is False
        assert "journal_date" not in by_type["insight"]
        # 三种对象都带完整公共字段。
        for item in items:
            assert set(item) >= {
                "type", "id", "title", "display_title", "content",
                "folder_id", "created_at", "updated_at", "deleted_at",
            }
            assert item["folder_id"] == folder["id"]
            assert item["deleted_at"] is None


# ---------------------------------------------------------------------------
# 软删除可见性与 total
# ---------------------------------------------------------------------------


class TestSoftDeleteVisibility:
    def test_soft_deleted_journal_and_insight_hidden_from_items_and_total(self, api):
        client, session = api
        folder = _create_folder(client, "软删隐藏")
        _add_journal(session, folder_id=folder["id"], deleted_at=T3)
        _add_insight(session, folder_id=folder["id"], deleted_at=T3)
        _add_inbox(session, folder_id=folder["id"])
        _add_journal(session, folder_id=folder["id"])
        body = client.get(f"/api/folders/{folder['id']}/files").json()
        # Inbox 现存行照常出现（不按未启用的 deleted_at 过滤）；
        # 只剩 1 条有效 Journal，软删除的不占 total。
        assert body["total"] == 2
        types = sorted(item["type"] for item in body["items"])
        assert types == ["inbox", "journal"]

    def test_soft_deleted_records_in_other_folder_do_not_leak(self, api):
        client, session = api
        folder = _create_folder(client, "本目录")
        other = _create_folder(client, "别的目录")
        _add_journal(session, folder_id=other["id"], deleted_at=T3)
        _add_journal(session, folder_id=folder["id"])
        body = client.get(f"/api/folders/{folder['id']}/files").json()
        assert body["total"] == 1


# ---------------------------------------------------------------------------
# 统一分页：LIMIT/OFFSET 与 count 作用于混合后的整体集合
# ---------------------------------------------------------------------------


class TestMixedPagination:
    def test_21_mixed_items_span_two_pages(self, api):
        client, session = api
        folder = _create_folder(client, "21条混合")
        # 11 条 Journal（T1）+ 5 条 Inbox（T2）+ 5 条 Insight（T3）= 21。
        for i in range(11):
            _add_journal(session, folder_id=folder["id"], created_at=T1)
        for i in range(5):
            _add_inbox(session, folder_id=folder["id"], created_at=T2)
        for i in range(5):
            _add_insight(session, folder_id=folder["id"], created_at=T3)

        first = client.get(f"/api/folders/{folder['id']}/files").json()
        assert first["total"] == 21
        assert first["page"] == 1
        assert first["page_size"] == 20
        assert first["has_next"] is True
        assert len(first["items"]) == 20

        second = client.get(
            f"/api/folders/{folder['id']}/files", params={"page": 2}
        ).json()
        assert second["page"] == 2
        assert second["total"] == 21
        assert second["has_next"] is False
        assert len(second["items"]) == 1

        # 两页并集无重叠、完整覆盖 21 条；排序对整体集合生效：
        # 第 1 页应是 5 条 Insight（T3）+ 5 条 Inbox（T2）+ 10 条 Journal（T1）。
        page1 = [(item["type"], item["id"]) for item in first["items"]]
        page2 = [(item["type"], item["id"]) for item in second["items"]]
        assert len(set(page1) | set(page2)) == 21
        assert not set(page1) & set(page2)
        assert [t for t, _ in page1] == ["insight"] * 5 + ["inbox"] * 5 + ["journal"] * 10
        assert [t for t, _ in page2] == ["journal"]

    def test_over_range_page_keeps_page_number_empty_items(self, api):
        client, session = api
        folder = _create_folder(client, "超范围")
        _add_journal(session, folder_id=folder["id"])
        body = client.get(
            f"/api/folders/{folder['id']}/files", params={"page": 9}
        ).json()
        assert body["items"] == []
        assert body["page"] == 9
        assert body["total"] == 1
        assert body["has_next"] is False


# ---------------------------------------------------------------------------
# Journal display_title：完整业务日期编号空间
# ---------------------------------------------------------------------------


class TestJournalNumberingAcrossFolders:
    def test_numbering_spans_other_folders_and_soft_deleted(self, api):
        """编号先在全日期集合上计算（含其他 Folder 与软删除），再筛选分页。"""
        client, session = api
        folder_a = _create_folder(client, "甲")
        folder_b = _create_folder(client, "乙")

        # 同一天的无标题 Journal 完整集合：
        # j1（无 Folder）= 1，j2（乙，软删除）= 2，j3（甲）= 3，j4（甲）= 4。
        _add_journal(session, folder_id=None, id_=990301, created_at=T1)
        _add_journal(
            session, folder_id=folder_b["id"], id_=990302, created_at=T2, deleted_at=T3
        )
        _add_journal(session, folder_id=folder_a["id"], id_=990303, created_at=T3)
        _add_journal(
            session, folder_id=folder_a["id"], id_=990304, created_at=T3
        )

        items = _items(client, folder_a["id"])
        # id DESC：990304 在前、990303 在后，但编号仍按 created_at ASC 全局计算。
        assert [(item["id"], item["display_title"]) for item in items] == [
            (990304, f"{DAY.isoformat()} (4)"),
            (990303, f"{DAY.isoformat()} (3)"),
        ]

    def test_numbering_consistent_with_journal_list_view(self, api):
        """Folder 内的 display_title 与普通 Journal 列表完全一致（同一编号空间）。"""
        client, session = api
        folder = _create_folder(client, "一致")
        journal = _add_journal(session, folder_id=folder["id"], created_at=T2)
        _add_journal(session, folder_id=None, created_at=T1)

        folder_view = _items(client, folder["id"])
        list_view = client.get(
            "/api/journals", params={"folder_id": folder["id"]}
        ).json()["items"]
        assert folder_view[0]["display_title"] == list_view[0]["display_title"]
        assert folder_view[0]["id"] == journal.id

    def test_titled_journal_keeps_title_and_does_not_consume_number(self, api):
        client, session = api
        folder = _create_folder(client, "手工标题")
        titled = _add_journal(
            session, folder_id=folder["id"], title="手工", created_at=T1
        )
        untitled = _add_journal(session, folder_id=folder["id"], created_at=T2)
        items = _items(client, folder["id"])
        by_id = {item["id"]: item for item in items}
        assert by_id[titled.id]["display_title"] == "手工"
        assert by_id[untitled.id]["display_title"] == DAY.isoformat()

    def test_inbox_and_insight_display_titles_reuse_existing_rules(self, api):
        client, session = api
        folder = _create_folder(client, "投影")
        _add_inbox(session, folder_id=folder["id"])  # title=None → 回退日期
        _add_insight(session, folder_id=folder["id"])  # title=None → 未命名 Insight
        items = _items(client, folder["id"])
        by_type = {item["type"]: item for item in items}
        assert by_type["inbox"]["display_title"] == DAY.isoformat()
        assert by_type["inbox"]["title"] is None
        assert by_type["insight"]["display_title"] == "未命名 Insight"
