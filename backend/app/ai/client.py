"""Minimal official DeepSeek HTTP client for Stage 3 / S3-T03.

Scope is deliberately small: one function that performs **one** bounded
``POST /chat/completions`` call and reports what the provider actually returned.
No retries, no streaming, no tool loop, no queue, no SDK. Later tasks (T05/T06)
add their own turn/orchestration logic on top of this transport.

Facts fixed here (``docs/stage3-architecture.md`` §6):

- official HTTPS address ``https://api.deepseek.com/chat/completions``;
- model ``deepseek-flash``, non-thinking (``thinking={"type": "disabled"}``),
  non-streaming (``stream=False``);
- the key is read from the server process environment ``DEEPSEEK_API_KEY``
  only. It is never accepted from a request body, never written to the
  database, never returned in a response and never included in an error
  message or log line;
- requests are bounded: connect/read timeout, maximum response body size,
  whitelisted request parameters only.

Transport seam: :func:`invoke` accepts any object with a
``post_json(url, payload, headers, timeout, max_bytes)`` method. Production uses
:class:`UrllibTransport` (Python standard library only). Tests inject a fake
transport, so no test needs a real key, a real socket or a paid call.
"""

from __future__ import annotations

import json
import os
import socket
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Protocol

API_ENDPOINT = "https://api.deepseek.com/chat/completions"
MODEL = "deepseek-flash"
API_KEY_ENV = "DEEPSEEK_API_KEY"

#: Total deadline for one subcall, from ``docs/stage3-architecture.md`` §6.
DEFAULT_TIMEOUT_SECONDS = 90.0
#: Any provider body larger than this is treated as malformed instead of buffered.
MAX_RESPONSE_BYTES = 1_048_576

#: Product budgets from ``docs/stage3-architecture.md`` §6 (local / review).
LOCAL_MAX_TOKENS = 512
REVIEW_MAX_TOKENS = 4096

#: Only these optional parameters may reach the official endpoint. A frontend
#: can therefore never redirect the call, change the model or enable streaming.
_ALLOWED_PARAMETERS = frozenset({"tools", "tool_choice"})


class AIClientError(RuntimeError):
    """Base class for safe, provider-agnostic client failures.

    ``str(error)`` is always a fixed, shareable sentence: it never contains the
    API key, the Authorization header, the provider's raw body or a traceback.
    """

    #: Error category persisted with the request (``ai_requests.error_category``).
    category = "upstream_error"


class ModelNotConfigured(AIClientError):
    """``DEEPSEEK_API_KEY`` is absent; nothing was sent."""

    category = "not_configured"


class UpstreamAuthError(AIClientError):
    """The provider rejected our credentials (HTTP 401/403)."""

    category = "auth"


class UpstreamRateLimited(AIClientError):
    """The provider asked us to slow down (HTTP 429)."""

    category = "rate_limited"


class UpstreamTimeout(AIClientError):
    """Connect or total deadline elapsed before a usable response arrived."""

    category = "timeout"


class UpstreamUnavailable(AIClientError):
    """Connection refused/reset, DNS failure, HTTP 5xx."""

    category = "unavailable"


class UpstreamResponseError(AIClientError):
    """Reachable provider, unusable answer: non-JSON, oversized or truncated."""

    category = "bad_response"


@dataclass(frozen=True)
class TransportResponse:
    """What a transport hands back; ``body`` is already bounded and decoded."""

    status: int
    body: bytes
    content_type: str = ""
    headers: dict[str, str] = field(default_factory=dict)


class Transport(Protocol):
    """The single seam between this client and the network."""

    def post_json(
        self,
        url: str,
        payload: dict[str, Any],
        headers: dict[str, str],
        timeout: float,
        max_bytes: int,
    ) -> TransportResponse: ...


