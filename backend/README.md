# SeekJournal Backend

SeekJournal 后端（Stage 1 / Task 8.1 列表接入与 Task 8.2 创建接入的后端产物）。

当前包含：

- 一个最小 FastAPI 应用；
- 一个存活检查接口；
- 一份本地 PostgreSQL 开发数据库的 Compose 配置；
- SQLAlchemy 2.x 数据库基础（Engine / Session 工厂 / 请求级 Session 依赖 / Declarative Base）；
- Journal SQLAlchemy Model；
- Alembic 首次迁移，已在本地数据库建立 `journals` 表；
- Journal 的 Pydantic Schema（`JournalCreate` / `JournalUpdate` / `JournalResponse`）；
- `POST /api/journals` 创建链路，打通
  HTTP → Pydantic → Router → Service → SQLAlchemy → psycopg → PostgreSQL；
- `GET /api/journals` 列表，以及可选的 `journal_date` 精确日期筛选；
- `GET /api/journals/{id}` 单篇详情（不存在返回 `404`）；
- `PATCH /api/journals/{id}` 部分更新（记录不存在返回 `404`）；
- `DELETE /api/journals/{id}` 硬删除（成功返回 `204` 与空响应体，不存在返回 `404`）；
- 本地开发用的最小 CORS（只允许 `127.0.0.1:5173` 与 `localhost:5173` 的
  `GET` 与 `POST`，并允许 JSON 请求体所需的 `Content-Type` 请求头）；
- 七套 pytest 测试：Schema 测试（创建 / 响应）、`JournalUpdate` Schema 测试
  （两者只用内存数据）、创建 API 测试、列表 / 筛选 API 测试、
  详情 API 测试、修改（PATCH）API 测试、删除（DELETE）API 测试
  （后五套使用 TestClient + 真实 PostgreSQL）；
- 一套 CORS 测试（`test_cors.py`，只读 `GET /api/health` 与 `OPTIONS`，不写数据库）；
- 一个测试库隔离守卫（`test_test_database.py`，断言测试进程连的是 `seekjournal_test`）；
- 一个只读的历史连接验证脚本。

前端（React）通过真实 HTTP `GET`（列表、筛选）与 `POST`（创建）调用本 API，
接入范围见 `frontend/README.md`。

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
│       ├── schemas.py          # JournalCreate / JournalUpdate / JournalResponse
│       ├── service.py          # create_journal（事务边界）/ list_journals / get_journal / update_journal / delete_journal
│       └── router.py           # POST / GET /api/journals、GET / PATCH / DELETE /api/journals/{id}
├── tests/
│   ├── conftest.py             # 共享 api fixture（事务隔离 + 无残留检查）
│   ├── test_journal_schemas.py # Task 4.1 的 Schema 测试（只用内存数据）
│   ├── test_journal_update_schemas.py # Task 6.1 的 JournalUpdate 测试（只用内存数据）
│   ├── test_journal_api.py     # Task 4.2 的创建 API 测试（真实 PostgreSQL）
│   ├── test_journal_read_api.py   # Task 5.1 的列表 / 筛选测试（真实 PostgreSQL）
│   ├── test_journal_detail_api.py # Task 5.2 的详情测试（真实 PostgreSQL）
│   ├── test_journal_update_api.py # Task 6.2 的修改 API 测试（真实 PostgreSQL）
│   ├── test_journal_delete_api.py # Task 7.1 / 7.2 的删除 API 测试（真实 PostgreSQL）
│   ├── test_cors.py            # 最小 CORS 测试（只读 GET / POST 预检，不写数据库）
│   └── test_test_database.py   # 隔离守卫：断言测试进程连的是 seekjournal_test（不建连接）
├── alembic/
│   ├── env.py
│   ├── script.py.mako
│   ├── README
│   └── versions/
│       └── 3a70890ddb10_create_journals_table.py
├── alembic.ini
├── scripts/
│   ├── check_db.py             # Task 3 第一步的历史脚本
│   └── prepare_test_db.py      # 创建 / 迁移独立测试库 seekjournal_test
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

