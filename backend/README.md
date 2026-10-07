# SeekJournal Backend

SeekJournal 后端（Stage 1 / Task 8.1–8.4 列表、创建、详情 / 修改 / 删除与整体验收的后端产物；
Stage 1.5 / S1.5-T2 增加请求输入校验：`title` ≤80 码点、`content` 非空白且 ≤50,000 码点；
Stage 2 / S2-T01 建立数据基础：新增 `folders` / `inboxes` / `insights` 三张表，
`journals` 增加可空 `folder_id` 与 `deleted_at` 两列，全部由 Alembic Migration 建立；
Stage 2 / S2-T02 把 Journal 读取 / 修改 / 删除升级为分页 envelope、
统一显示标题投影与**软删除**，全部响应扩展为完整 Journal，**未新增 Migration**）。

当前包含：

- 一个最小 FastAPI 应用；
- 一个存活检查接口；
- 一份本地 PostgreSQL 开发数据库的 Compose 配置；
- SQLAlchemy 2.x 数据库基础（Engine / Session 工厂 / 请求级 Session 依赖 / Declarative Base）；
- Journal SQLAlchemy Model（Stage 2 / S2-T01 增加可空 `folder_id`、`deleted_at`）；
- Folder / Inbox / Insight SQLAlchemy Model（Stage 2 / S2-T01，只有表结构，尚无 API）；
- Alembic 迁移：初始 `journals` 表，以及 S2-T01 的 M1（folders + journals 两列）与 M2（inboxes / insights）；
- Journal 的 Pydantic Schema（`JournalCreate` / `JournalUpdate` / `JournalResponse` / `JournalPage`）；
  响应为完整十字段（`type` / `id` / `title` / `display_title` / `content` / `journal_date` /
  `folder_id` / `created_at` / `updated_at` / `deleted_at`），Stage 2 / S2-T02）；
- `POST /api/journals` 创建链路，打通
  HTTP → Pydantic → Router → Service → SQLAlchemy → psycopg → PostgreSQL；
- `GET /api/journals` 分页列表（固定 20 条/页，可选 `journal_date` / `folder_id` / `page`
  精确筛选，返回 `items` / `page` / `page_size` / `total` / `has_next` envelope）；
- `GET /api/journals/{id}` 单篇详情（不存在或已软删除返回 `404`）；
- `PATCH /api/journals/{id}` 部分更新（记录不存在或已软删除返回 `404`；
  指定不存在的 `folder_id` 返回 `404` 且不留下半截更新）；
- `DELETE /api/journals/{id}` **软删除**（成功返回 `204` 与空响应体；
  置 `deleted_at`、保留数据库行与 `updated_at`；不存在或已软删除返回 `404`）；
- 本地开发用的最小 CORS（只允许 `127.0.0.1:5173` 与 `localhost:5173` 的
  `GET` / `POST` / `PATCH` / `DELETE`，并允许 JSON 请求体所需的 `Content-Type` 请求头）；
- 八套 pytest 测试：Schema 测试（创建 / 响应）、`JournalUpdate` Schema 测试
  （两者只用内存数据）、创建 API 测试、列表 / 筛选 API 测试、
  详情 API 测试、修改（PATCH）API 测试、删除（DELETE）API 测试、
  分页 / 编号 / 软删除 API 测试（`test_journal_pagination_api.py`）
  （后六套使用 TestClient + 真实 PostgreSQL）；
- 一套 CORS 测试（`test_cors.py`，只读 `GET /api/health` 与 `OPTIONS`，不写数据库）；
- 一个测试库隔离守卫（`test_test_database.py`，断言测试进程连的是 `seekjournal_test`）；
- 一套迁移验证测试（`test_stage2_migrations.py`，在一次性隔离验证库上验证 M1 / M2 逐行保留旧 Journal）；
- 一个只读的历史连接验证脚本。

