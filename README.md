# SeekJournal

SeekJournal 是一个以个人认知成长为核心、生活与情感记录为辅的个人记录与复盘软件。

**Stage 1：Journal 本地 Web Demo 已完成；当前准备 Stage 1.5 Bug Fix，并规划 Stage 2。**
当前代码仍是 Stage 1，Stage 1.5 与 Stage 2 功能尚未实现。已跑通的开发链路：

```text
React → REST API / JSON → FastAPI → Pydantic → Service → SQLAlchemy → psycopg → PostgreSQL
```

Stage 1 不是完整产品。范围、验收标准与架构见：

| 文档 | 内容 |
|---|---|
| `docs/stage1.md` | Stage 1 历史产品需求与验收标准 |
| `docs/stage1-api.md` | Stage 1 历史 API 契约 |
| `docs/stage1-architecture.md` | Stage 1 历史技术架构 |
| `docs/stage1-acceptance.md` | Stage 1 整体验收记录（一次带时间点的快照） |
| `docs/stage1.5-bugfix.md` | 当前 Bug Fix 需求、契约修订与 2 个 Task；先于 Stage 2 |
| `docs/stage2.md` | Stage 2 产品需求、未来阶段路线、Pending Product Decisions（权威） |
| `docs/stage2-api.md` | Stage 2 API 契约设计（尚未实现） |
| `docs/stage2-architecture.md` | Stage 2 对象关系、模块、事务、迁移与测试设计 |
| `docs/stage2-tasks.md` | Stage 2 的 14 个开发 Task、依赖、验证顺序 |
| `AGENTS.md` / `agents/*.md` | Agent 协作规则 |
| `frontend/README.md` / `backend/README.md` | 前 / 后端各自的详细说明 |

## 1. 当前实现范围

已实现（Stage 1 全部）：

- Journal 的**创建 / 列表（含按日期精确筛选）/ 详情 / 修改 / 删除（硬删除）**；
- 前端 React 页面：新建表单、列表与筛选、详情面板、编辑与删除确认；
- 业务日期 `journal_date`「04:00 换日」的默认值规则（前端计算，用户可改）；
- 同一日期允许多篇；无标题记录在 UI 上用 `journal_date` 与 `(2)`、`(3)` 区分；
- 本地开发用最小 CORS（只放开本机两个前端来源）。

Stage 1.5 待修复：新增导致旧 Journal 编号变化、title 80 / content 50,000 与非空白规则、
标题一行预览及既有正文三行截断的实际验证。旧 Journal 数据必须完整保留。

Stage 2 已规划、未实现：Inbox、手动 Insight、一级 Folder、Markdown 阅读、普通搜索、
回收箱、简单内部链接、20 条/页、基础卡片与统一离开提醒。
**Inbox → Journal 整理、操作记录与内容版本历史已取消，不在 Stage 2。**

未来功能尚未实现：注册 / 登录 / 多用户 / 权限、图片、标签、AI、同步、云部署等。
阶段路线与 Non-goals 以 `docs/stage2.md` 为准。

## 2. 环境要求

| 组件 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Windows（本机开发） | 命令按 PowerShell / Git Bash 均可执行 |
| Python | 3.12 | 后端虚拟环境用标准库 `venv` 创建；不使用 uv / Poetry / Conda |
| Node.js | 与 `frontend/package.json` 匹配的现代版本 | 前端用 Vite 8 / React 19 |
| Docker Desktop | 提供本地 PostgreSQL | 只跑数据库容器，不容器化前后端 |

## 3. 目录结构

```text
SeekJournal/
├── AGENTS.md
├── agents/                 # 协作规则
├── docs/                   # Stage 1 历史、Stage 1.5 修复计划、Stage 2 权威规划
├── compose.yaml            # 只定义 postgres 单服务
├── backend/                # FastAPI + SQLAlchemy + Alembic
│   ├── app/
│   ├── tests/
│   ├── alembic/
│   ├── scripts/            # check_db.py（历史只读脚本）、prepare_test_db.py
│   ├── .env.example        # 占位符，真实 .env 不提交
│   └── requirements.txt
└── frontend/               # React + TypeScript + Vite
    ├── src/
    ├── .env.example        # 占位符，真实 .env 不提交
    └── package.json
```

## 4. 启动顺序

固定为：**PostgreSQL → Backend → Frontend**。

### 4.1 PostgreSQL（Docker Compose）