## 运行 JournalUpdate Schema 测试

Stage 1 / Task 6.1 的 `JournalUpdate` 测试在 `tests/test_journal_update_schemas.py`。
在 `backend/` 目录下执行：

```powershell
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_journal_update_schemas.py tests/test_journal_schemas.py
```

与创建 Schema 测试一样，它**只使用内存数据**：不导入 Model / Engine / Session，
不创建数据库连接、不 flush / commit、不执行 SQL，因此运行它不需要 Docker 或 PostgreSQL。
命令里同时带上 `tests/test_journal_schemas.py`，
是为了确认原有的 `JournalCreate` / `JournalResponse` 测试没有被改坏。

### 部分更新语义

`JournalUpdate` 只声明 `title` / `content` / `journal_date` 三个可更新字段，三者都允许省略。
区分「字段未提交」和「显式提交值」用的是 Pydantic v2 的提交状态：

```python
JournalUpdate().model_dump(exclude_unset=True)          # {}          没有字段需要更新
JournalUpdate(title=None).model_dump(exclude_unset=True)  # {"title": None}  清空标题
JournalUpdate(content="新正文").model_dump(exclude_unset=True)  # {"content": "新正文"}
```

- 省略字段 → 不进入更新数据；
- `title` 显式 `null` → 进入更新数据，表示清空标题；
- `content` / `journal_date` 显式 `null` → 被拒绝（它们对应的数据库列是 NOT NULL），
  只有「省略」才表示不更新；
- **不使用 `exclude_none=True`**：它会把显式提交的 `title=None` 一起丢掉，
  把「清空标题」误判成「不更新标题」；
- 也不能拿普通 `model_dump()` 当更新数据：它会把省略字段的默认值一起带出来。

### 覆盖范围

- `JournalUpdate` 恰好声明三个可更新字段，不含 `id` / `created_at` / `updated_at`；
- 三字段都可省略；空请求 `{}` 的更新数据为 `{}`；
- 只更新单字段、同时更新多字段；
- `title` 省略与显式 `null` 的区别；`title` 字符串与空字符串原样保留；
- `content` 空字符串与文本被接受，显式 `null` 被拒绝；
- `journal_date` 合法日期与有效闰日（2024-02-29）被接受；
  非法日历日期、无效闰日、格式错误与无法解析的值被拒绝，显式 `null` 被拒绝；
- 日期解析边界与 `JournalCreate` 一致（带时间后缀的字符串同样被截断，见下面的说明）；
- 类型错误（三字段传整数）被拒绝；
- 客户端提交的系统字段与未知字段被 `extra="ignore"` 忽略，
  既不进入更新数据，也不出现在模型上；
- `exclude_unset` 不带入未提交字段，且显式 `title=null` 不会被丢弃；
- `JournalUpdate` 未新增正则、strict、日期范围或默认日期规则。

`JournalUpdate` 内部的 `content` / `journal_date` 写成「非 Optional 注解 + `None` 默认值」：
默认值不参与验证，所以省略合法；显式提交 `null` 时仍按 `str` / `date` 验证，因此被拒绝。
这与契约要求一致，并由上面的测试逐条固定。

**日期解析边界说明**：与 `JournalCreate` 相同，Pydantic v2 内置的 `date` 解析会接受
`"2026-10-02T00:00:00"` 并截断为 `2026-10-02`。契约要求前端发送 `YYYY-MM-DD`，
但把这条边界收紧需要正则、`strict` 或自定义解析器，属于 Task 6.1 明确不增加的规则。

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

## 运行详情 API 测试

Stage 1 / Task 5.2 的单篇详情测试在 `tests/test_journal_detail_api.py`。
在 `backend/` 目录下执行：

```powershell
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_journal_detail_api.py
```

同样需要一个正在运行的本地 PostgreSQL，并复用同一个 `api` fixture。

覆盖：

