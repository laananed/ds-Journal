"""共享的 pytest fixture。

Stage 1 / Task 5.1：把原先写在 `tests/test_journal_api.py` 里的 `api` fixture
最小提取到这里，让创建 API 测试与读取 API 测试共用同一份实现。

提取范围只有两样东西：

- `api` fixture 本身；
- 它内部用到的 `_count_rows_with_engine()`（原本也只被该 fixture 使用）。

fixture 名称 `api` 与返回值 `(TestClient, Session)` 保持不变，
事务隔离语义与 Task 4.2 完全一致，因此原有测试的断言不需要任何改动。

Stage 2 / S2-T01：无残留检查从只数 `journals` 扩展到**全部四张业务表**
（folders / journals / inboxes / insights），并新增新表时同步扩展。
表名列表复用 `scripts/prepare_test_db.py` 的 `BUSINESS_TABLES`，
避免准备脚本与守卫各维护一份。

各测试模块自己用的局部 helper（例如 `_count_rows_in`）留在原来的模块里，
不在这里再包一层通用工具。

## 事务隔离方式（为什么测试不会污染真实数据）

每个测试用一个「外层事务 + savepoint」把 Service 的 `commit()` 关在里面：

```text
connection = engine.connect()                 # 取一条真实连接
outer      = connection.begin()               # 开启外层事务
session    = Session(bind=connection,
                     join_transaction_mode="create_savepoint")
```

- `join_transaction_mode="create_savepoint"` 让这个 Session 加入外层事务：
  Session 自己的事务表现为连接上的一个 SAVEPOINT；
- 因此 Service 里的 `db.commit()` 实际是 **RELEASE SAVEPOINT**，
  数据在当前连接上可见，但**不会提交外层事务**；
- 用另一条独立连接查询时看不到这些行 —— 这正是「没有真正写入」的证据。

测试结束时按顺序做三件事：

1. `app.dependency_overrides.clear()`：撤掉注入的测试 Session；
2. `session.close()`：归还连接（SQLAlchemy 的 close 只释放 Session 持有的连接，
   不会提交任何东西）；
3. `outer.rollback()` + `connection.close()`：回滚外层事务并归还连接，
   测试期间插入的所有行随之消失。

fixture 结束时会再查一次每张业务表的行数，确认与测试开始时逐表一致（无残留）。

注意：PostgreSQL 的 sequence 取值**不随事务回滚**，所以 `id` 会跳号。
测试只要求「同一天两篇 id 不同」，不要求 id 连续。
"""

from __future__ import annotations

import os

from scripts.prepare_test_db import BUSINESS_TABLES, get_test_database_url

# 必须在导入 app.database / app.main 之前切换，确保所有测试模块引用同一测试 Engine。
# 只修改 pytest 进程环境，不修改 backend/.env 或应用运行时配置。
os.environ["DATABASE_URL"] = get_test_database_url().render_as_string(hide_password=False)

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import engine, get_db
from app.main import app


def _count_rows_with_engine(table: str) -> int:
    """用一条独立连接数某张业务表的行数（在外层事务之外）。

    独立连接看不到外层事务里未提交的数据，
    因此它数到的就是「真实留在库里」的记录数。

    `table` 只来自 `BUSINESS_TABLES` 这个固定元组，
    不是外部输入，所以这里直接拼进 SQL 没有注入风险。
    """
    with engine.connect() as connection:
        return connection.execute(text(f"SELECT count(*) FROM {table}")).scalar_one()


def _table_baselines() -> dict[str, int]:
    """返回四张业务表各自的行数基线。"""
    return {table: _count_rows_with_engine(table) for table in BUSINESS_TABLES}


@pytest.fixture
def api():
    """提供 (TestClient, 测试 Session)，并保证测试结束后数据无残留。

    这里注入的 Session 与真实运行时 `get_db` 产出的 Session 用法完全一致，
    区别只有一个：它绑定的是一条已经开着外层事务的连接，
    所以 Service 的 commit() 只会释放 savepoint。

    测试可以直接用返回的 Session 准备数据（`add` + `flush`），
    这些数据位于外层事务之内，测试结束后随回滚一起消失。
    """
    baseline = _table_baselines()

    connection = engine.connect()
    outer_transaction = connection.begin()
    session = Session(bind=connection, join_transaction_mode="create_savepoint")

    def override_get_db():
        """替换 get_db：提供上面这个测试 Session。

        由 fixture 负责它的关闭，这里不再重复关闭。
        """
        yield session

    app.dependency_overrides[get_db] = override_get_db
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            yield client, session
    finally:
        # 1. 撤掉注入
        app.dependency_overrides.clear()
        # 2. 关闭 Session（只归还连接，不提交）
        session.close()
        # 3. 回滚外层事务并关闭连接，测试数据随之消失
        outer_transaction.rollback()
        connection.close()

    # 每个测试结束后都验证一次：四张业务表都回到测试前的状态。
    assert _table_baselines() == baseline, "测试数据残留"
    assert get_db not in app.dependency_overrides