先启动 Docker Desktop，等 Engine 就绪。然后在**仓库根目录**执行：

```powershell
docker compose --env-file backend/.env up -d postgres
```

- Compose 只定义 `postgres` 一个服务，镜像 `postgres:17`；
- 端口只绑定 `127.0.0.1:5432`，不对外暴露；
- 数据保存在 named volume `postgres_data`，删除容器不会丢数据；
- 数据库名 / 用户名 / 密码必须由 `backend/.env` 提供，缺失时 Compose 直接报错；
- 若本地已有同名数据卷，数据库不会被重新初始化。

首次使用需要先准备 `backend/.env`（见第 5 节）。

如需只检查 Compose 配置是否有效，在仓库根目录执行：

```powershell
docker compose --env-file backend/.env config --quiet
```

该命令不输出解析后的配置，退出码为 0 表示配置检查通过。省略 `--quiet` 的
`config` 会输出插值后的真实密码，不要将其输出复制到聊天、Issue 或文档。

### 4.2 Backend（FastAPI）

```powershell
cd backend

# 首次：创建虚拟环境并安装依赖
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

# 应用数据库结构（首次或新增 Migration 后）
.\.venv\Scripts\python.exe -m alembic upgrade head

# 启动
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

- 应用地址：`http://127.0.0.1:8000`
- 交互式文档：`http://127.0.0.1:8000/docs`
- 存活检查：`GET /api/health`（只表示应用能响应，**不检查数据库**）
- 运行命令请始终使用 `.venv\Scripts\python.exe`，不要用全局 pip。

### 4.3 Frontend（Vite）

另开一个终端：

```powershell
cd frontend
npm install
npm run dev
```

- 开发地址**固定**为 `http://127.0.0.1:5173`
  （`vite.config.ts` 写了 `host: '127.0.0.1'`、`port: 5173`、`strictPort: true`）；
- 端口被占用时 Vite **直接报错**而不是换到 5174：后端 CORS 只放开了 5173 这两个来源，
  静默换端口会让跨源请求失效；
- 浏览器打开 `http://127.0.0.1:5173` 即可（CORS 已按第 6 节配置）。

## 5. 配置

### 5.1 Backend 的 `backend/.env`

复制示例并填入本机真实值（**不提交 Git**）：

```powershell
cd backend
Copy-Item .env.example .env
```

需要同步的两处（示例里是占位符 `REPLACE_WITH_LOCAL_PASSWORD`）：

```text
POSTGRES_DB / POSTGRES_USER / POSTGRES_PASSWORD   # 供 Compose 初始化容器
DATABASE_URL=postgresql://<user>:<password>@127.0.0.1:5432/seekjournal   # 供 Python 连接
```

- 密码含 `@` `:` `/` `?` `#` 等 URL 特殊字符时，`DATABASE_URL` 里必须做 URL 编码；
- `DATABASE_URL` 写 `postgresql://` 即可，`app/database.py` 会用 SQLAlchemy 的 URL 工具
  把驱动改写成 `postgresql+psycopg`，不必手写驱动名；
- 真实密码只存在于本机 `backend/.env`，仓库只提交 `backend/.env.example`。

### 5.2 Frontend 的 `VITE_API_BASE_URL`

前端通过 `VITE_API_BASE_URL` 读取后端**根地址（不含 `/api`）**：

```text
VITE_API_BASE_URL=http://127.0.0.1:8000
```

- 未设置时代码内使用同一默认值（`src/api/journals.ts`），因此本地开发可以不建 `.env`；
- 需要覆盖时复制 `frontend/.env.example` 为 `frontend/.env` 再修改；
- `VITE_*` 会被编译进浏览器产物，**只能放非敏感配置**，绝不放数据库凭据或其它秘密。

## 6. 两个数据库：开发库 vs 测试库

| 项 | 开发库 | 测试库 |
|---|---|---|
| 库名 | `seekjournal` | `seekjournal_test` |
| 用途 | 应用运行时真实数据（个人日记） | 只给 pytest 的 API 测试使用 |
| 谁写 | 应用（浏览器操作） | 测试进程（跑完回滚，不留数据） |
| 连接来源 | `backend/.env` 的 `DATABASE_URL` | 复用同一凭据，**仅在测试进程内替换库名** |
| 表结构 | Alembic `upgrade head` | 由 `scripts/prepare_test_db.py` 执行同一套 Migration |

