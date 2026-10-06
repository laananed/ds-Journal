# SeekJournal Backend

SeekJournal 后端（Stage 1 / Task 5.1 产物）。

当前包含：

- 一个最小 FastAPI 应用；
- 一个存活检查接口；
- 一份本地 PostgreSQL 开发数据库的 Compose 配置；
- SQLAlchemy 2.x 数据库基础（Engine / Session 工厂 / 请求级 Session 依赖 / Declarative Base）；
- Journal SQLAlchemy Model；
- Alembic 首次迁移，已在本地数据库建立 `journals` 表；
- Journal 的 Pydantic Schema（`JournalCreate` / `JournalResponse`）；
- `POST /api/journals` 创建链路，打通
  HTTP → Pydantic → Router → Service → SQLAlchemy → psycopg → PostgreSQL；
- `GET /api/journals` 列表，以及可选的 `journal_date` 精确日期筛选；
- 三套 pytest 测试：Schema 测试（只用内存数据）、创建 API 测试、列表 / 筛选 API 测试
  （后两套使用 TestClient + 真实 PostgreSQL）；
- 一个只读的历史连接验证脚本。

单篇详情（`GET /api/journals/{id}`）与 `PATCH` / `DELETE` 尚未实现，前端尚未接入。

## 环境要求

- Python 3.12（使用 `py -3.12` 启动）
- Docker Desktop（提供本地 PostgreSQL）

## 目录结构

```text
backend/
├── app/
│   ├── __init__.py
│   ├── main.py
│   ├── database.py             # Engine / SessionLocal / Base
│   └── journal/
│       ├── __init__.py
│       ├── models.py           # Journal Model
│       ├── schemas.py          # JournalCreate / JournalResponse
│       ├── service.py          # create_journal（事务边界）/ list_journals（只读查询）
│       └── router.py           # POST / GET /api/journals
├── tests/
│   ├── conftest.py             # 共享 api fixture（事务隔离 + 无残留检查）
│   ├── test_journal_schemas.py # Task 4.1 的 Schema 测试（只用内存数据）
│   ├── test_journal_api.py     # Task 4.2 的创建 API 测试（真实 PostgreSQL）
│   └── test_journal_read_api.py # Task 5.1 的列表 / 筛选测试（真实 PostgreSQL）
├── alembic/
│   ├── env.py
│   ├── script.py.mako
│   ├── README
│   └── versions/
│       └── 3a70890ddb10_create_journals_table.py
├── alembic.ini
├── scripts/
│   └── check_db.py             # Task 3 第一步的历史脚本
├── .env.example
├── .env                        # 本机配置，不提交 Git
├── requirements.txt
└── README.md
```

仓库根目录另有：

```text
compose.yaml
```

## 创建虚拟环境

在 `backend/` 目录下执行：

```powershell
py -3.12 -m venv .venv
```

## 安装依赖

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

依赖的实际安装版本记录在 `requirements.txt`，由虚拟环境的 `pip freeze` 生成。

运行命令请始终使用 `.venv\Scripts\python.exe`，不要使用全局 pip。

## 配置

复制示例配置，生成本机配置文件：

```powershell
Copy-Item .env.example .env
```

然后编辑 `backend/.env`，把 `REPLACE_WITH_LOCAL_PASSWORD` 替换为真实密码。

需要同步修改两处：

```text
POSTGRES_PASSWORD=...
DATABASE_URL=postgresql://seekjournal:<同一个密码>@127.0.0.1:5432/seekjournal
```

说明：

- `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` 供 Compose 初始化数据库容器使用；
- `DATABASE_URL` 供 Python 连接数据库使用；
- 密码若包含 `@` `:` `/` `?` `#` 等 URL 特殊字符，`DATABASE_URL` 中必须做 URL 编码；
- `DATABASE_URL` 写 `postgresql://` 即可。`app/database.py` 会用 SQLAlchemy 的 URL 工具把驱动改写成 `postgresql+psycopg`，不需要在这里手写驱动名；
- `backend/.env` 不提交 Git，只提交 `backend/.env.example`。

## 启动数据库

先启动 Docker Desktop，等 Engine 就绪，然后在**仓库根目录**执行：

```powershell
docker compose --env-file backend/.env up -d postgres
```

说明：

