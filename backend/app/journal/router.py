"""Journal HTTP 路由。

Stage 1 / Task 4.2：只实现 `POST /api/journals`。

Router 只负责：

- 接收请求体（Pydantic 负责校验）；
- 通过依赖拿到请求级 Session；
- 调用 Service；
- 返回 HTTP 响应。

Router 不写业务规则，也不直接使用 SQLAlchemy。

其他 CRUD（GET / PATCH / DELETE）属于后续 Task，本文件暂不实现。
"""

from __future__ import annotations

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