前端（React）通过真实 HTTP `GET`（列表、筛选、详情）、`POST`（创建）、
`PATCH`（修改）与 `DELETE`（删除）调用本 API，
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
│   ├── journal/
│   │   ├── __init__.py
│   │   ├── models.py           # Journal Model（含 folder_id / deleted_at）
│   │   ├── schemas.py          # JournalCreate / JournalUpdate / JournalResponse / JournalPage
│   │   ├── service.py          # create / list（分页）/ get / update / delete（软删除）
│   │   ├── titles.py           # display_title 投影与窗口函数编号（S2-T02）
│   │   └── router.py           # POST / GET /api/journals、GET / PATCH / DELETE /api/journals/{id}
│   ├── folder/
│   │   ├── __init__.py
│   │   └── models.py           # Folder Model（S2-T01 / M1）
│   ├── inbox/
│   │   ├── __init__.py
│   │   └── models.py           # Inbox Model（S2-T01 / M2）
│   └── insight/
│       ├── __init__.py
│       └── models.py           # Insight Model（S2-T01 / M2）
├── tests/
│   ├── conftest.py             # 共享 api fixture（事务隔离 + 四张业务表无残留检查）
│   ├── test_journal_schemas.py # Task 4.1 的 Schema 测试（只用内存数据）
│   ├── test_journal_update_schemas.py # Task 6.1 的 JournalUpdate 测试（只用内存数据）
│   ├── test_journal_api.py     # Task 4.2 的创建 API 测试（真实 PostgreSQL）
│   ├── test_journal_read_api.py   # Task 5.1 的列表 / 筛选测试（真实 PostgreSQL）
│   ├── test_journal_detail_api.py # Task 5.2 的详情测试（真实 PostgreSQL）
│   ├── test_journal_update_api.py # Task 6.2 的修改 API 测试（真实 PostgreSQL）
│   ├── test_journal_delete_api.py # Task 7.1 / 7.2 的删除 API 测试（软删除，真实 PostgreSQL）
│   ├── test_journal_pagination_api.py # S2-T02 的分页 / 编号 / 软删除测试（真实 PostgreSQL）
│   ├── test_stage2_migrations.py  # S2-T01 的 M1 / M2 迁移与旧数据保留验证（一次性隔离库）
│   ├── test_cors.py            # 最小 CORS 测试（只读 health / 四种方法预检，不写数据库）
│   └── test_test_database.py   # 隔离守卫：断言测试进程连的是 seekjournal_test（不建连接）
├── alembic/
│   ├── env.py
│   ├── script.py.mako
│   ├── README
│   └── versions/
│       ├── 3a70890ddb10_create_journals_table.py            # Stage 1 初始迁移
│       ├── 52c8e94a365c_create_folders_add_journal_folder_id_deleted_at.py  # S2-T01 / M1
│       └── a8d98342e603_create_inboxes_and_insights.py      # S2-T01 / M2
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
  `title` 超过 80 码点、`content` 为空白或超过 50,000 码点被拒绝（Stage 1.5 / T2）；
- 额外字段策略：`id` / `created_at` / `updated_at` 等未知字段被忽略，
  不会出现在 `model_dump()` 中；
- `JournalResponse`：恰好十个字段（`type` / `id` / `title` / `display_title` / `content` /
  `journal_date` / `folder_id` / `created_at` / `updated_at` / `deleted_at`），要求齐全、
  `title` / `folder_id` / `deleted_at` 可为 `null`（Stage 2 / S2-T02）；
- JSON 序列化：`journal_date` 表达为 `YYYY-MM-DD`，时间可解析回带时区原值；
- 未持久化 `Journal` 对象经 `model_validate()` 转换为 `JournalResponse`，字段值一致。
- `JournalPage`：`items` / `page` / `page_size` / `total` / `has_next` 五个字段。

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
- `content` 非空文本被接受；空白正文（含空字符串）与显式 `null` 被拒绝；
  标题超过 80 码点、正文超过 50,000 码点被拒绝（Stage 1.5 / T2）；
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

- 正常请求返回 `201`，响应包含完整十字段（`type` / `id` / `title` / `display_title` /
  `content` / `journal_date` / `folder_id` / `created_at` / `updated_at` / `deleted_at`）；
- 响应与事务内实际数据库记录逐字段一致；
- `title` 省略与显式 `null` 都能创建，数据库不写入默认标题；
- `folder_id` 省略 / `null` 表示不属于任何 Folder；指定不存在的 Folder 返回 `404`
  且不产生任何记录（`folder_id` 类型非法则返回 `422`）；
- 同一天创建两篇，`id` 不同；
- 缺必填项 / 必填为 `null` / 非法日历日期（2026-02-30、无效闰日）/ 无法解析的字符串
  返回 `422`，且不产生任何记录；
- 客户端提交的 `id` / `created_at` / `updated_at` / `folder_id` / `display_title` /
  `deleted_at` 不会控制生成结果（系统字段仍按 `extra="ignore"` 被忽略）；
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

- `GET /api/journals` 返回 `200` 与**分页 envelope**
  （`items` / `page` / `page_size` / `total` / `has_next`，Stage 2 / S2-T02），
  每个 `items` 元素是完整十字段且各字段值与数据库里的实际记录一致；
- 空库返回 `200` 与空 `items`（`[]`）；无匹配日期同样返回空 `items`；
- 默认排序 `journal_date DESC`，同一天内 `created_at DESC`，再以 `id DESC` 打破并列；
  测试手动指定时间并**乱序插入**，证明确实由数据库查询排序，
  而不是插入顺序或 Python 侧排序；
- `?journal_date=YYYY-MM-DD` 精确匹配，不含相邻日期；同日多篇全部返回；
- 非法日历日期（2026-02-30、无效闰日 2026-02-29）、格式错误与无法解析的字符串
  返回标准 `422`；非法 `page`（`0` / 负数 / 非整数）同样返回标准 `422`；
- `title` 为 `null` 时返回 `null`，`display_title` 回退为其 `journal_date`；
- 发出列表与筛选请求后，实际列值与请求前完全一致（`GET` 不修改任何记录）。

分页本身（固定 20 条/页、`total` / `has_next`、0/1/20/21/41 条边界、跨页编号、
`folder_id` 筛选、软删除隐藏等）由 `tests/test_journal_pagination_api.py` 单独覆盖，
见下文「运行分页 / 编号 / 软删除 API 测试」。

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

