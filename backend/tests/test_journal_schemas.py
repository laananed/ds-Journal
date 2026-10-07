"""JournalCreate / JournalResponse 的最小 Schema 测试。

Stage 1 / Task 4.1；Stage 2 / S2-T02 按新响应契约更新。

只使用内存数据：

- 不导入 Model、Engine、Session；
- 不创建数据库连接；
- 不 flush / commit；
- 不执行任何 SQL。

`pytest` 会加载同目录的 `conftest.py`，其中确实导入 `app.database` 并创建了
Engine 对象，但 `create_engine` 是惰性的，不会真的连接数据库；
本文件也不请求 `api` fixture。

断言只验证字段行为与字段值，
不绑定 ValidationError 的具体文案。
"""

from __future__ import annotations

import json
from datetime import date, datetime, timezone
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.journal.schemas import JournalCreate, JournalResponse

DAY = date(2026, 10, 2)
CREATED_AT = datetime(2026, 10, 2, 14, 30, tzinfo=timezone.utc)
UPDATED_AT = datetime(2026, 10, 2, 15, 45, tzinfo=timezone.utc)

CREATE_FIELDS = {"title", "content", "journal_date", "folder_id"}

# Stage 2 / S2-T02：完整响应为十个字段。
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
}

# 必填字段（没有默认值）：缺一个就必须报错。
REQUIRED_RESPONSE_FIELDS = {
    "id",
    "title",
    "display_title",
    "content",
    "journal_date",
    "created_at",
    "updated_at",
}
# 有默认值的字段：省略时使用默认值，而不是报错。
DEFAULTED_RESPONSE_FIELDS = RESPONSE_FIELDS - REQUIRED_RESPONSE_FIELDS

SYSTEM_FIELDS = {
    "id": 999,
    "created_at": "2020-01-01T00:00:00Z",
    "updated_at": "2020-01-01T00:00:00Z",
}


def _response(**overrides) -> JournalResponse:
    """构造一个合法的完整响应，允许按字段覆盖。"""
    payload: dict[str, object] = {
        "id": 1,
        "title": None,
        "display_title": "2026-10-02",
        "content": "正文",
        "journal_date": DAY,
        "created_at": CREATED_AT,
        "updated_at": UPDATED_AT,
    }
    payload.update(overrides)
    return JournalResponse(**payload)


# --------------------------------------------------------------------------
# JournalCreate：title
# --------------------------------------------------------------------------


def test_title_omitted_defaults_to_none():
    created = JournalCreate(content="正文", journal_date=DAY)

    assert created.title is None
    assert created.model_dump()["title"] is None


@pytest.mark.parametrize("title", [None, "广州动物园复盘"])
def test_title_accepts_null_and_plain_string(title):
    created = JournalCreate(title=title, content="正文", journal_date=DAY)

    assert created.title == title


# Stage 1.5 / S1.5-T2 收紧 title：可省略 / null / 空字符串，最多 80 个 Unicode 码点，
# 非空标题原样保存（不 trim，也不拒绝纯空白手工标题）。


@pytest.mark.parametrize("title", [None, ""])
def test_title_null_and_empty_string_are_accepted(title):
    created = JournalCreate(title=title, content="正文", journal_date=DAY)

    assert created.title == title


def test_title_of_exactly_eighty_code_points_is_accepted():
    title = "标" * 80

    created = JournalCreate(title=title, content="正文", journal_date=DAY)

    assert created.title == title


def test_title_of_eighty_one_code_points_is_rejected():
    with pytest.raises(ValidationError):
        JournalCreate(title="标" * 81, content="正文", journal_date=DAY)


def test_title_length_counts_non_bmp_emoji_by_code_point():
    """非 BMP emoji 在 UTF-16 里占 2 个 code unit，但按 Unicode 码点只算 1 个。

    契约按码点计数：80 个 emoji 合法，81 个非法。
    如果误用 UTF-16 计数，这里会在 41 个 emoji 就被拒绝。
    """
    title = "🧭" * 80
    assert len(title) == 80

    created = JournalCreate(title=title, content="正文", journal_date=DAY)
    assert created.title == title

    with pytest.raises(ValidationError):
        JournalCreate(title="🧭" * 81, content="正文", journal_date=DAY)