- 已存在的 `id` 返回 `200`，响应恰好六个字段，且与数据库实际列值逐字段一致；
- `title` 为 `null` 时原样返回 `null`；时间字段带时区；
- 同一天多篇时按 `id` 精确命中，不会取回同日的另一篇（乱序插入以证明靠主键而非插入顺序）；
- 不存在的合法整数 `id` 返回 `404`（`detail` 为标准字符串，不自定义错误包装）；
- `0` 与负数同样返回 `404` —— 契约没有规定 `gt=0`，因此它们属于「合法整数但不存在」；
- 非整数路径参数（`abc`、`12abc`、`1.5`、`null`、`2026-10-02`）返回标准 `422`；
- 成功、`404`、`422` 三种请求之后，六个字段的实际列值与记录数量都不变
  （详情接口不修改任何记录，也不会顺手创建东西）；
- `POST` 创建之后用详情接口读回同一条记录，两份响应完全一致；
- 详情接口与列表接口对同一条记录给出相同的字段值。

### 不存在的 id 怎么取

不写死 `999` 这类固定值，也不假设 sequence 起始值或 `id` 连续：
测试先从当前事务里真实存在的 `id` 集合出发，挑一个**确认不在集合内**的值，
并在发出请求前后各断言一次该 `id` 确实不存在。
这样无论测试库是空库还是已有用户数据都成立。

共享 fixture 与写入隔离方式同样与上面几节一致，因此详情测试也不会留下残留，
`id` 同样会跳号。

## 运行修改（PATCH）API 测试

Stage 1 / Task 6.2 的部分更新测试在 `tests/test_journal_update_api.py`。
在 `backend/` 目录下执行：

```powershell
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_journal_update_api.py
```

同样需要一个正在运行的本地 PostgreSQL，并复用同一个 `api` fixture。

### 部分更新语义

- 只更新请求体里**实际提交**的字段（`JournalUpdate.model_dump(exclude_unset=True)`）；
  省略的字段保持原值；
- `title` 显式提交 `null` 表示清空标题，不会被丢弃；
- `content` 可以更新为空字符串；`content` / `journal_date` 显式 `null` 返回 `422`；
- `id` / `created_at` / `updated_at` 由系统决定，客户端提交的同名值被忽略。

### 空更新

请求体为 `{}`，或者只提交了被忽略的额外字段 / 系统字段时，验证后的更新数据是空集合：

- 记录存在：返回 `200` 与当前记录，**不产生任何写入**，`updated_at` 不变；
- 记录不存在：返回 `404`（空更新不会因为「没有内容可改」就跳过存在性判断）。

提交与原值相同的字段时，沿用 SQLAlchemy 的无变化处理：不额外强制刷新 `updated_at`，
也不额外增加比较层。这与「真的改了字段」是两条不同的路径。

### 覆盖范围

- 分别修改 `title` / `content` / `journal_date`，以及多字段同时修改；
- 响应恰好六字段，且与数据库实际列值逐字段一致；
- 未提交字段保持不变；同日另一篇记录完全不受影响；
- 清空标题后不生成日期标题、不写同日编号；
- `id` 与 `created_at` 不变；真的发生字段修改后 `updated_at` 更新
  （测试使用合成的、明显更早的时间，不需要 sleep）；
- 空更新返回当前记录且整表快照不变；只提交系统字段 / 未知字段按空更新处理；
- 不存在 id 返回 `404`（普通 PATCH 与空 PATCH 都是）；`0` / 负数同样 `404`；
- 非整数路径参数、`content` / `journal_date` 显式 `null`、非法日历日期、
  类型错误返回标准 `422`，且前后数据快照一致；
- 失败回滚：受控触发真实 `IntegrityError`（绕过校验构造 `content=None`）
  与受控 commit 故障，验证字段恢复、无半截更新、Session 仍可用，HTTP 返回 `500`；
- 联动：PATCH 后详情返回新值；改 `journal_date` 后按日期筛选体现新日期、
  旧日期不再包含该记录；列表反映新值；
- 独立连接确认测试期间没有任何提交，既有行快照不变。

### 失败路径为什么用 POST 造数据

