"""S3-T03 model client tests: fixed official parameters and bounded failures.

Every test injects a fake transport, so no test opens a socket, needs a real key
or spends money. The fake also proves *what* would have been sent, which is the
only way to verify the frozen official request shape.
"""
import json
import socket
import urllib.error

import pytest

from app.ai import client

SECRET = "sk-synthetic-do-not-log-0123456789"


class FakeTransport:
    """Records the request and returns one programmed transport response."""

    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.calls = []

    def post_json(self, url, payload, headers, timeout, max_bytes):
        self.calls.append({"url": url, "payload": payload, "headers": headers,
                           "timeout": timeout, "max_bytes": max_bytes})
        if self.error is not None:
            raise self.error
        return self.response


def ok_body(**overrides):
    body = {
        "id": "chatcmpl-synthetic",
        "choices": [{"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant", "content": "嗯，我在听。"}}],
        "usage": {"prompt_tokens": 90, "completion_tokens": 18, "total_tokens": 108},
    }
    body.update(overrides)
    return json.dumps(body).encode()


def response(status=200, body=None, headers=None, content_type="application/json"):
    return client.TransportResponse(status=status, body=ok_body() if body is None else body,
                                    content_type=content_type, headers=headers or {})


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setenv(client.API_KEY_ENV, SECRET)
    return SECRET


def test_request_uses_fixed_official_endpoint_model_and_flags(configured):
    transport = FakeTransport(response())
    messages = [{"role": "user", "content": "synthetic prompt"}]

    result = client.invoke(messages, max_tokens=client.LOCAL_MAX_TOKENS, transport=transport)

    assert len(transport.calls) == 1
    call = transport.calls[0]
    assert call["url"] == "https://api.deepseek.com/chat/completions"
    assert call["payload"] == {
        "model": "deepseek-flash",
        "messages": messages,
        "max_tokens": 512,
        "stream": False,
        "thinking": {"type": "disabled"},
    }
    assert call["headers"]["Authorization"] == f"Bearer {SECRET}"
    assert call["timeout"] == client.DEFAULT_TIMEOUT_SECONDS
    assert call["max_bytes"] == client.MAX_RESPONSE_BYTES
    assert result.text == "嗯，我在听。"
    assert result.finish_reason == "stop" and result.truncated is False


def test_caller_parameters_cannot_change_model_base_url_or_streaming(configured):
    transport = FakeTransport(response())

    client.invoke([{"role": "user", "content": "x"}], max_tokens=client.REVIEW_MAX_TOKENS,
                  parameters={"model": "other-model", "base_url": "http://evil.test",
                              "stream": True, "thinking": {"type": "enabled"},
                              "temperature": 0.9, "tools": []},
                  transport=transport)

    payload = transport.calls[0]["payload"]
    assert payload["model"] == "deepseek-flash"
    assert payload["stream"] is False
    assert payload["thinking"] == {"type": "disabled"}
    assert payload["max_tokens"] == 4096
    assert payload["tools"] == []
    assert "base_url" not in payload and "temperature" not in payload


def test_missing_key_fails_before_any_network_activity(monkeypatch):
    monkeypatch.delenv(client.API_KEY_ENV, raising=False)
    transport = FakeTransport(response())

    with pytest.raises(client.ModelNotConfigured) as failure:
        client.invoke([{"role": "user", "content": "x"}], max_tokens=512, transport=transport)

    assert transport.calls == []
    assert failure.value.category == "not_configured"
    assert client.is_configured() is False


def test_blank_key_is_treated_as_not_configured(monkeypatch):
    monkeypatch.setenv(client.API_KEY_ENV, "   ")
    transport = FakeTransport(response())

    with pytest.raises(client.ModelNotConfigured):
        client.invoke([{"role": "user", "content": "x"}], max_tokens=512, transport=transport)

    assert transport.calls == []


@pytest.mark.parametrize("status", [401, 403])
def test_auth_failure_is_classified_and_never_leaks_the_key(configured, status):
    body = json.dumps({"error": {"message": f"bad key {SECRET}", "type": "authentication_error",
                                 "code": "invalid_api_key"}}).encode()
    transport = FakeTransport(response(status=status, body=body))

    with pytest.raises(client.UpstreamAuthError) as failure:
        client.invoke([{"role": "user", "content": "x"}], max_tokens=512, transport=transport)

    message = str(failure.value)
    assert failure.value.category == "auth"
    assert SECRET not in message
    assert "invalid_api_key" in message
    assert "bad key" not in message


