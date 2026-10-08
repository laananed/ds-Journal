"""Folder 删除与文件移入的真实并发竞争测试（Stage 2 / S2-T07）。

与 `test_folder_api.py` 的 savepoint 隔离不同，本模块使用**独立的
Session / 连接 / 真实 commit** 复现并发时序，并做受控暂停：

1. 删除方先 `FOR UPDATE` 锁住 Folder 行，移入方阻塞在 FK 校验上：
   - 删除方提交 → 移入方收到 FK 冲突（sqlstate 23503），
     映射为 FolderNotFoundError（HTTP 404），不留孤儿、不留半截更新；
   - 删除方回滚 → 移入方正常完成。
2. 移入方先 flush（持有 FOR KEY SHARE），删除方的锁/检查被阻塞：
   - 移入方提交 → 删除方发现引用，FolderInUseError（HTTP 409）；
   - 移入方回滚 → 删除方真空删除成功。

所有真实写入的行在 finally 里按本轮登记的 typed IDs 清理，
不整表删除、不重置 sequence。pytest 与真实 HTTP 造数串行。
"""

from __future__ import annotations

import threading
import time
from datetime import date

import pytest
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.database import engine
from app.folder.models import Folder
from app.folder.schemas import FolderCreate
from app.folder.service import (
    FolderInUseError,
    FolderNotFoundError,
    create_folder,
    delete_folder,
)
from app.journal.models import Journal
from app.journal.schemas import JournalCreate, JournalUpdate
from app.journal.service import (
    FolderNotFoundError as JournalFolderNotFoundError,
)
from app.journal.service import create_journal, update_journal

DAY = date(2026, 10, 8)


class _Registry:
    """登记本轮真实写入的 typed IDs，finally 里精确清理。"""

    def __init__(self) -> None:
        self.folders: list[int] = []
        self.journals: list[int] = []
        self.inboxes: list[int] = []
        self.insights: list[int] = []

    def cleanup(self) -> None:
        with engine.begin() as connection:
            for name, ids in (
                ("journals", self.journals),
                ("inboxes", self.inboxes),
                ("insights", self.insights),
            ):
                if ids:
                    connection.execute(
                        text(f"DELETE FROM {name} WHERE id = ANY(:ids)"),
                        {"ids": ids},
                    )
            if self.folders:
                connection.execute(
                    text("DELETE FROM folders WHERE id = ANY(:ids)"),
                    {"ids": self.folders},
                )


@pytest.fixture
def registry():
    record = _Registry()
    yield record
    record.cleanup()


def _assert_test_database() -> None:
    with engine.connect() as connection:
        database = connection.execute(text("SELECT current_database()")).scalar_one()
    assert database == "seekjournal_test"


def _new_session() -> Session:
    # 独立 Session：从连接池拿自己的连接，commit 是真实提交。
    return Session(engine)


def _make_journal(session: Session, registry: _Registry) -> Journal:
    journal = create_journal(
        session,
        JournalCreate(content="并发竞争正文", journal_date=DAY),
    )
    registry.journals.append(journal.id)
    return Journal(id=journal.id)  # 只携带 id 的轻量标记。


# ---------------------------------------------------------------------------
# 场景 1：删除方持锁并提交删除，移入方在 FK 校验处失败
# ---------------------------------------------------------------------------