`Session.rollback()` 会回滚到 Session 自己的 savepoint，
连测试刚 `flush()` 但还没 release 的行一起撤销。
所以回滚用例先用一次 `POST` 建记录（会 RELEASE SAVEPOINT，把该行留在外层事务里），
这样失败后的 rollback 只撤销那次 `UPDATE`，「字段是否恢复」才真的可验证。

### 关于 `journal_date`

修改 `journal_date` 后同一天仍允许存在多篇记录（该列不是 UNIQUE），
测试只在返回结果里定位自己创建的 id，不假设整个列表的内容。

## 运行删除（DELETE）API 测试

Stage 1 / Task 7.1 的硬删除测试与 Task 7.2 的失败回滚 / 影响范围 / 查询联动测试
都在 `tests/test_journal_delete_api.py`。
在 `backend/` 目录下执行：

```powershell
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_journal_delete_api.py
```

同样需要一个正在运行的本地 PostgreSQL，并复用同一个 `api` fixture。

### 行为

- 记录存在：硬删除，成功 `commit`，返回 `204 No Content` 与**空响应体**
  （不是 `null`、`{}`、Journal 对象或成功消息）；
- 记录不存在：返回 `404`；
- 非整数路径参数返回标准 `422`；
- Stage 1 使用硬删除：记录直接从 PostgreSQL 移除，不做软删除、不写 `deleted_at`。

失败的删除（`delete` / `commit` 报错）在 Service 内 `rollback` 后继续抛出异常，
不吞异常、不返回伪成功，也不把写入失败改写成 `404`。
`404` 与 `422` 都发生在写入之前，不会改变任何数据。

### 覆盖范围

- 删除已存在的记录返回 `204`，响应体为 `b""`；
- 用**原生 SQL** 确认该 `id` 在本次测试事务里已经不存在（不依赖 Session identity map）；
- 删除只影响目标行：其余记录逐字段原样保留；
- 同日其他记录（含 `title=null` 的一篇）与其他日期记录的六个字段完全不变，总行数只少一条；
- 同一记录删两次，第二次返回 `404`；
- 不存在的合法整数 `id` 返回 `404`，且不会顺手创建任何东西；
- `0` 与负数同样返回 `404` —— 契约没有规定 `gt=0`；
- 非整数路径参数（`abc`、`12abc`、`1.5`、`null`、`true`、`2026-10-02`）返回标准 `422`；
- `404` 与 `422` 前后整表六字段快照与记录数量都不变；
- 独立连接看不到任何变化：删除只存在于被回滚的外层事务里。

### 失败回滚（Task 7.2）

失败路径不使用「commit 前直接抛异常」的假故障，而是**先真实 `flush()` 出 DELETE**，
再抛出受控异常，因此能证明已经发到 PostgreSQL 的删除被 `rollback` 撤销：

- **Service 层**：目标行先用 `POST` 建好（已 RELEASE SAVEPOINT，留在外层事务内），
  再替换 Session 的 `commit` 为「`flush()` + 抛异常」；`delete_journal` 继续抛异常，
  `rollback` 后目标行恢复原值、整表快照回到失败前，`SELECT 1` 仍可执行；
- **恢复后可用**：撤掉故障注入后，对同一 Session 再删一次能成功返回 `True`；
- **HTTP 层**：同样注入故障，`DELETE` 返回 `500`（不是 `204` 也不是 `404`），
  原生 SQL 确认目标记录仍在、Session 仍可查询。

故障注入全部通过 `pytest` 的 `monkeypatch` 局限于单个测试，产品代码不做任何改动。

### 删除后的查询联动（Task 7.2）

在同一个回滚事务里验证：

- `DELETE` 目标返回 `204` 且响应体为空；
- `GET /api/journals/{id}` 对已删记录返回 `404`；
- `GET /api/journals` 列表不再包含目标 `id`；
- `GET /api/journals?journal_date=...` 对应日期筛选不再包含目标 `id`；
- 同日其他记录仍可经详情读取、仍出现在该日期的筛选里；
- 另一日期的记录仍可正常读取、出现在自己的日期筛选里；
- 对已删目标二次删除返回 `404`，其余记录快照不变。

