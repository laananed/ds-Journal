"""CORS 最小测试（Stage 1 / Task 8.1）。

目标：确认本地前端来源可以读取后端 API，未允许来源拿不到允许响应头。

- 只使用 `GET /api/health` 与 `OPTIONS` 预检，**不写数据库**；
- 使用 FastAPI 自带的 `CORSMiddleware` 行为，不自定义错误格式；
- 只验证最小集合：允许来源的读取与预检、未允许来源不获允许头、当前仅放开 GET。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app

ALLOW_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173"]
DISALLOWED_ORIGIN = "http://evil.example.com"

ALLOW_ORIGIN = "access-control-allow-origin"
ALLOW_METHODS = "access-control-allow-methods"

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


def test_disallowed_origin_gets_no_allow_origin_header():
    """未允许来源不会获得 Allow-Origin（因此浏览器读不到响应）。"""
    response = client.get("/api/health", headers={"Origin": DISALLOWED_ORIGIN})

    assert ALLOW_ORIGIN not in response.headers


def test_disallowed_origin_preflight_is_not_allowed():
    """未允许来源的预检不返回允许头。"""
    response = client.options(
        "/api/journals",
        headers={
            "Origin": DISALLOWED_ORIGIN,
            "Access-Control-Request-Method": "GET",
        },
    )

    assert ALLOW_ORIGIN not in response.headers


def test_only_get_is_allowed_in_this_stage():
    """本阶段只放开 GET：POST 不应出现在允许方法里。"""
    response = client.options(
        "/api/journals",
        headers={
            "Origin": ALLOW_ORIGINS[0],
            "Access-Control-Request-Method": "POST",
        },
    )

    assert "POST" not in response.headers.get(ALLOW_METHODS, "")


def test_wildcard_origin_is_not_used():
    """不使用通配来源。"""
    response = client.get("/api/health", headers={"Origin": ALLOW_ORIGINS[0]})

    assert response.headers.get(ALLOW_ORIGIN) != "*"
