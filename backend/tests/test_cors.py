"""CORS 最小测试（Stage 1 / Task 8.1，Task 8.2 扩展 GET → GET/POST，
Task 8.3 再扩展到 GET / POST / PATCH / DELETE）。

目标：确认本地前端来源可以读取后端 API、能发起带 JSON 请求体的 POST、
也能发起修改与删除（PATCH / DELETE）；未允许来源拿不到允许响应头；
并且不使用通配来源或通配方法。

- 只使用 `GET /api/health` 与 `OPTIONS` 预检，**不写数据库**
  （预检不会到达业务路由，因此 PATCH / DELETE 的用例也不会改动任何记录）；
- 使用 FastAPI 自带的 `CORSMiddleware` 行为，不自定义错误格式；
- Task 8.1 / 8.2 的保护断言全部保留，只是把 Task 8.2 里
  「尚不开放 PATCH / DELETE」更新为 Task 8.3 的「允许 PATCH / DELETE」。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app

ALLOW_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173"]
DISALLOWED_ORIGIN = "http://evil.example.com"

# 已支持的写方法：POST（创建）、PATCH（修改）、DELETE（删除）。
WRITE_METHODS = ["POST", "PATCH", "DELETE"]

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


@pytest.mark.parametrize("origin", ALLOW_ORIGINS)
@pytest.mark.parametrize("method", ["PATCH", "DELETE"])
def test_allowed_origin_can_preflight_patch_and_delete(origin, method):
    """允许来源的 PATCH / DELETE 预检成功（Task 8.3 新开放）。

    浏览器在发出跨来源的 PATCH / DELETE 之前会先发预检；
    预检被拒绝时浏览器根本不会发出真实请求，前端的修改 / 删除会直接失败。
    因此这里必须确认允许头里同时有 Allow-Origin 与该方法。

    预检请求由 `CORSMiddleware` 直接应答，不会进入业务路由，
    所以本用例不会创建、修改或删除任何记录。
    """
    response = client.options(
        "/api/journals/1",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": "content-type",
        },
    )

    assert response.status_code == 200
    assert response.headers.get(ALLOW_ORIGIN) == origin
    assert method in response.headers.get(ALLOW_METHODS, "")
    assert "content-type" in response.headers.get(ALLOW_HEADERS, "").lower()


def test_allow_methods_lists_every_supported_method_without_wildcard():
    """允许方法覆盖 Stage 1 用到的四种方法，且不使用通配方法。"""
    response = client.options(
        "/api/journals",
        headers={
            "Origin": ALLOW_ORIGINS[0],
            "Access-Control-Request-Method": "GET",
        },
    )

    allowed = response.headers.get(ALLOW_METHODS, "")
    assert response.status_code == 200
    for method in ["GET", *WRITE_METHODS]:
        assert method in allowed
    assert "*" not in allowed


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
def test_disallowed_origin_patch_and_delete_preflight_is_rejected(method):
    """未允许来源在 Task 8.3 新开放的方法上同样被拒绝。

    放开 PATCH / DELETE 只是针对本机的两个开发来源，
    不是对所有来源放开写权限。
    """
    response = client.options(
        "/api/journals/1",
        headers={
            "Origin": DISALLOWED_ORIGIN,
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": "content-type",
        },
    )

    assert response.status_code == 400
    assert ALLOW_ORIGIN not in response.headers


def test_wildcard_origin_is_not_used():
    """不使用通配来源。"""
    response = client.get("/api/health", headers={"Origin": ALLOW_ORIGINS[0]})

    assert response.headers.get(ALLOW_ORIGIN) != "*"
