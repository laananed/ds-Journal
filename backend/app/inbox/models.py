"""Inbox SQLAlchemy Model。

Stage 2 / S2-T01（M2）。

字段定义以 `docs/stage2.md`、`docs/stage2-api.md` 与
`docs/stage2-architecture.md` 第 3 节为准：

- id；
- title：Nullable Text；
- content：Text Not Null；
- inbox_date：Date Not Null（本机 04:00 业务日期）；
- is_daily：Boolean Not Null，默认 false（区分当日 Daily 与额外 Inbox）；
- folder_id：Nullable 外键 → folders.id；
- created_at / updated_at：带时区时间；
- deleted_at：Nullable 带时区时间。

刻意**没有**的字段：

- 整理状态、完成状态、颜色、过期规则；
- Journal 来源关系；
- Daily 唯一索引（属于 S2-T04 的 M3，本任务不建）。

`title` 先保持 Nullable：**「用户能否主动清空 Inbox 标题」是产品 Pending P1**，
本任务只提供不丢数据的存储，不替产品做决定。

时间沿用 Journal 的 Python default / onupdate 方式，不新增数据库触发器。
本模块只描述表结构映射，不创建表；实际的表由 Alembic Migration 建立。
"""

from __future__ import annotations

from datetime import date, datetime, timezone

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, Text, false
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

    # 软删除时间。本轮只建立列，不实现软删除行为。
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
