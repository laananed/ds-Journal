"""Insight SQLAlchemy Model。

Stage 2 / S2-T01（M2）。

字段定义以 `docs/stage2.md`、`docs/stage2-api.md` 与
`docs/stage2-architecture.md` 第 3 节为准：

- id；
- title：Nullable Text；
- content：Text Not Null；
- folder_id：Nullable 外键 → folders.id；
- created_at / updated_at：带时区时间；
- deleted_at：Nullable 带时区时间。

刻意**没有**的字段：

- 所属日期（Insight 不要求业务日期）；
- 来源 Journal 关系；
- 任何 AI / 生成状态字段。

时间沿用 Journal 的 Python default / onupdate 方式，不新增数据库触发器。
本模块只描述表结构映射，不创建表；实际的表由 Alembic Migration 建立。
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from sqlalchemy import BigInteger
from sqlalchemy.dialects.postgresql import JSONB, UUID
from uuid import UUID as PythonUUID
from app.database import Base


def _utcnow() -> datetime:
    """返回带时区的当前时间，供 created_at / updated_at 使用。"""
    return datetime.now(timezone.utc)


class Insight(Base):
    """一条 Insight（认识、原则、结论与长期思考）。

    字段比 Journal / Inbox 更少：没有业务日期，用户手动管理。
    空标题的展示回退（“未命名 Insight”）属于展示逻辑，不写入 `title`。
    """

    __tablename__ = "insights"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    title: Mapped[str | None] = mapped_column(Text, nullable=True)

    content: Mapped[str] = mapped_column(Text, nullable=False)

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

    # Stage 3 safe writing foundation; old rows keep their original fields.
    revision: Mapped[int] = mapped_column(BigInteger, nullable=False, default=1, server_default="1")
    client_create_id: Mapped[PythonUUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, unique=True)
    create_payload_hash: Mapped[str | None] = mapped_column(Text, nullable=True)
