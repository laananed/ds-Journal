import os, json, sys
from pathlib import Path
from dotenv import load_dotenv
import psycopg
from sqlalchemy import make_url

BACKEND = Path(r"C:/Programme/demo/SeekJournal/backend")
load_dotenv(BACKEND / ".env", override=False)
url = make_url(os.environ["DATABASE_URL"])
db = "seekjournal_test_03"
conn_url = url.set(drivername="postgresql", database=db).render_as_string(hide_password=False)
tables = ("folders","journals","inboxes","insights","ai_requests","ai_checkpoints","ai_usage","ai_settings","ritual_templates","ritual_goal_links","ritual_copies","ai_comments")
out = {}
with psycopg.connect(conn_url, connect_timeout=5) as c:
    cur = c.execute("select current_database(), current_user, inet_server_addr()::text, inet_server_port()")
    out["identity"] = cur.fetchone()
    out["alembic_version"] = c.execute("select version_num from alembic_version").fetchall()
    out["tables_present"] = [r[0] for r in c.execute(
        "select tablename from pg_tables where schemaname='public' order by 1").fetchall()]
    counts = {}
    for t in tables:
        try:
            counts[t] = c.execute(f"select count(*) from public.{t}").fetchone()[0]
        except Exception as e:
            c.rollback(); counts[t] = f"ERR:{type(e).__name__}"
    out["business_counts"] = counts
    out["other_connections"] = c.execute(
        "select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()").fetchone()[0]
    out["all_databases"] = [r[0] for r in c.execute("select datname from pg_database order by 1").fetchall()]
    out["schemas"] = [r[0] for r in c.execute(
        "select nspname from pg_namespace where nspname not like 'pg_%' and nspname<>'information_schema' order by 1").fetchall()]
    out["ai_usage_rows"] = c.execute("select id::text, coalesce(request_id::text,'') , total_tokens, created_at from ai_usage order by created_at").fetchall() if counts.get("ai_usage") else []
    out["activity_all_dbs"] = c.execute(
        "select datname, count(*) from pg_stat_activity where pid<>pg_backend_pid() group by 1 order by 1").fetchall()
print(json.dumps(out, indent=2, default=str, ensure_ascii=False))
