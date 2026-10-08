"""Insight 的 Pydantic Schema（Stage 2 / S2-T06）。

字段与约束以 `docs/stage2-api.md` 第 5 节为准：

- 创建请求声明 title / content / folder_id，其中只有 content 必填；
- 修改请求只声明可更新的 title / content / folder_id，三者都允许省略；
- 响应包含完整字段，其中 `display_title` 是**只读投影**，由 Service 计算后填入。

Insight 是三类文件里字段最少的一种：**没有所属日期**，也没有来源 Journal、
AI 状态、版本历史等字段，因此这里刻意不声明 `journal_date` / `inbox_date` /
`is_daily` / 来源 / AI 字段。

标题请求规则复用 Journal / Inbox 的同一套实现
（`app.journal.schemas` 的 `_validate_title` / `_validate_content`）：

- title 可省略 / null / 空字符串，最多 80 个 Unicode 码点，非空字符串不 trim；
- content 原始字符串最多 50,000 个 Unicode 码点，且至少含一个非空白字符。

这些限制**只加在请求 Schema 上**，不加在 `InsightResponse` 上：
否则数据库里历史超长 / 空白记录会读不出来。

本模块只依赖 Pydantic 与标准库类型，不导入 Engine、Session 或 Model。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, field_validator

# 复用 Journal 的请求校验实现，保持三类文件的输入口径完全一致。
from app.journal.schemas import _validate_content, _validate_title


class InsightCreate(BaseModel):
    """创建 Insight 的请求体。

    - title：可省略 / 可显式传 null / 空字符串，默认 None；最多 80 个 Unicode 码点；
      **没有**任何默认标题回退（Insight 不要求业务日期，不套用 Inbox 的日期标题规则）；
    - content：必填；原始字符串最多 50,000 个 Unicode 码点，且至少含一个非空白字符；
    - folder_id：可省略 / 可显式传 null，默认 None；指定的 Folder 是否存在由 Service
      校验，**不在这一层查库**。

    id / display_title / created_at / updated_at / deleted_at 由系统生成或只读，
    因此不在本 Schema 中声明。

    额外字段沿用 Pydantic 默认的 extra="ignore"：
    请求里多带的字段会被忽略，不会进入验证后的创建数据。
    """

    title: str | None = None
    content: str
    folder_id: int | None = None

    _check_title = field_validator("title")(_validate_title)
    _check_content = field_validator("content")(_validate_content)


class InsightUpdate(BaseModel):
    """PATCH Insight 的请求体，只承载「本次提交的字段」。

    三个可更新字段都允许省略：

    - 省略表示「不更新该字段」，**不表示**把该字段赋成 null；
    - title：省略不更新；显式传 null 表示清空标题；普通字符串与空字符串原样保留；
    - content：省略不更新；一旦提交必须是字符串，显式传 null 会被拒绝
      —— content 在数据库里是 NOT NULL，「允许省略」不能变成「允许清空」；
    - folder_id：省略不更新；显式传 null 表示**移出 Folder**；
      提交整数时由 Service 校验该 Folder 是否存在。

    id / display_title / created_at / updated_at / deleted_at 不允许修改，
    因此不在本 Schema 中声明；额外字段沿用 extra="ignore"。

    更新数据必须用「本次提交了哪些字段」来表达，
    也就是 `model_dump(exclude_unset=True)`（等价于看 `model_fields_set`）：

    - `InsightUpdate()` → `{}`，表示没有任何字段需要更新；
    - `InsightUpdate(title=None)` → `{"title": None}`，表示清空标题；
    - `InsightUpdate(folder_id=None)` → `{"folder_id": None}`，表示移出 Folder。

    **不要用 `exclude_none=True`**：它会连显式提交的 `title=None` / `folder_id=None`
    一起丢掉，把「清空标题 / 移出 Folder」误判成「不更新」。

    长度与非空白校验只作用于本次真正提交的字段：
    字段被省略时默认值不参与验证，因此旧记录即使正文超长 / 空白，
    只要本次不提交正文，就仍能只改标题或 Folder。
    """

    title: str | None = None

    # 刻意写成「非 Optional 注解 + None 默认值」：
    # 默认值不参与验证，所以省略字段合法；
    # 但显式提交 null 时仍按注解 str 验证，因此会被拒绝。
    content: str = None

    # folder_id 用普通可选字段：显式 null 是有意义的（移出 Folder），
    # 不能写成「非 Optional 注解 + None 默认值」。
    folder_id: int | None = None

    # field_validator 默认只在字段**被提交**时运行（默认值不校验），
    # 因此下面的校验天然满足「省略字段不变、只校验实际提交字段」。
    _check_title = field_validator("title")(_validate_title)
    _check_content = field_validator("content")(_validate_content)


class InsightResponse(BaseModel):
    """Insight 的完整响应。

    - `type`：固定 `"insight"`，只读，用于跨类型列表区分文件种类；
    - `id` / `created_at` / `updated_at` / `deleted_at`：系统字段，只读；
    - `title`：数据库里的**原始标题**，可为 null，不含自动生成值；
    - `display_title`：**只读显示标题投影**，由 Service 计算后填入
      （空标题回退「未命名 Insight」），不写入数据库、不新增字段；
    - `content` / `folder_id`：业务字段；
    - 普通响应的 `deleted_at` 恒为 `null`（已软删除记录不出现在普通入口）。

    **本 Schema 不套用请求的长度 / 非空限制**：
    数据库里的历史超长标题、超长或空白正文必须仍然读得出来。

    from_attributes=True 允许用 model_validate() 读取带有同名属性的对象；
    但 `type` 与 `display_title` 不是 ORM 属性，由 Service 显式构造。
    """

    model_config = ConfigDict(from_attributes=True)

    type: Literal["insight"] = "insight"
    id: int
    title: str | None
    display_title: str
    content: str
    folder_id: int | None = None
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None = None


class InsightPage(BaseModel):
    """Insight 列表的分页 envelope。

    与其他文件一致：`page_size` 固定 20，`total` 是「有效状态 + 筛选条件」后的总数，
    `has_next` 由全局总数计算（`page * page_size < total`）。
    """

    items: list[InsightResponse]
    page: int
    page_size: int
    total: int
    has_next: bool
