"""Folder HTTP 路由（Stage 2 / S2-T07）。

五个端点（`docs/stage2-api.md` 第 6 节）：

- `POST   /api/folders`          201 Folder
- `GET    /api/folders`          200 Folder 数组（id ASC）
- `PATCH  /api/folders/{id}`     200 / 404
- `GET    /api/folders/{id}/files` 200 混合分页 / 404
- `DELETE /api/folders/{id}`     204 空体 / 404 / 409

Router 只负责：接收参数、调用 Service、把领域异常转成 HTTP 状态码。
业务规则与事务边界都在 Service；使用 FastAPI 自带的 HTTPException，
不自定义错误包装或错误码体系。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.folder import service
from app.folder.schemas import (
    FolderCreate,
    FolderFilesPage,
    FolderResponse,
    FolderUpdate,
)

router = APIRouter(prefix="/api/folders", tags=["folders"])

_NOT_FOUND = "Folder not found"
_IN_USE = "Folder is not empty"


@router.post("", response_model=FolderResponse, status_code=status.HTTP_201_CREATED)
def create_folder(
    payload: FolderCreate,
    db: Session = Depends(get_db),
) -> FolderResponse:
    """创建 Folder，返回 201 与 `{id, name}`。

    - name 先 trim 再校验 1～80 个 Unicode 码点，保存 trim 后的名称；
    - 空串、纯空白、null、超长名称由 Schema 拒绝（标准 422）；
    - 名称不要求唯一，重名允许。
    """
    return service.create_folder(db, payload)


@router.get("", response_model=list[FolderResponse], status_code=status.HTTP_200_OK)
def list_folders(db: Session = Depends(get_db)) -> list[FolderResponse]:
    """返回全部 Folder，按 `id ASC`；不是内容文件卡片列表，无强制分页。"""
    return service.list_folders(db)


@router.patch("/{id}", response_model=FolderResponse, status_code=status.HTTP_200_OK)
def update_folder(
    id: int,
    payload: FolderUpdate,
    db: Session = Depends(get_db),
) -> FolderResponse:
    """改名一个 Folder。

    - name 可省略：省略返回原对象，不产生任何写入；
    - 有效空 PATCH（`{}` 或只提交被忽略的额外字段）同样不写库；
    - trim 后与当前名称相同：不做无意义 UPDATE；
    - 显式 `name=null` 非法（标准 422）；
    - 不存在返回 404。
    """
    folder = service.update_folder(db, id, payload)
    if folder is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_NOT_FOUND,
        )
    return folder


@router.get(
    "/{id}/files",
    response_model=FolderFilesPage,
    status_code=status.HTTP_200_OK,
)
def list_folder_files(
    id: int,
    page: int = Query(1, ge=1),
    db: Session = Depends(get_db),
) -> FolderFilesPage:
    """返回一个 Folder 下三类有效文件的混合分页列表。

    - Folder 不存在返回 404；存在但无有效内容返回标准空分页；
    - 三类文件统一排序（`updated_at DESC, 类型 Journal→Inbox→Insight, id DESC`）
      与 LIMIT/OFFSET 作用于整体集合，固定 20 条/页；
    - 对象以 `(type, id)` 区分，三张表相同数字 id 不会去重成一条；
    - Journal 的 display_title 来自完整业务日期编号空间（含其他 Folder
      与仍存在的软删除记录），先编号再筛选分页；
    - `page` 默认 1，非法值由 FastAPI / Pydantic 返回标准 422。
    """
    try:
        return service.list_folder_files(db, id, page=page)
    except service.FolderNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_NOT_FOUND,
        )


@router.delete("/{id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_folder(
    id: int,
    db: Session = Depends(get_db),
) -> Response:
    """真空删除一个 Folder，成功返回 204 与空响应体。

    - 不存在返回 404；
    - 只要仍有任一文件引用（含回收箱中 Journal/Insight 的软删除记录；
      Inbox 为现存行）返回 409；
    - 不级联删除文件，不把引用 SET NULL；
    - 成功时返回显式的空 `Response`，响应体为空字节串。
    """
    try:
        deleted = service.delete_folder(db, id)
    except service.FolderInUseError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=_IN_USE,
        )
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_NOT_FOUND,
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
