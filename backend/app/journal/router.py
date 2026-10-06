"""Journal HTTP 路由。

Stage 1 / Task 4.2：`POST /api/journals`。
Stage 1 / Task 5.1：`GET /api/journals`（可选 `journal_date` 精确筛选）。

Router 只负责：

- 接收请求体与查询参数（Pydantic 负责校验）；
- 通过依赖拿到请求级 Session；
- 调用 Service；
- 返回 HTTP 响应。

Router 不写业务规则，也不直接使用 SQLAlchemy。

单篇详情（`GET /api/journals/{id}`）与 PATCH / DELETE 属于后续 Task，本文件暂不实现。
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.journal import service
from app.journal.models import Journal
from app.journal.schemas import JournalCreate, JournalResponse

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