def test_error_message_is_safe_even_when_provider_echoes_credentials(configured):
    body = json.dumps({"error": {"message": f"Authorization: Bearer {SECRET}"}}).encode()
    transport = FakeTransport(response(status=400, body=body, content_type="text/html"))

    with pytest.raises(client.UpstreamResponseError) as failure:
        client.invoke([{"role": "user", "content": "x"}], max_tokens=512, transport=transport)

    assert SECRET not in str(failure.value)
    assert "Bearer" not in str(failure.value)


def test_rate_limit_is_classified_with_bounded_retry_after(configured):
    transport = FakeTransport(response(status=429, body=b"{}",
                                       headers={"retry-after": "17"}))

    with pytest.raises(client.UpstreamRateLimited) as failure:
        client.invoke([{"role": "user", "content": "x"}], max_tokens=512, transport=transport)

    assert failure.value.category == "rate_limited"
    assert failure.value.retry_after_seconds == 17
    assert "429" in str(failure.value)


def test_rate_limit_without_retry_after_is_still_bounded(configured):
    transport = FakeTransport(response(status=429, body=b"{}"))

    with pytest.raises(client.UpstreamRateLimited) as failure:
        client.invoke([{"role": "user", "content": "x"}], max_tokens=512, transport=transport)

    assert not hasattr(failure.value, "retry_after_seconds")


@pytest.mark.parametrize("status", [500, 502, 503])
def test_server_errors_are_unavailable(configured, status):
    transport = FakeTransport(response(status=status, body=b"{}"))

    with pytest.raises(client.UpstreamUnavailable) as failure:
        client.invoke([{"role": "user", "content": "x"}], max_tokens=512, transport=transport)

    assert failure.value.category == "unavailable"


@pytest.mark.parametrize("error", [
    client.UpstreamTimeout("model request timed out"),
    socket.timeout("timed out"),
    TimeoutError("timed out"),
])
def test_timeouts_are_classified_as_timeout(configured, error):
    transport = FakeTransport(error=error)

    with pytest.raises(client.UpstreamTimeout) as failure:
        client.invoke([{"role": "user", "content": "x"}], max_tokens=512, transport=transport)

    assert failure.value.category == "timeout"
    assert "timed out" in str(failure.value)


def test_non_json_body_is_a_bad_response(configured):
    transport = FakeTransport(response(body=b"<html>gateway</html>", content_type="text/html"))

    with pytest.raises(client.UpstreamResponseError) as failure:
        client.invoke([{"role": "user", "content": "x"}], max_tokens=512, transport=transport)

    assert failure.value.category == "bad_response"
    assert "not valid JSON" in str(failure.value)


def test_oversized_body_is_rejected_instead_of_buffered(configured):
    transport = FakeTransport(response(body=b"{" + b"x" * (client.MAX_RESPONSE_BYTES + 1)))

    with pytest.raises(client.UpstreamResponseError) as failure:
        client.invoke([{"role": "user", "content": "x"}], max_tokens=512, transport=transport)

    assert "size limit" in str(failure.value)


def test_truncated_completion_is_flagged_not_silently_accepted(configured):
    body = ok_body(choices=[{"index": 0, "finish_reason": "length",
                             "message": {"role": "assistant", "content": "半句话"}}])
    transport = FakeTransport(response(body=body))

    result = client.invoke([{"role": "user", "content": "x"}], max_tokens=512,
                           transport=transport)

    assert result.truncated is True
    assert result.finish_reason == "length"
    assert result.usage.total_tokens == 108