- 两者在同一台 PostgreSQL 服务里，**不是**多数据库的产品设计；
- 测试**不会**读、改、删开发库里的日记；
- 测试可能让**测试库**的 sequence 前进，但不会影响开发库。

## 7. 数据库结构管理（Alembic）

以下命令都在 `backend/` 目录下执行：

```powershell
.\.venv\Scripts\python.exe -m alembic upgrade head   # 应用迁移
.\.venv\Scripts\python.exe -m alembic current        # 当前库所处版本
.\.venv\Scripts\python.exe -m alembic heads          # 脚本里的最新版本
.\.venv\Scripts\python.exe -m alembic check          # 无差异时输出 No new upgrade operations detected.
```

约定：表结构只通过 Migration 建立（代码里不调用 `create_all` / `drop_all`）；
不删除历史 Migration；不通过 `stamp head` 假装迁移已执行；结构变更时新增 Migration，
而不是删库重建。

> **注意：`alembic.ini` 必须保持纯 ASCII。**
> Alembic 用 `configparser` 以系统 locale 编码读取它，本机 locale 是 GBK，
> 在该文件里写中文注释会让所有 alembic 命令报 `UnicodeDecodeError`。
> 中文注释请写在 `env.py`、迁移文件或 README 里。

## 8. 测试

### 8.1 准备测试库（首次以及新增 Migration 之后）

```powershell
cd backend
.\.venv\Scripts\python.exe -B -m scripts.prepare_test_db
```

只创建不存在的 `seekjournal_test` 并执行已有 Migration；
可以重复执行；**若测试库已有日记记录会失败并保留数据，不会清空**。

### 8.2 后端完整回归

```powershell
cd backend
$env:PYTHONDONTWRITEBYTECODE = '1'
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests
```

- 当前共 **232** 个用例；
- 连库测试用「外层事务 + savepoint」，结束后回滚，测试库不留日记数据；
- 隔离守卫 `tests/test_test_database.py` 断言测试进程连的是 `seekjournal_test`；
- **测试库必须保持空白业务数据基线**：`test_journal_read_api.py` 里有 3 个用例
  要求运行前 `journals` 表为空；若失败，那是前置条件不满足，**不要为了过测试去删数据**。

### 8.3 前端检查

```powershell
cd frontend
npm run build                                                  # tsc -b && vite build
npm run lint                                                   # Oxlint
node --experimental-strip-types src/utils/journalDate.test.ts   # 默认日期规则 10 例
node --experimental-strip-types src/utils/journalDetail.test.ts # 详情纯逻辑 25 断言
```

前端**不引入测试框架**，`src/utils/` 下的纯逻辑用 Node 内置类型剥离直接跑。
其余前端行为按 `docs/stage1-architecture.md` §20 采用人工 / 浏览器验收，
具体做法见 `docs/stage1-acceptance.md`。

### 8.4 依赖自检

```powershell
cd backend
.\.venv\Scripts\python.exe -m pip check   # 期望 No broken requirements found.
```

## 9. 停止服务与数据保留

- **停止 FastAPI / Vite**：在各自终端按 `Ctrl+C`；
- **停止数据库容器（保留数据）**：在仓库根目录执行

```powershell
docker compose --env-file backend/.env stop
```

- `stop` 只停容器，named volume 保留，数据不丢；
- 需要删除容器但保留数据：用 `down`，**不要加 `-v`**；
- `down -v` 会删除数据卷，本地开发数据将丢失——**仅在确认不需要数据时使用**。

## 10. 已知限制

1. 只有本地单用户，没有认证 / 权限；前端来源与后端 CORS 都限定在本机两个地址；
2. 无分页、搜索；列表一次返回全部记录；
3. 删除是**硬删除**，没有回收箱 / 撤销；
4. 前端没有自动化测试框架，前端行为主要靠人工 / 浏览器验收；
5. `journal_date` 由前端计算与发送，后端不推断用户想写哪一天；
6. 详情面板额外显示 `id`（方便与数据库对照），不属于 API 契约要求；
7. 通过 API 直接 `POST {"title": ""}` 可以写入空字符串标题；经 UI 只会产生 `NULL`。

## 11. 数据与隐私

- 不要把真实日记内容、`.env`、数据库密码、连接串写进 Issue、文档或提交；
- `.gitignore` 已忽略 `.env` / `.env.*`（保留 `!.env.example`）、`node_modules/`、
  `.venv/`、`__pycache__/`、`dist/`。