class UrllibTransport:
    """Standard-library transport. No third-party HTTP dependency is required."""

    def post_json(
        self,
        url: str,
        payload: dict[str, Any],
        headers: dict[str, str],
        timeout: float,
        max_bytes: int,
    ) -> TransportResponse:
        request = urllib.request.Request(
            url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return TransportResponse(
                    status=response.status,
                    body=response.read(max_bytes + 1),
                    content_type=response.headers.get("Content-Type", ""),
                    headers={k.lower(): v for k, v in response.headers.items()},
                )
        except urllib.error.HTTPError as error:
            # Body is read with the same bound; it is only used to classify the
            # failure, never stored or echoed.
            try:
                body = error.read(max_bytes + 1)
            except Exception:  # noqa: BLE001 - a broken error body is still an error
                body = b""
            return TransportResponse(
                status=error.code,
                body=body,
                content_type=(error.headers or {}).get("Content-Type", ""),
                headers={k.lower(): v for k, v in (error.headers or {}).items()},
            )
        except socket.timeout as error:
            raise UpstreamTimeout("model request timed out") from error
        except TimeoutError as error:
            raise UpstreamTimeout("model request timed out") from error
        except urllib.error.URLError as error:
            reason = error.reason
            if isinstance(reason, (socket.timeout, TimeoutError)):
                raise UpstreamTimeout("model request timed out") from error
            # URLError text may embed proxy/OS detail; keep only the category.
            raise UpstreamUnavailable("model endpoint is unreachable") from error
        except OSError as error:
            # Connection reset/aborted and similar socket-level failures.
            raise UpstreamUnavailable("model endpoint is unreachable") from error


@dataclass(frozen=True)
class ModelUsage:
    """Measured token usage of exactly one provider subcall."""

    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    cache_hit_tokens: int | None = None
    cache_miss_tokens: int | None = None


@dataclass(frozen=True)
class ModelResult:
    """One successful subcall.

    ``usage`` is ``None`` when the provider answered without usable usage
    figures. Callers must record that as ``unknown`` metering rather than as
    zero (``docs/stage3-architecture.md`` §5).
    """

    text: str
    response_id: str | None
    usage: ModelUsage | None
    finish_reason: str | None

    @property
    def truncated(self) -> bool:
        """``finish_reason == "length"`` means the answer is incomplete."""
        return self.finish_reason == "length"


def is_configured() -> bool:
    """Whether this process has a usable model key. Never reveals the value."""
    return bool((os.environ.get(API_KEY_ENV) or "").strip())


def configured_models() -> dict[str, bool]:
    """Configuration status used by the settings response (no secret values)."""
    from app.ai.settings import search_configured

    return {"model_configured": is_configured(), "search_configured": search_configured()}


def _positive_int_or_none(value: Any) -> int | None:
    """Usage counters must be real integers >= 0; anything else is unusable."""
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def parse_usage(payload: dict[str, Any]) -> ModelUsage | None:
    """Extract official usage, or ``None`` when any required counter is missing.

    Cache counters are informational only. They are **not** added to
    ``prompt_tokens``: the provider already includes cache hits there, so adding
    them again would double count (``docs/stage3-architecture.md`` §5).
    """
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        return None
    prompt = _positive_int_or_none(usage.get("prompt_tokens"))
    completion = _positive_int_or_none(usage.get("completion_tokens"))
    total = _positive_int_or_none(usage.get("total_tokens"))
    if prompt is None or completion is None or total is None:
        return None
    cache_hit = _positive_int_or_none(usage.get("prompt_cache_hit_tokens"))
    cache_miss = _positive_int_or_none(usage.get("prompt_cache_miss_tokens"))
    return ModelUsage(prompt, completion, total, cache_hit, cache_miss)


def _extract_message_text(message: Any) -> str:
    if isinstance(message, str):
        return message
    if isinstance(message, list):
        # Some official responses send content parts instead of one string.
        return "".join(
            part.get("text", "")
            for part in message
            if isinstance(part, dict) and isinstance(part.get("text"), str)
        )
    return ""


def parse_completion(payload: dict[str, Any]) -> ModelResult:
    """Validate the answer shape; unusable answers raise a safe error."""
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        raise UpstreamResponseError("model response has no completion choices")
    first = choices[0]
    if not isinstance(first, dict):
        raise UpstreamResponseError("model response has an invalid choice")
    message = first.get("message")
    if not isinstance(message, dict):
        raise UpstreamResponseError("model response has no message")
    text = _extract_message_text(message.get("content"))
    if not text.strip():
        raise UpstreamResponseError("model response contains no text")
    finish_reason = first.get("finish_reason")
    response_id = payload.get("id")
    return ModelResult(
        text=text,
        response_id=response_id if isinstance(response_id, str) else None,
        usage=parse_usage(payload),
        finish_reason=finish_reason if isinstance(finish_reason, str) else None,
    )


def _safe_error_detail(body: bytes, content_type: str) -> str:
    """Return a short provider error code, never provider text or credentials.

    Only the documented ``error.type``/``error.code`` identifiers are kept; the
    human-readable message is dropped because it can echo request content or the
    Authorization header back at us.
    """
    if "json" not in content_type.lower() and not body.lstrip().startswith(b"{"):
        return ""
    try:
        payload = json.loads(body.decode("utf-8", errors="replace"))
    except (ValueError, UnicodeDecodeError):
        return ""
    if not isinstance(payload, dict):
        return ""
    error = payload.get("error")
    if not isinstance(error, dict):
        return ""
    parts: list[str] = []
    for field_name in ("type", "code"):
        value = error.get(field_name)
        if isinstance(value, str) and value.strip() and value.strip() not in parts:
            parts.append(value.strip()[:64])
    return "/".join(parts)


def _decode_body(response: TransportResponse) -> dict[str, Any]:
    if len(response.body) > MAX_RESPONSE_BYTES:
        raise UpstreamResponseError("model response exceeded the size limit")
    try:
        payload = json.loads(response.body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as error:
        raise UpstreamResponseError("model response was not valid JSON") from error
    if not isinstance(payload, dict):
        raise UpstreamResponseError("model response was not a JSON object")
    return payload


def _raise_for_status(response: TransportResponse) -> None:
    status = response.status
    if status < 400:
        return
    detail = _safe_error_detail(response.body, response.content_type)
    suffix = f" ({detail})" if detail else ""
    if status in (401, 403):
        raise UpstreamAuthError(f"model credentials were rejected (HTTP {status}){suffix}")
    if status == 429:
        retry_after = response.headers.get("retry-after")
        seconds = None
        if isinstance(retry_after, str) and retry_after.strip().isdigit():
            seconds = int(retry_after.strip())
        error = UpstreamRateLimited(f"model rate limit reached (HTTP 429){suffix}")
        if seconds is not None:
            # Safe metadata for callers/tests; no content, no credentials.
            error.retry_after_seconds = seconds  # type: ignore[attr-defined]
        raise error
    if status >= 500:
        raise UpstreamUnavailable(f"model provider is unavailable (HTTP {status}){suffix}")
    raise UpstreamResponseError(f"model provider rejected the request (HTTP {status}){suffix}")


def build_payload(
    messages: list[dict[str, Any]],
    *,
    max_tokens: int,
    parameters: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the exact official request body for one subcall.

    ``parameters`` only contributes whitelisted keys, so a caller cannot smuggle
    in a different model, base URL, stream flag or thinking mode.
    """
    extra = {key: value for key, value in (parameters or {}).items() if key in _ALLOWED_PARAMETERS}
    return {
        "model": MODEL,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": False,
        "thinking": {"type": "disabled"},
        **extra,
    }


def invoke(
    messages: list[dict[str, Any]],
    *,
    max_tokens: int,
    parameters: dict[str, Any] | None = None,
    transport: Transport | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    max_bytes: int = MAX_RESPONSE_BYTES,
) -> ModelResult:
    """Perform one bounded official call and return its result.

    Raises :class:`ModelNotConfigured` **before** any network activity when the
    process has no key, so "not configured" never consumes quota.
    """
    if not is_configured():
        raise ModelNotConfigured("model is not configured on the server")
    key = os.environ[API_KEY_ENV].strip()
    payload = build_payload(messages, max_tokens=max_tokens, parameters=parameters)
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    try:
        response = (transport or UrllibTransport()).post_json(
            API_ENDPOINT, payload, headers, timeout, max_bytes
        )
    except AIClientError:
        # Already classified by the transport (for example HTTP status codes).
        raise
    except (TimeoutError, socket.timeout) as error:
        raise UpstreamTimeout("model request timed out") from error
    except OSError as error:
        # Connection reset/aborted and similar socket-level failures. The
        # original text is not reused: it can carry local paths or proxy detail.
        raise UpstreamUnavailable("model endpoint is unreachable") from error
    _raise_for_status(response)
    payload = _decode_body(response)
    try:
        return parse_completion(payload)
    except UpstreamResponseError as error:
        # T05 must retain already spent metering even when answer validation
        # fails. Only these safe fields escape; never attach the provider body.
        error.usage = parse_usage(payload)
        response_id = payload.get("id")
        error.response_id = response_id if isinstance(response_id, str) else None
        raise