### 删除目标只用测试自己创建的数据

删除是一类不可逆操作，因此本文件的删除目标**一律是本测试自己创建的合成记录**，
不存在「删掉既有数据」的路径：

- 数据由 `_seed()`（`session.add` + `flush`）在当前外层事务内创建；
- 不存在的 `id` 从当前事务里真实存在的 `id` 集合反推，不写死固定值；
- conftest 在导入应用之前已把连接切到测试库 `seekjournal_test`，
  所以这些删除不会落在开发库 `seekjournal` 上。

测试结束由 fixture 回滚外层事务，记录随之恢复，测试库回到运行前的行数；
`id` 同样会跳号（sequence 不随事务回滚）。

## 独立测试数据库与完整回归

API 测试现在使用同一 PostgreSQL 服务中的独立数据库 `seekjournal_test`，
开发库 `seekjournal` 中的记录不会参与测试，也不会被删除或修改。
连接凭据沿用本机 `.env`，仅在 pytest 进程内替换库名；无需修改 `.env`。

在 `backend/` 目录准备测试库（首次运行及新增 Migration 后执行）：

```powershell
.\.venv\Scripts\python.exe -B -m scripts.prepare_test_db
```

该命令仅创建不存在的 `seekjournal_test`，并对它执行已有的 Alembic
`upgrade head`。需要当前数据库用户有创建数据库权限。
可以重复执行；若测试库已存在日记记录，会失败并保留数据，不会清空。

完整回归：

```powershell
$env:PYTHONDONTWRITEBYTECODE = '1'
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests
```

所有上述 API 测试命令都自动使用测试库。
Schema 测试仍只使用内存，不建立数据库连接。
现有外层事务与 savepoint 隔离保持不变，测试结束后测试库无日记残留。
测试可能增加测试库的 sequence 取值，但不影响开发库的 sequence。

`tests/test_test_database.py` 是一道隔离守卫：它断言测试进程内的 Engine
指向 `seekjournal_test`（而不是开发库），本身不建立数据库连接。

当前用例数（`pytest --collect-only`，合计 **227**）：

| 文件 | 用例数 | 是否连库 |
|---|---|---|
| `test_journal_schemas.py` | 37 | 否（纯内存） |
| `test_journal_update_schemas.py` | 41 | 否（纯内存） |
| `test_journal_api.py` | 21 | 是（测试库） |
| `test_journal_read_api.py` | 18 | 是（测试库） |
| `test_journal_detail_api.py` | 21 | 是（测试库） |
| `test_journal_update_api.py` | 51 | 是（测试库） |
| `test_journal_delete_api.py` | 25 | 是（测试库） |
| `test_cors.py` | 12 | 否（只读 health / 预检） |
| `test_test_database.py` | 1 | 否（只读 Engine 元数据） |

## 测试库需要空白业务数据基线

`tests/test_journal_read_api.py` 里有三个用例要求**运行前 `journals` 表为空**
（它们自己带断言与提示信息）：

- `test_empty_database_returns_200_and_empty_array`
- `test_list_returns_200_with_items_carrying_exactly_six_fields`
- `test_title_null_is_returned_as_null`

`seekjournal_test.journals` 表已有记录时，这三个用例会失败。
**这是前置条件不满足，不是功能缺陷，也不要为了通过测试去删除数据。**
其余测试都在「外层事务 + savepoint」里运行，不要求空库。

## 本地开发 CORS

前端由 Vite 在 `5173` 端口提供，与本后端（`8000`）属于不同来源，
浏览器需要 CORS 才允许读取响应。配置在 `app/main.py`：

- 允许来源：`http://127.0.0.1:5173`、`http://localhost:5173`；
- 允许方法：`GET`（列表 / 详情读取）与 `POST`（创建）；
- 允许请求头：`Content-Type`（浏览器发 JSON POST 前的预检需要它）；
- **不使用通配来源**，**不开启 credentials**。

