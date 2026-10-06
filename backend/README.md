# SeekJournal Backend

SeekJournal 后端（Stage 1 / Task 3 第一步产物）。

当前包含：

- 一个最小 FastAPI 应用；
- 一个存活检查接口；
- 一份本地 PostgreSQL 开发数据库的 Compose 配置；
- 一个只读的数据库连接验证脚本。

尚未接入 SQLAlchemy 与 Alembic，业务表尚未创建。

## 环境要求

- Python 3.12（使用 `py -3.12` 启动）
- Docker Desktop（提供本地 PostgreSQL）

## 目录结构

```text
backend/
├── app/
│   ├── __init__.py
│   └── main.py
├── scripts/
│   └── check_db.py
├── .env.example
├── .env              # 本机配置，不提交 Git
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

## 验证数据库连接

在 `backend/` 目录下执行：

```powershell
.\.venv\Scripts\python.exe scripts\check_db.py
```

期望结果：

```text
连接成功
  current_database() = seekjournal
  常量 1             = 1
  用户表数量         = 0
PASS  数据库连接可用，且尚未创建业务表
```

该脚本只读，不创建也不修改任何 Schema，不打印密码。

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
- Python 到数据库的连接验证脚本

尚未实现：Journal CRUD、SQLAlchemy Engine / Session、Alembic Migration、CORS、认证、pytest，以及前端调用。
