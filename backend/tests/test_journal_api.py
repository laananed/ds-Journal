"""POST /api/journals 创建链路的最小 API 测试。

Stage 1 / Task 4.2。

这些测试使用 FastAPI TestClient 与**真实 PostgreSQL**，
完整走一遍：HTTP → Pydantic → Router → Service → SQLAlchemy → psycopg → PostgreSQL。

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

fixture 结束时会再查一次总行数，确认与测试开始时一致（无残留）。

注意：PostgreSQL 的 sequence 取值**不随事务回滚**，所以 `id` 会跳号。
本测试只要求「同一天两篇 id 不同」，不要求 id 连续。

## 失败路径

`test_write_failure_...` 与 `test_commit_failure_...` 用受控故障触发真实失败，
验证 Service 的 rollback 与 Session 清理，而不是用纯 mock 代替真实写入。
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import engine, get_db
from app.journal import service
from app.journal.models import Journal
from app.journal.schemas import JournalCreate
from app.main import app

DAY = "2026-10-02"
RESPONSE_FIELDS = {
    "id",
    "title",
    "content",
    "journal_date",
    "created_at",
    "updated_at",
}


def _count_rows_with_engine() -> int:
    """用一条独立连接数总行数（在外层事务之外）。"""
    with engine.connect() as connection:
        return connection.execute(text("SELECT count(*) FROM journals")).scalar_one()


def _count_rows_in(session: Session) -> int:
    """在当前 Session 所在的事务里数行数。"""
    return session.execute(text("SELECT count(*) FROM journals")).scalar_one()


@pytest.fixture
def api():
    """提供 (TestClient, 测试 Session)，并保证测试结束后数据无残留。

    这里注入的 Session 与真实运行时 `get_db` 产出的 Session 用法完全一致，
    区别只有一个：它绑定的是一条已经开着外层事务的连接，
    所以 Service 的 commit() 只会释放 savepoint。
    """
    baseline = _count_rows_with_engine()

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

    # 每个测试结束后都验证一次：数据库回到测试前的状态。
    assert _count_rows_with_engine() == baseline, "测试数据残留"
    assert get_db not in app.dependency_overrides


def _post(client: TestClient, **payload):
    return client.post("/api/journals", json=payload)


# --------------------------------------------------------------------------
# 1. 正常创建
# --------------------------------------------------------------------------


def test_create_returns_201_with_six_fields(api):
    client, _session = api

    response = _post(
        client,
        title="广州动物园复盘",
        content="今天去了广州动物园……",
        journal_date=DAY,
    )

    assert response.status_code == 201
    body = response.json()
    assert set(body) == RESPONSE_FIELDS
    assert isinstance(body["id"], int)
    assert body["title"] == "广州动物园复盘"
    assert body["content"] == "今天去了广州动物园……"
    assert body["journal_date"] == "2026-10-02"


def test_response_matches_the_row_inside_the_transaction(api):
    client, session = api

    response = _post(client, title=None, content="正文", journal_date=DAY)

    assert response.status_code == 201
    body = response.json()

    row = session.execute(
        select(Journal).where(Journal.id == body["id"])
    ).scalar_one()

    assert row.id == body["id"]
    assert row.title == body["title"] is None
    assert row.content == body["content"]
    assert row.journal_date.isoformat() == body["journal_date"]
    assert row.created_at == datetime.fromisoformat(body["created_at"])
    assert row.updated_at == datetime.fromisoformat(body["updated_at"])


def test_created_at_and_updated_at_are_timezone_aware(api):
    client, session = api

    response = _post(client, content="正文", journal_date=DAY)
    body = response.json()

    created_at = datetime.fromisoformat(body["created_at"])
    updated_at = datetime.fromisoformat(body["updated_at"])

    assert created_at.tzinfo is not None
    assert updated_at.tzinfo is not None
    # 创建时两个时间相同，均带时区。
    assert created_at == updated_at

    # 与数据库里的真实值一致，且确实是「刚刚」生成的，而不是客户端提供的。
    row = session.execute(select(Journal).where(Journal.id == body["id"])).scalar_one()
    assert row.created_at == created_at
    assert datetime.now(timezone.utc) - created_at < timedelta(minutes=5)


# --------------------------------------------------------------------------
# 2. title：省略与 null
# --------------------------------------------------------------------------


def test_title_omitted_is_accepted_and_stored_as_null(api):
    client, session = api

    response = _post(client, content="没有标题的正文", journal_date=DAY)

    assert response.status_code == 201
    body = response.json()
    assert body["title"] is None

    row = session.execute(select(Journal).where(Journal.id == body["id"])).scalar_one()
    # 数据库不写入默认标题，也不写入日期字符串。
    assert row.title is None


def test_title_explicit_null_is_accepted(api):
    client, _session = api

    response = _post(client, title=None, content="正文", journal_date=DAY)

    assert response.status_code == 201
    assert response.json()["title"] is None


# --------------------------------------------------------------------------
# 3. 同一天多篇
# --------------------------------------------------------------------------


def test_two_journals_on_the_same_day_get_different_ids(api):
    client, session = api

    before = _count_rows_in(session)

    first = _post(client, content="同一天第一篇", journal_date=DAY)
    second = _post(client, content="同一天第二篇", journal_date=DAY)

    assert first.status_code == second.status_code == 201
    first_body, second_body = first.json(), second.json()

    assert first_body["journal_date"] == second_body["journal_date"] == DAY
    assert first_body["id"] != second_body["id"]

    # sequence 不随事务回滚，因此只要求 id 不同，不要求连续。
    assert _count_rows_in(session) == before + 2

    same_day = date.fromisoformat(first_body["journal_date"])
    ids = (
        session.execute(select(Journal.id).where(Journal.journal_date == same_day))
        .scalars()
        .all()
    )
    assert set(ids) == {first_body["id"], second_body["id"]}


# --------------------------------------------------------------------------
# 4. 请求不合法 → 422，且不产生记录
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "payload",
    [
        {"content": "正文"},  # 缺 journal_date
        {"journal_date": DAY},  # 缺 content
        {"title": "标题"},  # 两个都缺
        {"content": None, "journal_date": DAY},  # content 为 null
        {"content": "正文", "journal_date": None},  # journal_date 为 null
        {"content": "正文", "journal_date": "2026-02-30"},  # 2 月没有 30 号
        {"content": "正文", "journal_date": "2026-02-29"},  # 2026 不是闰年
        {"content": "正文", "journal_date": "2026-13-01"},  # 没有 13 月
        {"content": "正文", "journal_date": "2026/10/02"},
        {"content": "正文", "journal_date": "not-a-date"},  # 无法解析
        {"content": "正文", "journal_date": ""},
    ],
)
def test_invalid_request_returns_422_and_creates_nothing(api, payload):
    client, session = api

    before = _count_rows_in(session)

    response = client.post("/api/journals", json=payload)

    assert response.status_code == 422
    assert _count_rows_in(session) == before


# --------------------------------------------------------------------------
# 5. 客户端提交的系统字段不控制生成结果
# --------------------------------------------------------------------------


def test_client_supplied_system_fields_are_ignored(api):
    client, session = api

    response = _post(
        client,
        title="正文标题",
        content="正文",
        journal_date=DAY,
        id=999,
        created_at="2020-01-01T00:00:00Z",
        updated_at="2020-01-01T00:00:00Z",
    )

    assert response.status_code == 201
    body = response.json()

    assert body["id"] != 999
    # 时间是系统刚生成的，不是客户端提交的 2020 年。
    created_at = datetime.fromisoformat(body["created_at"])
    assert created_at.year == datetime.now(timezone.utc).year
    assert created_at != datetime(2020, 1, 1, tzinfo=timezone.utc)

    row = session.execute(select(Journal).where(Journal.id == body["id"])).scalar_one()
    assert row.id == body["id"]
    assert row.created_at == created_at


# --------------------------------------------------------------------------
# 6. 失败路径：rollback 与 Session 清理
# --------------------------------------------------------------------------


def test_write_failure_rolls_back_and_leaves_no_row(api):
    """真实数据库约束失败：绕过校验构造 journal_date=None，触发 NOT NULL 违反。

    这里用 `model_construct()` 跳过 Pydantic 校验，让 INSERT 真的被
    PostgreSQL 拒绝，从而验证 Service 的 rollback 分支与 Session 清理。
    """
    _client, session = api

    before = _count_rows_in(session)
    invalid = JournalCreate.model_construct(content="受控故障正文", journal_date=None)

    with pytest.raises(IntegrityError):
        service.create_journal(session, invalid)

    # 失败后没有留下记录，且 Session 已被 rollback 清理，可以继续使用。
    assert _count_rows_in(session) == before
    assert session.execute(text("SELECT 1")).scalar_one() == 1


def test_commit_failure_returns_500_and_rolls_back(api, monkeypatch):
    """受控 commit 故障：先真实 flush 出 INSERT，再抛异常。

    用于验证 HTTP 层：写入失败返回 500，界面不会看到半截记录。
    """
    client, session = api

    def failing_commit(self):
        self.flush()  # 让 INSERT 真的发到 PostgreSQL
        raise RuntimeError("受控的 commit 故障")

    monkeypatch.setattr(Session, "commit", failing_commit)

    before = _count_rows_in(session)

    response = _post(client, content="提交会失败的正文", journal_date=DAY)

    assert response.status_code == 500
    assert _count_rows_in(session) == before
    assert session.execute(text("SELECT 1")).scalar_one() == 1


# --------------------------------------------------------------------------
# 7. 原有接口行为不变
# --------------------------------------------------------------------------


def test_health_endpoint_is_unchanged(api):
    client, _session = api

    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert response.headers["content-type"].startswith("application/json")
