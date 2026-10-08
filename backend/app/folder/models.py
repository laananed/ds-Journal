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

# ---- S2-T07：三张文件表指向 folders.id 的外键约束名 ----
#
# 这个集合与判定函数放在 models 模块而不是 folder/service.py，
# 是因为 Journal / Inbox / Insight 三个 Service 都已经导入本模块
# （FK 竞争异常映射需要它），而 folder/service.py 又会导入三者的
# 投影实现；放在 service 层会造成 Service 之间的循环导入。

FOLDER_FK_CONSTRAINTS = frozenset(
    {
        "journals_folder_id_fkey",
        "inboxes_folder_id_fkey",
        "insights_folder_id_fkey",
    }
)


def folder_fk_violation(error: BaseException) -> bool:
    """判断一个数据库异常是否为「文件 → Folder」外键引用失败。

    只认 psycopg 上报的 sqlstate 23503（foreign_key_violation）且
    约束名是三张文件表指向 folders 的 FK；其他 IntegrityError
    （例如 Daily 唯一索引冲突）一律返回 False，由调用方按原语义处理，
    不做无差别改写、不掩盖其他真实写入故障。

    并发场景（S2-T07）：Folder 真空删除与文件创建/移入竞争时，
    FK 仲裁失败的一方收到这里识别的异常，
    文件 Service 把它转成「Folder 不存在」（404），
    Folder 删除把它转成「仍有引用」（409）。
    """
    orig = getattr(error, "orig", None)
    if getattr(orig, "sqlstate", None) != "23503":
        return False
    constraint_name = getattr(getattr(orig, "diag", None), "constraint_name", None)
    return constraint_name in FOLDER_FK_CONSTRAINTS


class Folder(Base):
    """一个一级 Folder（分类）。

    名称是否唯一、长度与空白规则由请求 Schema 决定（S2-T07），
    数据库层不加 UNIQUE、不加长度/空白 CHECK：
    与 Journal 一样，规则留在请求层，避免迁移因历史数据失败。
    """

    __tablename__ = "folders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    name: Mapped[str] = mapped_column(Text, nullable=False)