- Compose 只定义 `postgres` 一个服务，使用 `postgres:17`；
- 端口只绑定 `127.0.0.1:5432`，不对外暴露；
- 数据保存在 named volume 中，删除容器不会丢失数据；
- 数据库名、用户名、密码必须由 `backend/.env` 提供，缺失时 Compose 会直接报错；
- 若本地已有同名数据卷，数据库不会被重新初始化。

## 数据库结构管理（Alembic）

以下命令都在 `backend/` 目录下执行。

连接信息不写在 `alembic.ini`：`alembic/env.py` 直接复用 `app/database.py` 里的
Engine 与 `Base.metadata`，真实 `DATABASE_URL` 只存在于本机 `backend/.env`。

> **注意：`alembic.ini` 必须保持纯 ASCII。**
> Alembic 通过 `configparser` 以系统 locale 编码读取该文件，本机 locale 是 GBK，
> 因此在该文件里写中文注释会让所有 alembic 命令报 `UnicodeDecodeError`。
> 中文注释请写在 `env.py`、迁移文件或本文档里。

生成迁移（修改 Model 之后）：

```powershell
.\.venv\Scripts\python.exe -m alembic revision --autogenerate -m "描述本次变化"
```

autogenerate 只是起点。执行前必须人工检查生成的文件：

- 字段数量、类型、Nullable 是否正确；
- 主键与索引是否符合文档；
- 是否出现多余的表或破坏性操作。

应用迁移：

```powershell
.\.venv\Scripts\python.exe -m alembic upgrade head
```

检查 revision 与结构差异：

```powershell
.\.venv\Scripts\python.exe -m alembic current   # 数据库当前所处的版本
.\.venv\Scripts\python.exe -m alembic heads     # 迁移脚本中的最新版本
.\.venv\Scripts\python.exe -m alembic check     # 无差异时输出 No new upgrade operations detected.
```

约定：

- 表结构只通过 Migration 建立，代码里不调用 `create_all` / `drop_all`；
- 不删除历史 Migration；
- 不通过 `stamp head` 伪装迁移已执行；
- 数据库结构变更时新增 Migration，而不是删库重建。

## 检查表结构与 Model 是否一致

看数据库里实际长什么样（在**仓库根目录**执行）：

```powershell
docker exec seekjournal-postgres-1 psql -U seekjournal -d seekjournal -c "\d journals"
docker exec seekjournal-postgres-1 psql -U seekjournal -d seekjournal -c "SELECT version_num FROM alembic_version;"
```

看 Model 在内存中声明了什么（在 `backend/` 目录执行）：

```powershell
.\.venv\Scripts\python.exe -c "from app.database import Base; from app.journal import models; print(sorted(Base.metadata.tables)); print([(c.name, str(c.type), c.nullable, c.index) for c in Base.metadata.tables['journals'].columns])"
```

两边对不上时执行 `alembic check`，再决定是否需要新的 Migration。

## 验证数据库连接

`scripts/check_db.py` 是 Task 3 第一步的历史脚本，只读，不创建也不修改任何 Schema。

它要求「用户表数量 = 0」，因此**只在首次迁移之前的空白数据库上返回 PASS**。
完成首次迁移后，数据库里已经有 `journals` 和 `alembic_version`，它会打印：

```text
FAIL  期望当前还没有业务表
```

**这是阶段变化，不是数据库连接失败。** 该脚本保留不改，作为第一步的历史记录。

迁移之前的期望结果：

```text
连接成功
  current_database() = seekjournal
  常量 1             = 1
  用户表数量         = 0
PASS  数据库连接可用，且尚未创建业务表
```

迁移之后判断连接是否可用，改用下面这两条：

```powershell
# 在 backend/ 目录执行：确认 Engine 能连上、且连的是 seekjournal
.\.venv\Scripts\python.exe -c "from sqlalchemy import text; from app.database import engine; print(engine.connect().execute(text('SELECT current_database()')).scalar_one())"

# 在 backend/ 目录执行：确认数据库版本与脚本一致
.\.venv\Scripts\python.exe -m alembic current
```

## 运行 Schema 测试

Stage 1 / Task 4.1 的 Pydantic Schema 测试在 `tests/test_journal_schemas.py`。
在 `backend/` 目录下执行：

```powershell
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_journal_schemas.py
```

说明：

