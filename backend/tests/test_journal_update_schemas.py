"""JournalUpdate 的最小 Schema 测试。

Stage 1 / Task 6.1。

只使用内存数据：

- 不导入 Model、Engine、Session；
- 不创建数据库连接；
- 不 flush / commit；
- 不执行任何 SQL。

`pytest` 会加载同目录的 `conftest.py`，其中确实导入 `app.database` 并创建了
Engine 对象，但 `create_engine` 是惰性的，不会真的连接数据库；
本文件也不请求 `api` fixture。

本文件固定的核心语义是「省略」与「显式 null」的区别：

- 省略字段 → 不进入更新数据；
- 显式 `title=null` → 进入更新数据，表示清空标题；
- 显式 `content=null` / `journal_date=null` → 被拒绝。

更新数据统一用 `model_dump(exclude_unset=True)` 表达。
断言只验证字段行为与字段值，不绑定 ValidationError 的具体文案。
"""

from __future__ import annotations

from datetime import date

import pytest
from pydantic import ValidationError

from app.journal.schemas import JournalCreate, JournalResponse, JournalUpdate

DAY = date(2026, 10, 2)
# Stage 2 / S2-T02：可更新字段增加 folder_id。
UPDATE_FIELDS = {"title", "content", "journal_date", "folder_id", "expected_revision", "content_blocks"}
CREATE_FIELDS = {"title", "content", "journal_date", "folder_id", "client_create_id", "content_blocks"}
RESPONSE_FIELDS = {
    "type",
    "id",
    "title",
    "display_title",
    "content",
    "journal_date",
    "folder_id",
    "created_at",
    "updated_at",
    "deleted_at",
"revision"}
SYSTEM_FIELDS = {
    "id": 999,
    "created_at": "2020-01-01T00:00:00Z",
    "updated_at": "2020-01-01T00:00:00Z",
}


def _update(**payload) -> dict:
    """构造 JournalUpdate，并返回「本次提交的字段」这份更新数据。

    刻意走 `exclude_unset=True`：这就是 Task 6.2 构造更新数据的方式。
    """
    update = JournalUpdate(**payload)
    return update.model_dump(exclude_unset=True)


# --------------------------------------------------------------------------
# 字段组成：只有三个可更新字段
# --------------------------------------------------------------------------


def test_update_declares_exactly_the_editable_fields():
    assert set(JournalUpdate.model_fields) == UPDATE_FIELDS


@pytest.mark.parametrize("name", sorted(SYSTEM_FIELDS))
def test_update_does_not_declare_system_fields(name):
    assert name not in JournalUpdate.model_fields


def test_existing_schemas_are_unchanged_by_adding_update():
    """本次只在 schemas.py 里新增 JournalUpdate，另外两个 Schema 的字段不变。"""
    assert set(JournalCreate.model_fields) == CREATE_FIELDS
    assert set(JournalResponse.model_fields) == RESPONSE_FIELDS


def test_schemas_module_does_not_hold_database_objects():
    """Schema 层不依赖数据库层：模块命名空间里不应出现 Session / Engine 之类的对象。"""
    import app.journal.schemas as schemas_module

    for name in ("Session", "sessionmaker", "SessionLocal", "engine", "Base"):
        assert not hasattr(schemas_module, name)


# --------------------------------------------------------------------------
# 省略语义
# --------------------------------------------------------------------------


def test_all_fields_can_be_omitted():
    update = JournalUpdate()

    assert update.model_fields_set == set()
    assert update.title is None
    assert update.content is None
    assert update.journal_date is None
    assert update.folder_id is None


def test_empty_request_produces_empty_update_data():
    assert _update() == {}


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"title": "新的标题"}, {"title": "新的标题"}),
        ({"content": "新的正文"}, {"content": "新的正文"}),
        ({"journal_date": "2026-10-01"}, {"journal_date": date(2026, 10, 1)}),
    ],
)
def test_single_field_update_carries_only_that_field(payload, expected):
    update = JournalUpdate(**payload)

    assert update.model_fields_set == set(payload)
    assert update.model_dump(exclude_unset=True) == expected


def test_multiple_fields_submitted_together():
    update = JournalUpdate(
        title="新的标题",
        content="新的内容",
        journal_date="2026-10-01",
        folder_id=7,
    )

    assert update.model_fields_set == UPDATE_FIELDS - {"expected_revision", "content_blocks"}
    assert update.model_dump(exclude_unset=True) == {
        "title": "新的标题",
        "content": "新的内容",
        "journal_date": date(2026, 10, 1),
        "folder_id": 7,
    }


