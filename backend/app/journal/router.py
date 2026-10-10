"""Journal HTTP 路由。

Stage 1 / Task 4.2：`POST /api/journals`。
Stage 1 / Task 5.1：`GET /api/journals`（可选 `journal_date` 精确筛选）。
Stage 1 / Task 5.2：`GET /api/journals/{id}` 单篇详情。
Stage 1 / Task 6.2：`PATCH /api/journals/{id}` 部分更新。
Stage 1 / Task 7.1：`DELETE /api/journals/{id}` 硬删除。

Stage 2 / S2-T02 按新契约调整：

- `GET /api/journals` 返回分页 envelope，可选 `journal_date` / `folder_id` / `page`；
- 全部响应改为完整 Journal（含只读 `display_title`）；
- `PATCH` 增加 `folder_id`；指定不存在 Folder 返回 404；
- `DELETE` 改为软删除，仍返回 204 空体。

Router 只负责：

- 接收请求体、查询参数与路径参数（Pydantic 负责校验）；
- 通过依赖拿到请求级 Session；
- 调用 Service；
- 返回 HTTP 响应。

Router 不写业务规则，也不直接使用 SQLAlchemy。
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.writing.router import matched_revision
from app.journal import service
from app.journal.schemas import JournalDetail
from app.journal.schemas import (
    JournalCreate,
    JournalPage,
    JournalResponse,
    JournalUpdate,
)

router = APIRouter(prefix="/api/journals", tags=["journals"])

_NOT_FOUND = "Journal not found"
_FOLDER_NOT_FOUND = "Folder not found"


@router.post("", response_model=JournalDetail, status_code=status.HTTP_201_CREATED)
def create_journal(
    payload: JournalCreate,
    response: Response,
    db: Session = Depends(get_db),
) -> JournalResponse:
    """创建一篇 Journal，返回 201 与创建后的完整记录。

    - `content` / `journal_date` 必填；`title` / `folder_id` 可省略 / null；
    - `folder_id` 指定不存在的 Folder 返回 404，且不产生任何写入；
    - 请求体不合法时由 FastAPI / Pydantic 返回 422，不自定义错误格式。
    """
    try:
        result = service.create_journal(db, payload)
        if result._creation_replayed:
            response.status_code = 200
        return result
    except service.FolderNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_FOLDER_NOT_FOUND,
        )


@router.get("", response_model=JournalPage, status_code=status.HTTP_200_OK)
def list_journals(
    journal_date: date | None = None,
    folder_id: int | None = None,
    page: int = Query(1, ge=1),
    db: Session = Depends(get_db),
) -> JournalPage:
    """获取分页的**有效** Journal 列表。

    - `journal_date` / `folder_id` 可选，均为精确筛选；
    - `page` 默认 1，必须是 >=1 的整数，非法值由 FastAPI / Pydantic 返回标准 422；
    - 固定 20 条/页，不提供 `page_size` 或排序参数；
    - 排序 `journal_date DESC, created_at DESC, id DESC`，由 Service 的 SQL 完成；
    - 返回 envelope：`items` / `page` / `page_size` / `total` / `has_next`；
      无匹配或超出最后页时 `200` + 空 `items`，并保留请求页码；
    - 已软删除的记录不出现在列表里。
    """
    return service.list_journals(
        db,
        journal_date=journal_date,
        folder_id=folder_id,
        page=page,
    )


@router.get("/{id}", response_model=JournalDetail, status_code=status.HTTP_200_OK)
def get_journal(
    id: int,
    db: Session = Depends(get_db),
) -> JournalResponse:
    """获取单篇**有效** Journal，返回 200 与完整记录。

    - 路径参数 `id` 由 FastAPI / Pydantic 解析为整数，
      非整数（例如 `/api/journals/abc`）返回标准 422；
    - 合法整数但记录不存在、或已软删除时返回 404；
    - `display_title` 与列表使用同一套编号投影；
    - 读取不修改任何数据。

    这里使用 FastAPI 自带的 `HTTPException` 与标准 404 状态码，
    不自定义错误包装、错误码或全局异常体系。
    """
    journal = service.get_journal(db, id)
    if journal is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_NOT_FOUND,
        )
    return journal


@router.patch("/{id}", response_model=JournalDetail, status_code=status.HTTP_200_OK)
def update_journal(
    id: int,
    payload: JournalUpdate,
    db: Session = Depends(get_db),
) -> JournalResponse:
    """部分更新一篇**有效** Journal，返回 200 与更新后的完整记录。

    - 只更新请求体里**实际提交**的字段：省略的字段保持原值，
      `title` 显式提交 `null` 表示清空标题，`folder_id` 显式提交 `null` 表示移出 Folder；
    - `folder_id` 指定不存在的 Folder 返回 404，且不留下其他字段的半截更新；
    - 空更新（`{}`，或只提交了被忽略的额外 / 系统字段）：
      记录存在时返回 200 与当前记录，不产生写入，也不改变 `updated_at`；
    - 合法整数但记录不存在或已软删除时返回 404；
    - 路径参数非整数、请求体不合法（例如 `content` / `journal_date`
      显式 `null`、非法日历日期）由 FastAPI / Pydantic 返回标准 422；
    - `id` / `created_at` / `updated_at` / `display_title` / `deleted_at`
      不允许由客户端决定。

    这里只做「调用 Service + 把 None 转成 404」，
    业务规则与事务边界都在 Service；
    使用 FastAPI 自带的 `HTTPException` 与标准状态码，
    不自定义错误包装、错误码或全局异常体系。
    """
    try:
        journal = service.update_journal(db, id, payload)
    except service.FolderNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_FOLDER_NOT_FOUND,
        )
    if journal is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_NOT_FOUND,
        )
    return journal


@router.delete("/{id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_journal(
    id: int,
    expected_revision: int = Depends(matched_revision),
    db: Session = Depends(get_db),
) -> Response:
    """**软删除**一篇有效 Journal，成功返回 204 与空响应体。

    - 路径参数 `id` 由 FastAPI / Pydantic 解析为整数，
      非整数（例如 `/api/journals/abc`）返回标准 422；
    - 合法整数但记录不存在、或**已软删除**时返回 404（重复删除不改原 `deleted_at`）；
    - 成功时返回显式的空 `Response` 与 204：
      不返回 `null`、`{}`、Journal 对象或成功消息，
      因此 HTTP 响应体是空字节串；
    - Stage 2 起使用软删除：设置 `deleted_at`，数据库行保留，原 `updated_at` 不变；
      恢复与永久删除属于 S2-T09。

    这里只做「调用 Service + 把 False 转成 404」，
    业务规则与事务边界都在 Service；
    使用 FastAPI 自带的 `HTTPException` 与标准状态码，
    不自定义错误包装、错误码或全局异常体系。
    删除成功不设置 `response_model`：204 本来就没有响应体。
    """
    if not service.delete_journal(db, id, expected_revision):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_NOT_FOUND,
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