- 必须在 `backend/` 目录下运行，`app` 包才能被导入；
- `-B` 不写 `.pyc`，`-p no:cacheprovider` 不生成 `.pytest_cache`；
- 这些测试**只使用内存数据与未持久化的 ORM 对象**：不创建数据库连接、
  不创建 Session、不 flush / commit、不执行 SQL；
- 因此运行测试**不需要启动 Docker 或 PostgreSQL**；
- 导入 Model 会经 `app/database.py` 读取本机 `backend/.env` 并建立 Engine 对象，
  但 `create_engine` 是惰性的，不会真的连接数据库。

已覆盖：

- `JournalCreate`：`title` 省略默认 `None`、显式 `null`、普通字符串；
  缺少 `content` / `journal_date`；必填字段为 `null`；
  合法日期（含有效闰日 2024-02-29）；非法日期（2026-02-30、无效闰日 2026-02-29 等）；
  `content` 空字符串被接受；
- 额外字段策略：`id` / `created_at` / `updated_at` 等未知字段被忽略，
  不会出现在 `model_dump()` 中；
- `JournalResponse`：恰好六个字段、要求六字段齐全、`title` 可为 `null`；
- JSON 序列化：`journal_date` 表达为 `YYYY-MM-DD`，时间可解析回带时区原值；
- 未持久化 `Journal` 对象经 `model_validate()` 转换为 `JournalResponse`，字段值一致。

## 运行 API 测试

Stage 1 / Task 4.2 的创建 API 测试在 `tests/test_journal_api.py`。
在 `backend/` 目录下执行：

```powershell
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_journal_api.py
```

与 Schema 测试不同，**这套测试需要一个正在运行的本地 PostgreSQL**
（先完成「启动数据库」一节）。

测试用的 HTTP 客户端由 `httpx2` 提供：FastAPI 的 `TestClient` 通过它发出请求，
所以 `httpx2` 已记入 `requirements.txt`。

### 它验证了什么

用 FastAPI `TestClient` 打真实数据库，完整走一遍：

```text
HTTP → Pydantic → Router → Service → SQLAlchemy → psycopg → PostgreSQL
```

覆盖：

- 正常请求返回 `201`，响应包含六个字段；
- 响应与事务内实际数据库记录逐字段一致；
- `title` 省略与显式 `null` 都能创建，数据库不写入默认标题；
- 同一天创建两篇，`id` 不同；
- 缺必填项 / 必填为 `null` / 非法日历日期（2026-02-30、无效闰日）/ 无法解析的字符串
  返回 `422`，且不产生任何记录；
- 客户端提交的 `id` / `created_at` / `updated_at` 不会控制生成结果；
- 创建时间带时区；
- 写入失败（受控故障）触发 `rollback`：HTTP 返回 `500`，数据库无半截记录，
  Session 仍可继续使用；
- `/api/health` 行为不变。

### 测试数据为什么不会留在数据库里

每个测试用「外层事务 + savepoint」把 Service 的 `commit()` 关在里面：

```python
connection = engine.connect()
outer_transaction = connection.begin()
session = Session(bind=connection, join_transaction_mode="create_savepoint")
app.dependency_overrides[get_db] = override_get_db   # override 里 yield 上面这个 session
```

`join_transaction_mode="create_savepoint"` 让这个测试 Session 加入外层事务：
Session 自己的事务在连接上表现为一个 SAVEPOINT，因此 Service 里的 `db.commit()`
实际是 **RELEASE SAVEPOINT** —— 数据在测试连接内可见，但外层事务没有被提交。

测试结束时按顺序做三件事：

1. `app.dependency_overrides.clear()`：撤掉注入的测试 Session；
2. `session.close()`：归还连接（不提交任何东西）；
3. `outer_transaction.rollback()` 与 `connection.close()`：回滚外层事务。

测试期间插入的行随之全部消失。fixture 还会在结束时再查一次 `journals` 总行数，
确认与测试开始时一致。

两点说明：

- **`id` 会跳号。** PostgreSQL 的 sequence 取值不随事务回滚，因此跑完测试后
  `journals_id_seq` 的当前值会前进。这不代表数据残留。
- 测试只插入，不删除、不清空任何既有数据；每次运行前后 `journals` 的行数不变。

## 运行列表 / 筛选 API 测试

Stage 1 / Task 5.1 的读取 API 测试在 `tests/test_journal_read_api.py`。
在 `backend/` 目录下执行：

