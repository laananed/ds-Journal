"""Journal 的 Pydantic Schema。

Stage 1 / Task 4.1 建立 JournalCreate 与 JournalResponse；
Task 6.1 增加 JournalUpdate。

Stage 2 / S2-T02 按新契约调整：

- `JournalCreate` / `JournalUpdate` 增加可空 `folder_id`；
- `JournalResponse` 从六字段扩展为完整响应：
  `type` / `id` / `title` / `display_title` / `content` / `journal_date` /
  `folder_id` / `created_at` / `updated_at` / `deleted_at`；
- 新增分页 envelope `JournalPage`。

字段与约束以 `docs/stage2-api.md` 为准：

- 创建请求声明 title / content / journal_date / folder_id，其中 content 与 journal_date 必填；
- 修改请求只声明可更新的 title / content / journal_date / folder_id，四者都允许省略；
- 响应包含完整字段，其中 `display_title` 是**只读投影**，由 Service 计算后填入。

本模块只依赖 Pydantic 与标准库类型，
不导入 Engine、Session 或 Model。
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, field_validator

# --------------------------------------------------------------------------
# Stage 1.5 / S1.5-T2：请求输入校验
#
# 规则来自 `docs/stage1.5-bugfix.md` 第 2 节「Bug 2 / Bug 4」：
#
# - title：可省略 / null / 空字符串，最多 80 个 Unicode 码点；
#   非空标题原样保存（不 trim），纯空白但非空的标题仍算手工标题，不拒绝；
# - content：原始字符串最多 50,000 个 Unicode 码点，且必须至少包含一个非空白字符。
#
# 这些约束**只加在请求 Schema 上**（JournalCreate / JournalUpdate），
# 不加在 JournalResponse 上：否则数据库里的历史超长 / 空白记录会读不出来。
# --------------------------------------------------------------------------

TITLE_MAX_CODE_POINTS = 80
CONTENT_MAX_CODE_POINTS = 50_000

# 空白字符集合：与前端 `frontend/src/utils/contentValidation.ts` 保持**同一份集合**，
# 避免两边对「纯空白正文」的判断不一致。
# 至少覆盖普通空格、Tab、换行、全角空格与 NBSP，另含常见的 Unicode 空白。
_WHITESPACE_CODE_POINTS = frozenset(
    {
        0x0009,  # TAB
        0x000A,  # LINE FEED
        0x000B,  # LINE TABULATION
        0x000C,  # FORM FEED
        0x000D,  # CARRIAGE RETURN
        0x0020,  # SPACE
        0x00A0,  # NO-BREAK SPACE
        0x1680,  # OGHAM SPACE MARK
        0x2028,  # LINE SEPARATOR
        0x2029,  # PARAGRAPH SEPARATOR
        0x202F,  # NARROW NO-BREAK SPACE
        0x205F,  # MEDIUM MATHEMATICAL SPACE
        0x3000,  # IDEOGRAPHIC SPACE（全角空格）
        0xFEFF,  # ZERO WIDTH NO-BREAK SPACE / BOM
        *range(0x2000, 0x200B),  # EN QUAD … HAIR SPACE
    }
)


def _count_code_points(value: str) -> int:
    """按 Unicode 码点计数。

    Python 的 `str` 本身就是码点序列，因此 `len()` 就是码点数：
    非 BMP 字符（如 emoji）只算 1 个，不会被当成 UTF-16 的 2 个 code unit。
    """
    return len(value)


def _is_blank(value: str) -> bool:
    """整串是否只由空白字符组成；空字符串也算空白。"""
    return all(ord(character) in _WHITESPACE_CODE_POINTS for character in value)


def _validate_title(value: str | None) -> str | None:
    """title 校验：允许 `None`；非空字符串按码点计长，不做 trim。"""
    if value is None:
        return value
    if _count_code_points(value) > TITLE_MAX_CODE_POINTS:
        raise ValueError(
            f"标题最多 {TITLE_MAX_CODE_POINTS} 个字符（按 Unicode 码点计数）"
        )
    return value


def _validate_content(value: str) -> str:
    """content 校验：按**原始字符串**计长，且必须含至少一个非空白字符。

    长度先于空白判断：`_is_blank()` 只用于校验，绝不会把结果写回数据库，
    因此 Markdown 缩进、空行与首尾空格都会原样保留。
    """
    if _count_code_points(value) > CONTENT_MAX_CODE_POINTS:
        raise ValueError(
            f"正文最多 {CONTENT_MAX_CODE_POINTS} 个字符（按 Unicode 码点计数）"
        )
    if _is_blank(value):
        raise ValueError("正文不能为空，也不能只包含空白字符")
    return value


from uuid import UUID
from pydantic import PrivateAttr
from app.writing.schemas import Block, Revision, StructuredCreate, StructuredInput


class JournalCreate(StructuredCreate):
    title: str | None = None
    journal_date: date
    folder_id: int | None = None
    client_create_id: UUID | None = None
    _check_title = field_validator("title")(_validate_title)
    _check_content = field_validator("content")(_validate_content)


class JournalUpdate(StructuredInput):
    title: str | None = None
    journal_date: date = None
    folder_id: int | None = None
    expected_revision: Revision = None
    _check_title = field_validator("title")(_validate_title)
    _check_content = field_validator("content")(_validate_content)


class JournalResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    _creation_replayed: bool = PrivateAttr(default=False)
    type: Literal["journal"] = "journal"
    id: int
    revision: Revision
    title: str | None
    display_title: str
    content: str
    journal_date: date
    folder_id: int | None = None
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None = None


class JournalDetail(JournalResponse):
    content_blocks: list[Block] | None = None


class JournalPage(BaseModel):
    items: list[JournalResponse]
    page: int
    page_size: int
    total: int
    has_next: bool
