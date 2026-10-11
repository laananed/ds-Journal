"""Brave Web Search access: one fixed endpoint, server-side key, bounded results.

Contract: ``docs/stage3.md`` §4 and ``docs/stage3-architecture.md`` §6.

What this module is responsible for:

- a single fixed HTTPS endpoint (Brave **Web Search**, no Answers service, no
  page fetching, no arbitrary URL the model could name);
- the credential stays in the server process environment and travels only in the
  service's own authentication header — never in the URL, the body, a response,
  a log line or an error message;
- bounds: at most ``MAX_RESULTS`` results, each summary/title truncated by
  Unicode code points, response body size capped, one 10-second search timeout;
- result URLs must be plain ``http``/``https``. ``javascript:``, ``data:``,
  ``file:`` and relative URLs are dropped instead of being passed on;
- privacy gate (:func:`check_public_query`) runs **before** any socket is opened.
  It rejects direct identifiers, long verbatim overlap with the user's own text
  and first-person/private-matter queries. It is a verifiable interception, not a
  semantic proof: an uncertain query is skipped, never sent.

Failure is always reported as :data:`WEB_FAILED` with no results. The module
never invents a result, a citation or a "searched" status.
"""

from __future__ import annotations

import html
import json
import os
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Iterable, Protocol

from app.ai.client import TransportResponse, UpstreamTimeout, UpstreamUnavailable
from app.ai.settings import SEARCH_KEY_ENV, search_configured

#: The one address anything in this feature may reach.
BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search"

#: One search may take at most this long, inside the 90 s whole-call budget.
SEARCH_TIMEOUT_SECONDS = 10.0
#: Bounds from ``docs/stage3-architecture.md`` §6.
MAX_RESULTS = 5
MAX_TITLE_CODE_POINTS = 300
MAX_SUMMARY_CODE_POINTS = 600
MAX_URL_CODE_POINTS = 2_048
MAX_QUERY_CODE_POINTS = 120
#: A query fragment at least this long, matching the user's own text verbatim,
#: is treated as leaked private text.
MIN_PRIVATE_OVERLAP_CODE_POINTS = 12
#: A provider body larger than this is malformed, not buffered.
MAX_RESPONSE_BYTES = 262_144

#: The frozen ``web_status`` vocabulary (``docs/stage3-api.md`` §4).
WEB_DISABLED = "disabled"
WEB_NOT_CONFIGURED = "not_configured"
WEB_NOT_NEEDED = "not_needed"
WEB_SEARCHED = "searched"
WEB_FAILED = "failed"
WEB_BLOCKED = "blocked"

#: ``X-Subscription-Token`` is Brave's documented server-side auth header.
_AUTH_HEADER = "X-Subscription-Token"
#: Safe category codes handed back for a blocked query. They never contain the
#: query itself, so a blocked private query cannot leak through an error path.
REASON_EMPTY = "empty"
REASON_NOT_TEXT = "not_text"
REASON_TOO_LONG = "too_long"
REASON_EMAIL = "email"
REASON_PHONE_OR_ID = "phone_or_id"
REASON_SOURCE_OVERLAP = "source_overlap"
REASON_PRIVATE_MATTER = "private_matter"
REASON_NOT_CONFIGURED = "not_configured"
REASON_TIMEOUT = "timeout"
REASON_UNAVAILABLE = "unavailable"
REASON_AUTH = "auth"
REASON_RATE_LIMITED = "rate_limited"
REASON_REJECTED = "rejected"
REASON_TOO_LARGE = "too_large"
REASON_BAD_RESPONSE = "bad_response"

_EMAIL_LIKE = re.compile(r"[^\s@]+@[^\s@]+\.[A-Za-z]{2,}")
#: 11+ digits, optionally separated: mobile numbers, landlines, ID numbers,
#: bank cards. Short public numbers (years, "第3次") stay allowed.
_PHONE_OR_ID_LIKE = re.compile(r"(?:\d[-\s]?){11,}")
_MARKUP = re.compile(r"<[^>]*>")
_WHITESPACE = re.compile(r"\s+")

#: First-person and close-relationship words. A query containing one of these is
#: treated as private matter and skipped rather than guessed about: the rules
#: cannot tell "how do I sleep better" from a public topic reliably, so the
#: uncertain case is not sent and the model is told to explain instead.
_PRIVATE_MARKERS = (
    "我", "本人", "自己", "咱", "我家",
    "老公", "老婆", "丈夫", "妻子", "男友", "女友", "男朋友", "女朋友", "对象", "前任",
    "儿子", "女儿", "孩子", "爸爸", "妈妈", "父亲", "母亲", "爸妈", "爷爷", "奶奶",
    "同事", "领导", "老板", "上司", "室友", "闺蜜", "朋友", "亲戚",
)


@dataclass(frozen=True)
class WebAccess:
    """Whether the tool may be offered, and the honest status to report."""

    enabled: bool
    status: str


