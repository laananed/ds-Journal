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

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from app.writing.service import (require_revision, WriteConflict, create_hash, verify_create_replay, validate_blocks, writing_changes, cleanup_private_ai)

from app.folder.models import Folder, folder_fk_violation
from app.journal.models import Journal
from app.journal.schemas import JournalDetail
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


def _to_response(journal: Journal, sequence: int | None, *, detail=False) -> JournalResponse:
    """把 ORM 行 + 序号投影成完整响应。"""
    return (JournalDetail if detail else JournalResponse)(
        **({"content_blocks": journal.content_blocks} if detail else {}),
        type="journal",
        id=journal.id,
        revision=journal.revision,
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
    payload_hash = create_hash(data)
    try:
        if data.client_create_id is not None:
            row = db.scalar(select(Journal).where(Journal.client_create_id == data.client_create_id))
            if row is not None:
                verify_create_replay(row, payload_hash)
                if row.deleted_at is not None:
                    raise WriteConflict("creation key belongs to a deleted file")
                response = _project_required(db, row.id)
                response._creation_replayed = True
                return response
        if data.folder_id is not None and not _folder_exists(db, data.folder_id):
            raise FolderNotFoundError(f"Folder {data.folder_id} does not exist")
        content = data.content
        blocks = None
        if "content_blocks" in data.model_fields_set:
            blocks = data.model_dump(mode="json")["content_blocks"]
            content = validate_blocks(blocks)
        row = Journal(title=data.title, content=content, folder_id=data.folder_id, journal_date=data.journal_date, content_blocks=blocks, client_create_id=data.client_create_id,
                      create_payload_hash=payload_hash if data.client_create_id else None)
        db.add(row)
        db.commit()
    except Exception as error:
        db.rollback()
        # PostgreSQL's unique constraint arbitrates concurrent inserts. After
        # rollback read the committed winner, retaining the first payload hash.
        if isinstance(error, IntegrityError) and data.client_create_id is not None:
            row = db.scalar(select(Journal).where(Journal.client_create_id == data.client_create_id))
            if row is not None:
                try:
                    verify_create_replay(row, payload_hash)
                    if row.deleted_at is not None:
                        raise WriteConflict("creation key belongs to a deleted file")
                    response = _project_required(db, row.id)
                    response._creation_replayed = True
                    return response
                except Exception:
                    db.rollback()
                    raise
        if folder_fk_violation(error):
            raise FolderNotFoundError(f"Folder {data.folder_id} does not exist") from error
        raise
    return _project_required(db, row.id)


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

    with db.no_autoflush:
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

    with db.no_autoflush:
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
    with db.no_autoflush:
        row = db.execute(statement.execution_options(populate_existing=True)).one_or_none()
    if row is None:
        return None

    journal, sequence = row
    return _to_response(journal, sequence, detail=True)


def _get_active_journal(db: Session, journal_id: int) -> Journal | None:
    """按主键取一篇**有效** Journal 的 ORM 对象；不存在或已软删除时返回 None。

    用显式 `SELECT ... WHERE deleted_at IS NULL` 而不是 `Session.get()`：
    后者会先命中 identity map，可能把已软删除（但对象还缓存着）的记录当成有效。
    """
    statement = select(Journal).where(
        Journal.id == journal_id,
        Journal.deleted_at.is_(None),
    )
    with db.no_autoflush:
        return db.scalars(statement.execution_options(populate_existing=True)).one_or_none()


def update_journal(db: Session, journal_id: int, data: JournalUpdate) -> JournalResponse | None:
    require_revision(data.expected_revision)
    try:
        row = _get_active_journal(db, journal_id)
        if row is None:
            return None
        changes = writing_changes(row, data)
        if not changes:
            return _project_required(db, journal_id)
        if row.revision != data.expected_revision:
            raise WriteConflict("file revision has changed")
        if "folder_id" in changes and changes["folder_id"] is not None:
            if not _folder_exists(db, changes["folder_id"]):
                raise FolderNotFoundError("Folder does not exist")
        # CAS: every real mutation is conditional in PostgreSQL, never a blind ORM UPDATE.
        result = db.execute(update(Journal).where(Journal.id == journal_id,
            Journal.revision == data.expected_revision, Journal.deleted_at.is_(None))
            .values(**changes, revision=Journal.revision + 1,
                    updated_at=Journal.updated_at if changes.keys() == {"content_blocks"} else _utcnow())
            .execution_options(synchronize_session=False))
        if result.rowcount == 0:
            db.expire_all()
            row = _get_active_journal(db, journal_id)
            if row is None:
                return None
            if not writing_changes(row, data):
                return _project_required(db, journal_id)
            raise WriteConflict("file revision has changed")
        db.commit()
    except Exception as error:
        db.rollback()
        if folder_fk_violation(error):
            raise FolderNotFoundError("Folder does not exist") from error
        raise
    return _project_required(db, journal_id)


def delete_journal(db: Session, journal_id: int, expected_revision: int | None = None) -> bool:
    require_revision(expected_revision)
    try:
        row = _get_active_journal(db, journal_id)
        if row is None:
            return False
        if row.revision != expected_revision:
            raise WriteConflict("file revision has changed")
        result = db.execute(update(Journal).where(Journal.id == journal_id,
            Journal.revision == expected_revision, Journal.deleted_at.is_(None)).values(deleted_at=_utcnow(), revision=Journal.revision + 1, updated_at=Journal.updated_at)
            .execution_options(synchronize_session=False))
        if result.rowcount == 0:
            db.expire_all()
            if _get_active_journal(db, journal_id) is None:
                return False
            raise WriteConflict("file revision has changed")
        db.commit()
    except Exception:
        db.rollback()
        raise
    return True
