"""C01 独立测试专用应用（仅测试用，不注册到产品 main.py）。

目的：日程路由当前没有注册到 `app.main`，为了验证路由/服务/数据库行为，
本轮在独立证据目录构造一个只含 schedule 路由的 FastAPI 应用，并复用
产品 `app.main` 中**同一份**异常处理函数，避免复制业务语义。

- 不改动产品代码，也不构成"正式入口已接通"的证据。
- 数据库目标完全由进程环境 DATABASE_URL 决定（测试走私有 search_path schema）。
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError

from app.schedule.router import router as schedule_router
from app.writing.service import WritingError

# 直接复用产品入口里已存在的两个处理器：WritingError → 422/428/409，
# RequestValidationError → 422（不回显提交值）。
from app.main import validation_error_response, writing_error_response

app = FastAPI(title="SeekJournal C01 schedule test app (test-only)")

app.add_exception_handler(WritingError, writing_error_response)
app.add_exception_handler(RequestValidationError, validation_error_response)
app.include_router(schedule_router)


@app.get("/__test_only/ping")
def ping() -> dict[str, str]:
    return {"status": "ok"}
