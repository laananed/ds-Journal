"""Journal 业务操作。

Stage 1 / Task 4.2：Create。
Stage 1 / Task 5.1：List（含可选 journal_date 精确筛选）。
Stage 1 / Task 5.2：Get（按主键取单篇）。

调用关系：Router → Service → SQLAlchemy → psycopg → PostgreSQL。

Service 负责业务行为与事务边界：

- 写入（create）：成功 commit，失败 rollback 并把异常继续抛给上层；
- 读取（list / get）：只查，不 add / flush / commit，也不修改任何字段。

读取函数不感知 HTTP：找不到记录时返回 None，
由 Router 决定对外的状态码（当前是 404），
因此这里不导入 FastAPI 的 HTTPException。

不包含 Repository、不引入额外抽象层。
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.journal.models import Journal
from app.journal.schemas import JournalCreate


def create_journal(db: Session, data: JournalCreate) -> Journal:
    """创建一篇 Journal，成功返回已持久化并带系统字段的完整记录。

    只有三个业务字段来自请求：

    - title：原样保存，可以是 None，数据库不生成默认标题；
    - content、journal_date：必填，已由 JournalCreate 校验。

    id / created_at / updated_at 由数据库与 Model 生成，这里不赋值，
    即使客户端在请求体里多传了这三个字段，JournalCreate 也已把它们忽略。
    """
    journal = Journal(
        title=data.title,
        content=data.content,
        journal_date=data.journal_date,
    )

    db.add(journal)
    try:
        db.commit()
    except Exception:
        # 写入失败必须回滚，否则该 Session 会停留在待回滚状态。
        db.rollback()
        raise

    # commit 后对象属性会过期，这里显式回读一次，
    # 保证返回给 Router 的记录带有数据库真正生成的 id 与时间。
    db.refresh(journal)
    return journal


def list_journals(db: Session, journal_date: date | None = None) -> list[Journal]:
    """返回 Journal 列表，可选按 journal_date 精确筛选。

    排序在数据库里完成，遵守 `docs/stage1-api.md`：

    - 第一排序：`journal_date DESC`（业务日期新的在前）；
    - 第二排序：`created_at DESC`（同一天里后创建的在前）。

    筛选同样在 SQL 里完成（等值比较），不是先取全部再在 Python 里过滤。

    这是只读函数：不 add、不 flush、不 commit，也不修改任何字段；
    Session 的关闭继续由 `get_db` 负责。

    没有记录或没有匹配时返回空列表。
    """
    statement = select(Journal)

    if journal_date is not None:
        statement = statement.where(Journal.journal_date == journal_date)

    statement = statement.order_by(
        Journal.journal_date.desc(),
        Journal.created_at.desc(),
    )

    return list(db.scalars(statement).all())


def get_journal(db: Session, journal_id: int) -> Journal | None:
    """按主键取一篇 Journal；不存在时返回 None。

    用 `Session.get()` 按主键查询，让 SQLAlchemy 走最简单的主键路径：
    不需要自己拼 where 条件，也不需要把整表取回来再在 Python 里查找。

    这是只读函数：不 add、不 flush、不 commit，也不修改任何字段；
    Session 的关闭继续由 `get_db` 负责。

    命中时会先看 Session 的 identity map，因此返回的可能是当前
    Session 里已有的同一个对象；这对调用方没有影响，因为本函数不写入。
    """
    return db.get(Journal, journal_id)
