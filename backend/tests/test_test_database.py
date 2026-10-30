"""测试库隔离守卫：默认 ``seekjournal_test``，白名单外一律拒绝。

本文件里的选库用例都是**纯逻辑**：只调用 `make_url` 与字符串判断，
不建立连接，因此不会因为验证非法取值而连到个人库或另一个 Agent 的测试库。
只有最后一条守卫实际核对 pytest Engine 的 URL（同样不连接）。
"""

from __future__ import annotations

import pytest

from app.database import engine
from scripts.prepare_test_db import (
    ALLOWED_TEST_DATABASES,
    DEFAULT_TEST_DATABASE_NAME,
    TEST_DATABASE_ENV,
    get_test_database_name,
    get_test_database_url,
)


def test_api_engine_targets_the_selected_test_database():
    """pytest 进程必须连在选定的隔离测试库上。"""
    assert engine.url.database == get_test_database_name()
    assert engine.url.database in ALLOWED_TEST_DATABASES


def test_default_stays_seekjournal_test_when_env_is_absent(monkeypatch):
    """未指定 SEEKJOURNAL_TEST_DB 时保留既有行为。"""
    monkeypatch.delenv(TEST_DATABASE_ENV, raising=False)
    assert get_test_database_name() == DEFAULT_TEST_DATABASE_NAME == "seekjournal_test"


def test_blank_env_value_also_falls_back_to_the_default(monkeypatch):
    monkeypatch.setenv(TEST_DATABASE_ENV, "   ")
    assert get_test_database_name() == DEFAULT_TEST_DATABASE_NAME


def test_each_whitelisted_database_can_be_selected(monkeypatch):
    """四个登记库都能被选中，且 URL 里的库名确实被替换。"""
    assert set(ALLOWED_TEST_DATABASES) == {
        "seekjournal_test",
        "seekjournal_test_02",
        "seekjournal_test_03",
        "seekjournal_test_04",
    }
    for name in ALLOWED_TEST_DATABASES:
        monkeypatch.setenv(TEST_DATABASE_ENV, name)
        assert get_test_database_name() == name
        assert get_test_database_url().database == name


@pytest.mark.parametrize(
    "name",
    [
        "seekjournal",  # 个人库
        "journal_test_02",  # 拼错的库名
        "seekjournal_test_09",  # 未登记库名
        "postgres",
        "template1",
        "SEEKJOURNAL_TEST",  # 大小写不敏感地放宽是不允许的
        "seekjournal_test;DROP DATABASE seekjournal",
        "postgresql://user:pw@localhost/seekjournal",
        "../seekjournal_test_02",
        "*",
    ],
)
def test_non_whitelisted_database_names_are_rejected(monkeypatch, name):
    """非白名单取值直接拒绝；错误信息不回显取值，也不含连接串。"""
    monkeypatch.setenv(TEST_DATABASE_ENV, name)
    with pytest.raises(RuntimeError) as error:
        get_test_database_name()
    message = str(error.value)
    assert "白名单" in message and "已拒绝连接" in message
    assert "://" not in message, "拒绝信息不能带连接串"
    # URL 解析同样必须失败：不能先连上再判断。
    with pytest.raises(RuntimeError):
        get_test_database_url()


def test_selection_never_opens_a_connection(monkeypatch):
    """选库与 URL 解析是纯逻辑：把 psycopg 连接函数换成炸弹也必须不触发。"""
    import scripts.prepare_test_db as prepare

    def explode(*args, **kwargs):  # pragma: no cover - 只在被误调用时执行
        raise AssertionError("选库逻辑不应该建立数据库连接")

    monkeypatch.setattr(prepare.psycopg, "connect", explode)
    for name in ALLOWED_TEST_DATABASES:
        monkeypatch.setenv(TEST_DATABASE_ENV, name)
        assert get_test_database_url().database == name
    monkeypatch.setenv(TEST_DATABASE_ENV, "seekjournal")
    with pytest.raises(RuntimeError):
        get_test_database_url()
