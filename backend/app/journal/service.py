"""Journal 业务操作。

Stage 1 / Task 4.2：只实现 Create。

调用关系：Router → Service → SQLAlchemy → psycopg → PostgreSQL。

Service 负责业务行为与事务边界：

- 成功：commit；
- 失败：rollback，并把异常继续抛给上层。

不包含 Repository、不引入额外抽象层。
"""

from __future__ import annotations

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
