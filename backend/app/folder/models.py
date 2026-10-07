"""Folder SQLAlchemy Model。

Stage 2 / S2-T01（M1）。

字段定义以 `docs/stage2.md`、`docs/stage2-api.md` 与
`docs/stage2-architecture.md` 为准：

- id / name（Text Not Null），只有两个字段；
- 一级 Folder：没有 parent_id、颜色、图标、排序字段。

Journal / Inbox / Insight 的 `folder_id` 都指向本表的 `id`，
因此本表必须比它们先建立（M1 先于 M2）。

本模块只描述表结构映射，不创建表；
实际的表由 Alembic Migration 建立。
"""

from __future__ import annotations

from sqlalchemy import Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Folder(Base):
    """一个一级 Folder（分类）。

    名称是否唯一、长度与空白规则由请求 Schema 决定（S2-T07），
    数据库层不加 UNIQUE、不加长度/空白 CHECK：
    与 Journal 一样，规则留在请求层，避免迁移因历史数据失败。
    """

    __tablename__ = "folders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    name: Mapped[str] = mapped_column(Text, nullable=False)