@pytest.mark.parametrize("title", ["  标题  ", "\t标题\t", "   ", "\u3000"])
def test_title_is_kept_verbatim_without_trim_or_cleaning(title):
    """非空标题（含纯空白字符串）原样保存：不 trim，也不因为「只是空白」被拒绝。"""
    created = JournalCreate(title=title, content="正文", journal_date=DAY)

    assert created.title == title
    assert created.model_dump()["title"] == title


# --------------------------------------------------------------------------
# JournalCreate：必填与 null
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "payload",
    [
        {"journal_date": "2026-10-02"},  # 缺 content
        {"content": "正文"},  # 缺 journal_date
        {},  # 两个都缺
    ],
)
def test_missing_required_field_is_rejected(payload):
    with pytest.raises(ValidationError):
        JournalCreate(**payload)


@pytest.mark.parametrize("field", ["content", "journal_date"])
def test_required_field_null_is_rejected(field):
    payload = {"content": "正文", "journal_date": DAY, field: None}

    with pytest.raises(ValidationError):
        JournalCreate(**payload)


# --------------------------------------------------------------------------
# JournalCreate：journal_date
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
    created = JournalCreate(content="正文", journal_date=raw)

    assert created.journal_date == expected
    assert isinstance(created.journal_date, date)


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
        JournalCreate(content="正文", journal_date=raw)


def test_datetime_like_string_is_truncated_to_date_by_builtin_parser():
    """记录当前 Pydantic 内置解析的实际边界行为，而不是契约要求。

    Pydantic v2 的内置 date 解析会接受带时间后缀的字符串，并截断成日期，
    因此 "2026-10-02T00:00:00" 不会被拒绝。

    Stage 1 暂不把 journal_date 收紧为仅允许 YYYY-MM-DD：
    那需要正则、strict 模式或自定义解析器，属于 Task 4.1 明确不增加的规则。
    契约要求前端发送 YYYY-MM-DD（docs/stage1-api.md 第 10 节）。
    """
    created = JournalCreate(content="正文", journal_date="2026-10-02T00:00:00")

    assert created.journal_date == date(2026, 10, 2)


# --------------------------------------------------------------------------
# JournalCreate：content
#
# Stage 1.5 / S1.5-T2 收紧 content：原始字符串最多 50,000 个 Unicode 码点，
# 且必须至少包含一个非空白字符。旧契约「空字符串合法」已被新规则替代。
# --------------------------------------------------------------------------


@pytest.mark.parametrize("content", ["正文", "多行\n正文", "  缩进\n\n结尾  "])
def test_content_accepts_non_blank_text(content):
    created = JournalCreate(content=content, journal_date=DAY)

    assert created.content == content


@pytest.mark.parametrize(
    "content",
    ["", " ", "\t", "\n", "\r\n", " \t\n", "\u3000", "\xa0", "\u3000\xa0 \t\n"],
)
def test_blank_content_is_rejected(content):
    """空字符串、普通空格、Tab、换行、全角空格、NBSP 及其组合都非法。"""
    with pytest.raises(ValidationError):
        JournalCreate(content=content, journal_date=DAY)


@pytest.mark.parametrize("length", [1, 49_999, 50_000])
def test_content_within_code_point_limit_is_accepted(length):
    content = "a" * length

    created = JournalCreate(content=content, journal_date=DAY)

    assert len(created.content) == length


def test_content_over_code_point_limit_is_rejected():
    with pytest.raises(ValidationError):
        JournalCreate(content="a" * 50_001, journal_date=DAY)