def test_omitted_fields_are_not_carried_by_exclude_unset():
    """省略的字段仍是默认值，但不会被当成「本次更新值」。"""
    update = JournalUpdate(content="新的正文")
    data = update.model_dump(exclude_unset=True)

    # 普通 model_dump() 会把默认值也带出来，这正是不能直接用它当更新数据的原因。
    assert update.model_dump() == {
        "title": None,
        "content": "新的正文",
        "journal_date": None,
        "folder_id": None,
        "expected_revision": None,
        "content_blocks": None,
    }

    assert data == {"content": "新的正文"}
    assert "title" not in data
    assert "journal_date" not in data
    assert "folder_id" not in data


# --------------------------------------------------------------------------
# title：省略 vs 显式 null vs 字符串
# --------------------------------------------------------------------------


def test_title_omitted_and_title_null_are_different():
    omitted = JournalUpdate()
    explicit_null = JournalUpdate(title=None)

    assert "title" not in omitted.model_fields_set
    assert "title" in explicit_null.model_fields_set

    assert omitted.model_dump(exclude_unset=True) == {}
    assert explicit_null.model_dump(exclude_unset=True) == {"title": None}


@pytest.mark.parametrize("title", ["", "广州动物园复盘", "多行\n标题"])
def test_title_string_is_kept_as_is(title):
    assert _update(title=title) == {"title": title}


# Stage 1.5 / S1.5-T2：PATCH 只校验**本次提交**的字段。
# title 省略时不触发长度校验；提交时最多 80 个 Unicode 码点。


@pytest.mark.parametrize("title", ["", None, "标" * 80])
def test_title_within_limit_is_accepted(title):
    assert _update(title=title) == {"title": title}


def test_title_over_eighty_code_points_is_rejected():
    with pytest.raises(ValidationError):
        JournalUpdate(title="标" * 81)


def test_title_length_counts_non_bmp_emoji_by_code_point():
    assert _update(title="🧭" * 80) == {"title": "🧭" * 80}

    with pytest.raises(ValidationError):
        JournalUpdate(title="🧭" * 81)


@pytest.mark.parametrize("title", ["  手工标题  ", "   ", "\u3000"])
def test_whitespace_title_is_kept_and_never_trimmed(title):
    assert _update(title=title) == {"title": title}


def test_omitted_title_is_not_validated():
    """只提交 content 时，title 完全没有进入校验路径。"""
    update = JournalUpdate(content="只改正文")

    assert update.model_fields_set == {"content"}
    assert update.model_dump(exclude_unset=True) == {"content": "只改正文"}


def test_explicit_title_null_is_not_dropped_by_exclude_unset():
    update = JournalUpdate(title=None)

    assert update.model_fields_set == {"title"}
    assert update.model_dump(exclude_unset=True) == {"title": None}

    # exclude_none=True 会把显式 null 一起丢掉，因此本阶段不使用它。
    assert update.model_dump(exclude_none=True) == {}


# --------------------------------------------------------------------------
# content：可省略，非空且不超过 50,000 码点，不可 null
#
# Stage 1.5 / S1.5-T2 收紧后，「空字符串合法」不再成立。
# --------------------------------------------------------------------------


@pytest.mark.parametrize("content", ["新的正文", "多行\n正文", "  缩进\n\n结尾  "])
def test_content_accepts_non_blank_text(content):
    assert _update(content=content) == {"content": content}


@pytest.mark.parametrize(
    "content",
    ["", " ", "\t", "\n", "\r\n", " \t\n", "\u3000", "\xa0"],
)
def test_blank_content_is_rejected(content):
    with pytest.raises(ValidationError):
        JournalUpdate(content=content)


def test_content_can_be_omitted():
    assert "content" not in JournalUpdate().model_fields_set


def test_omitted_content_is_not_validated():
    """省略 content 时不触发非空 / 长度校验（PATCH 只校验本次提交的字段）。"""
    update = JournalUpdate(title="只改标题")

    assert update.model_fields_set == {"title"}
    assert update.model_dump(exclude_unset=True) == {"title": "只改标题"}


def test_content_null_is_rejected():
    with pytest.raises(ValidationError):
        JournalUpdate(content=None)


@pytest.mark.parametrize("length", [1, 50_000])
def test_content_within_code_point_limit_is_accepted(length):
    assert _update(content="a" * length) == {"content": "a" * length}