@dataclass(frozen=True)
class QueryVerdict:
    """Outcome of the public-query gate. ``reason`` is a code, never the query."""

    allowed: bool
    query: str | None
    reason: str | None


@dataclass(frozen=True)
class SearchResult:
    title: str
    url: str
    summary: str


@dataclass(frozen=True)
class SearchOutcome:
    """What one search attempt produced, including how many requests it cost."""

    status: str
    query: str
    results: tuple[SearchResult, ...] = ()
    #: Actual outbound requests. A blocked or unconfigured query is ``0``.
    requests: int = 0
    reason: str | None = None


def web_access(settings_snapshot: Any) -> WebAccess:
    """Decide tool availability from a frozen settings snapshot.

    ``effective_web_enabled`` already folds in the user preference, the search
    key and the deployment kill switch, so the difference between "the user
    turned it off" and "there is no key" is reconstructed here:

    - preference off (or the deployment switch off) -> ``disabled``;
    - preference on but no key -> ``not_configured``;
    - otherwise the tool may be offered and the initial status is ``not_needed``.
    """
    data = settings_snapshot if isinstance(settings_snapshot, dict) else {}
    preference = data.get("web_enabled") is True
    configured = data.get("search_configured") is True
    effective = data.get("effective_web_enabled") is True
    if not preference:
        return WebAccess(False, WEB_DISABLED)
    if not configured:
        return WebAccess(False, WEB_NOT_CONFIGURED)
    if effective:
        return WebAccess(True, WEB_NOT_NEEDED)
    return WebAccess(False, WEB_DISABLED)


def _has_continuous_overlap(query: str, texts: Iterable[Any], size: int) -> bool:
    """Whether ``query`` shares any ``size``-code-point run with a private text."""
    if len(query) < size:
        return False
    for text in texts:
        if not isinstance(text, str) or len(text) < size:
            continue
        windows = {text[index:index + size] for index in range(len(text) - size + 1)}
        for index in range(len(query) - size + 1):
            if query[index:index + size] in windows:
                return True
    return False


def check_public_query(query: Any, source_texts: Iterable[Any] = ()) -> QueryVerdict:
    """Validate a model-formed search query before anything can leave the process.

    Order matters: shape, then direct identifiers, then verbatim overlap with the
    user's own text, then the conservative private-matter list.
    """
    if not isinstance(query, str):
        return QueryVerdict(False, None, REASON_NOT_TEXT)
    text = query.strip()
    if not text:
        return QueryVerdict(False, None, REASON_EMPTY)
    if len(text) > MAX_QUERY_CODE_POINTS:
        return QueryVerdict(False, None, REASON_TOO_LONG)
    if _EMAIL_LIKE.search(text):
        return QueryVerdict(False, None, REASON_EMAIL)
    if _PHONE_OR_ID_LIKE.search(text):
        return QueryVerdict(False, None, REASON_PHONE_OR_ID)
    if _has_continuous_overlap(text, source_texts, MIN_PRIVATE_OVERLAP_CODE_POINTS):
        return QueryVerdict(False, None, REASON_SOURCE_OVERLAP)
    if any(marker in text for marker in _PRIVATE_MARKERS):
        return QueryVerdict(False, None, REASON_PRIVATE_MATTER)
    return QueryVerdict(True, text, None)


class SearchTransport(Protocol):
    """The single seam between this module and the search provider."""

    def get_json(
        self,
        url: str,
        params: dict[str, Any],
        headers: dict[str, str],
        timeout: float,
        max_bytes: int,
    ) -> TransportResponse: ...