- 已存在的 `id` 返回 `200`，响应是完整十字段，且与数据库实际列值逐字段一致；
- `title` 为 `null` 时原样返回 `null`；时间字段带时区；
  `deleted_at` 在普通详情响应里恒为 `null`；
- `display_title` 与列表、`POST` / `PATCH` 返回值使用同一套投影：
  手工标题原样显示，无标题（`null` 或 `""`）显示其 `journal_date` 与同日编号；
- 同一天多篇时按 `id` 精确命中，不会取回同日的另一篇（乱序插入以证明靠主键而非插入顺序）；
- 不存在的合法整数 `id` 返回 `404`（`detail` 为标准字符串，不自定义错误包装）；
  **已软删除的 `id` 同样返回 `404`**；
- `0` 与负数同样返回 `404` —— 契约没有规定 `gt=0`，因此它们属于「合法整数但不存在」；
- 非整数路径参数（`abc`、`12abc`、`1.5`、`null`、`2026-10-02`）返回标准 `422`；
- 成功、`404`、`422` 三种请求之后，实际列值与记录数量都不变
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

- 分别修改 `title` / `content` / `journal_date` / `folder_id`，以及多字段同时修改；
- 响应是完整十字段，且与数据库实际列值逐字段一致；
- 未提交字段保持不变；同日另一篇记录完全不受影响；
- 清空标题后不生成日期标题、不写同日编号（`display_title` 回退为日期）；
- `folder_id` 显式 `null` 表示移出 Folder；指定不存在的 Folder 返回 `404` 且字段全部不变；
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

Stage 1 / Task 7.1 的删除测试与 Task 7.2 的失败回滚 / 影响范围 / 查询联动测试
都在 `tests/test_journal_delete_api.py`；Stage 2 / S2-T02 起语义由**硬删除**改为**软删除**
（进入回收箱，见 `docs/stage2-api.md` §3）。
在 `backend/` 目录下执行：

```powershell
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_journal_delete_api.py
```

同样需要一个正在运行的本地 PostgreSQL，并复用同一个 `api` fixture。

### 行为（Stage 2 软删除）

- 记录存在：软删除，成功 `commit`，返回 `204 No Content` 与**空响应体**
  （不是 `null`、`{}`、Journal 对象或成功消息）；
- **数据库行保留**，只把 `deleted_at` 置为当前时间；
- 原六字段、`folder_id` 与 `updated_at` **逐字段不变**——
  `updated_at` 的 `onupdate` 必须在同一个 `UPDATE` 里被显式抵消，
  否则「删除」会被误记成一次内容修改；
- 记录不存在 / 已软删除：返回 `404`；
- 非整数路径参数返回标准 `422`。

失败的删除（`delete` / `commit` 报错）在 Service 内 `rollback` 后继续抛出异常，
不吞异常、不返回伪成功，也不把写入失败改写成 `404`。
`404` 与 `422` 都发生在写入之前，不会改变任何数据。
恢复、永久删除与回收箱列表属于 S2-T09，本任务不覆盖。

### 覆盖范围

- 删除已存在的记录返回 `204`，响应体为 `b""`；
- 用**原生 SQL** 确认该 `id` 在本次测试事务里**仍然存在**，且 `deleted_at` 由 `NULL` 变为非空；
- 删除只影响目标行：其余记录逐字段原样保留；
- 同日其他记录（含 `title=null` 的一篇）与其他日期记录的完整列完全不变，物理行数不变；
- `updated_at` 与删除前**精确相等**（不与 `deleted_at` 一起被刷新）；
- 同一记录删两次：第二次返回 `404`，且原来的 `deleted_at` 不被改写；
- 不存在的合法整数 `id` 返回 `404`，且不会顺手创建任何东西；
- `0` 与负数同样返回 `404` —— 契约没有规定 `gt=0`；
- 非整数路径参数（`abc`、`12abc`、`1.5`、`null`、`true`、`2026-10-02`）返回标准 `422`；
- `404` 与 `422` 前后整表完整列快照与记录数量都不变；
- 独立连接看不到任何变化：软删除只存在于被回滚的外层事务里。

### 失败回滚（Task 7.2）

失败路径不使用「commit 前直接抛异常」的假故障，而是**先真实 `flush()` 出 `UPDATE`**，
再抛出受控异常，因此能证明已经发到 PostgreSQL 的软删除被 `rollback` 撤销：

- **Service 层**：目标行先用 `POST` 建好（已 RELEASE SAVEPOINT，留在外层事务内），
  再替换 Session 的 `commit` 为「`flush()` + 抛异常」；`delete_journal` 继续抛异常，
  `rollback` 后目标行恢复原值（`deleted_at` 回到 `NULL`）、整表快照回到失败前，
  `SELECT 1` 仍可执行；
- **恢复后可用**：撤掉故障注入后，对同一 Session 再删一次能成功返回 `True`；
- **HTTP 层**：同样注入故障，`DELETE` 返回 `500`（不是 `204` 也不是 `404`），
  原生 SQL 确认目标记录仍有效、Session 仍可查询。

故障注入全部通过 `pytest` 的 `monkeypatch` 局限于单个测试，产品代码不做任何改动。

### 删除后的查询联动

在同一个回滚事务里验证：

