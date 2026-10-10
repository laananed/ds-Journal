"""S3-T03 settings API tests: zero-write default, single row, CAS, 4,000 code points."""
import pytest
from sqlalchemy import event, select, text

from app.ai.client import MODEL
from app.ai.models import AISettings
from app.ai.settings import CUSTOM_PROMPT_MAX_CODE_POINTS, SEARCH_KEY_ENV

SETTINGS_ROW = "SELECT count(*) FROM ai_settings"
WRITE_KEYWORDS = ("insert", "update", "delete")


def counting_writes(engine):
    """Record real write statements sent to the database.

    A read path may still trigger SQLAlchemy's *autoflush*, which is a no-op when
    the Session holds no pending objects. What must never happen on a GET is an
    actual ``INSERT``/``UPDATE``/``DELETE``, so that is what gets counted here.
    Returns ``(statements, stop)``.
    """
    statements: list[str] = []

    def before_cursor_execute(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement.strip())

    event.listen(engine, "before_cursor_execute", before_cursor_execute)
    return statements, lambda: event.remove(engine, "before_cursor_execute",
                                            before_cursor_execute)


def writes_to(statements, table):
    return [s for s in statements
            if s.lower().split()[0] in WRITE_KEYWORDS and table in s.lower()]


DEFAULT_SHAPE = {
    "custom_prompt": "",
    "web_enabled": True,
    "revision": 0,
    "model": MODEL,
    "model_configured": False,
    "search_configured": False,
    "effective_web_enabled": False,
}


@pytest.fixture(autouse=True)
def no_keys(monkeypatch):
    """Start every case from "nothing configured" for deterministic status flags."""
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.delenv(SEARCH_KEY_ENV, raising=False)
    monkeypatch.delenv("WEB_SEARCH_ENABLED", raising=False)


def test_get_settings_returns_defaults_without_creating_a_row(api):
    client, db = api

    first = client.get("/api/ai/settings")
    second = client.get("/api/ai/settings")

    assert first.status_code == 200 and second.status_code == 200
    assert first.json() == DEFAULT_SHAPE
    assert second.json() == DEFAULT_SHAPE
    assert db.scalar(text(SETTINGS_ROW)) == 0


def test_get_settings_issues_no_write_statement(api):
    client, db = api
    statements, stop = counting_writes(db.get_bind())
    try:
        assert client.get("/api/ai/settings").status_code == 200
        assert client.get("/api/ai/usage").status_code == 200
    finally:
        stop()

    assert writes_to(statements, "ai_settings") == []
    assert db.scalar(text(SETTINGS_ROW)) == 0


def test_settings_response_never_contains_a_key_even_when_configured(api, monkeypatch):
    client, _ = api
    secret = "sk-synthetic-settings-key"
    monkeypatch.setenv("DEEPSEEK_API_KEY", secret)
    monkeypatch.setenv(SEARCH_KEY_ENV, "brave-synthetic-key")

    body = client.get("/api/ai/settings").text

    assert secret not in body and "brave-synthetic-key" not in body
    payload = client.get("/api/ai/settings").json()
    assert payload["model_configured"] is True and payload["search_configured"] is True
    # Preference true plus a configured key is the only case that enables web.
    assert payload["effective_web_enabled"] is True


def test_effective_web_enabled_is_false_when_preference_true_but_key_missing(api):
    client, _ = api
    assert client.get("/api/ai/settings").json()["effective_web_enabled"] is False

    created = client.patch("/api/ai/settings", json={"expected_revision": 0,
                                                     "web_enabled": True}).json()

    assert created["web_enabled"] is True and created["effective_web_enabled"] is False


def test_first_patch_creates_the_single_row_with_revision_one(api):
    client, db = api

    response = client.patch("/api/ai/settings",
                            json={"expected_revision": 0, "custom_prompt": "写得温柔一点"})

    assert response.status_code == 200
    assert response.json() == {**DEFAULT_SHAPE, "custom_prompt": "写得温柔一点", "revision": 1}
    assert db.scalar(text(SETTINGS_ROW)) == 1
    assert db.scalar(select(AISettings.id)) == 1


def test_first_patch_defaults_web_enabled_true_and_empty_prompt(api):
    client, _ = api

    payload = client.patch("/api/ai/settings", json={"expected_revision": 0}).json()

    assert payload["web_enabled"] is True and payload["custom_prompt"] == ""
    assert payload["revision"] == 1


def test_settings_persist_across_a_new_session(api):
    client, db = api
    client.patch("/api/ai/settings", json={"expected_revision": 0,
                                           "custom_prompt": "保持简短", "web_enabled": False})

    # A brand-new Session on the same database is how "restart" is modelled here.
    from sqlalchemy.orm import Session
    with Session(bind=db.get_bind()) as fresh:
        stored = fresh.scalar(select(AISettings).where(AISettings.id == 1))
        assert stored.custom_prompt == "保持简短"
        assert stored.web_enabled is False and stored.revision == 1
    assert client.get("/api/ai/settings").json() == {
        **DEFAULT_SHAPE, "custom_prompt": "保持简短", "web_enabled": False, "revision": 1,
    }


