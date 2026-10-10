"""Insight 业务操作（Stage 2 / S2-T06）。

实现用户手动管理 Insight 的完整小闭环：

- 创建 / 列表（分页）/ 详情 / 部分更新 / 软删除；
- 没有所属日期，也没有来源 Journal、AI 状态、版本历史等字段。

契约要点（`docs/stage2-api.md` §5）：

- PATCH 只允许业务字段 `title` / `content` / `folder_id` 更新；
- 列表只返回 `deleted_at IS NULL` 的有效记录，排序 `updated_at DESC, id DESC`，固定 20 条/页；
- 普通删除为**软删除**：设置 `deleted_at`，并在同一个 UPDATE 里**显式保留原 `updated_at`**；
- 普通入口（列表 / 详情 / PATCH / DELETE）一律排除已软删除记录；
- 空 / 相同值 PATCH 返回原对象且不改变 `updated_at`。

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

from datetime import datetime, timezone

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from app.writing.service import (require_revision, WriteConflict, create_hash, verify_create_replay, validate_blocks, writing_changes, cleanup_private_ai)

from app.folder.models import Folder, folder_fk_violation
from app.insight.models import Insight
from app.insight.schemas import (
    InsightCreate,
    InsightPage,
    InsightResponse,
    InsightUpdate,
)

# 复用 Journal 的「无标题」判定：None 与空字符串都算无标题，纯空白非空字符串不算。
from app.journal.titles import is_untitled

# 固定的每页条数。契约明确不提供客户端自定义 page_size 参数。
PAGE_SIZE = 20

# 空标题的展示回退文案（只读投影，**不写入** `title`）。
UNTITLED_INSIGHT_DISPLAY = "未命名 Insight"


class FolderNotFoundError(LookupError):
    """写入请求指定的 `folder_id` 在 `folders` 表中不存在。

    Service 不构造 HTTP 响应，只表达领域错误；Router 把它转成 404。
    """


def _utcnow() -> datetime:
    """带时区的当前时间，供软删除写入 `deleted_at` 使用。"""
    return datetime.now(timezone.utc)


def _folder_exists(db: Session, folder_id: int) -> bool:
    """判断 Folder 是否存在。Folder 没有软删除状态，用主键查询即可。"""
    return db.get(Folder, folder_id) is not None


def build_insight_display_title(title: str | None) -> str:
    """把原始 `title` 投影成 `display_title`。

    - 无标题（`None` 或 `""`）→ `"未命名 Insight"`；
    - 其余（含纯空白非空字符串）→ 原样返回，不 trim。

    这只是读取投影：回退文案不会写回数据库的 `title`。
    """
    if is_untitled(title):
        return UNTITLED_INSIGHT_DISPLAY
    # is_untitled 为假已保证 title 不是 None。
    return title  # type: ignore[return-value]


def _to_response(insight: Insight) -> InsightResponse:
    """把 ORM 行投影成完整响应。"""
    return InsightResponse(
        type="insight",
        id=insight.id,
        revision=insight.revision,
        title=insight.title,
        display_title=build_insight_display_title(insight.title),
        content=insight.content,
        folder_id=insight.folder_id,
        created_at=insight.created_at,
        updated_at=insight.updated_at,
        deleted_at=insight.deleted_at,
    )


def _project_required(db: Session, insight_id: int) -> InsightResponse:
    """写操作之后按 id 读回投影；理论上必然存在，取不到视为内部错误。"""
    projected = get_insight(db, insight_id)
    if projected is None:
        # 不可能发生：刚 commit 的有效记录一定读得到。
        # 宁可显式报错，也不要返回 None 让 Router 误报 404。
        raise RuntimeError(f"刚写入的 Insight {insight_id} 无法读回")
    return projected


def _get_active_insight(db: Session, insight_id: int) -> Insight | None:
    """按主键取一条**有效** Insight 的 ORM 对象；不存在或已软删除时返回 None。

    用显式 `SELECT ... WHERE deleted_at IS NULL` 而不是 `Session.get()`：
    后者会先命中 identity map，可能把已软删除（但对象还缓存着）的记录当成有效。
    """
    statement = select(Insight).where(
        Insight.id == insight_id,
        Insight.deleted_at.is_(None),
    )
    with db.no_autoflush:
        return db.scalars(statement.execution_options(populate_existing=True)).one_or_none()


def create_insight(db: Session, data: InsightCreate) -> InsightResponse:
    payload_hash = create_hash(data)
    try:
        if data.client_create_id is not None:
            row = db.scalar(select(Insight).where(Insight.client_create_id == data.client_create_id))
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
        row = Insight(title=data.title, content=content, folder_id=data.folder_id, client_create_id=data.client_create_id,
                      create_payload_hash=payload_hash if data.client_create_id else None)
        db.add(row)
        db.commit()
    except Exception as error:
        db.rollback()
        # PostgreSQL's unique constraint arbitrates concurrent inserts. After
        # rollback read the committed winner, retaining the first payload hash.
        if isinstance(error, IntegrityError) and data.client_create_id is not None:
            row = db.scalar(select(Insight).where(Insight.client_create_id == data.client_create_id))
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


def list_insights(
    db: Session,
    folder_id: int | None = None,
    page: int = 1,
) -> InsightPage:
    """返回分页的**有效** Insight 列表，可选按 `folder_id` 精确筛选。

    排序在数据库里完成，遵守 `docs/stage2-api.md`：

    - 第一排序：`updated_at DESC`（最近修改的在前）；
    - 第二排序：`id DESC`（时间并列时稳定，避免跨页抖动）。

    筛选、`count`、排序与 `LIMIT/OFFSET` 全部在 SQL 里完成，
    不把全量数据拉到 Python 再切片。

    `total` 是「有效状态 + 筛选条件」生效后的总数；
    `has_next` 由全局总数计算，而不是「本页是否满 20 条」。
    超出最后页时返回 200 与空 `items`，并保留请求页码。

    这是只读函数：不 add、不 flush、不 commit，也不修改任何字段。
    """
    conditions = [Insight.deleted_at.is_(None)]
    if folder_id is not None:
        conditions.append(Insight.folder_id == folder_id)

    with db.no_autoflush:
        total = db.scalar(
            select(func.count()).select_from(Insight).where(*conditions)
        ) or 0

    statement = (
        select(Insight)
        .where(*conditions)
        .order_by(Insight.updated_at.desc(), Insight.id.desc())
        .limit(PAGE_SIZE)
        .offset((page - 1) * PAGE_SIZE)
    )
    with db.no_autoflush:
        rows = db.scalars(statement).all()

    return InsightPage(
        items=[_to_response(row) for row in rows],
        page=page,
        page_size=PAGE_SIZE,
        total=total,
        has_next=page * PAGE_SIZE < total,
    )


def get_insight(db: Session, insight_id: int) -> InsightResponse | None:
    """按主键取一条**有效** Insight；不存在或已软删除时返回 None。

    「是否已删除」的判定放在 SQL 的 `WHERE deleted_at IS NULL` 里，
    不依赖 Session 的 identity map —— 即使 Session 里还缓存着软删除前的对象，
    数据库也不会把这一行返回。

    这是只读函数：不 add、不 flush、不 commit，也不修改任何字段。
    """
    insight = _get_active_insight(db, insight_id)
    if insight is None:
        return None
    return _to_response(insight)


def update_insight(db: Session, insight_id: int, data: InsightUpdate) -> InsightResponse | None:
    require_revision(data.expected_revision)
    try:
        row = _get_active_insight(db, insight_id)
        if row is None:
            return None
        changes = writing_changes(row, data)
        if not changes:
            return _project_required(db, insight_id)
        if row.revision != data.expected_revision:
            raise WriteConflict("file revision has changed")
        if "folder_id" in changes and changes["folder_id"] is not None:
            if not _folder_exists(db, changes["folder_id"]):
                raise FolderNotFoundError("Folder does not exist")
        # CAS: every real mutation is conditional in PostgreSQL, never a blind ORM UPDATE.
        result = db.execute(update(Insight).where(Insight.id == insight_id,
            Insight.revision == data.expected_revision, Insight.deleted_at.is_(None))
            .values(**changes, revision=Insight.revision + 1,
                    updated_at=Insight.updated_at if changes.keys() == {"content_blocks"} else _utcnow())
            .execution_options(synchronize_session=False))
        if result.rowcount == 0:
            db.expire_all()
            row = _get_active_insight(db, insight_id)
            if row is None:
                return None
            if not writing_changes(row, data):
                return _project_required(db, insight_id)
            raise WriteConflict("file revision has changed")
        db.commit()
    except Exception as error:
        db.rollback()
        if folder_fk_violation(error):
            raise FolderNotFoundError("Folder does not exist") from error
        raise
    return _project_required(db, insight_id)


def delete_insight(db: Session, insight_id: int, expected_revision: int | None = None) -> bool:
    require_revision(expected_revision)
    try:
        row = _get_active_insight(db, insight_id)
        if row is None:
            return False
        if row.revision != expected_revision:
            raise WriteConflict("file revision has changed")
        result = db.execute(update(Insight).where(Insight.id == insight_id,
            Insight.revision == expected_revision, Insight.deleted_at.is_(None)).values(deleted_at=_utcnow(), revision=Insight.revision + 1, updated_at=Insight.updated_at)
            .execution_options(synchronize_session=False))
        if result.rowcount == 0:
            db.expire_all()
            if _get_active_insight(db, insight_id) is None:
                return False
            raise WriteConflict("file revision has changed")
        db.commit()
    except Exception:
        db.rollback()
        raise
    return True
