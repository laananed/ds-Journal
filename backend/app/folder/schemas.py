"""Folder 的 Pydantic Schema（Stage 2 / S2-T07）。

字段与约束以 `docs/stage2-api.md` 第 6 节为准：

- Folder 对象只有 `id: integer, name: string`，不增加时间线或其他字段；
- name 校验：**先 trim，再校验 1～80 个 Unicode 码点，保存 trim 后名称**；
  空串、纯空白、null、超长名称非法；
- 名称不要求唯一：重名允许，页面以 id 操作，数据库不加 UNIQUE
  （Model 与迁移层自 S2-T01 起就是这个约定，本任务不改动）。

trim 使用的空白集合与 Journal/Inbox/Insight 的输入校验是**同一份**
（`app.journal.schemas._WHITESPACE_CODE_POINTS`），保证整个后端对
「什么是空白」的判断一致。

本模块只依赖 Pydantic 与标准库类型，
不导入 Engine、Session 或 Model。
"""

from __future__ import annotations

from typing import Union

from pydantic import BaseModel, field_validator

# 复用三类文件请求校验的同一份空白集合做 trim，
# 以及码点计数口径（len(str) 即码点数）。
from app.insight.schemas import InsightResponse
from app.inbox.schemas import InboxResponse
from app.journal.schemas import (
    TITLE_MAX_CODE_POINTS,
    _WHITESPACE_CODE_POINTS,
    JournalResponse,
)

FOLDER_NAME_MAX_CODE_POINTS = TITLE_MAX_CODE_POINTS


def trim_folder_name(value: str) -> str:
    """按项目统一的空白集合 trim 名称两端。

    只用于 Folder name（契约明确要求 trim）；
    Journal/Inbox/Insight 的 title 不 trim，不要把这个函数用过去。
    """
    start = 0
    end = len(value)
    while start < end and ord(value[start]) in _WHITESPACE_CODE_POINTS:
        start += 1
    while end > start and ord(value[end - 1]) in _WHITESPACE_CODE_POINTS:
        end -= 1
    return value[start:end]


def _validate_folder_name(value: str) -> str:
    """Folder name 校验：先 trim，再检查 1～80 码点，返回 trim 后的值。

    空串、纯空白、超长都在这里拒绝（Router 之前的标准 422）；
    `null` 不进入本函数：Schema 里 name 一旦显式提交就必须是字符串，
    显式提交 null 会被 Pydantic 的类型验证拒绝（标准 422）。
    """
    trimmed = trim_folder_name(value)
    if not trimmed:
        raise ValueError("Folder 名称不能为空，也不能只包含空白字符")
    if len(trimmed) > FOLDER_NAME_MAX_CODE_POINTS:
        raise ValueError(
            f"Folder 名称最多 {FOLDER_NAME_MAX_CODE_POINTS} 个字符（按 Unicode 码点计数）"
        )
    return trimmed


class FolderCreate(BaseModel):
    """创建 Folder 的请求体。

    - name：必填字符串；先 trim，再校验 1～80 个 Unicode 码点，
      **保存 trim 后的名称**；
    - id 由系统生成，不在本 Schema 中声明；
    - 额外/系统字段沿用 Pydantic 默认的 extra="ignore"。

    校验失败由 FastAPI 统一转成标准 422，在进入 Router / Service 之前结束。
    """

    name: str

    @field_validator("name")
    @classmethod
    def _check_name(cls, value: str) -> str:
        return _validate_folder_name(value)


class FolderUpdate(BaseModel):
    """PATCH Folder 的请求体，只承载「本次提交的 name」。

    - name 可省略：省略表示不更新，返回原对象，不产生任何写入；
    - name 刻意写成「非 Optional 注解 + None 默认值」：
      默认值不参与验证，所以省略合法；
      但显式提交 null 时仍按注解 str 验证，因此会被拒绝（标准 422）；
    - 提交的 name 同样先 trim、再校验 1～80 码点，保存 trim 后的值；
    - 「trim 后与当前名称相同则不做无意义 UPDATE」由 Service 判断，
      不在这一层规定。

    id 不允许修改，不在本 Schema 中声明；
    额外字段沿用 extra="ignore"。
    """

    name: str = None  # type: ignore[assignment]

    @field_validator("name")
    @classmethod
    def _check_name(cls, value: str) -> str:
        return _validate_folder_name(value)


class FolderResponse(BaseModel):
    """Folder 的完整响应：只有 `id` 与 `name` 两个字段。

    契约明确不增加 created_at / updated_at / 文件计数等时间线字段。
    """

    id: int
    name: str


# 三类文件的完整响应按 (type, id) 区分；三张表允许相同数字 id，
# 因此这里是真正的 Union，不是任何一种「去重」。
FolderFileItem = Union[JournalResponse, InboxResponse, InsightResponse]


class FolderFilesPage(BaseModel):
    """Folder 混合内容列表的分页 envelope（Stage 2 / S2-T07）。

    与通用列表契约一致：`page_size` 固定 20，不提供客户端自定义参数；
    `total` 是该 Folder 下全部有效文件数（Journal/Insight 排除已软删除，
    Inbox 为现存行）；`has_next` 由全局总数计算。
    `items` 内的对象是三类完整文件响应之一，以 `type` + `id` 区分。
    """

    items: list[FolderFileItem]
    page: int
    page_size: int
    total: int
    has_next: bool