def test_second_patch_requires_the_current_revision(api):
    client, _ = api
    first = client.patch("/api/ai/settings", json={"expected_revision": 0,
                                                   "custom_prompt": "第一版"}).json()

    missing = client.patch("/api/ai/settings", json={"custom_prompt": "第二版"})
    stale = client.patch("/api/ai/settings", json={"expected_revision": 0,
                                                   "custom_prompt": "第二版"})
    ahead = client.patch("/api/ai/settings", json={"expected_revision": 99,
                                                   "custom_prompt": "第二版"})

    assert missing.status_code == 428
    assert missing.json() == {"detail": "expected_revision is required"}
    assert stale.status_code == 409 and ahead.status_code == 409
    assert client.get("/api/ai/settings").json()["custom_prompt"] == "第一版"
    updated = client.patch("/api/ai/settings",
                           json={"expected_revision": first["revision"],
                                 "custom_prompt": "第二版"}).json()
    assert updated["custom_prompt"] == "第二版" and updated["revision"] == 2


def test_identical_update_is_a_safe_no_op_without_revision_bump(api):
    client, _ = api
    created = client.patch("/api/ai/settings",
                           json={"expected_revision": 0, "custom_prompt": "一样",
                                 "web_enabled": False}).json()

    echoed = client.patch("/api/ai/settings",
                          json={"expected_revision": created["revision"],
                                "custom_prompt": "一样", "web_enabled": False})

    assert echoed.status_code == 200
    assert echoed.json() == created


def test_partial_update_keeps_the_other_field(api):
    client, _ = api
    created = client.patch("/api/ai/settings",
                           json={"expected_revision": 0, "custom_prompt": "保留我",
                                 "web_enabled": False}).json()

    changed = client.patch("/api/ai/settings",
                           json={"expected_revision": created["revision"],
                                 "custom_prompt": "改了"}).json()

    assert changed["web_enabled"] is False and changed["custom_prompt"] == "改了"


def test_empty_prompt_clears_it(api):
    client, _ = api
    created = client.patch("/api/ai/settings", json={"expected_revision": 0,
                                                     "custom_prompt": "先写点什么"}).json()

    cleared = client.patch("/api/ai/settings",
                           json={"expected_revision": created["revision"],
                                 "custom_prompt": ""}).json()

    assert cleared["custom_prompt"] == "" and cleared["revision"] == created["revision"] + 1


@pytest.mark.parametrize("length,allowed", [
    (CUSTOM_PROMPT_MAX_CODE_POINTS - 1, True),
    (CUSTOM_PROMPT_MAX_CODE_POINTS, True),
    (CUSTOM_PROMPT_MAX_CODE_POINTS + 1, False),
])
def test_prompt_limit_counts_unicode_code_points(api, length, allowed):
    client, _ = api
    # Astral-plane characters: one code point each, two UTF-16 units each.
    prompt = "🧪" * length

    response = client.patch("/api/ai/settings",
                            json={"expected_revision": 0, "custom_prompt": prompt})

    assert (response.status_code == 200) is allowed
    if allowed:
        assert len(response.json()["custom_prompt"]) == length
    else:
        assert response.json()["detail"][0]["type"] == "value_error"
        assert client.get("/api/ai/settings").json()["revision"] == 0


@pytest.mark.parametrize("payload", [
    {"expected_revision": 0, "api_key": "sk-injected"},
    {"expected_revision": 0, "model": "other-model"},
    {"expected_revision": 0, "base_url": "http://evil.test"},
    {"expected_revision": 1, "custom_prompt": None},
    {"expected_revision": 1, "web_enabled": None},
    {"expected_revision": None},
    {"expected_revision": -1},
    {"expected_revision": "1"},
    {"expected_revision": 1.0},
    {"expected_revision": True},
    {"expected_revision": 9223372036854775808},
])
def test_invalid_or_forbidden_patch_bodies_are_422_and_write_nothing(api, payload):
    client, db = api

    response = client.patch("/api/ai/settings", json=payload)

    assert response.status_code == 422
    assert db.scalar(text(SETTINGS_ROW)) == 0


def _settings_engine(db):
    """Build an engine that behaves like production: one transaction per write.

    The ``api`` fixture keeps the whole test inside one outer transaction, which
    cannot model two competing writers. Concurrency uses its own engine and
    removes every row it creates.
    """
    from sqlalchemy import create_engine

    url = db.get_bind().engine.url.render_as_string(hide_password=False)
    return create_engine(url)


def _clear_settings(engine) -> None:
    with engine.begin() as connection:
        connection.execute(text("DELETE FROM ai_settings"))


