"""Journal 业务操作。

Stage 1 / Task 4.2：Create。
Stage 1 / Task 5.1：List（含可选 journal_date 精确筛选）。
Stage 1 / Task 5.2：Get（按主键取单篇）。
Stage 1 / Task 6.2：Update（部分更新）。
Stage 1 / Task 7.1：Delete（按主键硬删除）。

Stage 2 / S2-T02 按新契约改造：

- 读取统一为分页 envelope，固定 20 条/页（`JournalPage`）；
- 响应新增只读 `type` / `display_title` / `folder_id` / `deleted_at`；
- 无标题 Journal 的显示编号在该日期**完整现存集合**上用窗口函数计算
  （含已软删除记录），再叠加有效状态与筛选；
- `folder_id` 在写入时校验 Folder 是否存在，不存在返回 404 且不产生半截更新；
- 普通删除改为**软删除**：在同一个 UPDATE 里写 `deleted_at`
  并**显式保留原 `updated_at`**（数据库里行仍在）；
- 普通入口（列表 / 详情 / PATCH / DELETE）一律排除 `deleted_at` 非空的记录。

调用关系：Router → Service → SQLAlchemy → psycopg → PostgreSQL。

Service 负责业务行为与事务边界：

- 写入（create / update / delete）：成功 commit，失败 rollback 并把异常继续抛给上层；
- 读取（list / get）：只查，不 add / flush / commit，也不修改任何字段。

读取函数不感知 HTTP：找不到（含已软删除）记录时返回 None，
删除函数不感知 HTTP：未命中有效记录时返回 False，
由 Router 决定对外的状态码（当前都是 404），
因此这里不导入 FastAPI 的 HTTPException。
唯一例外是「指定了不存在的 Folder」——它用 `FolderNotFoundError` 表达领域错误，
仍由 Router 转成 404，Service 自己不构造 HTTP 响应。

不包含 Repository、不引入额外抽象层。
"""

from __future__ import annotations

from datetime import date, datetime, timezone

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.folder.models import Folder, folder_fk_violation
from app.journal.models import Journal
from app.journal.schemas import (
    JournalCreate,
    JournalPage,
    JournalResponse,
    JournalUpdate,
)
from app.journal.titles import build_display_title, numbered_subquery

# 固定的每页条数。契约明确不提供客户端自定义 page_size 参数。
PAGE_SIZE = 20


class FolderNotFoundError(LookupError):
    """写入请求指定的 `folder_id` 在 `folders` 表中不存在。

    Service 不构造 HTTP 响应，只表达领域错误；Router 把它转成 404。
    """


def _utcnow() -> datetime:
    """带时区的当前时间，供软删除写入 `deleted_at` 使用。"""
    return datetime.now(timezone.utc)


def _folder_exists(db: Session, folder_id: int) -> bool:
    """判断 Folder 是否存在。

    Folder 目前没有软删除状态，因此用主键查询即可。
    """
    return db.get(Folder, folder_id) is not None


def _projected_statement():
    """带编号的投影查询：`Journal` 实体 + 该日期内无标题序号 `seq`。

    编号由 `numbered_subquery()` 的窗口函数在**完整现存集合**（含已软删除）上计算，
    这里只把结果 `LEFT JOIN` 回来；手工标题的行 JOIN 不到，`seq` 为 NULL。
    """
    numbered = numbered_subquery()
    return (
        select(Journal, numbered.c.seq)
        .outerjoin(numbered, numbered.c.id == Journal.id)
        .where(Journal.deleted_at.is_(None))
    )


def _to_response(journal: Journal, sequence: int | None) -> JournalResponse:
    """把 ORM 行 + 序号投影成完整响应。"""
    return JournalResponse(
        type="journal",
        id=journal.id,
        title=journal.title,
        display_title=build_display_title(
            journal.title, journal.journal_date, sequence
        ),
        content=journal.content,
        journal_date=journal.journal_date,
        folder_id=journal.folder_id,
        created_at=journal.created_at,
        updated_at=journal.updated_at,
        deleted_at=journal.deleted_at,
    )


def _project_required(db: Session, journal_id: int) -> JournalResponse:
    """写操作之后按 id 读回投影；理论上必然存在，取不到视为内部错误。"""
    projected = get_journal(db, journal_id)
    if projected is None:
        # 不可能发生：刚 commit 的有效记录一定读得到。
        # 宁可显式报错，也不要返回 None 让 Router 误报 404。
        raise RuntimeError(f"刚写入的 Journal {journal_id} 无法读回")
    return projected