`PATCH` / `DELETE` 的浏览器支持留给 Task 8.3，届时再扩展 `allow_methods`。

`tests/test_cors.py` 覆盖：允许来源的 `GET` 响应带正确 `Allow-Origin`、
允许来源的 `GET` 预检成功、允许来源的 `POST` 预检成功且允许 `Content-Type`、
未允许来源拿不到允许头（读取与预检都不给）、`PATCH` / `DELETE` 预检被拒绝、
以及不使用通配来源。该文件只打 `GET /api/health` 与 `OPTIONS`，不写数据库。

## 启动应用

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

- 应用地址：http://127.0.0.1:8000
- 交互式文档：http://127.0.0.1:8000/docs

配合前端时，另开一个终端启动 Vite（固定在 `http://127.0.0.1:5173`），
两者同时运行，浏览器打开前端地址即可（CORS 已按上文配置）。
前端启动方式见 `frontend/README.md`。

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
- `GET /api/journals/{id}`：返回单篇 Journal，不存在时返回 `404`
- `PATCH /api/journals/{id}`：部分更新，成功返回 `200` 与完整六字段记录，
  不存在时返回 `404`，空更新不产生写入
- `DELETE /api/journals/{id}`：硬删除，成功返回 `204` 与空响应体，不存在时返回 `404`
- 请求级 Session 依赖 `get_db()`（`app/database.py`）
- 创建 Service `create_journal()`：成功 commit、失败 rollback；
  查询 Service `list_journals()`（排序与筛选都在 SQL 里完成）与
  `get_journal()`（按主键取单篇，未命中返回 `None`）；
  更新 Service `update_journal()`（部分更新、空更新直接返回、未命中返回 `None`、
  失败 rollback）；
  删除 Service `delete_journal()`（按主键硬删除、未命中返回 `False`、失败 rollback）
  （`app/journal/service.py`）
- Journal Router（`app/journal/router.py`），已在 `app/main.py` 注册
- 本地 PostgreSQL 开发数据库的 Compose 配置
- SQLAlchemy 2.x 数据库基础：Engine、Session 工厂、共享 Declarative Base（`app/database.py`）
- Journal Model：`journals` 表六个字段（`app/journal/models.py`）
- Alembic 首次迁移，`journals` 表已在本地数据库建立
- Journal Pydantic Schema：`JournalCreate` / `JournalUpdate` / `JournalResponse`
  （`app/journal/schemas.py`）
- 七套 pytest 测试：`tests/test_journal_schemas.py`、
  `tests/test_journal_update_schemas.py`（两者只用内存数据）、
  `tests/test_journal_api.py`、`tests/test_journal_read_api.py`、
  `tests/test_journal_detail_api.py`、`tests/test_journal_update_api.py`、
  `tests/test_journal_delete_api.py`
  （后五套均为 TestClient + 真实 PostgreSQL），
  共享 fixture 在 `tests/conftest.py`
- 测试库隔离守卫 `tests/test_test_database.py`（断言测试进程连的是 `seekjournal_test`）
- CORS 测试 `tests/test_cors.py`（只读，不写数据库）
- 本地开发 CORS（`app/main.py`，仅允许两个本地来源的 `GET` 与 `POST`，
  并允许 `Content-Type` 请求头）
- 只读的历史连接验证脚本（`scripts/check_db.py`）
- 独立测试库准备脚本（`scripts/prepare_test_db.py`）

尚未实现：

- 分页、搜索与排序查询参数；
- 认证；
- `PATCH` / `DELETE` 的浏览器端 CORS（Task 8.3）；
- 详情 / 修改 / 删除的前端 UI（Task 8.3）。

`journals` 表现在能创建、能列出、能按日期筛选、能按 `id` 取单篇、
能部分更新，也能硬删除；前端已能通过 `GET` 读取列表并按日期筛选（Task 8.1），
也能通过表单真实创建记录（Task 8.2）；详情 / 修改 / 删除 UI 尚未实现。
