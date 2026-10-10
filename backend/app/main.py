from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Register all M2 models at runtime so Folder foreign keys resolve.
# S2-T04 adds the Inbox router; S2-T06 adds the Insight router;
# S2-T07 adds the Folder router.
from app.folder import models as _folder_models  # noqa: F401
from app.folder.router import router as folder_router
from app.inbox import models as _inbox_models  # noqa: F401
from app.insight import models as _insight_models  # noqa: F401
from app.journal.router import router as journal_router
from app.inbox.router import router as inbox_router
from app.insight.router import router as insight_router
from app.trash.router import router as trash_router
from app.search.router import router as search_router
from app.link.router import router as link_router

app = FastAPI(title="SeekJournal API")

# 本地开发时，前端由 Vite 在 5173 端口提供，与后端 8000 端口属于不同来源，
# 需要 CORS 才允许浏览器读取响应，并发起写请求。这里只放开本机的两个开发来源：
#
# - 不使用通配来源（`*`），也不使用通配方法；
# - 不开启 credentials（当前不需要携带 Cookie / 凭据）；
# - 允许 GET（列表 / 详情读取）、POST（创建）、PATCH（修改）与 DELETE（删除），
#   覆盖 Stage 1 全部前端用到的 HTTP 方法；
# - 允许 JSON 请求体所需的 `Content-Type` 请求头；
# - 这里只配置浏览器访问策略，不涉及任何业务路由或 Service 行为。
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5173",
        "http://localhost:5173",
    ],
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Content-Type"],
)

app.include_router(journal_router)
app.include_router(inbox_router)
app.include_router(insight_router)
app.include_router(folder_router)
app.include_router(trash_router)
app.include_router(search_router)
app.include_router(link_router)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