def test_content_length_counts_the_raw_string_before_trimming():
    """原始长度 50,001：即使两端空白被 trim 掉后只剩 1 个字符，也必须按原始长度拒绝。"""
    content = " " * 50_000 + "x"
    assert len(content) == 50_001
    assert content.strip() == "x"

    with pytest.raises(ValidationError):
        JournalCreate(content=content, journal_date=DAY)


def test_content_counts_cjk_and_non_bmp_emoji_by_code_point():
    accept = "中" * 49_999 + "🧭"
    assert len(accept) == 50_000

    created = JournalCreate(content=accept, journal_date=DAY)
    assert created.content == accept

    with pytest.raises(ValidationError):
        JournalCreate(content="中" * 50_000 + "🧭", journal_date=DAY)


def test_content_round_trips_markdown_indentation_and_trailing_spaces():
    """Markdown 缩进、空行与首尾空格原样往返：校验用的 trim 不会写回数据库。"""
    content = "# 标题\n\n  - 缩进列表\n\n结尾有空行\n\n"

    created = JournalCreate(content=content, journal_date=DAY)

    assert created.content == content
    assert created.model_dump()["content"] == content


# --------------------------------------------------------------------------
# JournalCreate：额外字段策略
# --------------------------------------------------------------------------


def test_system_fields_are_ignored_in_create_payload():
    created = JournalCreate(content="正文", journal_date=DAY, **SYSTEM_FIELDS)

    assert set(created.model_dump()) == CREATE_FIELDS
    for name in SYSTEM_FIELDS:
        assert not hasattr(created, name)


def test_unknown_field_is_ignored_not_rejected():
    created = JournalCreate(content="正文", journal_date=DAY, author="someone")

    assert set(created.model_dump()) == CREATE_FIELDS
    assert not hasattr(created, "author")


def test_create_dump_contains_only_the_contract_fields():
    created = JournalCreate(title=None, content="正文", journal_date=DAY)

    assert created.model_dump() == {
        "title": None,
        "content": "正文",
        "journal_date": DAY,
        "folder_id": None,
    }


# --------------------------------------------------------------------------
# JournalCreate：folder_id（Stage 2 / S2-T02 新增）
# --------------------------------------------------------------------------


def test_create_folder_id_defaults_to_none():
    created = JournalCreate(content="正文", journal_date=DAY)

    assert created.folder_id is None


@pytest.mark.parametrize("folder_id", [None, 1, 42])
def test_create_folder_id_accepts_null_and_integers(folder_id):
    created = JournalCreate(content="正文", journal_date=DAY, folder_id=folder_id)

    assert created.folder_id == folder_id


@pytest.mark.parametrize("folder_id", ["abc", 1.5, [1]])
def test_create_folder_id_rejects_wrong_types(folder_id):
    """`folder_id` 只接受整数或 null；字符串 / 小数 / 列表被拒绝。"""
    with pytest.raises(ValidationError):
        JournalCreate(content="正文", journal_date=DAY, folder_id=folder_id)


def test_create_folder_id_keeps_the_builtin_bool_boundary():
    """记录 Pydantic 内置（非 strict）解析的边界：`True` 被当成整数 1。

    与 `journal_date` 的「带时间后缀会被截断」一样，本轮不为此额外加
    strict 模式或自定义解析器；契约要求前端发送整数或 null。
    """
    created = JournalCreate(content="正文", journal_date=DAY, folder_id=True)

    assert created.folder_id == 1
    assert isinstance(created.folder_id, int)


# --------------------------------------------------------------------------
# JournalResponse：字段组成
# --------------------------------------------------------------------------


def test_response_declares_the_full_field_set():
    assert set(JournalResponse.model_fields) == RESPONSE_FIELDS


def test_response_type_and_display_title_are_declared():
    assert "type" in JournalResponse.model_fields
    assert "display_title" in JournalResponse.model_fields


def test_response_defaults_type_and_keeps_optional_fields_nullable():
    """`type` 默认 `"journal"`；`folder_id` / `deleted_at` 默认 None。"""
    response = _response()

    assert response.type == "journal"
    assert response.folder_id is None
    assert response.deleted_at is None
    assert set(response.model_dump()) == RESPONSE_FIELDS


