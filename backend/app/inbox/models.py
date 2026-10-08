"""Inbox storage mapping (M2) plus Daily's partial unique index (M3).

All Inbox kinds are physically deleted. M2's deleted_at column stays unused.
Daily identity is inbox_date + is_daily, independent of title and Folder.
"""

from __future__ import annotations

from datetime import date, datetime, timezone

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, Text, false, Index, text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def _utcnow() -> datetime:
    """返回带时区的当前时间，供 created_at / updated_at 使用。

    与 `app/journal/models.py` 中的实现相同，刻意各自保留一份：
    两个模块互不依赖，改动一个不会影响另一个。
    """
    return datetime.now(timezone.utc)


class Inbox(Base):
    """一条 Inbox（快速记录的想法、任务与碎片）。

    与 Journal 不同，Inbox 没有可修改的业务日期：
    `inbox_date` 与 `is_daily` 在创建时确定，之后不参与更新，
    Daily 的身份靠这两个字段识别，而不是靠 title 是否等于日期。
    """

    __tablename__ = "inboxes"
    __table_args__ = (
        Index('uq_inboxes_daily_date', 'inbox_date', unique=True,
              postgresql_where=text('is_daily = true')),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    title: Mapped[str | None] = mapped_column(Text, nullable=True)

    content: Mapped[str] = mapped_column(Text, nullable=False)

    inbox_date: Mapped[date] = mapped_column(Date, nullable=False)

    # Python 侧 default 与数据库侧 server_default 同时给出，
    # 两者都是 false，因此无论走 ORM 还是直接 SQL 插入，默认值一致。
    is_daily: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        server_default=false(),
    )

    # 与 Journal.folder_id 相同：不写 ondelete（PostgreSQL 默认 NO ACTION），
    # 也不加 index=True。
    folder_id: Mapped[int | None] = mapped_column(
        ForeignKey("folders.id"),
        nullable=True,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=_utcnow,
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=_utcnow,
        onupdate=_utcnow,
    )

    # Retained M2 column; Inbox never assigns or filters this field.
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