def create_journal(db: Session, data: JournalCreate) -> JournalResponse:
    """创建一篇 Journal，成功返回已持久化的完整响应。

    四个业务字段来自请求：

    - title：原样保存，可以是 None，数据库不生成默认标题；
    - content、journal_date：必填，已由 JournalCreate 校验；
    - folder_id：可空；**先校验目标 Folder 存在**，不存在则抛 `FolderNotFoundError`
      （Router 转 404），此时还没有任何写入，不会留下半截记录。

    id / created_at / updated_at / display_title / deleted_at 由系统决定，
    这里不赋值，客户端多传这些字段也已被 JournalCreate 忽略。
    """
    if data.folder_id is not None and not _folder_exists(db, data.folder_id):
        raise FolderNotFoundError(f"Folder {data.folder_id} 不存在")

    journal = Journal(
        title=data.title,
        content=data.content,
        journal_date=data.journal_date,
        folder_id=data.folder_id,
    )

    db.add(journal)
    try:
        db.commit()
    except Exception as error:
        # 写入失败必须回滚，否则该 Session 会停留在待回滚状态。
        db.rollback()
        # S2-T07：与 Folder 真空删除竞争时，FK 仲裁失败（引用的 Folder
        # 在校验之后、提交之前被删除）。只转换这种 Folder 引用冲突为 404，
        # 其他数据库故障原样向上抛，不掩盖真实写入问题。
        if folder_fk_violation(error):
            raise FolderNotFoundError(f"Folder {data.folder_id} 不存在") from error
        raise

    # commit 后重新按 id 读回带编号的投影，保证返回的 display_title
    # 与随后 GET 列表 / 详情看到的一致。
    return _project_required(db, journal.id)


def list_journals(
    db: Session,
    journal_date: date | None = None,
    folder_id: int | None = None,
    page: int = 1,
) -> JournalPage:
    """返回分页的 Journal 列表，可选按 journal_date / folder_id 精确筛选。

    排序在数据库里完成，遵守 `docs/stage2-api.md`：

    - 第一排序：`journal_date DESC`（业务日期新的在前）；
    - 第二排序：`created_at DESC`（同一天里后创建的在前）；
    - 第三排序：`id DESC`（时间并列时稳定，避免跨页抖动）。

    筛选、`count`、排序与 `LIMIT/OFFSET` 全部在 SQL 里完成，
    不把全量数据拉到 Python 再切片；每条记录的编号也不是单独查库，
    而是用窗口函数子查询 JOIN 一次算出。

    `total` 是「有效状态 + 全部筛选条件」生效后的总数；
    `has_next` 由全局总数计算，而不是「本页是否满 20 条」。
    超出最后页时返回 200 与空 `items`，并保留请求页码。

    这是只读函数：不 add、不 flush、不 commit，也不修改任何字段。
    """
    statement = _projected_statement()
    count_statement = select(func.count()).select_from(Journal).where(
        Journal.deleted_at.is_(None)
    )

    if journal_date is not None:
        statement = statement.where(Journal.journal_date == journal_date)
        count_statement = count_statement.where(Journal.journal_date == journal_date)

    if folder_id is not None:
        statement = statement.where(Journal.folder_id == folder_id)
        count_statement = count_statement.where(Journal.folder_id == folder_id)

    total = db.scalar(count_statement) or 0

    statement = (
        statement.order_by(
            Journal.journal_date.desc(),
            Journal.created_at.desc(),
            Journal.id.desc(),
        )
        .limit(PAGE_SIZE)
        .offset((page - 1) * PAGE_SIZE)
    )

    rows = db.execute(statement).all()
    items = [_to_response(journal, sequence) for journal, sequence in rows]

    return JournalPage(
        items=items,
        page=page,
        page_size=PAGE_SIZE,
        total=total,
        has_next=page * PAGE_SIZE < total,
    )


def get_journal(db: Session, journal_id: int) -> JournalResponse | None:
    """按主键取一篇**有效** Journal；不存在或已软删除时返回 None。

    与列表使用同一套投影：编号在该日期完整现存集合上计算，
    因此详情与列表对同一条记录给出相同的 `display_title`。

    「是否已删除」的判定放在 SQL 的 `WHERE deleted_at IS NULL` 里，
    不依赖 Session 的 identity map —— 即使 Session 里还缓存着软删除前的对象，
    数据库也不会把这一行返回。

    这是只读函数：不 add、不 flush、不 commit，也不修改任何字段。
    """
    statement = _projected_statement().where(Journal.id == journal_id)
    row = db.execute(statement).one_or_none()
    if row is None:
        return None

    journal, sequence = row
    return _to_response(journal, sequence)


def _get_active_journal(db: Session, journal_id: int) -> Journal | None:
    """按主键取一篇**有效** Journal 的 ORM 对象；不存在或已软删除时返回 None。

    用显式 `SELECT ... WHERE deleted_at IS NULL` 而不是 `Session.get()`：
    后者会先命中 identity map，可能把已软删除（但对象还缓存着）的记录当成有效。
    """
    statement = select(Journal).where(
        Journal.id == journal_id,
        Journal.deleted_at.is_(None),
    )
    return db.scalars(statement).one_or_none()