- `DELETE` 目标返回 `204` 且响应体为空；
- `GET /api/journals/{id}` 对已删记录返回 `404`，`PATCH` 同样返回 `404` 且不写任何字段；
- `GET /api/journals` 列表不再包含目标 `id`；
- `GET /api/journals?journal_date=...` 对应日期筛选不再包含目标 `id`；
- 同日其他记录仍可经详情读取、仍出现在该日期的筛选里；
- 另一日期的记录仍可正常读取、出现在自己的日期筛选里；
- 对已删目标二次删除返回 `404`，其余记录快照不变；
- 已删除的记录行仍留在数据库里，只是被标记为已删除。

### 删除目标只用测试自己创建的数据

删除是一类不易恢复的操作，因此本文件的删除目标**一律是本测试自己创建的合成记录**，
不存在「删掉既有数据」的路径：

- 数据由 `_seed()`（`session.add` + `flush`）在当前外层事务内创建；
- 不存在的 `id` 从当前事务里真实存在的 `id` 集合反推，不写死固定值；
- conftest 在导入应用之前已把连接切到测试库 `seekjournal_test`，
  所以这些删除不会落在开发库 `seekjournal` 上。

测试结束由 fixture 回滚外层事务，记录随之恢复，测试库回到运行前的行数；
`id` 同样会跳号（sequence 不随事务回滚）。

## 运行分页 / 编号 / 软删除 API 测试

Stage 2 / S2-T02 新增的 `tests/test_journal_pagination_api.py` 覆盖新读取契约。
在 `backend/` 目录下执行：

```powershell
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_journal_pagination_api.py
```

它同样使用 TestClient + 真实 PostgreSQL，并复用共享的 `api` fixture。

**这批测试按「非空库」设计**：分页总数断言一律带 `journal_date` / `folder_id` 筛选，
只数本用例自己造的数据，因此测试库之前是否有记录都能通过；
每个用例还使用与其它测试文件错开的业务日期。

覆盖：

- 边界：0 / 1 / 20 / 21 / 41 条时的 `page` / `page_size` / `total` / `has_next`；
- 非法页码（`0` / 负数 / 非整数）返回标准 `422`；超出最后页返回 `200` + 空 `items`
  并**保留请求页码**；
- `journal_date` 与 `folder_id` 筛选（含 `folder_id` 指向不存在 Folder 时列表为空）；
- 并列 `created_at` 的稳定排序（第三键 `id DESC`），跨页不重叠、不遗漏；
- **同日跨页编号**：无标题记录跨两页时编号连续，不按当前页重新计数；
- 手工标题 / `NULL` / `""` / 纯空白标题混合时的编号规则（纯空白是手工标题，不占号）；
- 新增较晚记录不改变旧记录编号；软删除仍占原号（编号在含已删除记录的完整集合上计算）；
- 详情、列表、`POST` 与 `PATCH` 返回值对同一条记录给出**相同的 `display_title`**；
- 已软删除记录在列表、日期筛选、详情、`PATCH` 与再次 `DELETE` 中全部隐藏（404）；
- 删除前后的完整列快照，`updated_at` **精确不变**、`deleted_at` 由 `NULL` 变为非空；
- 重复删除返回 `404` 且不改写原 `deleted_at`；204 响应体为空；
- 空 `PATCH` / 相同值 `PATCH` 不改变 `updated_at`；Folder 原子更新（`null` 移出、不存在 404）；
- 写失败 rollback 后 Session 仍可继续使用。

## 请求输入校验（Stage 1.5 / S1.5-T2）

`POST /api/journals` 与 `PATCH /api/journals/{id}` 对**实际提交**的字段执行同一套规则
（`app/journal/schemas.py`）：

| 字段 | 规则 |
|---|---|
| `title` | 可省略 / `null` / 空字符串；最多 **80 个 Unicode 码点**；非空标题原样保存（不 `trim`） |
| `content` | 必须含**至少一个非空白字符**，且原始字符串最多 **50,000 个 Unicode 码点** |
| `folder_id` | 可省略 / `null` / 正整数（S2-T02）；字符串、小数与 `true` 被拒绝。**是否存在由 Service 查库判断**，不存在返回 `404` |

要点：

- **按 Unicode 码点计数**：Python 的 `len(str)` 本身就是码点数，非 BMP 字符（emoji）算 1 个，
  不会被当成 UTF-16 的 2 个 code unit；
- **空白判定与前端同一份集合**（`frontend/src/utils/contentValidation.ts`），
  至少覆盖普通空格、Tab、换行、全角空格（U+3000）与 NBSP（U+00A0）；
- **trim 只用于判断**，不会把 `trim` 结果写回数据库：Markdown 缩进、空行与首尾空格原样保存；
- 校验失败抛 `ValidationError`，由 FastAPI 统一转成标准 **422**，
  发生在 Router / Service 之前，因此**不会产生任何写入**；
- **PATCH 只校验本次提交的字段**：字段省略时默认值不参与验证，
  因此「旧记录正文超长 / 空白，本次只改标题」依然成功；真的重新提交非法值才会 422。
