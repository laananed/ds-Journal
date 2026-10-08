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

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.folder.models import Folder
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
    return db.scalars(statement).one_or_none()


def create_insight(db: Session, data: InsightCreate) -> InsightResponse:
    """创建一条 Insight，成功返回已持久化的完整响应。

    - title：原样保存，可以是 None；**没有**默认日期标题；
    - content：必填，已由 InsightCreate 校验；
    - folder_id：可空；**先校验目标 Folder 存在**，不存在则抛 `FolderNotFoundError`
      （Router 转 404），此时还没有任何写入，不会留下半截记录。

    id / created_at / updated_at / display_title / deleted_at 由系统决定，
    这里不赋值，客户端多传这些字段也已被 InsightCreate 忽略。
    """
    if data.folder_id is not None and not _folder_exists(db, data.folder_id):
        raise FolderNotFoundError(f"Folder {data.folder_id} 不存在")

    insight = Insight(
        title=data.title,
        content=data.content,
        folder_id=data.folder_id,
    )

    db.add(insight)
    try:
        db.commit()
    except Exception:
        # 写入失败必须回滚，否则该 Session 会停留在待回滚状态。
        db.rollback()
        raise

    return _project_required(db, insight.id)


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


def update_insight(
    db: Session,
    insight_id: int,
    data: InsightUpdate,
) -> InsightResponse | None:
    """部分更新一条**有效** Insight；记录不存在或已软删除时返回 None。

    「哪些字段要改」完全由请求的提交状态决定：

    - `data.model_dump(exclude_unset=True)` 只给出本次**实际提交**的字段；
    - 因此省略的字段不会被写回，`title` 显式提交 `null` 时也会被保留为 None
      （这正是不使用 `exclude_none=True` 的原因）；
    - `folder_id` 显式提交 `null` 表示移出 Folder。

    Folder 校验发生在**任何赋值之前**：指定不存在的 Folder 直接抛
    `FolderNotFoundError`（Router 转 404），此时没有任何写入，
    因此不会出现「正文改了、Folder 没移成」的半截更新。

    `updated_at` 复用 Model 现有的 `onupdate`：
    只有真的产生了 UPDATE 才会刷新它。提交的字段值与当前值完全相同时，
    SQLAlchemy 不发 UPDATE，因此 `updated_at` 保持原值。

    空更新（验证后没有任何可更新字段）：记录存在时直接返回当前投影，
    不 commit、不 flush。

    写入失败时 rollback 并把异常继续抛给上层，
    不吞异常、不返回伪成功，也不把数据库错误改写成 404。
    """
    insight = _get_active_insight(db, insight_id)
    if insight is None:
        return None

    changes = data.model_dump(exclude_unset=True)
    if not changes:
        # 空更新：不产生任何写入，updated_at 保持不变。
        return _to_response(insight)

    target_folder = changes.get("folder_id")
    if "folder_id" in changes and target_folder is not None:
        if not _folder_exists(db, target_folder):
            raise FolderNotFoundError(f"Folder {target_folder} 不存在")

    for field, value in changes.items():
        setattr(insight, field, value)

    try:
        db.commit()
    except Exception:
        # 写入失败必须回滚，否则该 Session 会停留在待回滚状态。
        db.rollback()
        raise

    return _project_required(db, insight_id)


def delete_insight(db: Session, insight_id: int) -> bool:
    """**软删除**一条有效 Insight；成功返回 True，未命中有效记录返回 False。

    删除进入回收箱（`docs/stage2-api.md` §5）：

    - 只把 `deleted_at` 设为当前时间，**数据库行保留**；
    - `updated_at` 在**同一个 UPDATE** 里显式写回原值
      （`SET updated_at = insights.updated_at`），抵消 Model 的 `onupdate`；
      软删除不是内容修改，不能刷新 `updated_at`；
    - `WHERE deleted_at IS NULL` 保证：不存在、或已软删除的目标都不会被再次改写，
      重复删除返回 False（Router 转 404）；
    - 删除条件在 SQL 里评估，不依赖 Session identity map。

    失败时 rollback 并把异常继续抛给上层。

    回收箱列表、恢复与永久删除属于 S2-T09，本任务不实现。

    本函数不感知 HTTP，因此不导入 FastAPI 的 HTTPException。
    """
    statement = (
        update(Insight)
        .where(
            Insight.id == insight_id,
            Insight.deleted_at.is_(None),
        )
        .values(
            deleted_at=_utcnow(),
            updated_at=Insight.updated_at,
        )
        # 这条 SQL 不走 ORM 同步：避免 SQLAlchemy 把表达式值同步回内存对象。
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
