"""最小复现 2：进程内 TestClient，带私有 schema，观察路由表在首请求前后的变化。"""

from __future__ import annotations

import os
import sys
import uuid

sys.path.insert(0, r"C:\Programme\demo\SeekJournal-Work-01\s04-c01-independent")
sys.path.insert(0, r"C:\Programme\demo\SeekJournal-Work-01\backend")

import run_indep_tests as T

schema = f"dbg2_{uuid.uuid4().hex[:8]}"
with T.connect() as connection:
    connection.execute(f"create schema {schema}")
os.environ["DATABASE_URL"] = T.base_url(schema=schema)

try:
    T.run_alembic(schema, "upgrade", "head")

    from fastapi.testclient import TestClient
    import c01_test_app as M

    def dump(label):
        print(label, [(getattr(r, "path", type(r).__name__)) for r in M.app.routes])

    client = TestClient(M.app)
    dump("before")
    payload = {"title": "x", "starts_at": "2026-10-30T09:00:00+08:00", "ends_at": None,
               "completed": False, "client_create_id": str(uuid.uuid4())}
    print("ping1", client.get("/__test_only/ping").status_code)
    print("post1", client.post("/api/schedules", json=payload).status_code)
    dump("after-post1")
    print("ping2", client.get("/__test_only/ping").status_code)
    print("post2", client.post("/api/schedules", json=dict(payload, client_create_id=str(uuid.uuid4()))).status_code)
    dump("after-post2")
finally:
    with T.connect() as connection:
        connection.execute(f"drop schema if exists {schema} cascade")