- `folder_id` 的**类型**错误由 Schema 返回 422，**指向不存在的 Folder** 由 Service
  返回 404 —— 两者都不产生任何写入。

### 为什么 `JournalResponse` 不加这些约束

历史数据里可能存在超长标题 / 超长或空白正文。如果把这些校验也加到响应 Schema 上，
读取这些旧记录时会在序列化阶段报错，记录直接读不出来。
因此约束**只加在请求 Schema**（`JournalCreate` / `JournalUpdate`）上，
响应保持宽松，旧值始终可读。测试里用 ORM 直接合成「旧非法记录」来固定这一点
（`test_journal_update_api.py` 的 F 节：列表 / 详情可读、只改其它字段不被连带清洗、
重新提交非法值才 422）。

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
可以重复执行；**只要四张业务表（`folders` / `journals` / `inboxes` / `insights`）
中任意一张已有记录，命令就会失败并保留数据，不会清空**。
升级前部分新表还不存在时，脚本会用 `to_regclass` 判断后跳过，不会报错，
也不会用 `create_all` / `drop_all` / `stamp` 代替 Alembic。

完整回归：

```powershell
$env:PYTHONDONTWRITEBYTECODE = '1'
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests
```

所有上述 API 测试命令都自动使用测试库。
Schema 测试仍只使用内存，不建立数据库连接。
现有外层事务与 savepoint 隔离保持不变；无残留检查已从只数 `journals`
扩展为逐表核对 `folders` / `journals` / `inboxes` / `insights`，
测试结束后四张业务表都回到运行前的行数。
测试可能增加测试库的 sequence 取值，但不影响开发库的 sequence。

`tests/test_test_database.py` 是一道隔离守卫：它断言测试进程内的 Engine
指向 `seekjournal_test`（而不是开发库），本身不建立数据库连接。

当前用例数（`pytest --collect-only`，合计 **385**；Stage 1.5 / T2 增加了输入校验与旧数据用例，Stage 2 / S2-T01 增加了迁移验证用例，S2-T02 增加了分页 / 编号 / 软删除用例）：

| 文件 | 用例数 | 是否连库 |
|---|---|---|
| `test_journal_schemas.py` | 78 | 否（纯内存） |
| `test_journal_update_schemas.py` | 70 | 否（纯内存） |
| `test_journal_api.py` | 36 | 是（测试库） |
| `test_journal_read_api.py` | 19 | 是（测试库） |
| `test_journal_detail_api.py` | 22 | 是（测试库） |
| `test_journal_update_api.py` | 67 | 是（测试库） |
| `test_journal_delete_api.py` | 27 | 是（测试库） |
| `test_journal_pagination_api.py` | 39 | 是（测试库） |
| `test_stage2_migrations.py` | 9 | 是（**一次性隔离迁移验证库**，不碰测试库与开发库） |
| `test_cors.py` | 17 | 否（只读 health / 预检） |
| `test_test_database.py` | 1 | 否（只读 Engine 元数据） |

## 测试库需要空白业务数据基线

`tests/test_journal_read_api.py` 里有三个用例要求**运行前 `journals` 表为空**
（它们自己带断言与提示信息）：

- `test_empty_database_returns_200_and_empty_items`
- `test_list_returns_200_with_items_carrying_the_complete_field_set`
- `test_title_null_falls_back_to_the_date_as_display_title`

`seekjournal_test.journals` 表已有记录时，这三个用例会失败。
**这是前置条件不满足，不是功能缺陷，也不要为了通过测试去删除数据。**
其余测试都在「外层事务 + savepoint」里运行，不要求空库；
`tests/test_journal_pagination_api.py` 特意按「非空库」设计——
它的总数断言一律带 `journal_date` / `folder_id` 筛选，只数自己造的数据，
因此无论测试库之前是否有记录都能通过。

`tests/test_stage2_migrations.py` 不依赖测试库基线：它在运行时创建自己的
一次性隔离迁移验证库，跑完即删。但 `folders` / `inboxes` / `insights`
三张新表必须已经存在，所以这个测试同样要求先跑一次 `prepare_test_db`。

## 本地开发 CORS

前端由 Vite 在 `5173` 端口提供，与本后端（`8000`）属于不同来源，
浏览器需要 CORS 才允许读取响应、并发起写请求。配置在 `app/main.py`：

- 允许来源：`http://127.0.0.1:5173`、`http://localhost:5173`；
- 允许方法：`GET`（列表 / 详情读取）、`POST`（创建）、`PATCH`（修改）与
  `DELETE`（删除），覆盖 Stage 1 前端用到的全部方法；
- 允许请求头：`Content-Type`（浏览器发 JSON POST / PATCH 前的预检需要它）；
- **不使用通配来源**，**也不使用通配方法**，**不开启 credentials**。

Task 8.3 只是把 `allow_methods` 从 `GET, POST` 扩成 `GET, POST, PATCH, DELETE`，
没有改动允许来源、允许请求头，也没有改动任何业务 Router 或 Service。

