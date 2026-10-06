"""Journal 的 Pydantic Schema。

Stage 1 / Task 4.1。

只包含请求 Schema（JournalCreate）与响应 Schema（JournalResponse）。
字段与约束以 `docs/stage1-api.md` 为准：

- 创建请求只声明 title / content / journal_date；
- 响应完整返回 id / title / content / journal_date / created_at / updated_at。

本模块只依赖 Pydantic 与标准库类型，
不导入 Engine、Session 或 Model。
"""

from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, ConfigDict


class JournalCreate(BaseModel):
    """创建 Journal 的请求体。

    只声明客户端可以提供的三个字段：

    - title：可省略，可显式传 null，默认 None；
    - content：必填，允许空字符串（契约没有规定非空限制）；
    - journal_date：必填的 YYYY-MM-DD 日期。

    id / created_at / updated_at 由系统生成，
    因此不在本 Schema 中声明，客户端也无法通过它决定这些字段。

    额外字段沿用 Pydantic 默认的 extra="ignore"：
    请求里多带的字段会被忽略，不会进入验证后的创建数据。
    """

    title: str | None = None
    content: str
    journal_date: date


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
