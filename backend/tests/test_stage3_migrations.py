"""S3-T01 migration entry checks; database preservation cases follow once ready."""

from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory


def test_stage3_has_one_new_linear_migration_after_m3():
    backend = Path(__file__).resolve().parents[1]
    config = Config(str(backend / "alembic.ini"))
    config.set_main_option("script_location", str(backend / "alembic"))
    scripts = ScriptDirectory.from_config(config)
    heads = scripts.get_heads()
    assert len(heads) == 1
    head = scripts.get_revision(heads[0])
    assert head.revision != "18ecf7e09da6", "S3-T01 migration has not been created"
    assert head.down_revision == "18ecf7e09da6"
    assert Path(head.path).name.endswith("_stage3_writing_ai.py")


def test_stage1_m3_s3_preserve_all_existing_fields_and_sequences(stage3_schema):
    from sqlalchemy import text
    from test_stage2_migrations import (
        _run_alembic, _seed_legacy_rows, _snapshot_six_fields, STAGE1_REVISION,
    )
    schema, engine = stage3_schema
    _run_alembic(schema, "upgrade", STAGE1_REVISION)
    _seed_legacy_rows(engine)
    first = _snapshot_six_fields(engine)
    _run_alembic(schema, "upgrade", "18ecf7e09da6")
    assert _snapshot_six_fields(engine) == first
    with engine.begin() as connection:
        for title in (None, "", "   ", "x" * 120):
            connection.execute(text("insert into inboxes (title,content,inbox_date,is_daily,created_at,updated_at) "
                                    "values (:title,:content,'2026-10-10',false,'2020-01-01+00','2020-02-02+00')"),
                               {"title": title, "content": "  原始 **Markdown** 🧪\n" + "x" * 60000})
            connection.execute(text("insert into insights (title,content,created_at,updated_at) "
                                    "values (:title,:content,'2020-01-01+00','2020-02-02+00')"),
                               {"title": title, "content": " \t\n"})
    def snapshot():
        with engine.connect() as c:
            rows = {t: c.execute(text(f"select * from {t} order by id")).mappings().all()
                    for t in ("journals", "inboxes", "insights")}
            sequences = c.execute(text("select sequencename,last_value from pg_sequences "
                                       "where schemaname=:schema order by sequencename"),
                                  {"schema": schema}).all()
        return rows, sequences
    legacy, sequences = snapshot()
    _run_alembic(schema, "upgrade", "head")
    current, after_sequences = snapshot()
    assert sequences == after_sequences
    for table, old_rows in legacy.items():
        for old, new in zip(old_rows, current[table], strict=True):
            assert {k: new[k] for k in old} == dict(old)
            assert new["revision"] == 1
            assert new["client_create_id"] is None and new["create_payload_hash"] is None
            if table != "insights":
                assert new["content_blocks"] is None
    _run_alembic(schema, "check")
    # Only this owned private schema is downgraded; no AI data exists here.
    _run_alembic(schema, "downgrade", "18ecf7e09da6")
    assert snapshot() == (legacy, sequences)
