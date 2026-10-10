"""POST /api/journals 创建链路的最小 API 测试。

Stage 1 / Task 4.2。

这些测试使用 FastAPI TestClient 与**真实 PostgreSQL**，
完整走一遍：HTTP → Pydantic → Router → Service → SQLAlchemy → psycopg → PostgreSQL。

共享的 `api` fixture（TestClient + 测试 Session）位于 `tests/conftest.py`：
Task 5.1 把它从本文件最小提取出去，让创建测试与读取测试共用。
本文件原有的断言与用例未做任何改动。

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

from app.folder.models import Folder
from app.journal import service
from app.journal.models import Journal
from app.journal.schemas import JournalCreate

# 共享 fixture `api`（TestClient + 测试 Session，含事务隔离与无残留检查）
# 已提取到 tests/conftest.py，创建测试与读取测试共用同一份实现。
# 本模块只保留创建测试自己用到的局部 helper。
DAY = "2026-10-02"
RESPONSE_FIELDS = {
    "type",
    "id",
    "title",
    "display_title",
    "content",
    "journal_date",
    "folder_id",
    "created_at",
    "updated_at",
    "deleted_at",
"revision", "content_blocks"}


def _count_rows_in(session: Session) -> int:
    """在当前 Session 所在的事务里数行数。"""
    return session.execute(text("SELECT count(*) FROM journals")).scalar_one()


def _post(client: TestClient, **payload):
    return client.post("/api/journals", json=payload)


# --------------------------------------------------------------------------
# 1. 正常创建
# --------------------------------------------------------------------------


def test_create_returns_201_with_complete_fields(api):
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
    assert body["type"] == "journal"
    assert body["title"] == "广州动物园复盘"
    # 手工标题的显示标题就是标题本身
    assert body["display_title"] == "广州动物园复盘"
    assert body["content"] == "今天去了广州动物园……"
    assert body["journal_date"] == "2026-10-02"
    assert body["folder_id"] is None
    # 普通响应的 deleted_at 必须是 null
    assert body["deleted_at"] is None


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
    assert row.folder_id == body["folder_id"] is None
    assert row.deleted_at == body["deleted_at"] is None
    # 无标题：显示标题回退为业务日期，且数据库里没有写入这个日期
    assert body["display_title"] == DAY
    assert row.title is None
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
# 2b. folder_id：可省略 / null / 存在 / 不存在（Stage 2 / S2-T02）
# --------------------------------------------------------------------------


def _add_folder(session: Session, name: str) -> Folder:
    folder = Folder(name=name)
    session.add(folder)
    session.flush()
    return folder


def test_create_with_folder_id_omitted_and_null(api):
    client, _session = api

    omitted = _post(client, content="没有 Folder", journal_date=DAY)
    explicit = _post(client, content="显式 null", journal_date=DAY, folder_id=None)

    assert omitted.status_code == explicit.status_code == 201
    assert omitted.json()["folder_id"] is None
    assert explicit.json()["folder_id"] is None


def test_create_with_existing_folder_returns_the_folder_id(api):
    client, session = api

    folder = _add_folder(session, "项目思考")

    response = _post(client, content="正文", journal_date=DAY, folder_id=folder.id)

    assert response.status_code == 201
    body = response.json()
    assert body["folder_id"] == folder.id

    row = session.execute(select(Journal).where(Journal.id == body["id"])).scalar_one()
    assert row.folder_id == folder.id


def test_create_with_missing_folder_returns_404_and_creates_nothing(api):
    client, session = api

    absent_folder = 1
    existing = {row[0] for row in session.execute(select(Folder.id))}
    while absent_folder in existing:
        absent_folder += 1

    before = _count_rows_in(session)

    response = _post(client, content="正文", journal_date=DAY, folder_id=absent_folder)

    assert response.status_code == 404
    assert response.json()["detail"] == "Folder not found"
    assert _count_rows_in(session) == before


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
        # Stage 1.5 / S1.5-T2：title 超过 80 码点、content 空白或超过 50,000 码点
        {"title": "标" * 81, "content": "正文", "journal_date": DAY},
        {"title": "🧭" * 81, "content": "正文", "journal_date": DAY},
        {"content": "", "journal_date": DAY},
        {"content": " ", "journal_date": DAY},
        {"content": "\t\n", "journal_date": DAY},
        {"content": "\u3000", "journal_date": DAY},
        {"content": "a" * 50_001, "journal_date": DAY},
        {"content": " " * 50_000 + "x", "journal_date": DAY},  # trim 后只剩 1 个字符
        # Stage 2 / S2-T02：folder_id 只接受整数或 null
        {"content": "正文", "journal_date": DAY, "folder_id": "abc"},
        {"content": "正文", "journal_date": DAY, "folder_id": 1.5},
    ],
)
def test_invalid_request_returns_422_and_creates_nothing(api, payload):
    client, session = api

    before = _count_rows_in(session)

    response = client.post("/api/journals", json=payload)

    assert response.status_code == 422
    assert _count_rows_in(session) == before


def test_create_accepts_title_and_content_at_the_limits(api):
    """边界合法值真的写进数据库：80 码点标题 + 50,000 码点正文。"""
    client, session = api

    before = _count_rows_in(session)
    title = "🧭" * 80
    content = "中" * 50_000

    response = _post(client, title=title, content=content, journal_date=DAY)

    assert response.status_code == 201
    body = response.json()
    assert body["title"] == title
    assert body["content"] == content
    assert _count_rows_in(session) == before + 1

    row = session.execute(select(Journal).where(Journal.id == body["id"])).scalar_one()
    assert row.title == title
    assert row.content == content


def test_create_preserves_markdown_spacing_verbatim(api):
    """校验只用于判断，不会把 trim 后的结果写进数据库。"""
    client, session = api

    content = "  缩进\n\n结尾还有空格  "

    response = _post(client, content=content, journal_date=DAY)

    assert response.status_code == 201
    body = response.json()
    assert body["content"] == content

    row = session.execute(select(Journal).where(Journal.id == body["id"])).scalar_one()
    assert row.content == content


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
        # display_title / deleted_at 同样是系统字段，客户端不能决定它们
        display_title="客户端伪造的显示标题",
        deleted_at="2020-01-01T00:00:00Z",
    )

    assert response.status_code == 201
    body = response.json()

    assert body["id"] != 999
    assert body["display_title"] == "正文标题"
    assert body["deleted_at"] is None
    # 时间是系统刚生成的，不是客户端提交的 2020 年。
    created_at = datetime.fromisoformat(body["created_at"])
    assert created_at.year == datetime.now(timezone.utc).year
    assert created_at != datetime(2020, 1, 1, tzinfo=timezone.utc)

    row = session.execute(select(Journal).where(Journal.id == body["id"])).scalar_one()
    assert row.id == body["id"]
    assert row.created_at == created_at
    assert row.deleted_at is None


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
