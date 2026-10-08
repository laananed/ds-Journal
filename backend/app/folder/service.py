"""Folder 业务操作（Stage 2 / S2-T07）。

实现一级 Folder 的后端契约（`docs/stage2-api.md` 第 6 节）：

- CRUD：创建 201、数组列表（id ASC、不强制分页）、改名（空/相同不写库）、
  真空物理删除（204 空体）；
- 混合内容列表 `GET /api/folders/{id}/files`：三类有效文件**统一**分页，
  排序、LIMIT/OFFSET 全部在数据库对整体集合完成；
- 删除限制：只要还有**任一**文件引用（含 Journal/Insight 已软删除的记录，
  Inbox 为现存行）就返回 409，绝不级联删除、不 SET NULL；
- 并发：删除前先用 `SELECT ... FOR UPDATE` 锁住目标 Folder 行，
  与文件创建/移入竞争时由锁/FK 仲裁，只转换与 Folder 引用有关的数据库异常，
  不掩盖其他真实写入故障。

调用关系：Router → Service → SQLAlchemy → psycopg → PostgreSQL。

Service 负责业务行为与事务边界：
写入成功 commit，失败 rollback 并把异常继续抛给上层；
读取只查、不写。Service 不感知 HTTP，
领域错误用 `FolderNotFoundError` / `FolderInUseError` 表达，
由 Router 转成 404 / 409。

不包含 Repository、不引入额外抽象层。
"""

from __future__ import annotations

from sqlalchemy import Boolean, Date, Integer, func, literal, select, union_all
from sqlalchemy.orm import Session

from app.folder.models import Folder, folder_fk_violation
from app.folder.schemas import (
    FolderCreate,
    FolderFileItem,
    FolderFilesPage,
    FolderResponse,
    FolderUpdate,
)
from app.inbox.models import Inbox
from app.inbox.schemas import InboxResponse
from app.insight.models import Insight
from app.insight.schemas import InsightResponse
from app.insight.service import build_insight_display_title
from app.journal.models import Journal
from app.journal.schemas import JournalResponse
from app.journal.titles import build_display_title, numbered_subquery

# 固定的每页条数。契约明确不提供客户端自定义 page_size 参数。
PAGE_SIZE = 20

# 混合排序里的类型固定顺序：Journal → Inbox → Insight（契约 §6 / §8 一致）。
_TYPE_ORDER_JOURNAL = 1
_TYPE_ORDER_INBOX = 2
_TYPE_ORDER_INSIGHT = 3


class FolderNotFoundError(LookupError):
    """目标 Folder 不存在。

    Service 不构造 HTTP 响应，只表达领域错误；Router 把它转成 404。
    文件 PATCH / POST 指定不存在的 Folder 时，三类文件 Service 抛出
    各自模块内的同名异常；本类供 Folder 自身端点使用。
    """


class FolderInUseError(ValueError):
    """目标 Folder 仍被至少一个文件引用（含回收箱中的软删除记录）。

    Router 把它转成 409。Folder 不是真空的，物理删除被拒绝；
    不级联删除文件，也不把引用 SET NULL。
    """


def _to_response(folder: Folder) -> FolderResponse:
    """把 ORM 行投影成响应。Folder 只有 id / name 两个字段。"""
    return FolderResponse(id=folder.id, name=folder.name)


def create_folder(db: Session, data: FolderCreate) -> FolderResponse:
    """创建 Folder，成功返回已持久化的响应（201 由 Router 声明）。

    name 已由 Schema trim 并校验；重名允许，id 由数据库生成。
    """
    folder = Folder(name=data.name)
    db.add(folder)
    try:
        db.commit()
    except Exception:
        # 写入失败必须回滚，否则该 Session 会停留在待回滚状态。
        db.rollback()
        raise
    db.refresh(folder)
    return _to_response(folder)


def list_folders(db: Session) -> list[FolderResponse]:
    """返回全部 Folder，按 `id ASC` 排序；契约不要求分页。

    这是只读函数：不 add、不 commit、不修改任何字段。
    """
    folders = db.scalars(select(Folder).order_by(Folder.id.asc())).all()
    return [_to_response(folder) for folder in folders]


