"""Journal HTTP 路由。

Stage 1 / Task 4.2：`POST /api/journals`。
Stage 1 / Task 5.1：`GET /api/journals`（可选 `journal_date` 精确筛选）。
Stage 1 / Task 5.2：`GET /api/journals/{id}` 单篇详情。
Stage 1 / Task 6.2：`PATCH /api/journals/{id}` 部分更新。
Stage 1 / Task 7.1：`DELETE /api/journals/{id}` 硬删除。

Router 只负责：

- 接收请求体、查询参数与路径参数（Pydantic 负责校验）；
- 通过依赖拿到请求级 Session；
- 调用 Service；
- 返回 HTTP 响应。

Router 不写业务规则，也不直接使用 SQLAlchemy。
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.journal import service
from app.journal.models import Journal
from app.journal.schemas import JournalCreate, JournalResponse, JournalUpdate

router = APIRouter(prefix="/api/journals", tags=["journals"])


@router.post("", response_model=JournalResponse, status_code=status.HTTP_201_CREATED)
def create_journal(
    payload: JournalCreate,
    db: Session = Depends(get_db),
) -> Journal:
    """创建一篇 Journal，返回 201 与创建后的完整记录。

    请求体不合法时由 FastAPI / Pydantic 返回 422，不自定义错误格式。
    """
    return service.create_journal(db, payload)


@router.get("", response_model=list[JournalResponse], status_code=status.HTTP_200_OK)
def list_journals(
    journal_date: date | None = None,
    db: Session = Depends(get_db),
) -> list[Journal]:
    """获取 Journal 列表，可选按 journal_date 精确筛选。

    - `journal_date` 省略时返回全部 Journal；
    - 提供时按该日期等值筛选（不含相邻日期）；
    - 排序为 `journal_date DESC`、同日 `created_at DESC`，由 Service 的 SQL 完成；
    - 没有记录或没有匹配时返回空数组。

    日期格式不合法时由 FastAPI / Pydantic 返回标准 422。
    """
    return service.list_journals(db, journal_date)


@router.get("/{id}", response_model=JournalResponse, status_code=status.HTTP_200_OK)
def get_journal(
    id: int,
    db: Session = Depends(get_db),
) -> Journal:
    """获取单篇 Journal，返回 200 与完整六字段。

    - 路径参数 `id` 由 FastAPI / Pydantic 解析为整数，
      非整数（例如 `/api/journals/abc`）返回标准 422；
    - 合法整数但记录不存在时返回 404；
    - 读取不修改任何数据。

    这里使用 FastAPI 自带的 `HTTPException` 与标准 404 状态码，
    不自定义错误包装、错误码或全局异常体系。
    """
    journal = service.get_journal(db, id)
    if journal is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Journal not found",
        )
    return journal


@router.patch("/{id}", response_model=JournalResponse, status_code=status.HTTP_200_OK)
def update_journal(
    id: int,
    payload: JournalUpdate,
    db: Session = Depends(get_db),
) -> Journal:
    """部分更新一篇 Journal，返回 200 与更新后的完整六字段。

    - 只更新请求体里**实际提交**的字段：省略的字段保持原值，
      `title` 显式提交 `null` 表示清空标题；
    - 空更新（`{}`，或只提交了被忽略的额外 / 系统字段）：
      记录存在时返回 200 与当前记录，不产生写入，也不改变 `updated_at`；
    - 合法整数但记录不存在时返回 404；
    - 路径参数非整数、请求体不合法（例如 `content` / `journal_date`
      显式 `null`、非法日历日期）由 FastAPI / Pydantic 返回标准 422；
    - `id` / `created_at` / `updated_at` 不允许由客户端决定。

    这里只做「调用 Service + 把 None 转成 404」，
    业务规则与事务边界都在 Service；
    使用 FastAPI 自带的 `HTTPException` 与标准状态码，
    不自定义错误包装、错误码或全局异常体系。
    """
    journal = service.update_journal(db, id, payload)
    if journal is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Journal not found",
        )
    return journal


@router.delete("/{id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_journal(
    id: int,
    db: Session = Depends(get_db),
) -> Response:
    """硬删除一篇 Journal，成功返回 204 与空响应体。

    - 路径参数 `id` 由 FastAPI / Pydantic 解析为整数，
      非整数（例如 `/api/journals/abc`）返回标准 422；
    - 合法整数但记录不存在时返回 404；
    - 成功时返回显式的空 `Response` 与 204：
      不返回 `null`、`{}`、Journal 对象或成功消息，
      因此 HTTP 响应体是空字节串；
    - Stage 1 使用硬删除：记录直接从 PostgreSQL 移除，
      不使用回收箱或软删除。

    这里只做「调用 Service + 把 False 转成 404」，
    业务规则与事务边界都在 Service；
    使用 FastAPI 自带的 `HTTPException` 与标准状态码，
    不自定义错误包装、错误码或全局异常体系。
    删除成功不设置 `response_model`：204 本来就没有响应体。
    """
    if not service.delete_journal(db, id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Journal not found",
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
