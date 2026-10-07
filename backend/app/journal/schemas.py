"""Journal 的 Pydantic Schema。

Stage 1 / Task 4.1 建立 JournalCreate 与 JournalResponse；
Task 6.1 增加 JournalUpdate。

包含创建请求 Schema（JournalCreate）、
修改请求 Schema（JournalUpdate）
与响应 Schema（JournalResponse）。
字段与约束以 `docs/stage1-api.md` 为准：

- 创建请求声明 title / content / journal_date，其中 content 与 journal_date 必填；
- 修改请求只声明可更新的 title / content / journal_date，三者都允许省略；
- 响应完整返回 id / title / content / journal_date / created_at / updated_at。

本模块只依赖 Pydantic 与标准库类型，
不导入 Engine、Session 或 Model。
"""

from __future__ import annotations

from datetime import date, datetime

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


class JournalCreate(BaseModel):
    """创建 Journal 的请求体。

    只声明客户端可以提供的三个字段：

    - title：可省略，可显式传 null / 空字符串，默认 None；最多 80 个 Unicode 码点；
      非空标题原样保存（不 trim）；
    - content：必填；原始字符串最多 50,000 个 Unicode 码点，
      且必须至少包含一个非空白字符（Stage 1.5 / S1.5-T2 新增）；
    - journal_date：必填的 YYYY-MM-DD 日期。

    id / created_at / updated_at 由系统生成，
    因此不在本 Schema 中声明，客户端也无法通过它决定这些字段。

    额外字段沿用 Pydantic 默认的 extra="ignore"：
    请求里多带的字段会被忽略，不会进入验证后的创建数据。

    校验失败会抛 `ValidationError`，由 FastAPI 统一转成标准 422，
    在进入 Router / Service 之前就结束，因此不会产生任何写入。
    """

    title: str | None = None
    content: str
    journal_date: date

    @field_validator("title")
    @classmethod
    def _check_title(cls, value: str | None) -> str | None:
        return _validate_title(value)

    @field_validator("content")
    @classmethod
    def _check_content(cls, value: str) -> str:
        return _validate_content(value)


class JournalUpdate(BaseModel):
    """PATCH Journal 的请求体，只承载「本次提交的字段」。

    三个可更新字段都允许省略：

    - 省略表示「不更新该字段」，**不表示**把该字段赋成 null；
    - title：省略不更新；显式传 null 表示清空标题；
      普通字符串与空字符串原样保留；
    - content：省略不更新；一旦提交必须是字符串，显式传 null 会被拒绝
      —— content 在数据库里是 NOT NULL，「允许省略」不能变成「允许清空」；
    - journal_date：省略不更新；一旦提交必须是合法日期，显式传 null 会被拒绝。

    id / created_at / updated_at 不允许修改，因此不在本 Schema 中声明；
    额外字段沿用 Pydantic 默认的 extra="ignore"，
    客户端提交的系统字段或未知字段都不会进入更新数据。

    更新数据必须用「本次提交了哪些字段」来表达，
    也就是 `model_dump(exclude_unset=True)`（等价于看 `model_fields_set`）：

    - `JournalUpdate()` → `{}`，表示没有任何字段需要更新；
    - `JournalUpdate(title=None)` → `{"title": None}`，表示清空标题。

    **不要用 `exclude_none=True`**：它会连显式提交的 `title=None` 一起丢掉，
    把「清空标题」误判成「不更新标题」。

    本 Schema 不额外禁止空请求 `{}`：
    空更新在 API 层是否产生写操作，由更新 Service 决定，不在这一层规定。

    Stage 1.5 / S1.5-T2 的长度与非空白校验**只作用于本次真正提交的字段**：
    字段被省略时默认值不参与验证，因此不会触发校验——
    这正是「旧记录正文超长 / 空白，但本次只改标题」依然能成功的原因。
    """

    title: str | None = None

    # 这两个字段刻意写成「非 Optional 注解 + None 默认值」：
    # 默认值不参与验证，所以省略字段合法；
    # 但显式提交 null 时仍按注解 str / date 验证，因此会被拒绝。
    # 这比额外加一个 validator 更短，语义由测试逐条固定。
    content: str = None
    journal_date: date = None

    # field_validator 默认只在字段**被提交**时运行（默认值不校验），
    # 因此下面的校验天然满足「省略字段不变、只校验实际提交字段」。
    @field_validator("title")
    @classmethod
    def _check_title(cls, value: str | None) -> str | None:
        return _validate_title(value)

    @field_validator("content")
    @classmethod
    def _check_content(cls, value: str) -> str:
        return _validate_content(value)


class JournalResponse(BaseModel):
    """Journal 的完整响应，六个字段全部返回。

    title 可以为 null；其余字段必须存在。
    本 Schema 不生成 id / created_at / updated_at，
    只负责把已有的数据（含 ORM 对象）读出来。

    from_attributes=True 允许用 model_validate() 直接读取
    ORM 对象的属性。
    """

    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str | None
    content: str
    journal_date: date
    created_at: datetime
    updated_at: datetime
