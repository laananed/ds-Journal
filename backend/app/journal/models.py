"""Journal SQLAlchemy Model。

Stage 1 / Task 3 第二步。

字段定义以 `docs/stage1.md` 与 `docs/stage1-architecture.md` 为准：
id / title / content / journal_date / created_at / updated_at。

本模块只描述表结构映射，不创建表。
实际的表由 Alembic Migration 建立。
"""

from __future__ import annotations

from datetime import date, datetime, timezone

from sqlalchemy import Date, DateTime, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def _utcnow() -> datetime:
    """返回带时区的当前时间，供 created_at / updated_at 使用。"""
    return datetime.now(timezone.utc)


class Journal(Base):
    """一篇 Journal。

    title 允许为空；数据库不写入任何默认标题或同日编号，
    默认标题与 `(n)` 编号都属于前端显示逻辑。
    """

    __tablename__ = "journals"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    title: Mapped[str | None] = mapped_column(Text, nullable=True)

    content: Mapped[str] = mapped_column(Text, nullable=False)

    # 普通索引，不是 UNIQUE：同一天允许多篇 Journal。
    journal_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)

    # 时间由 SQLAlchemy 在写入时生成：
    # - default 负责创建时赋值；
    # - onupdate 负责 UPDATE 时刷新 updated_at，created_at 不受影响。
    #
    # 这里没有使用 PostgreSQL 的 now()/server_default：
    # now() 等价于 transaction_timestamp()，在同一个事务里取到的值相同，
    # 插入与更新发生在同一事务时 updated_at 不会体现变化。
    # 也没有使用数据库触发器。
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
