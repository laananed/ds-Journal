"""C01 索引修复 — 独立证据采集（不修改产品代码）。

1) 从 SQLAlchemy metadata 独立读取 schedules 的索引定义；
2) 从迁移文件 AST / 文本读取 create_index 声明；
3) 从 router AST 读取列表查询的 order_by 列；
4) 用 Alembic ScriptDirectory 计算真实 head 与线性链。
"""
from __future__ import annotations

import ast
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BACKEND = REPO / "backend"
sys.path.insert(0, str(BACKEND))
os.chdir(BACKEND)
os.environ.setdefault("SEEKJOURNAL_TEST_DB", "seekjournal_test_03")
from dotenv import load_dotenv  # noqa: E402
load_dotenv(BACKEND / ".env", override=False)

from app.schedule.models import Schedule  # noqa: E402

result = {}
table = Schedule.__table__

result["table"] = table.name
result["indexes"] = []
for index in sorted(table.indexes, key=lambda i: i.name):
    result["indexes"].append({
        "name": index.name,
        "table": index.table.name,
        "columns": [c.name for c in index.columns],
        "unique": bool(index.unique),
        "dialect_options": {k: str(v) for k, v in index.dialect_options.items()
                            if v and k in ("postgresql",)},
    })
result["unique_constraints"] = [
    {"name": c.name, "columns": [col.name for col in c.columns]}
    for c in table.constraints if c.__class__.__name__ == "UniqueConstraint"
]
result["check_constraints"] = [
    {"name": c.name, "sqltext": str(c.sqltext)}
    for c in table.constraints if c.__class__.__name__ == "CheckConstraint"
]

# --- 迁移文件：静态解析 create_index ---
mig = BACKEND / "alembic" / "versions" / "c01a7e421b50_create_schedules.py"
tree = ast.parse(mig.read_text(encoding="utf-8"))
mig_idx = []
for node in ast.walk(tree):
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "create_index":
        mig_idx.append({
            "name": ast.literal_eval(node.args[0]),
            "table": ast.literal_eval(node.args[1]),
            "columns": ast.literal_eval(node.args[2]),
            "kwargs": {k.arg: ast.literal_eval(k.value) for k in node.keywords},
        })
result["migration_create_index"] = mig_idx
result["migration_revision"] = {"revision": "c01a7e421b50", "file": mig.name}
result["migration_uses_op_drop_index_in_downgrade"] = "drop_index('ix_schedules_starts_at_id'" in mig.read_text(encoding="utf-8")

# --- router：列表 order_by ---
router_src = (BACKEND / "app" / "schedule" / "router.py").read_text(encoding="utf-8")
rtree = ast.parse(router_src)
order_cols = []
for node in ast.walk(rtree):
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "order_by":
        for arg in node.args:
            if isinstance(arg, ast.Attribute):
                order_cols.append(arg.attr)
result["list_order_by_columns"] = order_cols
result["list_has_limit_21_offset"] = "limit(21)" in router_src and "offset((page - 1) * 20)" in router_src

# --- Alembic 链 ---
from alembic.config import Config  # noqa: E402
from alembic.script import ScriptDirectory  # noqa: E402

cfg = Config(str(BACKEND / "alembic.ini"))
cfg.set_main_option("script_location", str(BACKEND / "alembic"))
script = ScriptDirectory.from_config(cfg)
heads = script.get_heads()
head = script.get_current_head()
chain = []
rev = head
while rev is not None:
    chain.append(rev)
    rev = script.get_revision(rev).down_revision
result["alembic_heads"] = list(heads)
result["alembic_chain_from_head"] = chain
result["alembic_chain_length"] = len(chain)
result["alembic_revision_count"] = len(list(script.walk_revisions()))

print(json.dumps(result, ensure_ascii=False, indent=2))