def update_journal(
    db: Session,
    journal_id: int,
    data: JournalUpdate,
) -> JournalResponse | None:
    """部分更新一篇**有效** Journal；记录不存在或已软删除时返回 None。

    「哪些字段要改」完全由请求的提交状态决定：

    - `data.model_dump(exclude_unset=True)` 只给出本次**实际提交**的字段；
    - 因此省略的字段不会被写回，`title` 显式提交 `null` 时也会被保留为 None
      （这正是不使用 `exclude_none=True` 的原因）；
    - `folder_id` 显式提交 `null` 表示移出 Folder。

    Folder 校验发生在**任何赋值之前**：指定不存在的 Folder 直接抛
    `FolderNotFoundError`（Router 转 404），此时没有任何写入，
    因此不会出现「正文改了、Folder 没移成」的半截更新。

    `updated_at` 复用 Model 现有的 `onupdate`：
    只有真的产生了 UPDATE 才会刷新它，这里不另建时间维护机制。
    提交的字段值与当前值完全相同时，SQLAlchemy 不发 UPDATE，
    因此 `updated_at` 保持原值。

    空更新（验证后没有任何可更新字段）：
    记录存在时直接返回当前投影，不 commit、不 flush。

    写入失败时 rollback 并把异常继续抛给上层，
    不吞异常、不返回伪成功，也不把数据库错误改写成 404。

    本函数不感知 HTTP，因此不导入 FastAPI 的 HTTPException。
    """
    journal = _get_active_journal(db, journal_id)
    if journal is None:
        return None

    changes = data.model_dump(exclude_unset=True)
    if not changes:
        # 空更新：不产生任何写入，updated_at 保持不变。
        return _project_required(db, journal_id)

    target_folder = changes.get("folder_id")
    if "folder_id" in changes and target_folder is not None:
        if not _folder_exists(db, target_folder):
            raise FolderNotFoundError(f"Folder {target_folder} 不存在")

    for field, value in changes.items():
        setattr(journal, field, value)

    try:
        db.commit()
    except Exception as error:
        # 写入失败必须回滚，否则该 Session 会停留在待回滚状态；
        # rollback 后正文、标题、日期、Folder 都回到提交前的值，
        # 不会留下「正文改了、Folder 没移成」的半截更新，
        # 该 Session 也可以继续执行后续合法操作。
        db.rollback()
        # S2-T07：与 Folder 真空删除竞争时，FK 仲裁失败
        # （目标 Folder 在存在性检查之后、提交之前被并发删除）。
        # 只转换这种 Folder 引用冲突为 404，其他数据库故障原样向上抛。
        if folder_fk_violation(error):
            raise FolderNotFoundError(f"Folder {target_folder} 不存在") from error
        raise

    return _project_required(db, journal_id)


def delete_journal(db: Session, journal_id: int) -> bool:
    """**软删除**一篇有效 Journal；成功返回 True，未命中有效记录返回 False。

    Stage 2 / S2-T02 起普通删除进入回收箱（`docs/stage2-api.md` §3）：

    - 只把 `deleted_at` 设为当前时间，**数据库行保留**；
    - `updated_at` 在**同一个 UPDATE** 里显式写回原值
      （`SET updated_at = journals.updated_at`），抵消 Model 的 `onupdate`；
      软删除/恢复不是内容修改，不能刷新 `updated_at`；
    - `WHERE deleted_at IS NULL` 保证：不存在、或已软删除的目标都不会被再次改写，
      重复删除返回 False（Router 转 404）；
    - 删除条件在 SQL 里评估，不依赖 Session identity map。

    失败时 rollback 并把异常继续抛给上层，
    不吞异常、不返回伪成功，也不把数据库错误改写成 404。

    恢复、永久删除与回收箱列表属于 S2-T09，本任务不实现。

    本函数不感知 HTTP，因此不导入 FastAPI 的 HTTPException。
    """
    statement = (
        update(Journal)
        .where(
            Journal.id == journal_id,
            Journal.deleted_at.is_(None),
        )
        .values(
            deleted_at=_utcnow(),
            updated_at=Journal.updated_at,
        )
        # 这条 SQL 不走 ORM 同步：commit 的 expire 会让需要的对象重新读库，
        # 也避免 SQLAlchemy 尝试把表达式值同步回内存对象。
        .execution_options(synchronize_session=False)
    )

    try:
        result = db.execute(statement)
        if result.rowcount == 0:
            # 不存在或已软删除：没有有效目标，也不产生任何写入。
            return False
        db.commit()
    except Exception:
        db.rollback()
        raise

    return True
