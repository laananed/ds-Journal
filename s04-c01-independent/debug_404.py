"""最小复现：连续 POST 到测试专用应用，定位第二次起出现 404 的原因。"""

from __future__ import annotations

import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, r"C:\Programme\demo\SeekJournal-Work-01\s04-c01-independent")
sys.path.insert(0, r"C:\Programme\demo\SeekJournal-Work-01\backend")

import run_indep_tests as T

schema = f"dbg_{uuid.uuid4().hex[:8]}"
with T.connect() as connection:
    connection.execute(f"create schema {schema}")
try:
    T.run_alembic(schema, "upgrade", "head")
    server = T.Server(schema).start()
    try:
        client = T.httpx.Client(base_url=server.url, timeout=20)
        for index in range(4):
            body = T.make_payload(title=f"probe {index}")
            response = client.post("/api/schedules", json=body)
            print(index, response.status_code, response.request.url, response.text[:120])
        print("ping", client.get("/__test_only/ping").status_code)
        print("list", client.get("/api/schedules").status_code)
        print("list2", client.get("/api/schedules").status_code)
        print("post again", client.post("/api/schedules", json=T.make_payload()).status_code)
        client.close()
    finally:
        server.stop()
finally:
    with T.connect() as connection:
        connection.execute(f"drop schema if exists {schema} cascade")