def update_folder(
    db: Session,
    folder_id: int,
    data: FolderUpdate,
) -> FolderResponse | None:
    """改名一个 Folder；不存在返回 None（Router 转 404）。

    - name 省略：不产生任何 UPDATE，返回当前对象；
    - name 提交且 trim 后与当前名称相同：不做无意义 UPDATE；
    - name 提交且不同：赋值后由 SQLAlchemy 发 UPDATE。
      Folder 没有时间字段，这里也没有额外的时间维护逻辑。
    """
    folder = db.get(Folder, folder_id)
    if folder is None:
        return None

    if "name" not in data.model_fields_set:
        return _to_response(folder)

    new_name = data.name  # Schema 已 trim 并校验。
    if new_name == folder.name:
        return _to_response(folder)

    folder.name = new_name
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.refresh(folder)
    return _to_response(folder)


def delete_folder(db: Session, folder_id: int) -> bool:
    """**真空删除**一个 Folder；成功返回 True，不存在返回 False。

    步骤与并发语义：

    1. `SELECT ... FOR UPDATE` 锁住目标 Folder 行：
       与「文件 PATCH folder_id 指向它」竞争时，对方的 FK 校验
       （FOR KEY SHARE）会与本锁串行化，要么等本事务结束、要么本事务等它；
       不会留下孤儿引用。
    2. 锁住后检查三张文件表的**全部**引用：
       Journal / Insight **不过滤 `deleted_at`**（回收箱中的软删除记录
       同样阻止删除，为将来恢复保留原 Folder 关系）；
       Inbox 检查现存行（Inbox 是硬删除，物理行即引用）。
       任何一个引用存在都抛 `FolderInUseError`（Router 转 409）。
    3. 真正无引用才 `DELETE`。FK 是 NO ACTION，不级联、不 SET NULL；
       若极端竞争下仍收到 Folder FK 冲突（例如引用在检查后、
       删除语句生效前提交），转换为 `FolderInUseError`，不泄漏数据库内部错误。

    失败时 rollback 并把异常继续抛给上层。
    本函数不感知 HTTP，因此不导入 FastAPI 的 HTTPException。
    """
    folder = (
        db.scalars(
            select(Folder).where(Folder.id == folder_id).with_for_update()
        )
        .one_or_none()
    )
    if folder is None:
        return False

    # 引用检查必须在锁之后进行：此时任何并发的移入都已被串行化。
    # Journal / Insight 刻意不加 deleted_at 过滤（含回收箱引用）；
    # Inbox 没有启用的软删除，物理行即引用。
    for model in (Journal, Inbox, Insight):
        referenced = (
            db.scalar(
                select(func.count()).select_from(model).where(
                    model.folder_id == folder_id
                )
            )
            or 0
        )
        if referenced:
            raise FolderInUseError(
                f"Folder {folder_id} 仍有 {referenced} 个文件引用（可能包含回收箱中的记录），不能删除"
            )

    try:
        db.delete(folder)
        db.commit()
    except Exception as error:
        db.rollback()
        if folder_fk_violation(error):
            raise FolderInUseError(
                f"Folder {folder_id} 仍有文件引用（可能包含回收箱中的记录），不能删除"
            ) from error
        raise
    return True


def _mixed_file_statement(folder_id: int):
    """三类有效文件的 UNION ALL 查询，投影成公共列。

    - Journal / Insight：排除 `deleted_at` 非空的记录；
    - Inbox：现存行（deleted_at 列未启用，不参与筛选）；
    - Journal 分支 `LEFT JOIN` 全范围编号子查询（`numbered_subquery()`，
      在该日期完整现存集合上计算、与 Journal 列表/详情同一套投影），
      保证 Folder 内的 display_title 使用的编号空间跨 Folder、含软删除记录；
      编号先算，之后再按 Folder 筛选与分页，不产生「Folder 内重新编号」。
    - `business_date` 对应 Journal 的 journal_date / Inbox 的 inbox_date，
      Insight 为 NULL；`is_daily` 只有 Inbox 有值；`seq` 只有 Journal 有值。
    """
    numbered = numbered_subquery()

    journal_branch = (
        select(
            literal(_TYPE_ORDER_JOURNAL).label("type_order"),
            literal("journal").label("type"),
            Journal.id.label("id"),
            Journal.title.label("title"),
            Journal.content.label("content"),
            Journal.folder_id.label("folder_id"),
            Journal.created_at.label("created_at"),
            Journal.updated_at.label("updated_at"),
            Journal.deleted_at.label("deleted_at"),
            Journal.journal_date.label("business_date"),
            literal(None, type_=Boolean).label("is_daily"),
            numbered.c.seq.label("seq"),
        )
        .outerjoin(numbered, numbered.c.id == Journal.id)
        .where(
            Journal.folder_id == folder_id,
            Journal.deleted_at.is_(None),
        )
    )

    inbox_branch = (
        select(
            literal(_TYPE_ORDER_INBOX).label("type_order"),
            literal("inbox").label("type"),
            Inbox.id.label("id"),
            Inbox.title.label("title"),
            Inbox.content.label("content"),
            Inbox.folder_id.label("folder_id"),
            Inbox.created_at.label("created_at"),
            Inbox.updated_at.label("updated_at"),
            # Inbox 的 deleted_at 列本期未启用；投影常量 NULL 保持列型一致。
            literal(None, type_=Journal.deleted_at.type).label("deleted_at"),
            Inbox.inbox_date.label("business_date"),
            Inbox.is_daily.label("is_daily"),
            literal(None, type_=Integer).label("seq"),
        ).where(Inbox.folder_id == folder_id)
    )

    insight_branch = (
        select(
            literal(_TYPE_ORDER_INSIGHT).label("type_order"),
            literal("insight").label("type"),
            Insight.id.label("id"),
            Insight.title.label("title"),
            Insight.content.label("content"),
            Insight.folder_id.label("folder_id"),
            Insight.created_at.label("created_at"),
            Insight.updated_at.label("updated_at"),
            Insight.deleted_at.label("deleted_at"),
            literal(None, type_=Date).label("business_date"),
            literal(None, type_=Boolean).label("is_daily"),
            literal(None, type_=Integer).label("seq"),
        ).where(
            Insight.folder_id == folder_id,
            Insight.deleted_at.is_(None),
        )
    )

    return union_all(journal_branch, inbox_branch, insight_branch)


