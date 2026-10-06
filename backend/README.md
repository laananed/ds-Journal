# SeekJournal Backend

SeekJournal 后端（Stage 1 / Task 3 第二步产物）。

当前包含：

- 一个最小 FastAPI 应用；
- 一个存活检查接口；
- 一份本地 PostgreSQL 开发数据库的 Compose 配置；
- SQLAlchemy 2.x 数据库基础（Engine / Session 工厂 / Declarative Base）；
- Journal SQLAlchemy Model；
- Alembic 首次迁移，已在本地数据库建立 `journals` 表；
- 一个只读的历史连接验证脚本。

Journal CRUD API 尚未实现，前端尚未接入。

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
│       └── models.py           # Journal Model
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

- `GET /api/health`
- 本地 PostgreSQL 开发数据库的 Compose 配置
- SQLAlchemy 2.x 数据库基础：Engine、Session 工厂、共享 Declarative Base（`app/database.py`）
- Journal Model：`journals` 表六个字段（`app/journal/models.py`）
- Alembic 首次迁移，`journals` 表已在本地数据库建立
- 只读的历史连接验证脚本（`scripts/check_db.py`）

尚未实现：

- Journal CRUD API（`POST` / `GET` / `PATCH` / `DELETE` `/api/journals`）；
- Pydantic Schema、Router、Service；
- CORS、认证、pytest；
- 前端调用。

`journals` 表已经存在，但还没有任何接口能读写它。