class TestDeleteWins:
    def test_move_in_blocked_by_lock_then_folder_deleted_returns_404_domain_error(
        self, registry
    ):
        _assert_test_database()
        setup = _new_session()
        folder = create_folder(setup, FolderCreate(name="删除方赢"))
        registry.folders.append(folder.id)
        journal = _make_journal(setup, registry)
        before = update_journal(setup, journal.id, JournalUpdate())  # 读取当前投影
        setup.close()

        lock_session = _new_session()
        locked = lock_session.scalars(
            select(Folder).where(Folder.id == folder.id).with_for_update()
        ).one()
        assert locked.id == folder.id

        mover_session = _new_session()
        errors: list[BaseException] = []
        result: dict = {}

        def move_in() -> None:
            try:
                # 阻塞点：commit 时的 FK 校验需要 folder 行的 FOR KEY SHARE。
                result["response"] = update_journal(
                    mover_session,
                    journal.id,
                    JournalUpdate(content="竞争新正文", folder_id=folder.id),
                )
            except BaseException as error:  # noqa: BLE001
                errors.append(error)

        thread = threading.Thread(target=move_in)
        thread.start()
        time.sleep(0.6)
        # 移入方确实被锁阻塞，还没有完成。
        assert thread.is_alive()
        assert not result

        # 删除方在持锁状态下完成真空删除并提交。
        lock_session.execute(
            text("DELETE FROM folders WHERE id = :fid"), {"fid": folder.id}
        )
        lock_session.commit()
        lock_session.close()

        thread.join(timeout=15)
        assert not thread.is_alive(), "移入方在删除提交后仍未结束"
        # FK 仲裁失败被映射为领域错误（Router 转 404），不是裸 IntegrityError。
        assert len(errors) == 1
        assert isinstance(errors[0], JournalFolderNotFoundError)
        mover_session.close()

        # 不留孤儿引用，也不留半截更新：
        with engine.connect() as connection:
            folder_gone = connection.execute(
                text("SELECT count(*) FROM folders WHERE id = :fid"),
                {"fid": folder.id},
            ).scalar_one()
            row = connection.execute(
                text(
                    "SELECT content, folder_id, title, updated_at "
                    "FROM journals WHERE id = :jid"
                ),
                {"jid": journal.id},
            ).one()
        assert folder_gone == 0
        assert row.folder_id is None
        assert row.content == before.content
        assert row.title == before.title
        assert row.updated_at == before.updated_at

    def test_session_reusable_after_fk_failure(self, registry):
        """FK 失败回滚后，同一个 Session 仍能继续执行后续合法操作。"""
        _assert_test_database()
        setup = _new_session()
        folder = create_folder(setup, FolderCreate(name="会话复用"))
        registry.folders.append(folder.id)
        journal = _make_journal(setup, registry)
        setup.close()

        lock_session = _new_session()
        lock_session.scalars(
            select(Folder).where(Folder.id == folder.id).with_for_update()
        ).one()

        mover_session = _new_session()
        errors: list[BaseException] = []

        def move_in() -> None:
            try:
                update_journal(
                    mover_session, journal.id, JournalUpdate(folder_id=folder.id)
                )
            except BaseException as error:  # noqa: BLE001
                errors.append(error)

        thread = threading.Thread(target=move_in)
        thread.start()
        time.sleep(0.6)
        lock_session.execute(
            text("DELETE FROM folders WHERE id = :fid"), {"fid": folder.id}
        )
        lock_session.commit()
        lock_session.close()
        thread.join(timeout=15)

        assert len(errors) == 1
        assert isinstance(errors[0], JournalFolderNotFoundError)

        # 同一个 mover_session：FK 失败已经 rollback，可以直接做合法 PATCH。
        response = update_journal(
            mover_session, journal.id, JournalUpdate(title="竞争后改名")
        )
        assert response.title == "竞争后改名"
        mover_session.close()


# ---------------------------------------------------------------------------
# 场景 2：删除方持锁后回滚，移入方正常完成
# ---------------------------------------------------------------------------


class TestRollbackWins:
    def test_move_in_succeeds_after_delete_rollback(self, registry):
        _assert_test_database()
        setup = _new_session()
        folder = create_folder(setup, FolderCreate(name="回滚方赢"))
        registry.folders.append(folder.id)
        journal = _make_journal(setup, registry)
        before = update_journal(setup, journal.id, JournalUpdate())
        setup.close()

        lock_session = _new_session()
        lock_session.scalars(
            select(Folder).where(Folder.id == folder.id).with_for_update()
        ).one()

        mover_session = _new_session()
        result: dict = {}
        errors: list[BaseException] = []

        def move_in() -> None:
            try:
                result["response"] = update_journal(
                    mover_session,
                    journal.id,
                    JournalUpdate(content="移入成功", folder_id=folder.id),
                )
            except BaseException as error:  # noqa: BLE001
                errors.append(error)

        thread = threading.Thread(target=move_in)
        thread.start()
        time.sleep(0.6)
        assert thread.is_alive(), "移入方未被 Folder 行锁阻塞"

        lock_session.rollback()
        lock_session.close()
        thread.join(timeout=15)
        assert not thread.is_alive()
        assert not errors
        assert result["response"].folder_id == folder.id
        assert result["response"].content == "移入成功"
        assert result["response"].updated_at > before.updated_at
        mover_session.close()

        with engine.connect() as connection:
            folder_alive = connection.execute(
                text("SELECT count(*) FROM folders WHERE id = :fid"),
                {"fid": folder.id},
            ).scalar_one()
        assert folder_alive == 1


# ---------------------------------------------------------------------------
# 场景 3：移入方先 flush（未提交），删除方被阻塞
# ---------------------------------------------------------------------------