def test_concurrent_first_write_creates_exactly_one_row_and_conflicts_the_loser(api):
    import threading

    from sqlalchemy.orm import Session

    _, db = api
    engine = _settings_engine(db)
    results: list[int] = []
    lock = threading.Lock()
    barrier = threading.Barrier(2, timeout=15)

    def first_write(prompt: str) -> None:
        with Session(bind=engine) as session:
            barrier.wait()
            from app.ai.settings import SettingsConflict, SettingsPreconditionRequired, update_settings
            try:
                update_settings(session, expected_revision=0, custom_prompt=prompt)
                status = 200
            except SettingsConflict:
                status = 409
            except SettingsPreconditionRequired:
                status = 428
        with lock:
            results.append(status)

    try:
        threads = [threading.Thread(target=first_write, args=(f"并发{prompt}",))
                   for prompt in ("甲", "乙")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=20)

        assert sorted(results) == [200, 409]
        with engine.connect() as connection:
            rows = connection.execute(
                text("SELECT id, revision, custom_prompt FROM ai_settings")).all()
        assert len(rows) == 1
        assert rows[0][0] == 1 and rows[0][1] == 1
        assert rows[0][2] in ("并发甲", "并发乙")
    finally:
        _clear_settings(engine)
        engine.dispose()


def test_conflicting_second_write_does_not_overwrite(api):
    import threading

    from sqlalchemy.orm import Session

    _, db = api
    engine = _settings_engine(db)
    results: list[int] = []
    lock = threading.Lock()
    barrier = threading.Barrier(2, timeout=15)

    def competing_write(prompt: str) -> None:
        from app.ai.settings import SettingsConflict, update_settings
        with Session(bind=engine) as session:
            barrier.wait()
            try:
                update_settings(session, expected_revision=1, custom_prompt=prompt)
                status = 200
            except SettingsConflict:
                status = 409
        with lock:
            results.append(status)

    try:
        with engine.begin() as connection:
            connection.execute(text(
                "INSERT INTO ai_settings (id, custom_prompt, web_enabled, revision) "
                "VALUES (1, '原始', true, 1)"))

        threads = [threading.Thread(target=competing_write, args=(f"竞争{prompt}",))
                   for prompt in ("甲", "乙")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=20)

        assert sorted(results) == [200, 409]
        with engine.connect() as connection:
            stored = connection.execute(text(
                "SELECT custom_prompt, revision FROM ai_settings WHERE id = 1")).one()
        assert stored[1] == 2 and stored[0] in ("竞争甲", "竞争乙")
    finally:
        _clear_settings(engine)
        engine.dispose()


def test_settings_write_failure_rolls_back_and_leaves_the_session_usable(api, monkeypatch):
    """A failed settings write must not leave a half-applied or poisoned session."""
    from sqlalchemy.orm import Session

    from app.ai.settings import update_settings

    _, db = api
    engine = _settings_engine(db)

    def boom(*args, **kwargs):
        raise RuntimeError("synthetic database failure")

    try:
        with Session(bind=engine) as session:
            with monkeypatch.context() as patch:
                patch.setattr(session, "commit", boom)
                with pytest.raises(RuntimeError):
                    update_settings(session, expected_revision=0, custom_prompt="不会留下")
            assert session.scalar(text(SETTINGS_ROW)) == 0
            assert session.scalar(text("SELECT 1")) == 1
        with engine.connect() as connection:
            assert connection.execute(text(SETTINGS_ROW)).scalar_one() == 0
    finally:
        _clear_settings(engine)
        engine.dispose()


def test_settings_failures_never_echo_credentials(api, monkeypatch):
    client, _ = api
    secret = "sk-synthetic-never-logged"
    monkeypatch.setenv("DEEPSEEK_API_KEY", secret)

    conflict = client.patch("/api/ai/settings", json={"expected_revision": 7})
    invalid = client.patch("/api/ai/settings", json={"expected_revision": 0, "model": secret})
    unknown_field = client.patch("/api/ai/settings",
                                 json={"expected_revision": 0, "api_key": secret})

    assert conflict.status_code == 409
    assert invalid.status_code == 422 and unknown_field.status_code == 422
    # A validation error body must not repeat back what the client submitted.
    assert secret not in conflict.text
    assert secret not in invalid.text and secret not in unknown_field.text
    assert client.get("/api/ai/settings").text.find(secret) == -1


def test_settings_snapshot_matches_the_response_and_is_not_mutated_by_later_edits(api):
    from app.ai.settings import settings_snapshot

    client, db = api
    created = client.patch("/api/ai/settings",
                           json={"expected_revision": 0, "custom_prompt": "发起时快照",
                                 "web_enabled": False}).json()

    snapshot = settings_snapshot(db)
    client.patch("/api/ai/settings", json={"expected_revision": created["revision"],
                                           "custom_prompt": "调用后修改"})

    assert snapshot == created
    assert snapshot["custom_prompt"] == "发起时快照"