class UrllibSearchTransport:
    """Standard-library GET transport; no third-party HTTP dependency."""

    def get_json(
        self,
        url: str,
        params: dict[str, Any],
        headers: dict[str, str],
        timeout: float,
        max_bytes: int,
    ) -> TransportResponse:
        full_url = f"{url}?{urllib.parse.urlencode(params)}"
        request = urllib.request.Request(full_url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return TransportResponse(
                    status=response.status,
                    body=response.read(max_bytes + 1),
                    content_type=response.headers.get("Content-Type", ""),
                    headers={key.lower(): value for key, value in response.headers.items()},
                )
        except urllib.error.HTTPError as error:
            try:
                body = error.read(max_bytes + 1)
            except Exception:  # noqa: BLE001 - a broken error body is still an error
                body = b""
            return TransportResponse(
                status=error.code,
                body=body,
                content_type=(error.headers or {}).get("Content-Type", ""),
                headers={key.lower(): value for key, value in (error.headers or {}).items()},
            )
        except (socket.timeout, TimeoutError) as error:
            raise UpstreamTimeout("search request timed out") from error
        except urllib.error.URLError as error:
            if isinstance(error.reason, (socket.timeout, TimeoutError)):
                raise UpstreamTimeout("search request timed out") from error
            raise UpstreamUnavailable("search endpoint is unreachable") from error
        except OSError as error:
            raise UpstreamUnavailable("search endpoint is unreachable") from error


class _UnusableAnswer(RuntimeError):
    """The provider answered, but not with a usable web result list."""


def _clean_text(value: Any, limit: int) -> str:
    """Plain text only: strip markup, decode entities, collapse whitespace."""
    if not isinstance(value, str):
        return ""
    text = html.unescape(_MARKUP.sub("", value))
    return _WHITESPACE.sub(" ", text).strip()[:limit]


def _safe_url(value: Any) -> str | None:
    """Only absolute ``http``/``https`` result URLs are passed on."""
    if not isinstance(value, str):
        return None
    url = value.strip()
    if not url.startswith(("http://", "https://")):
        return None
    if len(url) > MAX_URL_CODE_POINTS:
        return None
    return url


def _extract_results(payload: Any) -> tuple[SearchResult, ...]:
    if not isinstance(payload, dict):
        raise _UnusableAnswer("search response was not a JSON object")
    web = payload.get("web")
    if not isinstance(web, dict):
        raise _UnusableAnswer("search response has no web results")
    raw = web.get("results")
    if not isinstance(raw, list):
        raise _UnusableAnswer("search response has no result list")
    results: list[SearchResult] = []
    for item in raw:
        if len(results) >= MAX_RESULTS:
            break
        if not isinstance(item, dict):
            continue
        url = _safe_url(item.get("url"))
        if url is None:
            continue
        title = _clean_text(item.get("title"), MAX_TITLE_CODE_POINTS) or url
        summary = _clean_text(item.get("description"), MAX_SUMMARY_CODE_POINTS)
        results.append(SearchResult(title=title, url=url, summary=summary))
    return tuple(results)


def _decode(response: TransportResponse, max_bytes: int) -> Any:
    if len(response.body) > max_bytes:
        raise _UnusableAnswer("search response exceeded the size limit")
    try:
        return json.loads(response.body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as error:
        raise _UnusableAnswer("search response was not valid JSON") from error


def _failure_reason(response: TransportResponse) -> str:
    if response.status in (401, 403):
        return REASON_AUTH
    if response.status == 429:
        return REASON_RATE_LIMITED
    if response.status >= 500:
        return REASON_UNAVAILABLE
    return REASON_REJECTED


def search_web(
    query: Any,
    *,
    source_texts: Iterable[Any] = (),
    transport: SearchTransport | None = None,
    timeout: float = SEARCH_TIMEOUT_SECONDS,
    max_bytes: int = MAX_RESPONSE_BYTES,
) -> SearchOutcome:
    """Perform one bounded public Web Search, or explain why it did not happen.

    ``requests`` counts only real outbound calls: a blocked, unconfigured or
    never-attempted search is ``0``. Every failure returns ``WEB_FAILED`` with no
    results so a caller can never mistake it for a verified answer.
    """
    verdict = check_public_query(query, source_texts)
    if not verdict.allowed:
        # Nothing is sent; the reason is a code, so the private text stays here.
        return SearchOutcome(status=WEB_BLOCKED, query="", requests=0, reason=verdict.reason)
    if not search_configured():
        return SearchOutcome(status=WEB_NOT_CONFIGURED, query=verdict.query, requests=0,
                             reason=REASON_NOT_CONFIGURED)

    params = {"q": verdict.query, "count": MAX_RESULTS}
    headers = {
        "Accept": "application/json",
        "Accept-Encoding": "identity",
        _AUTH_HEADER: os.environ[SEARCH_KEY_ENV].strip(),
    }
    try:
        response = (transport or UrllibSearchTransport()).get_json(
            BRAVE_ENDPOINT, params, headers, timeout, max_bytes
        )
    except UpstreamTimeout:
        return SearchOutcome(status=WEB_FAILED, query=verdict.query, requests=1,
                             reason=REASON_TIMEOUT)
    except (UpstreamUnavailable, OSError):
        return SearchOutcome(status=WEB_FAILED, query=verdict.query, requests=1,
                             reason=REASON_UNAVAILABLE)
    except Exception:  # noqa: BLE001 - an unknown transport fault is still a failure
        return SearchOutcome(status=WEB_FAILED, query=verdict.query, requests=1,
                             reason=REASON_UNAVAILABLE)

    if response.status >= 400:
        return SearchOutcome(status=WEB_FAILED, query=verdict.query, requests=1,
                             reason=_failure_reason(response))
    try:
        payload = _decode(response, max_bytes)
        results = _extract_results(payload)
    except _UnusableAnswer as error:
        reason = REASON_TOO_LARGE if "size limit" in str(error) else REASON_BAD_RESPONSE
        return SearchOutcome(status=WEB_FAILED, query=verdict.query, requests=1, reason=reason)
    return SearchOutcome(status=WEB_SEARCHED, query=verdict.query, results=results, requests=1)