`tests/test_cors.py` 覆盖：允许来源的 `GET` 响应带正确 `Allow-Origin`、
允许来源的 `GET` 预检成功、允许来源的 `POST` 预检成功且允许 `Content-Type`、
允许来源的 `PATCH` / `DELETE` 预检成功、
允许头里包含四种方法且**不含通配方法**、未允许来源拿不到允许头
（读取、预检、以及新开放的 `PATCH` / `DELETE` 预检都不给）。
该文件只打 `GET /api/health` 与 `OPTIONS`；预检由 `CORSMiddleware` 直接应答、
不会进入业务路由，因此它不写数据库。

> 顺带一提：实测本机（2026-10-06）浏览器确实会为跨来源的
> `PATCH` / `DELETE` 发出 `OPTIONS` 预检，且带未在 `allow_headers` 里的
> 自定义请求头时预检被拒（后端记录为 `OPTIONS ... 400`）。
> 也就是说 CORS 不是「配置了但浏览器没真的检查」。

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
- `POST /api/journals`：创建 Journal，成功返回 `201` 与完整十字段记录
- `GET /api/journals`：Journal 分页列表，成功返回 `200` 与分页 envelope
  （固定 20 条/页，可选 `journal_date` / `folder_id` / `page`）
- `GET /api/journals?journal_date=YYYY-MM-DD` / `?folder_id=N`：精确筛选（同样分页）
- `GET /api/journals/{id}`：返回单篇 Journal，不存在或已软删除时返回 `404`
- `PATCH /api/journals/{id}`：部分更新，成功返回 `200` 与完整十字段记录，
  不存在或已软删除时返回 `404`，指定的 `folder_id` 不存在时返回 `404`，空更新不产生写入
- `DELETE /api/journals/{id}`：**软删除**（进入回收箱），成功返回 `204` 与空响应体，
  不存在或已软删除时返回 `404`
- 请求级 Session 依赖 `get_db()`（`app/database.py`）
- 创建 Service `create_journal()`：成功 commit、失败 rollback（含 Folder 存在性校验）；
  查询 Service `list_journals()`（分页 + 筛选 + 窗口函数编号都在 SQL 里完成）与
  `get_journal()`（按主键取单篇且排除已删除，未命中返回 `None`）；
  更新 Service `update_journal()`（部分更新、空更新直接返回、未命中返回 `None`、
  Folder 原子校验、失败 rollback）；
  删除 Service `delete_journal()`（软删除、显式保留 `updated_at`、未命中或已删返回 `False`、
  失败 rollback）（`app/journal/service.py`）
- 显示标题投影 `build_display_title()` / `is_untitled()`（`app/journal/titles.py`）
- Journal Router（`app/journal/router.py`），已在 `app/main.py` 注册
- 本地 PostgreSQL 开发数据库的 Compose 配置
- SQLAlchemy 2.x 数据库基础：Engine、Session 工厂、共享 Declarative Base（`app/database.py`）
- Journal Model：原六字段 + 可空 `folder_id`、`deleted_at`（`app/journal/models.py`）
- Alembic 迁移：初始 `journals` 表，以及 S2-T01 的 M1 / M2（S2-T02 无新迁移）
- Journal Pydantic Schema：`JournalCreate` / `JournalUpdate` / `JournalResponse` / `JournalPage`
  （`app/journal/schemas.py`）
- 八套 pytest 测试：`tests/test_journal_schemas.py`、
  `tests/test_journal_update_schemas.py`（两者只用内存数据）、
  `tests/test_journal_api.py`、`tests/test_journal_read_api.py`、
  `tests/test_journal_detail_api.py`、`tests/test_journal_update_api.py`、
  `tests/test_journal_delete_api.py`、`tests/test_journal_pagination_api.py`
  （后六套均为 TestClient + 真实 PostgreSQL），
  共享 fixture 在 `tests/conftest.py`
- 测试库隔离守卫 `tests/test_test_database.py`（断言测试进程连的是 `seekjournal_test`）
- CORS 测试 `tests/test_cors.py`（只读，不写数据库）
- 本地开发 CORS（`app/main.py`，仅允许两个本地来源的
  `GET` / `POST` / `PATCH` / `DELETE`，并允许 `Content-Type` 请求头）
- 只读的历史连接验证脚本（`scripts/check_db.py`）
- 独立测试库准备脚本（`scripts/prepare_test_db.py`）

尚未实现：

- 可配置的 `page_size` 与自定义排序参数；
- 恢复 / 永久删除 / 回收箱列表（S2-T09）；
- Folder、Inbox、Insight 的 API（只有表结构与 Model）；
- 搜索、内部链接解析；
- 认证。

`journals` 表现在能创建、能分页列出、能按日期 / Folder 筛选、能按 `id` 取单篇、
能部分更新，也能软删除。前端（`frontend/`）仍按 Stage 1.5 的**数组契约**读取列表，
尚未适配分页 envelope —— 前端对接属于 **S2-T03**，本任务不修改前端，
也不为了兼容而保留第二套旧 API。

## Stage 1 整体验收（Task 8.4）

Stage 1 的整体验收记录在
[`docs/stage1-acceptance.md`](../docs/stage1-acceptance.md)：包含验收时 HEAD / 日期 / 环境、
功能与技术验收矩阵、逐项证据、真实与合成证据的区分、持久化专项、
两库数据保护、未验证项与用户确认事项。

