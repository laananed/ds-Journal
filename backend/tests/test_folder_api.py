"""Folder CRUD 与真空删除限制的 API 测试（Stage 2 / S2-T07）。

使用共享的 `api` fixture（外层事务 + savepoint 隔离，测试数据随回滚消失）：

- POST 201 / GET 数组（id ASC）/ PATCH（省略、相同、改名、404、422）；
- DELETE：真空 204 空体、不存在 404、重复删除 404；
- 引用限制：任一 Journal / Inbox / Insight 引用（**含已软删除的
  Journal / Insight**）都返回 409；Inbox 硬删除后释放引用；
- 三种写入路径（Journal/Inbox/Insight 的 POST 与 PATCH）指定
  不存在的 Folder 均返回 404，且不留下半截更新。
"""

from __future__ import annotations

from datetime import date, datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.inbox.models import Inbox
from app.insight.models import Insight
from app.journal.models import Journal


def _create_folder(client: TestClient, name: str) -> dict:
    response = client.post("/api/folders", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def _add_journal(
    session: Session,
    *,
    title: str | None,
    content: str = "正文",
    journal_date: date = date(2026, 10, 8),
    folder_id: int | None = None,
    deleted_at: datetime | None = None,
) -> Journal:
    journal = Journal(
        title=title,
        content=content,
        journal_date=journal_date,
        folder_id=folder_id,
        deleted_at=deleted_at,
    )
    session.add(journal)
    session.flush()
    return journal


def _add_insight(
    session: Session,
    *,
    folder_id: int | None = None,
    deleted_at: datetime | None = None,
) -> Insight:
    insight = Insight(title=None, content="洞察", folder_id=folder_id,
                      deleted_at=deleted_at)
    session.add(insight)
    session.flush()
    return insight


def _add_inbox(session: Session, *, folder_id: int | None = None) -> Inbox:
    inbox = Inbox(title=None, content="收件", inbox_date=date(2026, 10, 8),
                  folder_id=folder_id)
    session.add(inbox)
    session.flush()
    return inbox


# ---------------------------------------------------------------------------
# POST /api/folders
# ---------------------------------------------------------------------------


class TestCreateFolder:
    def test_create_returns_201_with_id_and_name(self, api):
        client, _ = api
        body = _create_folder(client, "项目思考")
        assert set(body.keys()) == {"id", "name"}
        assert body["name"] == "项目思考"
        assert isinstance(body["id"], int)

    def test_create_trims_name(self, api):
        client, _ = api
        assert _create_folder(client, "  空格包围  ")["name"] == "空格包围"

    def test_duplicate_names_allowed(self, api):
        client, _ = api
        first = _create_folder(client, "同名")
        second = _create_folder(client, "同名")
        assert first["id"] != second["id"]
        assert first["name"] == second["name"] == "同名"

    @pytest.mark.parametrize(
        "payload",
        [
            {"name": ""},
            {"name": "   "},
            {"name": None},
            {"name": "a" * 81},
            {},
        ],
    )
    def test_invalid_names_return_422(self, api, payload):
        client, _ = api
        response = client.post("/api/folders", json=payload)
        assert response.status_code == 422

    def test_system_fields_are_ignored(self, api):
        client, _ = api
        response = client.post(
            "/api/folders",
            json={"name": "思考", "id": 424242, "created_at": "2020-01-01T00:00:00Z"},
        )
        assert response.status_code == 201
        assert response.json()["id"] != 424242


# ---------------------------------------------------------------------------
# GET /api/folders
# ---------------------------------------------------------------------------


class TestListFolders:
    def test_empty_list(self, api):
        client, _ = api
        response = client.get("/api/folders")
        assert response.status_code == 200
        assert response.json() == []

    def test_ordered_by_id_asc(self, api):
        client, _ = api
        first = _create_folder(client, "第一")
        second = _create_folder(client, "第二")
        third = _create_folder(client, "第三")
        response = client.get("/api/folders")
        assert response.status_code == 200
        ids = [folder["id"] for folder in response.json()]
        assert ids == sorted([first["id"], second["id"], third["id"]])
        assert ids[0] == first["id"]

    def test_is_plain_array_not_envelope(self, api):
        client, _ = api
        _create_folder(client, "普通数组")
        response = client.get("/api/folders")
        body = response.json()
        assert isinstance(body, list)
        assert set(body[0].keys()) == {"id", "name"}


# ---------------------------------------------------------------------------
# PATCH /api/folders/{id}
# ---------------------------------------------------------------------------


class TestUpdateFolder:
    def test_rename(self, api):
        client, _ = api
        folder = _create_folder(client, "旧名")
        response = client.patch(f"/api/folders/{folder['id']}", json={"name": "新名"})
        assert response.status_code == 200
        assert response.json() == {"id": folder["id"], "name": "新名"}

    def test_empty_patch_returns_current_without_change(self, api):
        client, _ = api
        folder = _create_folder(client, "原名")
        response = client.patch(f"/api/folders/{folder['id']}", json={})
        assert response.status_code == 200
        assert response.json() == {"id": folder["id"], "name": "原名"}

    def test_same_name_patch_returns_current(self, api):
        client, _ = api
        folder = _create_folder(client, "同名")
        response = client.patch(f"/api/folders/{folder['id']}", json={"name": "同名"})
        assert response.status_code == 200
        assert response.json()["name"] == "同名"

    def test_missing_folder_returns_404(self, api):
        client, _ = api
        response = client.patch("/api/folders/999999", json={"name": "无名"})
        assert response.status_code == 404

    def test_empty_patch_on_missing_folder_returns_404(self, api):
        client, _ = api
        response = client.patch("/api/folders/999999", json={})
        assert response.status_code == 404

    @pytest.mark.parametrize("payload", [{"name": None}, {"name": ""}, {"name": "a" * 81}])
    def test_invalid_name_returns_422(self, api, payload):
        client, _ = api
        folder = _create_folder(client, "有效")
        response = client.patch(f"/api/folders/{folder['id']}", json=payload)
        assert response.status_code == 422

    def test_extra_and_system_fields_ignored(self, api):
        client, _ = api
        folder = _create_folder(client, "原名")
        response = client.patch(
            f"/api/folders/{folder['id']}",
            json={"id": 888, "created_at": "2020-01-01T00:00:00Z"},
        )
        assert response.status_code == 200
        assert response.json() == {"id": folder["id"], "name": "原名"}


# ---------------------------------------------------------------------------
# DELETE /api/folders/{id}：真空删除与引用限制
# ---------------------------------------------------------------------------


class TestDeleteFolder:
    def test_delete_empty_folder_returns_204_empty_body(self, api):
        client, _ = api
        folder = _create_folder(client, "空目录")
        response = client.delete(f"/api/folders/{folder['id']}")
        assert response.status_code == 204
        assert response.content == b""
        # 删除后列表中不再出现。
        assert client.get("/api/folders").json() == []

    def test_delete_missing_folder_returns_404(self, api):
        client, _ = api
        assert client.delete("/api/folders/999999").status_code == 404

    def test_delete_twice_returns_404(self, api):
        client, _ = api
        folder = _create_folder(client, "只删一次")
        assert client.delete(f"/api/folders/{folder['id']}").status_code == 204
        assert client.delete(f"/api/folders/{folder['id']}").status_code == 404

    def test_active_journal_reference_blocks_delete(self, api):
        client, session = api
        folder = _create_folder(client, "有日志")
        _add_journal(session, title=None, folder_id=folder["id"])
        response = client.delete(f"/api/folders/{folder['id']}")
        assert response.status_code == 409
        assert "detail" in response.json()
        # Folder 仍在。
        assert client.get("/api/folders").json() != []

    def test_soft_deleted_journal_reference_still_blocks_delete(self, api):
        """只有回收箱（软删除 Journal）引用时同样 409（为恢复保留关系）。"""
        client, session = api
        folder = _create_folder(client, "回收箱引用")
        _add_journal(
            session,
            title=None,
            folder_id=folder["id"],
            deleted_at=datetime(2026, 10, 8, 3, 0, tzinfo=timezone.utc),
        )
        response = client.delete(f"/api/folders/{folder['id']}")
        assert response.status_code == 409

    def test_soft_deleted_insight_reference_still_blocks_delete(self, api):
        client, session = api
        folder = _create_folder(client, "回收箱洞察")
        _add_insight(session, folder_id=folder["id"],
                     deleted_at=datetime(2026, 10, 8, 3, 0, tzinfo=timezone.utc))
        assert client.delete(f"/api/folders/{folder['id']}").status_code == 409

    def test_active_insight_reference_blocks_delete(self, api):
        client, session = api
        folder = _create_folder(client, "有洞察")
        _add_insight(session, folder_id=folder["id"])
        assert client.delete(f"/api/folders/{folder['id']}").status_code == 409

    def test_active_inbox_reference_blocks_delete(self, api):
        client, session = api
        folder = _create_folder(client, "有收件")
        _add_inbox(session, folder_id=folder["id"])
        assert client.delete(f"/api/folders/{folder['id']}").status_code == 409

    def test_hard_deleted_inbox_releases_reference(self, api):
        """Inbox 是硬删除：物理行消失后 Folder 恢复真空，可删除。"""
        client, session = api
        folder = _create_folder(client, "先清收件")
        inbox = _add_inbox(session, folder_id=folder["id"])
        delete_response = client.delete(f"/api/inboxes/{inbox.id}")
        assert delete_response.status_code == 204
        assert client.delete(f"/api/folders/{folder['id']}").status_code == 204

    def test_moving_journal_out_releases_reference(self, api):
        client, session = api
        folder = _create_folder(client, "移出后可删")
        journal = _add_journal(session, title=None, folder_id=folder["id"])
        patch = client.patch(
            f"/api/journals/{journal.id}", json={"folder_id": None}
        )
        assert patch.status_code == 200
        assert client.delete(f"/api/folders/{folder['id']}").status_code == 204

    def test_delete_does_not_cascade_or_set_null(self, api):
        """409 拒绝时引用原样保留：Journal 仍指向该 Folder。"""
        client, session = api
        folder = _create_folder(client, "拒绝后不破坏")
        journal = _add_journal(session, title=None, folder_id=folder["id"])
        client.delete(f"/api/folders/{folder['id']}")
        detail = client.get(f"/api/journals/{journal.id}")
        assert detail.status_code == 200
        assert detail.json()["folder_id"] == folder["id"]

    def test_noninteger_id_returns_422(self, api):
        client, _ = api
        assert client.delete("/api/folders/abc").status_code == 422


# ---------------------------------------------------------------------------
# 三类文件的写入路径引用不存在的 Folder → 404，不留半截更新
# ---------------------------------------------------------------------------


class TestFileServicesValidateFolder:
    def test_journal_post_missing_folder_404(self, api):
        client, session = api
        before = client.get("/api/journals").json()["total"]
        response = client.post(
            "/api/journals",
            json={"content": "正文", "journal_date": "2026-10-08", "folder_id": 999999},
        )
        assert response.status_code == 404
        assert client.get("/api/journals").json()["total"] == before

    def test_journal_patch_missing_folder_keeps_other_fields(self, api):
        client, session = api
        journal = _add_journal(session, title="原标题", content="原正文")
        response = client.patch(
            f"/api/journals/{journal.id}",
            json={"content": "新正文", "folder_id": 999999},
        )
        assert response.status_code == 404
        detail = client.get(f"/api/journals/{journal.id}").json()
        # 原子性：正文与 Folder 都没变。
        assert detail["content"] == "原正文"
        assert detail["folder_id"] is None
        assert detail["title"] == "原标题"

    def test_inbox_post_missing_folder_404(self, api):
        client, session = api
        response = client.post(
            "/api/inboxes",
            json={"content": "收件", "inbox_date": "2026-10-08", "folder_id": 999999},
        )
        assert response.status_code == 404

    def test_inbox_patch_missing_folder_keeps_content(self, api):
        client, session = api
        # 用真实 POST 造数：Inbox 的 update_inbox 在异常路径会 rollback，
        # savepoint 里 flush 的行会被一并撤销，所以这里不能只 flush。
        created = client.post(
            "/api/inboxes",
            json={"content": "收件", "inbox_date": "2026-10-08"},
        )
        assert created.status_code == 201
        inbox_id = created.json()["id"]
        response = client.patch(
            f"/api/inboxes/{inbox_id}",
            json={"content": "新收件", "folder_id": 999999},
        )
        assert response.status_code == 404
        detail = client.get(f"/api/inboxes/{inbox_id}").json()
        assert detail["content"] == "收件"
        assert detail["folder_id"] is None

    def test_insight_post_missing_folder_404(self, api):
        client, _ = api
        response = client.post(
            "/api/insights",
            json={"content": "洞察", "folder_id": 999999},
        )
        assert response.status_code == 404

    def test_insight_patch_missing_folder_keeps_content(self, api):
        client, session = api
        insight = _add_insight(session)
        response = client.patch(
            f"/api/insights/{insight.id}",
            json={"content": "新洞察", "folder_id": 999999},
        )
        assert response.status_code == 404
        detail = client.get(f"/api/insights/{insight.id}").json()
        assert detail["content"] == "洞察"
        assert detail["folder_id"] is None


# ---------------------------------------------------------------------------
# 三类文件移动：归属变化更新 updated_at；相同 folder_id 不产生无意义写入
# ---------------------------------------------------------------------------


class TestFileMoveTimestamps:
    def test_journal_move_updates_updated_at_keeps_created_at(self, api):
        client, session = api
        folder = _create_folder(client, "目标")
        journal = _add_journal(session, title=None)
        before = client.get(f"/api/journals/{journal.id}").json()
        response = client.patch(
            f"/api/journals/{journal.id}", json={"folder_id": folder["id"]}
        )
        assert response.status_code == 200
        after = response.json()
        assert after["folder_id"] == folder["id"]
        assert after["updated_at"] > before["updated_at"]
        assert after["created_at"] == before["created_at"]

    def test_journal_move_out_to_null(self, api):
        client, session = api
        folder = _create_folder(client, "临时")
        journal = _add_journal(session, title=None, folder_id=folder["id"])
        response = client.patch(f"/api/journals/{journal.id}", json={"folder_id": None})
        assert response.status_code == 200
        assert response.json()["folder_id"] is None

    def test_journal_same_folder_patch_keeps_updated_at(self, api):
        client, session = api
        folder = _create_folder(client, "同处")
        journal = _add_journal(session, title=None, folder_id=folder["id"])
        before = client.get(f"/api/journals/{journal.id}").json()
        response = client.patch(
            f"/api/journals/{journal.id}", json={"folder_id": folder["id"]}
        )
        assert response.status_code == 200
        assert response.json()["updated_at"] == before["updated_at"]

    def test_inbox_move_keeps_daily_identity_and_date(self, api):
        client, session = api
        folder = _create_folder(client, "收件目标")
        inbox = Inbox(title="日志正文", content="内容", inbox_date=date(2026, 10, 8),
                      is_daily=True)
        session.add(inbox)
        session.flush()
        response = client.patch(
            f"/api/inboxes/{inbox.id}", json={"folder_id": folder["id"]}
        )
        assert response.status_code == 200
        after = response.json()
        assert after["folder_id"] == folder["id"]
        assert after["is_daily"] is True
        assert after["inbox_date"] == "2026-10-08"

    def test_insight_move_updates_updated_at(self, api):
        client, session = api
        folder = _create_folder(client, "洞察目标")
        insight = _add_insight(session)
        before = client.get(f"/api/insights/{insight.id}").json()
        response = client.patch(
            f"/api/insights/{insight.id}", json={"folder_id": folder["id"]}
        )
        assert response.status_code == 200
        assert response.json()["updated_at"] > before["updated_at"]
