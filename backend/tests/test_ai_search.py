"""S3-T06 search executor: fixed Brave endpoint, bounded results, honest failures.

Every case injects a fake transport, so no test opens a socket, needs a real
Brave key or spends money. The fake records the exact outbound request, which is
the only way to prove the frozen endpoint/parameters and the request count.
"""

from __future__ import annotations

import json

import pytest

from app.ai import search
from app.ai.client import TransportResponse, UpstreamTimeout

KEY = "synthetic-brave-key-do-not-log"


class FakeSearchTransport:
    def __init__(self, response=None, error=None):
        self.calls = []
        self.response = response
        self.error = error

    def get_json(self, url, params, headers, timeout, max_bytes):
        self.calls.append({"url": url, "params": params, "headers": headers,
                           "timeout": timeout, "max_bytes": max_bytes})
        if self.error is not None:
            raise self.error
        return self.response


def body(results, **overrides):
    payload = {"web": {"results": results}}
    payload.update(overrides)
    return json.dumps(payload).encode()


def result(title="标题", url="https://example.com/a", description="摘要"):
    return {"title": title, "url": url, "description": description}


def response(status=200, raw=None, headers=None, content_type="application/json"):
    return TransportResponse(status=status, body=raw if raw is not None else body([result()]),
                             content_type=content_type, headers=headers or {})


@pytest.fixture
def search_key(monkeypatch):
    monkeypatch.setenv(search.SEARCH_KEY_ENV, KEY)
    return KEY


# ---------------------------------------------------------------------------
# Web access decision (switch / key / deployment kill switch)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("snapshot,enabled,status", [
    ({"web_enabled": True, "search_configured": True, "effective_web_enabled": True},
     True, search.WEB_NOT_NEEDED),
    ({"web_enabled": False, "search_configured": True, "effective_web_enabled": False},
     False, search.WEB_DISABLED),
    ({"web_enabled": True, "search_configured": False, "effective_web_enabled": False},
     False, search.WEB_NOT_CONFIGURED),
    # Preference on and key present, but the deployment switch is off.
    ({"web_enabled": True, "search_configured": True, "effective_web_enabled": False},
     False, search.WEB_DISABLED),
])
def test_web_access_reports_disabled_and_not_configured_separately(snapshot, enabled, status):
    access = search.web_access(snapshot)
    assert access.enabled is enabled
    assert access.status == status


def test_web_access_defaults_to_disabled_when_the_snapshot_is_unusable():
    for snapshot in ({}, None, {"web_enabled": "yes"}):
        access = search.web_access(snapshot)
        assert access.enabled is False
        assert access.status in {search.WEB_DISABLED, search.WEB_NOT_CONFIGURED}


# ---------------------------------------------------------------------------
# The one fixed outbound shape
# ---------------------------------------------------------------------------


def test_outbound_request_uses_the_fixed_brave_endpoint_and_server_key(search_key):
    transport = FakeSearchTransport(response=response())

    outcome = search.search_web("认知失调 定义", transport=transport)

    assert outcome.status == search.WEB_SEARCHED and outcome.requests == 1
    assert len(transport.calls) == 1
    call = transport.calls[0]
    assert call["url"] == search.BRAVE_ENDPOINT == "https://api.search.brave.com/res/v1/web/search"
    assert call["params"]["q"] == "认知失调 定义"
    assert call["params"]["count"] == search.MAX_RESULTS
    assert set(call["params"]) <= {"q", "count"}, "不允许携带额外参数"
    assert call["headers"]["X-Subscription-Token"] == KEY
    assert call["headers"]["Accept"] == "application/json"
    assert call["timeout"] <= search.SEARCH_TIMEOUT_SECONDS
    assert call["max_bytes"] == search.MAX_RESPONSE_BYTES
    # Nothing about the user's private text may travel in headers.
    assert all(KEY not in value or name == "X-Subscription-Token"
               for name, value in call["headers"].items())


def test_endpoint_is_web_search_only_no_answers_service():
    assert "/web/search" in search.BRAVE_ENDPOINT
    assert "answers" not in search.BRAVE_ENDPOINT
    assert search.BRAVE_ENDPOINT.startswith("https://")


