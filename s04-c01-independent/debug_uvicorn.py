"""最小复现 3：真实 uvicorn 进程，检查 404 是否来自另一个应用/进程。"""

from __future__ import annotations

import json
import sys
import uuid

sys.path.insert(0, r"C:\Programme\demo\SeekJournal-Work-01\s04-c01-independent")
sys.path.insert(0, r"C:\Programme\demo\SeekJournal-Work-01\backend")

import run_indep_tests as T

schema = f"dbg3_{uuid.uuid4().hex[:8]}"
with T.connect() as connection:
    connection.execute(f"create schema {schema}")
try:
    T.run_alembic(schema, "upgrade", "head")
    server = T.Server(schema).start()
    client = T.httpx.Client(base_url=server.url, timeout=20, trust_env=False)
    try:
        print("alive before:", server.proc.poll())
        spec = client.get("/openapi.json")
        print("openapi paths:", sorted(spec.json().get("paths", {}))[:8])
        payload = T.make_payload(title="uvicorn probe")
        first = client.post("/api/schedules", json=payload)
        print("post1", first.status_code, first.text[:100])
        print("alive after post1:", server.proc.poll())
        second = client.post("/api/schedules", json=T.make_payload(title="uvicorn probe 2"))
        print("post2", second.status_code, second.text[:100])
        print("alive after post2:", server.proc.poll())
        spec2 = client.get("/openapi.json")
        print("openapi2 status:", spec2.status_code, sorted(json.loads(spec2.text).get("paths", {}))[:8] if spec2.status_code == 200 else spec2.text[:200])
        print("health", client.get("/api/health").status_code)
        print("root", client.get("/").status_code)
    finally:
        client.close()
        server.stop()
finally:
    with T.connect() as connection:
        connection.execute(f"drop schema if exists {schema} cascade")