```powershell
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_journal_read_api.py
```

与创建测试一样，它也需要一个正在运行的本地 PostgreSQL。

覆盖：

- `GET /api/journals` 返回 `200` 与完整 Journal 数组，
  每个元素恰好六个字段，且各字段值与数据库里的实际记录一致；
- 空库返回 `[]`；无匹配日期返回 `200` 与 `[]`；
- 默认排序 `journal_date DESC`，同一天内 `created_at DESC`；
  测试手动指定时间并**乱序插入**，证明确实由数据库查询排序，
  而不是插入顺序或 Python 侧排序；
- `?journal_date=YYYY-MM-DD` 精确匹配，不含相邻日期；同日多篇全部返回；
- 非法日历日期（2026-02-30、无效闰日 2026-02-29）、格式错误与无法解析的字符串
  返回标准 `422`；
- `title` 为 `null` 时返回 `null`；
- 发出列表与筛选请求后，六个字段的实际列值与请求前完全一致
  （`GET` 不修改任何记录）。

共享 fixture `api` 位于 `tests/conftest.py`，创建测试与读取测试共用它：
它返回 `(TestClient, 测试 Session)`，并负责事务隔离与结束时的无残留检查。
隔离原理与上面「测试数据为什么不会留在数据库里」一节完全相同，
因此 `journal_date` 筛选测试同样不会写入真实数据，`id` 同样会跳号。

## 启动应用

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

- 应用地址：http://127.0.0.1:8000
- 交互式文档：http://127.0.0.1:8000/docs

## 验证应用

另开一个终端：

```powershell
curl.exe -i http://127.0.0.1:8000/api/health
```

期望结果：

- HTTP `200 OK`
- `Content-Type: application/json`
- 响应体：`{"status":"ok"}`

`/api/health` 只表示应用可以响应 HTTP 请求，不检查数据库。

## 停止

停止 FastAPI：

在运行 uvicorn 的终端按 `Ctrl+C`。

停止数据库容器（保留数据）：

在仓库根目录执行：

```powershell
docker compose --env-file backend/.env stop
```

说明：

- `stop` 只停止容器，数据卷保留；
- 如需删除容器而不删除数据，使用 `down`，不要加 `-v`；
- `down -v` 会删除数据卷，本地开发数据会丢失。

## 当前范围

已实现：

- `GET /api/health`（不检查数据库）
- `POST /api/journals`：创建 Journal，成功返回 `201` 与完整六字段记录
- `GET /api/journals`：返回 Journal 列表，成功返回 `200` 与完整数组
- `GET /api/journals?journal_date=YYYY-MM-DD`：按日期精确筛选
- 请求级 Session 依赖 `get_db()`（`app/database.py`）
- 创建 Service `create_journal()`：成功 commit、失败 rollback；
  查询 Service `list_journals()`：只读，排序与筛选都在 SQL 里完成（`app/journal/service.py`）
- Journal Router（`app/journal/router.py`），已在 `app/main.py` 注册
- 本地 PostgreSQL 开发数据库的 Compose 配置
- SQLAlchemy 2.x 数据库基础：Engine、Session 工厂、共享 Declarative Base（`app/database.py`）
- Journal Model：`journals` 表六个字段（`app/journal/models.py`）
- Alembic 首次迁移，`journals` 表已在本地数据库建立
- Journal Pydantic Schema：`JournalCreate` / `JournalResponse`（`app/journal/schemas.py`）
- 三套 pytest 测试：`tests/test_journal_schemas.py`（只用内存数据）、
  `tests/test_journal_api.py`（TestClient + 真实 PostgreSQL）、
  `tests/test_journal_read_api.py`（TestClient + 真实 PostgreSQL），
  共享 fixture 在 `tests/conftest.py`
- 只读的历史连接验证脚本（`scripts/check_db.py`）

尚未实现：

- `GET /api/journals/{id}` 单篇详情（Task 5.2）；
- `PATCH /api/journals/{id}`、`DELETE /api/journals/{id}`；
- 分页、搜索与排序查询参数；
- `JournalUpdate` 与其他后续 Schema；
- CORS、认证；
- 前端调用。

`journals` 表现在既能写入也能读出：`POST /api/journals` 创建记录，
`GET /api/journals` 列表与按日期筛选都能使用；
单篇详情、修改与删除接口尚未实现。