def test_results_are_limited_to_five_and_summaries_bounded(search_key):
    many = [result(title=f"标题{i}", url=f"https://example.com/{i}",
                   description="摘" * 900) for i in range(8)]
    transport = FakeSearchTransport(response=response(raw=body(many)))

    outcome = search.search_web("公开主题", transport=transport)

    assert len(outcome.results) == search.MAX_RESULTS == 5
    for item in outcome.results:
        assert len(item.summary) <= search.MAX_SUMMARY_CODE_POINTS
        assert len(item.title) <= search.MAX_TITLE_CODE_POINTS
    assert [item.url for item in outcome.results] == [f"https://example.com/{i}" for i in range(5)]


def test_only_http_and_https_result_urls_are_accepted(search_key):
    mixed = [
        result(url="https://ok.example.com/a"),
        result(url="http://ok.example.com/b"),
        result(url="javascript:alert(1)"),
        result(url="data:text/html;base64,PHNjcmlwdD4="),
        result(url="ftp://example.com/c"),
        result(url="file:///C:/Windows/win.ini"),
        result(url="/relative/path"),
        result(url=""),
        {"title": "无链接", "description": "摘要"},
    ]
    transport = FakeSearchTransport(response=response(raw=body(mixed)))

    outcome = search.search_web("公开主题", transport=transport)

    assert [item.url for item in outcome.results] == [
        "https://ok.example.com/a", "http://ok.example.com/b"]
    assert outcome.status == search.WEB_SEARCHED


def test_summary_markup_is_treated_as_text(search_key):
    transport = FakeSearchTransport(response=response(raw=body([
        result(description="<strong>认知失调</strong> 是 &amp; 一个心理学术语 <script>x</script>")])))

    outcome = search.search_web("公开主题", transport=transport)

    summary = outcome.results[0].summary
    assert "<strong>" not in summary and "<script>" not in summary
    assert "认知失调" in summary and "&" in summary


@pytest.mark.parametrize("failure", [
    response(status=500, raw=b"{}"),
    response(status=429, raw=b"{}"),
    response(status=401, raw=b"{}"),
    response(status=403, raw=b"{}"),
    response(status=200, raw=b"<html>not json</html>", content_type="text/html"),
    response(status=200, raw=b'{"query": {"original": "x"}}'),          # no web key
    response(status=200, raw=b'{"web": null}'),
    response(status=200, raw=b'{"web": {"results": "nope"}}'),
])
def test_unusable_answers_are_reported_as_failed_not_fabricated(search_key, failure):
    transport = FakeSearchTransport(response=failure)

    outcome = search.search_web("公开主题", transport=transport)

    assert outcome.status == search.WEB_FAILED
    assert outcome.results == ()
    assert outcome.requests == 1
    assert outcome.reason and KEY not in outcome.reason


def test_cached_or_copied_credentials_never_appear_in_failures(search_key):
    transport = FakeSearchTransport(response=response(
        status=401, raw=json.dumps({"error": {"detail": KEY}}).encode()))

    outcome = search.search_web("公开主题", transport=transport)

    assert KEY not in json.dumps({"status": outcome.status, "reason": outcome.reason})


@pytest.mark.parametrize("error", [
    UpstreamTimeout("search request timed out"),
    TimeoutError("timed out"),
    OSError("connection reset"),
])
def test_transport_failures_are_classified_as_failed(search_key, error):
    transport = FakeSearchTransport(error=error)

    outcome = search.search_web("公开主题", transport=transport)

    assert outcome.status == search.WEB_FAILED
    assert outcome.requests == 1
    assert outcome.results == ()
    assert outcome.reason in {"timeout", "unavailable"}


def test_oversized_answer_is_rejected_without_buffering(search_key):
    transport = FakeSearchTransport(response=response(
        raw=b"{" + b"x" * (search.MAX_RESPONSE_BYTES + 1)))

    outcome = search.search_web("公开主题", transport=transport)

    assert outcome.status == search.WEB_FAILED and outcome.reason == "too_large"


def test_successful_and_failed_searches_each_count_exactly_one_request(search_key):
    ok = FakeSearchTransport(response=response())
    bad = FakeSearchTransport(response=response(status=503, raw=b"{}"))

    assert search.search_web("甲 主题", transport=ok).requests == 1
    assert search.search_web("乙 主题", transport=bad).requests == 1
