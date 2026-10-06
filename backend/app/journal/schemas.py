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
    """

    title: str | None = None

    # 这两个字段刻意写成「非 Optional 注解 + None 默认值」：
    # 默认值不参与验证，所以省略字段合法；
    # 但显式提交 null 时仍按注解 str / date 验证，因此会被拒绝。
    # 这比额外加一个 validator 更短，语义由测试逐条固定。
    content: str = None
    journal_date: date = None


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
