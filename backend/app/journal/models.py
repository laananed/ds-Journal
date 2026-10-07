"""Journal SQLAlchemy Model。

Stage 1 / Task 3 第二步建立原有六字段。

Stage 2 / S2-T01（M1）新增两个可空列：

- `folder_id`：可空外键，指向 `folders.id`；
- `deleted_at`：可空的带时区时间（软删除占位）。

原有六字段定义仍以 `docs/stage1.md` 与 `docs/stage1-architecture.md` 为准：
id / title / content / journal_date / created_at / updated_at。
新增两列以 `docs/stage2-architecture.md` 第 3 节为准，旧记录默认 NULL。

本模块只描述表结构映射，不创建表。
实际的表由 Alembic Migration 建立。
"""

from __future__ import annotations

from datetime import date, datetime, timezone

from sqlalchemy import Date, DateTime, ForeignKey, Integer, Text
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

    # ---- Stage 2 / S2-T01（M1）新增的两个可空列 ----
    #
    # 两个列都加在原有六字段之后（对应的 Migration 也只会 ADD COLUMN），
    # 所有旧记录升级后这两列都是 NULL。

    # 可空外键，指向 folders.id。
    #
    # 不写 ondelete：PostgreSQL 默认就是 NO ACTION，
    # 与 `docs/stage2-architecture.md` 的「RESTRICT / NO ACTION、
    # 不 cascade、不 SET NULL」一致。
    # 也刻意不加 index=True：本轮没有查询需要，保持迁移最小。
    folder_id: Mapped[int | None] = mapped_column(
        ForeignKey("folders.id"),
        nullable=True,
    )

    # 软删除时间。本轮只建立列，**不实现软删除行为**：
    # API 仍然是 Stage 1.5 的硬删除（见 router.py / service.py），
    # 普通 GET / 列表在 S2-T02 才会开始过滤这一列。
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
