"""Journal 业务操作。

Stage 1 / Task 4.2：Create。
Stage 1 / Task 5.1：List（含可选 journal_date 精确筛选）。
Stage 1 / Task 5.2：Get（按主键取单篇）。
Stage 1 / Task 6.2：Update（部分更新）。

调用关系：Router → Service → SQLAlchemy → psycopg → PostgreSQL。

Service 负责业务行为与事务边界：

- 写入（create / update）：成功 commit，失败 rollback 并把异常继续抛给上层；
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
from app.journal.schemas import JournalCreate, JournalUpdate


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


def update_journal(
    db: Session,
    journal_id: int,
    data: JournalUpdate,
) -> Journal | None:
    """部分更新一篇 Journal；记录不存在时返回 None。

    「哪些字段要改」完全由请求的提交状态决定：

    - `data.model_dump(exclude_unset=True)` 只给出本次**实际提交**的字段；
    - 因此省略的字段不会被写回，`title` 显式提交 `null` 时也会被保留为 None
      （这正是不使用 `exclude_none=True` 的原因）。

    `JournalUpdate` 只声明 title / content / journal_date 三个字段，
    额外字段与系统字段在 Schema 层已被忽略，
    所以这里的赋值循环只会写这三个业务字段，
    `id` / `created_at` / `updated_at` 都不在这里赋值。

    `updated_at` 复用 Model 现有的 `onupdate`：
    只有真的产生了 UPDATE 才会刷新它，这里不另建时间维护机制。
    提交的字段值与当前值完全相同时，SQLAlchemy 不发 UPDATE，
    因此 `updated_at` 保持原值 —— 本函数不做额外的“强制刷新”，
    也不加比较层去判断“是否真的变了”。

    空更新（验证后没有任何可更新字段）：

    - 记录存在：直接返回当前记录，不 commit、不 flush、不 refresh，
      也不触碰 `updated_at`；
    - 记录不存在：返回 None，由 Router 转成 404。

    记录存在且有提交字段时：
    该记录是当前 Session 里的既有持久化对象，不需要 add；
    赋值后 commit，成功 refresh 回读数据库真正持久化的结果（含新的 `updated_at`）。

    写入失败时 rollback 并把异常继续抛给上层，
    不吞异常、不返回伪成功，也不把数据库错误改写成 404。

    本函数不感知 HTTP，因此不导入 FastAPI 的 HTTPException。
    """
    journal = db.get(Journal, journal_id)
    if journal is None:
        return None

    changes = data.model_dump(exclude_unset=True)
    if not changes:
        # 空更新：不产生任何写入，updated_at 保持不变。
        # 这里刻意不调用 refresh()：refresh 会发出 SELECT，
        # 而“什么都不做”的定义就是连读回都不需要。
        return journal

    for field, value in changes.items():
        setattr(journal, field, value)

    try:
        db.commit()
    except Exception:
        # 写入失败必须回滚，否则该 Session 会停留在待回滚状态。
        db.rollback()
        raise

    # commit 后对象属性会过期，这里显式回读一次，
    # 保证返回的记录带有数据库真正持久化的值（包括新的 updated_at）。
    db.refresh(journal)
    return journal