def test_content_over_code_point_limit_is_rejected():
    with pytest.raises(ValidationError):
        JournalUpdate(content="a" * 50_001)


def test_content_length_counts_raw_string_not_trimmed():
    with pytest.raises(ValidationError):
        JournalUpdate(content=" " * 50_000 + "x")


# --------------------------------------------------------------------------
# journal_date：可省略，接受当前解析器认可的日期，不可 null
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("2026-10-02", date(2026, 10, 2)),
        ("2024-02-29", date(2024, 2, 29)),  # 有效闰日
        (date(2026, 10, 2), date(2026, 10, 2)),
    ],
)
def test_valid_journal_date_is_accepted(raw, expected):
    data = _update(journal_date=raw)

    assert data == {"journal_date": expected}
    assert isinstance(data["journal_date"], date)


@pytest.mark.parametrize(
    "raw",
    [
        "2026-02-30",  # 2 月没有 30 号
        "2026-02-29",  # 2026 不是闰年
        "2026-13-01",  # 没有 13 月
        "2026/10/02",
        "02-10-2026",
        "not-a-date",
        "",
    ],
)
def test_invalid_journal_date_is_rejected(raw):
    with pytest.raises(ValidationError):
        JournalUpdate(journal_date=raw)


def test_journal_date_can_be_omitted():
    assert "journal_date" not in JournalUpdate().model_fields_set


def test_journal_date_null_is_rejected():
    with pytest.raises(ValidationError):
        JournalUpdate(journal_date=None)


def test_datetime_like_string_keeps_journal_create_boundary():
    """延续 JournalCreate 的日期解析边界，不新增正则 / strict / 日期范围规则。

    Pydantic v2 内置的 date 解析会接受带时间后缀的字符串并截断成日期，
    因此 "2026-10-02T00:00:00" 不会被拒绝。
    契约要求前端发送 YYYY-MM-DD（docs/stage1-api.md 第 10 节），
    收紧这条边界不在 Task 6.1 范围内。
    """
    updated = JournalUpdate(journal_date="2026-10-02T00:00:00")
    created = JournalCreate(content="正文", journal_date="2026-10-02T00:00:00")

    assert updated.journal_date == date(2026, 10, 2)
    assert updated.journal_date == created.journal_date


# --------------------------------------------------------------------------
# folder_id：省略 vs 显式 null（Stage 2 / S2-T02 新增）
#
# 显式 null 是有意义的：表示「移出 Folder」，因此不能写成
# 「非 Optional 注解 + None 默认值」，只能靠 model_fields_set 区分。
# --------------------------------------------------------------------------


def test_folder_id_omitted_and_folder_id_null_are_different():
    omitted = JournalUpdate()
    explicit_null = JournalUpdate(folder_id=None)

    assert "folder_id" not in omitted.model_fields_set
    assert "folder_id" in explicit_null.model_fields_set

    assert omitted.model_dump(exclude_unset=True) == {}
    assert explicit_null.model_dump(exclude_unset=True) == {"folder_id": None}


@pytest.mark.parametrize("folder_id", [None, 1, 42])
def test_folder_id_accepts_null_and_integers(folder_id):
    assert _update(folder_id=folder_id) == {"folder_id": folder_id}


def test_folder_id_can_be_omitted():
    assert "folder_id" not in JournalUpdate().model_fields_set


# --------------------------------------------------------------------------
# 类型错误
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("title", 123),
        ("content", 123),
        ("journal_date", 123),
        ("folder_id", "abc"),
        ("folder_id", 1.5),
    ],
)
def test_wrong_type_is_rejected(field, value):
    with pytest.raises(ValidationError):
        JournalUpdate(**{field: value})


# --------------------------------------------------------------------------
# 额外字段策略
# --------------------------------------------------------------------------


def test_system_fields_are_ignored_in_update_payload():
    update = JournalUpdate(content="新的正文", **SYSTEM_FIELDS)

    assert set(update.model_dump()) == UPDATE_FIELDS
    assert update.model_fields_set == {"content"}
    assert update.model_dump(exclude_unset=True) == {"content": "新的正文"}
    for name in SYSTEM_FIELDS:
        assert not hasattr(update, name)


def test_unknown_field_is_ignored_not_rejected():
    update = JournalUpdate(title="新的标题", author="someone")

    assert set(update.model_dump()) == UPDATE_FIELDS
    assert update.model_fields_set == {"title"}
    assert update.model_dump(exclude_unset=True) == {"title": "新的标题"}
    assert not hasattr(update, "author")