class TestMoverFlushedFirst:
    def _flush_move_in(self, mover_session: Session, journal_id: int, folder_id: int):
        """在 mover_session 里做归属变化并 flush（不提交）。"""
        journal = mover_session.scalars(
            select(Journal).where(
                Journal.id == journal_id, Journal.deleted_at.is_(None)
            )
        ).one()
        journal.folder_id = folder_id
        mover_session.flush()

    def test_folder_delete_blocked_until_move_in_commit_then_409(self, registry):
        _assert_test_database()
        setup = _new_session()
        folder = create_folder(setup, FolderCreate(name="移入先flush"))
        registry.folders.append(folder.id)
        journal = _make_journal(setup, registry)
        setup.close()

        mover_session = _new_session()
        self._flush_move_in(mover_session, journal.id, folder.id)

        deleter_session = _new_session()
        errors: list[BaseException] = []

        def delete_folder_later() -> None:
            try:
                delete_folder(deleter_session, folder.id)
            except BaseException as error:  # noqa: BLE001
                errors.append(error)

        thread = threading.Thread(target=delete_folder_later)
        thread.start()
        time.sleep(0.6)
        # 删除方阻塞在 FOR UPDATE（移入方 flush 后持有 FOR KEY SHARE）。
        assert thread.is_alive()
        assert len(errors) == 0

        mover_session.commit()
        thread.join(timeout=15)
        assert not thread.is_alive()
        # 提交后引用真实存在：删除方按契约报「仍有引用」（Router 转 409）。
        assert len(errors) == 1
        assert isinstance(errors[0], FolderInUseError)
        deleter_session.close()

        with engine.connect() as connection:
            folder_alive = connection.execute(
                text("SELECT count(*) FROM folders WHERE id = :fid"),
                {"fid": folder.id},
            ).scalar_one()
            reference = connection.execute(
                text("SELECT folder_id FROM journals WHERE id = :jid"),
                {"jid": journal.id},
            ).scalar_one()
        assert folder_alive == 1
        assert reference == folder.id
        mover_session.close()

    def test_folder_delete_succeeds_after_move_in_rollback(self, registry):
        _assert_test_database()
        setup = _new_session()
        folder = create_folder(setup, FolderCreate(name="移入回滚"))
        registry.folders.append(folder.id)
        journal = _make_journal(setup, registry)
        setup.close()

        mover_session = _new_session()
        self._flush_move_in(mover_session, journal.id, folder.id)

        deleter_session = _new_session()
        outcome: dict = {}
        errors: list[BaseException] = []

        def delete_folder_later() -> None:
            try:
                outcome["deleted"] = delete_folder(deleter_session, folder.id)
            except BaseException as error:  # noqa: BLE001
                errors.append(error)

        thread = threading.Thread(target=delete_folder_later)
        thread.start()
        time.sleep(0.6)
        assert thread.is_alive()

        mover_session.rollback()
        thread.join(timeout=15)
        assert not thread.is_alive()
        assert not errors
        assert outcome["deleted"] is True
        deleter_session.close()
        mover_session.close()

        with engine.connect() as connection:
            folder_gone = connection.execute(
                text("SELECT count(*) FROM folders WHERE id = :fid"),
                {"fid": folder.id},
            ).scalar_one()
            still = connection.execute(
                text("SELECT folder_id FROM journals WHERE id = :jid"),
                {"jid": journal.id},
            ).scalar_one()
        assert folder_gone == 0
        # 移入回滚：Journal 的归属未被改动。
        assert still is None


# ---------------------------------------------------------------------------
# 防回归：非 Folder 引用的 IntegrityError 不被无差别改写
# ---------------------------------------------------------------------------


class TestNoBlanketConversion:
    def test_daily_conflict_is_not_mapped_to_folder_error(self, registry):
        """Daily 唯一索引冲突保持原有 DailyInboxConflictError 语义。"""
        from app.inbox.schemas import InboxCreate
        from app.inbox.service import DailyInboxConflictError, create_inbox

        _assert_test_database()
        session = _new_session()
        first = create_inbox(
            session,
            InboxCreate(content="第一篇", inbox_date=DAY, is_daily=True),
        )
        registry.inboxes.append(first.id)
        with pytest.raises(DailyInboxConflictError) as excinfo:
            create_inbox(
                session,
                InboxCreate(content="第二篇", inbox_date=DAY, is_daily=True),
            )
        assert not isinstance(excinfo.value, FolderNotFoundError)
        # 失败的第二次创建没有留下任何行。
        with engine.connect() as connection:
            count = connection.execute(
                text(
                    "SELECT count(*) FROM inboxes "
                    "WHERE inbox_date = :d AND is_daily = true"
                ),
                {"d": DAY},
            ).scalar_one()
        assert count == 1
        session.close()