@pytest.mark.parametrize("title", [None, "广州动物园复盘"])
def test_response_keeps_title_null_or_string(title):
    response = _response(title=title)

    assert response.title == title


def test_response_display_title_is_independent_of_raw_title():
    """`display_title` 是读取投影：与原始 `title` 可以不同。"""
    response = _response(title=None, display_title="2026-10-02 (2)")

    assert response.title is None
    assert response.display_title == "2026-10-02 (2)"


@pytest.mark.parametrize("missing", sorted(REQUIRED_RESPONSE_FIELDS))
def test_response_requires_every_required_field(missing):
    payload: dict[str, object] = {
        "id": 1,
        "title": None,
        "display_title": "2026-10-02",
        "content": "正文",
        "journal_date": DAY,
        "created_at": CREATED_AT,
        "updated_at": UPDATED_AT,
    }
    payload.pop(missing)

    with pytest.raises(ValidationError):
        JournalResponse(**payload)


@pytest.mark.parametrize("omitted", sorted(DEFAULTED_RESPONSE_FIELDS))
def test_response_defaulted_fields_can_be_omitted(omitted):
    """`type` / `folder_id` / `deleted_at` 有默认值，省略时按默认值填充。"""
    response = _response()

    assert getattr(response, omitted) is not None or omitted != "type"
    assert set(response.model_dump()) == RESPONSE_FIELDS


# --------------------------------------------------------------------------
# JSON 序列化
# --------------------------------------------------------------------------


def test_create_json_expresses_journal_date():
    created = JournalCreate(content="正文", journal_date=DAY)

    data = json.loads(created.model_dump_json())

    assert data["journal_date"] == "2026-10-02"


def test_response_json_expresses_date_and_datetime():
    response = _response(id=12)

    data = json.loads(response.model_dump_json())

    assert data["journal_date"] == "2026-10-02"
    assert data["type"] == "journal"
    assert data["display_title"] == "2026-10-02"
    assert data["folder_id"] is None
    assert data["deleted_at"] is None
    # 时间按 ISO 8601 表达并要求能解析回原来的带时区时间。
    # 不断言 Z 还是 +00:00 的写法，避免绑定序列化细节。
    assert datetime.fromisoformat(data["created_at"]) == CREATED_AT
    assert datetime.fromisoformat(data["updated_at"]) == UPDATED_AT


# --------------------------------------------------------------------------
# 普通对象 → JournalResponse
# --------------------------------------------------------------------------


def test_response_from_plain_object():
    """`from_attributes=True` 从一个带同名属性的普通对象读出字段。

    `type` 与 `display_title` 不是 ORM 属性，由 Service 在构造响应时显式提供；
    这里用 SimpleNamespace 模拟「Service 已经算好投影」的对象。
    """
    journal = SimpleNamespace(
        id=7,
        title=None,
        display_title="2026-10-02",
        content="未持久化的日记",
        journal_date=DAY,
        folder_id=None,
        created_at=CREATED_AT,
        updated_at=UPDATED_AT,
        deleted_at=None,
    )

    response = JournalResponse.model_validate(journal)

    assert response.id == 7
    assert response.type == "journal"
    assert response.title is None
    assert response.display_title == "2026-10-02"
    assert response.content == "未持久化的日记"
    assert response.journal_date == DAY
    assert response.folder_id is None
    assert response.created_at == CREATED_AT
    assert response.updated_at == UPDATED_AT
    assert response.deleted_at is None
    assert set(response.model_dump()) == RESPONSE_FIELDS


def test_response_does_not_apply_request_length_limits():
    """响应不套用请求的 80 / 50,000 与空白限制：旧记录必须读得出来。"""
    response = _response(title="旧" * 500, content="旧" * 80_000, display_title="旧" * 500)

    assert len(response.title) == 500
    assert len(response.content) == 80_000