Task 8.4 **没有修改任何后端源码或测试**：只运行了既有测试、做了只读的
Alembic / Compose / 表结构核对，并在**指向测试库**的临时后端上完成浏览器验收。
后端侧的可复现命令：

```powershell
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests   # 验收当时 232 passed
.\.venv\Scripts\python.exe -m pip check                               # No broken requirements found.
.\.venv\Scripts\python.exe -m alembic current                          # 3a70890ddb10 (head)
.\.venv\Scripts\python.exe -m alembic check                            # No new upgrade operations detected.
```

> 上面 `232 passed` 是 Stage 1 验收当时的快照。Stage 1.5 / T2 之后变为 **305**，
> Stage 2 / S2-T01 之后为 **314**，S2-T02 之后为 **385**；
> 当前准确数量见上文「独立测试数据库与完整回归」里的用例表。

## Stage 2 / S2-T01 — 数据基础与旧 Journal 升级

S2-T01 只做数据结构，**不做任何 API / Service / Router 变更**：
Stage 1.5 的六个字段、数组列表响应与硬删除行为在当时原样保留。
`deleted_at` 当时只是列占位，软删除行为在下一个任务 S2-T02 落地。

> **已被 S2-T02 取代的部分**：列表数组响应、六字段响应与硬删除均已在本轮升级为
> 分页 envelope、十字段响应与软删除。本节只作为 S2-T01 当时的数据结构与迁移记录保留。

### 两份新 Migration

| 代号 | Revision | down_revision | 内容 |
|---|---|---|---|
| M1 | `52c8e94a365c` | `3a70890ddb10` | 建 `folders`（id、name Text Not Null）；`journals` 增加可空 `folder_id`（FK → `folders.id`）与可空 `deleted_at` |
| M2 | `a8d98342e603` | `52c8e94a365c` | 建 `inboxes`（含 `inbox_date`、`is_daily` Not Null 默认 false）与 `insights` |

- 三步是一条线性链、只有一个 head：`3a70890ddb10 → 52c8e94a365c → a8d98342e603`；
- 初始迁移 `3a70890ddb10` **未做任何修改**；
- 只 `ADD COLUMN` + `CREATE TABLE`，没有 drop / 重建 / 数据清洗，也没有额外表；
- 旧 Journal 的两列升级后都是 `NULL`，原六字段、主键、sequence 与
  `ix_journals_journal_date` 索引全部保留；
- 外键保持 PostgreSQL 默认的 `NO ACTION`，不 cascade、不 SET NULL；
- `is_daily` 同时有 Python 默认值与数据库 `server_default = false`；
- 本任务**没有 M3**：Daily 唯一部分索引等 P2 确认后在 S2-T04 建。

新增 Model 在两处显式注册：`alembic/env.py`（autogenerate 用）与
`app/main.py`（运行时用）。后者只导入 Model，**不注册任何新 Router**。

### Model 结构

| 表 | 字段 |
|---|---|
| `folders` | id、name（Text Not Null） |
| `journals` | 原六字段 + folder_id（Nullable FK）、deleted_at（Nullable timestamptz） |
| `inboxes` | id、title（Nullable）、content（Not Null）、inbox_date（Not Null）、is_daily（Not Null，默认 false）、folder_id（Nullable FK）、created_at、updated_at、deleted_at |
| `insights` | id、title（Nullable）、content（Not Null）、folder_id（Nullable FK）、created_at、updated_at、deleted_at |

### 迁移验证方式

`tests/test_stage2_migrations.py` 在**一次性隔离验证库**（名字带进程号，跑完即删）上：

1. 升到 `3a70890ddb10`，用**旧六字段 SQL** 合成 8 条历史数据
   （NULL / 空字符串 / 纯空白标题、同日多篇、空字符串与纯空白正文、
   超长标题与超长正文、不同日期、2020 年的历史时间戳）；
2. 逐行记录原六字段（id + 每行 digest，不打印正文）；
3. 升到 M1 比对一次，再升到 M2 比对一次，要求完全一致；
4. 校验新列为 NULL、列顺序、FK 与 `ondelete`、`is_daily` 默认值、索引，
   以及实际结构与 `Base.metadata` 一致；
5. 在隔离事务里通过 ORM 读写三张新表，并确认回滚后无残留。

迁移子进程通过独立 `DATABASE_URL` 环境变量启动，因此使用的是新 Engine，
不会复用测试进程里已经创建的 Engine。

### 命令与结果

```powershell
.\.venv\Scripts\python.exe -B -m scripts.prepare_test_db
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_stage2_migrations.py tests/test_test_database.py
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests
.\.venv\Scripts\python.exe -B -m alembic heads
```

| 命令 | 实际结果 |
|---|---|
| `scripts.prepare_test_db` | `PASS: seekjournal_test 已准备，开发库未执行迁移或数据操作` |
| 迁移 + 隔离守卫 | `10 passed` |
| 全量回归 | `314 passed` |
| `alembic heads` | `a8d98342e603 (head)`（单 head） |

对 `seekjournal_test` 用进程级 `DATABASE_URL` 执行 `alembic current` → `a8d98342e603 (head)`，
`alembic check` → `No new upgrade operations detected.`