def _row_to_response(row) -> FolderFileItem:
    """把 UNION 行投影成对应类型的完整文件响应。

    三类 display_title 全部复用各自模块已验证的投影规则：
    - Journal：`build_display_title(title, date, seq)`，seq 来自全范围窗口函数；
    - Inbox：`title or inbox_date`（与 Inbox Service 的响应投影同一条规则）；
    - Insight：`build_insight_display_title(title)`（空标题回退「未命名 Insight」）。
    """
    if row.type == "journal":
        return JournalResponse(
            type="journal",
            id=row.id,
            title=row.title,
            display_title=build_display_title(
                row.title, row.business_date, row.seq
            ),
            content=row.content,
            journal_date=row.business_date,
            folder_id=row.folder_id,
            created_at=row.created_at,
            updated_at=row.updated_at,
            deleted_at=row.deleted_at,
        )
    if row.type == "inbox":
        return InboxResponse(
            type="inbox",
            id=row.id,
            title=row.title,
            display_title=row.title or row.business_date.isoformat(),
            content=row.content,
            inbox_date=row.business_date,
            is_daily=row.is_daily,
            folder_id=row.folder_id,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )
    return InsightResponse(
        type="insight",
        id=row.id,
        title=row.title,
        display_title=build_insight_display_title(row.title),
        content=row.content,
        folder_id=row.folder_id,
        created_at=row.created_at,
        updated_at=row.updated_at,
        deleted_at=row.deleted_at,
    )


def list_folder_files(
    db: Session,
    folder_id: int,
    page: int = 1,
) -> FolderFilesPage:
    """返回一个 Folder 下三类有效文件的混合分页列表。

    - Folder 不存在抛 `FolderNotFoundError`（Router 转 404）；
      存在但无有效内容返回标准空分页；
    - **混合后的整体集合**上执行排序、count 与 LIMIT/OFFSET：
      不是每种类型各取 20 条再拼接，也不把全部记录读入 Python 再排序分页；
    - 排序 `updated_at DESC, 类型顺序 Journal→Inbox→Insight, id DESC`；
    - `total` 是该 Folder 全部有效文件数；`has_next` 由全局总数计算；
      超出最后页返回 200 与空 items 并保留请求页码。

    这是只读函数：不 add、不 flush、不 commit、不修改任何字段。
    """
    if db.scalar(select(Folder.id).where(Folder.id == folder_id)) is None:
        raise FolderNotFoundError(f"Folder {folder_id} 不存在")

    union_sub = _mixed_file_statement(folder_id).subquery("folder_files")

    total = (
        db.scalar(select(func.count()).select_from(union_sub))
        or 0
    )

    statement = (
        select(union_sub)
        .order_by(
            union_sub.c.updated_at.desc(),
            union_sub.c.type_order.asc(),
            union_sub.c.id.desc(),
        )
        .limit(PAGE_SIZE)
        .offset((page - 1) * PAGE_SIZE)
    )
    rows = db.execute(statement).all()

    return FolderFilesPage(
        items=[_row_to_response(row) for row in rows],
        page=page,
        page_size=PAGE_SIZE,
        total=total,
        has_next=page * PAGE_SIZE < total,
    )