@pytest.mark.parametrize("usage", [
    None,
    {},
    {"prompt_tokens": 1},
    {"prompt_tokens": 1, "completion_tokens": 2},
    {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": None},
    {"prompt_tokens": "9", "completion_tokens": 2, "total_tokens": 11},
    {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": -1},
])
def test_missing_usage_stays_none_so_callers_record_unknown(configured, usage):
    body = ok_body()
    payload = json.loads(body)
    if usage is None:
        payload.pop("usage")
    else:
        payload["usage"] = usage
    transport = FakeTransport(response(body=json.dumps(payload).encode()))

    result = client.invoke([{"role": "user", "content": "x"}], max_tokens=512,
                           transport=transport)

    assert result.usage is None


def test_cache_tokens_are_reported_separately_and_not_added_to_prompt_tokens(configured):
    body = ok_body(usage={"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120,
                          "prompt_cache_hit_tokens": 64, "prompt_cache_miss_tokens": 36})
    transport = FakeTransport(response(body=body))

    usage = client.invoke([{"role": "user", "content": "x"}], max_tokens=512,
                          transport=transport).usage

    assert usage.prompt_tokens == 100 and usage.total_tokens == 120
    assert usage.cache_hit_tokens == 64 and usage.cache_miss_tokens == 36


@pytest.mark.parametrize("payload", [
    {},
    {"choices": []},
    {"choices": [{}]},
    {"choices": [{"message": {"content": "   "}}]},
    {"choices": [{"message": {}}]},
])
def test_unusable_completion_shape_is_a_bad_response(configured, payload):
    transport = FakeTransport(response(body=json.dumps(payload).encode()))

    with pytest.raises(client.UpstreamResponseError):
        client.invoke([{"role": "user", "content": "x"}], max_tokens=512, transport=transport)


def test_content_parts_response_is_joined(configured):
    body = ok_body(choices=[{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant",
                                         "content": [{"type": "text", "text": "你"},
                                                     {"type": "text", "text": "好"}]}}])
    transport = FakeTransport(response(body=body))

    assert client.invoke([{"role": "user", "content": "x"}], max_tokens=512,
                         transport=transport).text == "你好"


def test_urllib_transport_bounds_the_read_and_keeps_status(monkeypatch):
    """The production transport must bound body reads and never raise on HTTP errors."""
    read_sizes = []

    class FakeHTTPResponse:
        status = 200
        headers = {"Content-Type": "application/json"}

        def read(self, size=-1):
            read_sizes.append(size)
            return b"{}"

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def fake_urlopen(request, timeout=None):
        assert request.method == "POST"
        assert request.get_header("Authorization").startswith("Bearer ")
        assert timeout == 5.0
        return FakeHTTPResponse()

    monkeypatch.setattr(client.urllib.request, "urlopen", fake_urlopen)
    transport = client.UrllibTransport()
    result = transport.post_json("https://api.deepseek.com/chat/completions",
                                 {"model": "deepseek-flash"}, {"Authorization": "Bearer x"},
                                 5.0, 4096)

    assert result.status == 200 and result.body == b"{}"
    assert read_sizes == [4097]


def test_urllib_transport_maps_http_error_to_status_without_raising(monkeypatch):
    def fake_urlopen(request, timeout=None):
        raise urllib.error.HTTPError(
            request.full_url, 429, "Too Many Requests", {"Retry-After": "3"}, None)

    monkeypatch.setattr(client.urllib.request, "urlopen", fake_urlopen)
    result = client.UrllibTransport().post_json(
        "https://api.deepseek.com/chat/completions", {}, {}, 5.0, 16)

    assert result.status == 429
    assert result.headers["retry-after"] == "3"


@pytest.mark.parametrize("raised,expected", [
    (urllib.error.URLError(socket.timeout("timed out")), client.UpstreamTimeout),
    (urllib.error.URLError(OSError("refused")), client.UpstreamUnavailable),
    (ConnectionResetError("reset"), client.UpstreamUnavailable),
    (socket.timeout("timed out"), client.UpstreamTimeout),
])
def test_urllib_transport_classifies_socket_failures(monkeypatch, raised, expected):
    def fake_urlopen(request, timeout=None):
        raise raised

    monkeypatch.setattr(client.urllib.request, "urlopen", fake_urlopen)
    transport = client.UrllibTransport()

    with pytest.raises(expected) as failure:
        transport.post_json("https://api.deepseek.com/chat/completions", {}, {}, 5.0, 16)

    assert SECRET not in str(failure.value)