### 开发库 `seekjournal` 的状态

本次实施**没有升级开发库**。开发库仍是 `3a70890ddb10`，
对它有数据变化的 `alembic check` 只会显示 `FAILED: Target database is not up to date.` ——
**这是预期的阶段状态：代码里的 Model 已经前进，开发库等用户单独授权的升级轮**。

用户授权后，升级命令为（在 `backend/` 下执行）：

```powershell
.\.venv\Scripts\python.exe -B -m alembic upgrade head   # 3a70890ddb10 -> 52c8e94a365c -> a8d98342e603
.\.venv\Scripts\python.exe -B -m alembic current
```

## Stage 2 / S2-T02 — Journal 分页、统一显示标题与软删除

S2-T02 按 `docs/stage2-api.md` 把 Journal 的读取 / 修改 / 删除升级为新契约，
**没有新增 Migration**（M1 / M2 保持不变，`alembic heads` 仍是 `a8d98342e603`）。

### 完整响应（十字段）

```json
{
  "type": "journal",
  "id": 1,
  "title": null,
  "display_title": "2026-10-02",
  "content": "正文",
  "journal_date": "2026-10-02",
  "folder_id": null,
  "created_at": "...",
  "updated_at": "...",
  "deleted_at": null
}
```

- `title` / `content` 保留数据库原始值；
- `display_title` 是**只读读取投影**，不写入 `title`、不新增数据库字段；
- 普通响应的 `deleted_at` 恒为 `null`（已删除记录不出现在普通入口）；
- 响应 Schema **不套用**请求的长度 / 非空限制：旧超长标题、超长或空白正文仍可读取。

### 分页 envelope

`GET /api/journals` 返回 `items` / `page` / `page_size`（固定 20）/ `total` / `has_next`：

- 可选 `journal_date`、`folder_id`、`page`（默认 1，`>= 1`，非法返回标准 422）；
- `total` 是「有效状态 + 全部筛选条件」生效后的总数；`has_next = page * page_size < total`；
- 无匹配或超出最后页返回 `200` + 空 `items`，并**保留请求页码**；
- 排序 `journal_date DESC, created_at DESC, id DESC`，由数据库完成；
- 不提供可配置 `page_size` 或排序参数；筛选、计数、排序、分页全部在 SQL 里，
  不拉全量到 Python 再切片。

### 统一显示标题（`app/journal/titles.py`）

- 无标题 = `title` 为 `NULL` 或 `""`（纯空白但非空是手工标题）；
- 非空手工标题原样显示，不 `trim`、不占编号；
- 无标题记录按 `created_at ASC, id ASC` 分配序号：第一篇显示 `journal_date`，
  其后 `日期 (2)`、`日期 (3)` ……；
- 编号在**该日期完整现存集合**上用窗口函数（`row_number() OVER (PARTITION BY journal_date …)`）
  计算，**包含已软删除但仍存在的记录**，再叠加有效状态与筛选：
  因此新增较晚记录、软删除、恢复都不会改动其他现存记录的编号；
- 永久删除、改日期、手工标题转换可能重新编号 —— 这是已确认的产品选择 **P3（动态编号）**；
- 列表、详情、`POST` / `PATCH` 返回值共用同一套投影，不为每条列表记录单独查库。

### 软删除（`DELETE /api/journals/{id}`）

- 成功返回 `204` 与空响应体；数据库行保留，只把 `deleted_at` 置为当前时间；
- 原六字段、`folder_id` 与 **`updated_at` 逐字段不变**：
  Model 的 `onupdate` 会在 UPDATE 时刷新 `updated_at`，
  因此删除语句在**同一个 UPDATE** 里显式写回原值（`updated_at = journals.updated_at`）抵消它，
  不是「只赋值 `deleted_at`」；
- 已删除 / 不存在：`404`；重复删除不重写原 `deleted_at`；
- 列表、日期 / Folder 筛选、详情、`PATCH`（含 `{}`）与再次 `DELETE` 都不访问已删除目标，
  判定在 SQL 的 `WHERE deleted_at IS NULL` 里，不依赖 Session identity map；
- 恢复、永久删除与回收箱列表属于 S2-T09，本任务不实现。

### 命令与结果

```powershell
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_journal_pagination_api.py
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests
.\.venv\Scripts\python.exe -B -m alembic heads
```

| 命令 | 实际结果 |
|---|---|
| 分页 / 编号 / 软删除测试 | `39 passed` |
| 全量回归 | `385 passed` |
| `alembic heads` | `a8d98342e603 (head)`（单 head，**无新 Migration**） |

### 开发库 `seekjournal` 的状态

本任务**不对开发库执行任何写操作或迁移**：只做只读查询与 `alembic` 只读检查。
实施前后观察到的开发库状态一致：13 行、`journals_id_seq` = 1651、
六字段 digest 不变、已软删除行数为 0。

> 注：S2-T01 记录里开发库停在 `3a70890ddb10`，而本次实施开始时它**已经在 head**
> （含 `folders` / `inboxes` / `insights` / `journals` 四张业务表）。
> 这属于本任务之外的状态变化，本任务没有运行过任何 `alembic upgrade`。
