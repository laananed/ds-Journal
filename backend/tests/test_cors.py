"""CORS 最小测试（Stage 1 / Task 8.1，Task 8.2 扩展 GET → GET/POST）。

目标：确认本地前端来源可以读取后端 API、并能发起带 JSON 请求体的 POST；
未允许来源拿不到允许响应头；尚未开放的写方法（PATCH / DELETE）仍被拒绝。

- 只使用 `GET /api/health` 与 `OPTIONS` 预检，**不写数据库**；
- 使用 FastAPI 自带的 `CORSMiddleware` 行为，不自定义错误格式；
- Task 8.1 的 GET 保护断言全部保留，只是在 Task 8.2 里把
  「本阶段只允许 GET」更新为「本阶段允许 GET 与 POST」。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app

ALLOW_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173"]
DISALLOWED_ORIGIN = "http://evil.example.com"

ALLOW_ORIGIN = "access-control-allow-origin"
ALLOW_METHODS = "access-control-allow-methods"
ALLOW_HEADERS = "access-control-allow-headers"

client = TestClient(app)


@pytest.mark.parametrize("origin", ALLOW_ORIGINS)
def test_allowed_origin_can_read_a_get_response(origin):
    """允许来源的 GET 响应带正确的 Allow-Origin。"""
    response = client.get("/api/health", headers={"Origin": origin})

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert response.headers.get(ALLOW_ORIGIN) == origin


@pytest.mark.parametrize("origin", ALLOW_ORIGINS)
def test_allowed_origin_preflight_succeeds(origin):
    """允许来源的 GET 预检成功，并声明允许 GET。"""
    response = client.options(
        "/api/journals",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "GET",
        },
    )

    assert response.status_code == 200
    assert response.headers.get(ALLOW_ORIGIN) == origin
    assert "GET" in response.headers.get(ALLOW_METHODS, "")


@pytest.mark.parametrize("origin", ALLOW_ORIGINS)
def test_allowed_origin_can_preflight_a_json_post(origin):
    """允许来源的 POST 预检成功，并允许 JSON 请求体所需的 Content-Type。

    浏览器发 `Content-Type: application/json` 的 POST 前会先发预检，
    服务的允许头里必须同时包含 POST 与 Content-Type，否则请求根本发不出去。
    """
    response = client.options(
        "/api/journals",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )

    assert response.status_code == 200
    assert response.headers.get(ALLOW_ORIGIN) == origin
    assert "POST" in response.headers.get(ALLOW_METHODS, "")
    assert "content-type" in response.headers.get(ALLOW_HEADERS, "").lower()


def test_disallowed_origin_gets_no_allow_origin_header():
    """未允许来源不会获得 Allow-Origin（因此浏览器读不到响应）。"""
    response = client.get("/api/health", headers={"Origin": DISALLOWED_ORIGIN})

    assert response.status_code == 200
    assert ALLOW_ORIGIN not in response.headers


def test_disallowed_origin_preflight_is_not_allowed():
    """未允许来源的 GET 预检不返回允许头。"""
    response = client.options(
        "/api/journals",
        headers={
            "Origin": DISALLOWED_ORIGIN,
            "Access-Control-Request-Method": "GET",
        },
    )

    assert ALLOW_ORIGIN not in response.headers


def test_disallowed_origin_post_preflight_is_rejected():
    """未允许来源的 POST 预检被拒绝：既没有 Allow-Origin，也不成功。"""
    response = client.options(
        "/api/journals",
        headers={
            "Origin": DISALLOWED_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )

    assert response.status_code == 400
    assert ALLOW_ORIGIN not in response.headers


@pytest.mark.parametrize("method", ["PATCH", "DELETE"])
def test_patch_and_delete_are_not_allowed_in_this_stage(method):
    """本阶段不开放 PATCH / DELETE：预检被拒绝，浏览器无法发起。

    这两个方法的浏览器支持留给 Task 8.3，届时再扩展 allow_methods。
    """
    response = client.options(
        "/api/journals/1",
        headers={
            "Origin": ALLOW_ORIGINS[0],
            "Access-Control-Request-Method": method,
        },
    )

    assert response.status_code == 400


def test_wildcard_origin_is_not_used():
    """不使用通配来源。"""
    response = client.get("/api/health", headers={"Origin": ALLOW_ORIGINS[0]})

    assert response.headers.get(ALLOW_ORIGIN) != "*"
