"""S3-T03 real HTTP check: the AI routes over a real uvicorn process.

The in-process ``TestClient`` never opens a socket, so it cannot prove that the
routes are reachable, that the JSON shapes survive the wire, or that a rejected
body is not echoed back. This module starts one uvicorn instance on a free
loopback port against ``seekjournal_test`` and drives it with
``urllib.request`` (standard library only, no new dependency).

The server log goes to a file rather than a pipe, and to the system temp
directory: this sandbox lets the spawned server write only there. Every row
created here is deleted in teardown, so the shared test database is left exactly
as found.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.ai.settings import SEARCH_KEY_ENV
from app.database import engine

BACKEND = Path(__file__).resolve().parents[1]
SECRET = "sk-synthetic-http-never-logged"


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _server_env() -> dict[str, str]:
    from scripts.prepare_test_db import get_test_database_url

    env = dict(os.environ)
    # The server process — not the test runner — must point at the test database.
    env["DATABASE_URL"] = get_test_database_url().render_as_string(hide_password=False)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env.pop("DEEPSEEK_API_KEY", None)
    env.pop(SEARCH_KEY_ENV, None)
    return env


def _request(method: str, port: int, path: str, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=data, method=method,
        headers={"Content-Type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            body = response.read(65_536)
            return response.status, json.loads(body) if body else None
    except urllib.error.HTTPError as error:
        body = error.read(65_536)
        return error.code, json.loads(body) if body else None


def _cleanup() -> None:
    """Remove every row this module committed.

    Unlike the in-process tests, a real HTTP write is really committed, so the
    teardown has to delete it. ``ai_usage`` and ``ai_requests`` are removed
    first: the ledger row is intentionally *not* cascaded away when its source
    journal disappears, which is exactly the behaviour the product wants but
    would otherwise leave rows behind here.
    """
    with engine.begin() as connection:
        connection.execute(text("DELETE FROM ai_usage"))
        connection.execute(text("DELETE FROM ai_requests"))
        connection.execute(text("DELETE FROM ai_settings"))
        connection.execute(text("DELETE FROM journals"))


@pytest.fixture
def live_server():
    """One real uvicorn process bound to loopback and to seekjournal_test."""
    port = _free_port()
    log_path = Path(tempfile.gettempdir()) / f"seekjournal-s3t03-uvicorn-{port}.log"
    with log_path.open("w", encoding="utf-8") as log:
        process = subprocess.Popen(
            [sys.executable, "-B", "-m", "uvicorn", "app.main:app",
             "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning"],
            cwd=BACKEND, env=_server_env(),
            stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
        )
        try:
            deadline = time.time() + 45
            ready = False
            while time.time() < deadline:
                if process.poll() is not None:
                    break
                try:
                    if _request("GET", port, "/api/health")[0] == 200:
                        ready = True
                        break
                except OSError:
                    time.sleep(0.25)
            if not ready:
                log.flush()
                tail = log_path.read_text(encoding="utf-8", errors="replace")[-600:]
                raise AssertionError(
                    f"uvicorn did not become ready (exit={process.poll()}): {tail}")
            yield port
        finally:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
            _cleanup()
    # Closed above; the file is removed only after the handle is released.
    log_path.unlink(missing_ok=True)


def _usage(port: int) -> dict[str, int]:
    status, payload = _request("GET", port, "/api/ai/usage")
    assert status == 200
    return payload


def _delta(before: dict[str, int], after: dict[str, int]) -> dict[str, int]:
    """Usage totals only ever grow, so assertions compare deltas.

    Real HTTP writes are committed for real, which makes absolute totals depend
    on test order. The delta is what this test actually created.
    """
    return {key: after[key] - before[key] for key in before}


def _row_counts() -> dict[str, int]:
    with engine.connect() as connection:
        return {
            table: connection.execute(text(f"SELECT count(*) FROM {table}")).scalar_one()
            for table in ("journals", "ai_requests", "ai_usage", "ai_settings")
        }


def test_http_module_leaves_the_shared_test_database_empty():
    """Guard: the real-HTTP writes above must be fully removed by their teardown.

    A real HTTP request commits for real, so this is the check that the module
    did not silently leave committed rows in the shared test database.
    """
    assert _row_counts() == {"journals": 0, "ai_requests": 0,
                             "ai_usage": 0, "ai_settings": 0}


def test_http_settings_lifecycle_over_a_real_socket(live_server):
    port = live_server
    status, first = _request("GET", port, "/api/ai/settings")
    assert status == 200
    assert first == {"custom_prompt": "", "web_enabled": True, "revision": 0,
                     "model": "deepseek-flash", "model_configured": False,
                     "search_configured": False, "effective_web_enabled": False}

    status, created = _request("PATCH", port, "/api/ai/settings",
                              {"expected_revision": 0, "custom_prompt": "真的 HTTP"})
    assert status == 200 and created["revision"] == 1
    assert created["custom_prompt"] == "真的 HTTP"

    assert _request("PATCH", port, "/api/ai/settings", {"custom_prompt": "x"})[0] == 428
    assert _request("PATCH", port, "/api/ai/settings",
                    {"expected_revision": 0, "custom_prompt": "x"})[0] == 409

    # A rejected body must not be echoed back over the wire.
    status, forbidden = _request("PATCH", port, "/api/ai/settings",
                                 {"expected_revision": 1, "api_key": SECRET})
    assert status == 422 and SECRET not in json.dumps(forbidden)
    status, echoed = _request("PATCH", port, "/api/ai/settings",
                              {"expected_revision": 1, "model": SECRET})
    assert status == 422 and SECRET not in json.dumps(echoed)

    # Still usable after those failures, and the earlier write survived.
    status, persisted = _request("GET", port, "/api/ai/settings")
    assert status == 200 and persisted["custom_prompt"] == "真的 HTTP"

    before = _usage(port)
    assert _request("PATCH", port, "/api/ai/settings",
                    {"expected_revision": 1, "custom_prompt": "改了"})[0] == 200
    assert _delta(before, _usage(port)) == {
        "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0,
        "unknown_subcalls": 0, "search_requests": 0,
    }


def test_http_file_calls_uses_typed_identity_over_a_real_socket(live_server):
    from uuid import uuid4

    from app.ai.models import AIRequest, AIUsage

    port = live_server
    before = _usage(port)
    status, journal = _request("POST", port, "/api/journals",
                               {"content": "synthetic http source",
                                "journal_date": "2026-10-10"})
    assert status == 201
    request_id = uuid4()
    with Session(bind=engine) as session:
        session.add(AIRequest(id=request_id, kind="local", payload_hash="http-hash",
                              status="applied",
                              sources=[{"type": "journal", "id": journal["id"],
                                        "revision": 1, "user_text": "private snapshot"}],
                              settings={}, question="private question"))
        session.add(AIUsage(request_id=request_id, subcall_index=0, metering="known",
                            prompt_tokens=5, completion_tokens=6, total_tokens=11,
                            search_requests=1))
        session.commit()

    status, page = _request("GET", port, f"/api/files/journal/{journal['id']}/ai-calls")
    assert status == 200 and page["total"] == 1
    item = page["items"][0]
    assert item["request_id"] == str(request_id)
    assert item["sources"] == [{"type": "journal", "id": journal["id"], "revision": 1}]
    assert item["total_tokens"] == 11 and item["search_requests"] == 1
    # Private request content stays out of the listing, even on the wire.
    body = json.dumps(page)
    assert "private snapshot" not in body and "private question" not in body

    status, usage = _request("GET", port, "/api/ai/usage")
    assert status == 200
    assert _delta(before, usage) == {"prompt_tokens": 5, "completion_tokens": 6,
                                     "total_tokens": 11, "unknown_subcalls": 0,
                                     "search_requests": 1}

    assert _request("GET", port, "/api/files/journal/999999/ai-calls")[0] == 404
    assert _request("GET", port, "/api/files/insight/1/ai-calls")[0] == 422


def test_http_server_reports_unconfigured_model_instead_of_calling_out(live_server):
    """No key in the server environment: the status says so, and nothing is sent."""
    port = live_server
    status, payload = _request("GET", port, "/api/ai/settings")

    assert status == 200 and payload["model_configured"] is False
    # A request body cannot smuggle a key or a different endpoint.
    assert _request("PATCH", port, "/api/ai/settings",
                    {"expected_revision": 0, "base_url": "http://evil.test"})[0] == 422
    assert _request("PATCH", port, "/api/ai/settings",
                    {"expected_revision": 0, "api_key": SECRET})[0] == 422
