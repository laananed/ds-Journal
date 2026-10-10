"""Insight HTTP 路由（Stage 2 / S2-T06）。

- `POST /api/insights`：创建，201 完整 Insight；
- `GET /api/insights`：分页有效列表，可选 `folder_id` / `page`；
- `GET /api/insights/{id}`：有效详情，200 / 404；
- `PATCH /api/insights/{id}`：部分更新，200 / 404；
- `DELETE /api/insights/{id}`：软删除，204 / 404。

Router 只负责：

- 接收请求体、查询参数与路径参数（Pydantic 负责校验）；
- 通过依赖拿到请求级 Session；
- 调用 Service；
- 返回 HTTP 响应。

Router 不写业务规则，也不直接使用 SQLAlchemy。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.writing.router import matched_revision
from app.insight import service
from app.insight.schemas import (
    InsightCreate,
    InsightPage,
    InsightResponse,
    InsightUpdate,
)

router = APIRouter(prefix="/api/insights", tags=["insights"])

_NOT_FOUND = "Insight not found"
_FOLDER_NOT_FOUND = "Folder not found"


@router.post("", response_model=InsightResponse, status_code=status.HTTP_201_CREATED)
def create_insight(
    payload: InsightCreate,
    response: Response,
    db: Session = Depends(get_db),
) -> InsightResponse:
    """创建一条 Insight，返回 201 与创建后的完整记录。

    - `content` 必填；`title` / `folder_id` 可省略 / null；
    - Insight **没有**所属日期，不接收 `journal_date` / `inbox_date` / `is_daily` 等字段；
    - `folder_id` 指定不存在的 Folder 返回 404，且不产生任何写入；
    - 请求体不合法时由 FastAPI / Pydantic 返回 422，不自定义错误格式。
    """
    try:
        result = service.create_insight(db, payload)
        if result._creation_replayed:
            response.status_code = 200
        return result
    except service.FolderNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_FOLDER_NOT_FOUND,
        )


@router.get("", response_model=InsightPage, status_code=status.HTTP_200_OK)
def list_insights(
    folder_id: int | None = None,
    page: int = Query(1, ge=1),
    db: Session = Depends(get_db),
) -> InsightPage:
    """获取分页的**有效** Insight 列表。

    - `folder_id` 可选，为精确筛选；
    - `page` 默认 1，必须是 >=1 的整数，非法值由 FastAPI / Pydantic 返回标准 422；
    - 固定 20 条/页，不提供 `page_size` 或排序参数；
    - 排序 `updated_at DESC, id DESC`，由 Service 的 SQL 完成；
    - 返回 envelope：`items` / `page` / `page_size` / `total` / `has_next`；
      无匹配或超出最后页时 `200` + 空 `items`，并保留请求页码；
    - 已软删除的记录不出现在列表里。
    """
    return service.list_insights(db, folder_id=folder_id, page=page)


@router.get("/{id}", response_model=InsightResponse, status_code=status.HTTP_200_OK)
def get_insight(
    id: int,
    db: Session = Depends(get_db),
) -> InsightResponse:
    """获取单条**有效** Insight，返回 200 与完整记录。

    - 路径参数 `id` 由 FastAPI / Pydantic 解析为整数，非整数返回标准 422；
    - 合法整数但记录不存在、或已软删除时返回 404；
    - 读取不修改任何数据。
    """
    insight = service.get_insight(db, id)
    if insight is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_NOT_FOUND,
        )
    return insight


@router.patch("/{id}", response_model=InsightResponse, status_code=status.HTTP_200_OK)
def update_insight(
    id: int,
    payload: InsightUpdate,
    db: Session = Depends(get_db),
) -> InsightResponse:
    """部分更新一条**有效** Insight，返回 200 与更新后的完整记录。

    - 只更新请求体里**实际提交**的字段：省略的字段保持原值，
      `title` 显式提交 `null` 表示清空标题，`folder_id` 显式提交 `null` 表示移出 Folder；
    - `folder_id` 指定不存在的 Folder 返回 404，且不留下其他字段的半截更新；
    - 空更新（`{}`，或只提交了被忽略的额外 / 系统字段）：
      记录存在时返回 200 与当前记录，不产生写入，也不改变 `updated_at`；
    - 合法整数但记录不存在或已软删除时返回 404；
    - 请求体不合法（例如 `content` 显式 `null`）由 FastAPI / Pydantic 返回标准 422；
    - `id` / `created_at` / `updated_at` / `display_title` / `deleted_at`
      不允许由客户端决定。
    """
    try:
        insight = service.update_insight(db, id, payload)
    except service.FolderNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_FOLDER_NOT_FOUND,
        )
    if insight is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_NOT_FOUND,
        )
    return insight


@router.delete("/{id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_insight(
    id: int,
    expected_revision: int = Depends(matched_revision),
    db: Session = Depends(get_db),
) -> Response:
    """**软删除**一条有效 Insight，成功返回 204 与空响应体。

    - 路径参数 `id` 由 FastAPI / Pydantic 解析为整数，非整数返回标准 422；
    - 合法整数但记录不存在、或**已软删除**时返回 404（重复删除不改原 `deleted_at`）；
    - 成功时返回显式的空 `Response` 与 204：不返回 `null`、`{}`、
      Insight 对象或成功消息，因此 HTTP 响应体是空字节串；
    - 软删除：设置 `deleted_at`，数据库行保留，原 `updated_at` 不变；
      回收箱列表、恢复与永久删除属于 S2-T09。
    """
    if not service.delete_insight(db, id, expected_revision):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_NOT_FOUND,
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
