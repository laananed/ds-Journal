"""Folder Schema 校验测试（Stage 2 / S2-T07）。

只测 Pydantic 请求 Schema 的纯验证行为，不连数据库：

- FolderCreate：name 先 trim、再校验 1～80 个 Unicode 码点，
  保存 trim 后的值；空串、纯空白、null、超长非法；
- FolderUpdate：name 可省略（省略 = 不更新）；显式 null 非法；
  提交时同样 trim + 1～80 码点；
- 额外/系统字段（id 等）沿用 extra="ignore"。
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.folder.schemas import (
    FolderCreate,
    FolderUpdate,
    trim_folder_name,
)


class TestFolderCreate:
    def test_valid_simple_name(self):
        data = FolderCreate(name="项目思考")
        assert data.name == "项目思考"

    def test_trim_surrounding_ascii_spaces(self):
        assert FolderCreate(name="  思考  ").name == "思考"

    def test_trim_fullwidth_and_nbsp(self):
        # 全角空格 U+3000 与 NBSP U+00A0 与三类文件用的是同一份空白集合。
        assert FolderCreate(name="\u3000思考\u00a0").name == "思考"

    def test_80_code_points_ok(self):
        assert FolderCreate(name="a" * 80).name == "a" * 80

    def test_81_code_points_rejected(self):
        with pytest.raises(ValidationError):
            FolderCreate(name="a" * 81)

    def test_emoji_counts_as_one_code_point(self):
        # 😀 是非 BMP 字符：按码点计 1 个（不是 UTF-16 的 2 个）。
        assert FolderCreate(name="\U0001F600" * 80).name == "\U0001F600" * 80
        with pytest.raises(ValidationError):
            FolderCreate(name="\U0001F600" * 81)

    def test_empty_string_rejected(self):
        with pytest.raises(ValidationError):
            FolderCreate(name="")

    def test_whitespace_only_rejected(self):
        for value in ("   ", "\t", "\u3000\u3000", "\u00a0"):
            with pytest.raises(ValidationError):
                FolderCreate(name=value)

    def test_explicit_null_rejected(self):
        with pytest.raises(ValidationError):
            FolderCreate(name=None)

    def test_missing_name_rejected(self):
        with pytest.raises(ValidationError):
            FolderCreate()

    def test_duplicate_names_allowed_by_schema(self):
        # Schema 层没有唯一性校验：两个相同 name 都是合法请求。
        first = FolderCreate(name="同名")
        second = FolderCreate(name="同名")
        assert first.name == second.name == "同名"

    def test_system_fields_ignored(self):
        data = FolderCreate.model_validate(
            {"name": "思考", "id": 999, "created_at": "2020-01-01T00:00:00Z"}
        )
        assert data.name == "思考"
        assert not hasattr(data, "id")
        assert not hasattr(data, "created_at")


class TestFolderUpdate:
    def test_name_omitted_means_no_update(self):
        data = FolderUpdate()
        assert "name" not in data.model_fields_set
        assert data.model_dump(exclude_unset=True) == {}

    def test_name_submitted_and_trimmed(self):
        data = FolderUpdate(name="  新名  ")
        assert data.model_dump(exclude_unset=True) == {"name": "新名"}

    def test_explicit_null_rejected(self):
        with pytest.raises(ValidationError):
            FolderUpdate(name=None)

    def test_empty_string_rejected(self):
        with pytest.raises(ValidationError):
            FolderUpdate(name="")

    def test_whitespace_only_rejected(self):
        with pytest.raises(ValidationError):
            FolderUpdate(name=" \u3000 ")

    def test_80_ok_81_rejected(self):
        assert FolderUpdate(name="a" * 80).name == "a" * 80
        with pytest.raises(ValidationError):
            FolderUpdate(name="a" * 81)

    def test_extra_fields_ignored(self):
        data = FolderUpdate.model_validate({"name": "新名", "id": 5})
        assert data.model_dump(exclude_unset=True) == {"name": "新名"}


class TestTrimFolderName:
    def test_noop_without_whitespace(self):
        assert trim_folder_name("abc") == "abc"

    def test_inner_whitespace_kept(self):
        # trim 只处理两端；中间空白属于名称本身。
        assert trim_folder_name("  a b  ") == "a b"

    def test_all_kinds_of_boundaries(self):
        assert trim_folder_name("\t\nx\u3000\u00a0") == "x"
