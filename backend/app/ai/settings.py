"""Persistent AI settings: one row, read-only default, CAS on every change.

Contract: ``docs/stage3-api.md`` §3.

- ``GET`` never creates the row. With no row the response is the default
  ``revision=0`` and the request performs **zero** writes (no flush, no commit).
- The first ``PATCH`` with ``expected_revision=0`` creates the single row.
- Every later ``PATCH`` must send the current revision; a stale value is 409 and
  a missing one is 428. Values are never merged blindly.
- ``custom_prompt`` is capped at 4,000 Unicode code points; an empty string
  clears it back to the default empty value.
- ``web_enabled`` defaults to ``true``.

The API key is not part of this table and cannot be written through it. Only the
*configuration status* derived from the server environment is exposed.
"""

from __future__ import annotations

import os

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as postgres_insert
from sqlalchemy.orm import Session

from app.ai.client import MODEL, is_configured
from app.ai.models import AISettings

CUSTOM_PROMPT_MAX_CODE_POINTS = 4_000
SEARCH_KEY_ENV = "BRAVE_SEARCH_API_KEY"

#: The single settings row always uses this primary key (DB CHECK id = 1).
SETTINGS_ID = 1


class SettingsConflict(RuntimeError):
    """``expected_revision`` no longer matches the stored row (409)."""


class SettingsPreconditionRequired(RuntimeError):
    """``expected_revision`` was not supplied (428)."""


def search_configured() -> bool:
    """Whether a search key exists in the server process environment."""
    return bool((os.environ.get(SEARCH_KEY_ENV) or "").strip())


def _web_enabled_from_env() -> bool:
    """Deployment-level switch; only affects the *effective* value, not the preference."""
    raw = (os.environ.get("WEB_SEARCH_ENABLED") or "").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def custom_prompt_limit_error(value: str) -> str | None:
    """Return a message when the prompt exceeds the code-point limit."""
    if len(value) > CUSTOM_PROMPT_MAX_CODE_POINTS:
        return f"自定义提示词最多 {CUSTOM_PROMPT_MAX_CODE_POINTS} 个字符（按 Unicode 码点计数）"
    return None


def load_settings(db: Session) -> AISettings | None:
    """Read the settings row or ``None``. Never writes."""
    return db.scalar(select(AISettings).where(AISettings.id == SETTINGS_ID))


def describe(row: AISettings | None) -> dict[str, object]:
    """Project a row (or its absence) into the fixed response shape.

    ``effective_web_enabled`` is a *preference AND capability* answer: a user
    preference of ``true`` with no search key still reports ``false``, so the UI
    can say "联网未配置" instead of pretending search works.
    """
    prompt = row.custom_prompt if row is not None else ""
    preference = row.web_enabled if row is not None else True
    revision = row.revision if row is not None else 0
    configured = search_configured() and _web_enabled_from_env()
    return {
        "custom_prompt": prompt,
        "web_enabled": preference,
        "revision": revision,
        "model": MODEL,
        "model_configured": is_configured(),
        "search_configured": search_configured(),
        "effective_web_enabled": bool(preference and configured),
    }


def read_settings(db: Session) -> dict[str, object]:
    """``GET /api/ai/settings``: default or persisted values, zero writes."""
    return describe(load_settings(db))


def settings_snapshot(db: Session) -> dict[str, object]:
    """Frozen settings for an in-flight call.

    A call keeps the settings captured when it was sent, even if the user edits
    them meanwhile; the snapshot is stored with the request and is not
    recalculated later (``docs/stage3.md`` §7).
    """
    return read_settings(db)


def update_settings(
    db: Session,
    *,
    expected_revision: int | None,
    custom_prompt: str | None = None,
    web_enabled: bool | None = None,
) -> dict[str, object]:
    """Apply one CAS update and return the stored result.

    Only the arguments that are actually supplied change. An update whose values
    already match the row is a safe no-op: it returns 200 without bumping the
    revision, which keeps a lost-response retry from failing.
    """
    if expected_revision is None:
        raise SettingsPreconditionRequired("expected_revision is required")
    if expected_revision < 0:
        raise SettingsConflict("expected_revision is out of range")

    if expected_revision == 0:
        values: dict[str, object] = {
            "custom_prompt": custom_prompt if custom_prompt is not None else "",
            "web_enabled": web_enabled if web_enabled is not None else True,
        }
        # Two concurrent first writes: exactly one inserts, the other is told to
        # re-read instead of silently overwriting the winner.
        statement = (
            postgres_insert(AISettings)
            .values(id=SETTINGS_ID, revision=1, **values)
            .on_conflict_do_nothing(index_elements=[AISettings.id])
            .returning(AISettings.id)
        )
        try:
            created = db.execute(statement).scalar_one_or_none()
            if created is None:
                raise SettingsConflict(
                    "settings were created by another write; re-read and retry"
                )
            db.commit()
        except Exception:
            db.rollback()
            raise
        return read_settings(db)

    row = load_settings(db)
    if row is None or row.revision != expected_revision:
        raise SettingsConflict("settings revision has changed; re-read and retry")

    changes: dict[str, object] = {}
    if custom_prompt is not None and custom_prompt != row.custom_prompt:
        changes["custom_prompt"] = custom_prompt
    if web_enabled is not None and web_enabled != row.web_enabled:
        changes["web_enabled"] = web_enabled
    if not changes:
        return describe(row)  # Identical intent: 200, no write, no revision bump.

    try:
        result = db.execute(
            update(AISettings)
            .where(AISettings.id == SETTINGS_ID, AISettings.revision == expected_revision)
            .values(revision=AISettings.revision + 1, **changes)
            .returning(AISettings.id)
        )
        if result.scalar_one_or_none() is None:
            raise SettingsConflict("settings revision has changed; re-read and retry")
        db.commit()
    except Exception:
        # Failure leaves no half-applied settings and no poisoned transaction.
        db.rollback()
        raise
    return read_settings(db)
