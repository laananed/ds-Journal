# SeekJournal - Stage 1 Architecture

## 1. Architecture Goal

Stage 1 使用最简单、清晰、能够学习完整开发链路的架构。

目标：

完成：

React
→ FastAPI
→ PostgreSQL

完整闭环。

不追求：

企业级架构。

---

## 2. High-Level Architecture

采用：

前后端分离。

Backend：

模块化单体。

总体数据流：

React
→ HTTP / REST / JSON
→ FastAPI
→ Pydantic
→ Service
→ SQLAlchemy
→ psycopg
→ PostgreSQL

---

## 3. Frontend Technology

- React
- TypeScript
- Vite

Stage 1 暂不使用：

- Redux
- Zustand
- React Query
- React Router
- 复杂全局状态管理方案

---

## 4. Frontend Responsibilities

Frontend 主要负责：

- 页面显示；
- 用户输入；
- Journal Editor；
- Journal List；
- API 调用；
- 默认显示标题；
- 同一天 `(n)` 编号；
- 默认 journal_date 计算；
- 页面临时 State。

业务数据最终以 Backend / PostgreSQL 为准。

---

## 5. Frontend Structure

初始建议：

```text
frontend/src/
├── api/
│   └── journals.ts
├── components/
│   ├── JournalEditor.tsx
│   └── JournalList.tsx
├── pages/
│   └── JournalPage.tsx
├── types/
│   └── journal.ts
├── utils/
│   └── journalDate.ts
├── App.tsx
└── main.tsx
```

如果实际开发中发现某个文件没有必要：

允许在不改变架构原则的情况下进一步简化。

不得为了形式完整创建大量空目录。

---

## 6. Backend Technology

- Python
- FastAPI
- Pydantic
- SQLAlchemy 2.x
- psycopg
- PostgreSQL
- Alembic

### Local Backend Environment

Stage 1 后端本机环境：

- Python 3.12（使用 `py -3.12` 启动）
- 依赖隔离：`backend/.venv`，由标准库 `venv` 创建
- 依赖管理：`pip`，实际安装版本记录在 `backend/requirements.txt`
- 执行命令统一使用：
  `backend\.venv\Scripts\python.exe`
  不使用全局 pip

Stage 1 不使用：

- uv
- Poetry
- Conda 项目环境
- 其它额外包管理配置

---

## 7. Backend Structure

初始结构：

```text
backend/app/
├── main.py
├── database.py
└── journal/
    ├── router.py
    ├── schemas.py
    ├── models.py
    └── service.py
```

### Implementation Progress

上述结构是 Stage 1 的目标结构，
不代表当前已经全部建立。

Task 1：
Frontend 初始化完成。

Task 2：
Backend 初始化。

Task 2 只创建：

```text
backend/
├── app/
│   ├── __init__.py
│   └── main.py
├── requirements.txt
└── README.md
```

`main.py` 只负责：

- 创建 FastAPI Application；
- 直接定义 `GET /api/health`。

Task 2 暂不创建：

- `database.py`
- `journal/`
- `router.py`
- `schemas.py`
- `models.py`
- `service.py`

也不引入：

- 应用工厂；
- 配置层；
- 响应包装；
- 业务 Router。

数据库结构与 pytest 要求保持不变，
在对应的后续 Task 中再实现。

### Task 3

配置 PostgreSQL 本地开发数据库，
并建立 Python 到数据库的基础连接。

Task 3 分两步实施。

#### Task 3 第一步

只建立：

- 本地 PostgreSQL 开发数据库；
- Python 使用 `DATABASE_URL` 直连数据库的最小验证。

新增：

```text
compose.yaml
backend/
├── .env.example
└── scripts/
    └── check_db.py
```

本机另有 `backend/.env`，
用于保存开发环境真实配置，
不提交 Git。

第一步暂不创建：

- `database.py`
- SQLAlchemy Engine / Session
- Alembic

#### Task 3 第二步

在第一步基础上再加入：

- SQLAlchemy 2.x；
- Alembic Migration。

第一步与第二步之间，
后端仍保持：

`app/__init__.py` + `app/main.py`

的结构，
不因数据库配置而增加新的应用层。

---

### Task 4

实现并验证 `POST /api/journals` 创建链路。

Task 4 分两阶段实施，不扩展到其他 CRUD 或 Frontend。
以下定义记录已确定的开发范围，不代表当前已经实现。

#### Task 4.1：Journal 创建请求与响应 Schema

包含：

- `backend/app/journal/schemas.py`；
- `JournalCreate` 与 `JournalResponse`；
- 最小 Schema 测试；
- 必要的 pytest 依赖记录和 Backend README 更新。

Schema 行为遵守 `docs/stage1-api.md`，不增加未规定的业务限制。
验收仅使用内存数据或未持久化的 ORM 对象，不连接或修改数据库。

本阶段不包含：

- `JournalUpdate` 或其他未来 Schema；
- Service、Router、Session 注入或 `main.py` 注册；
- 数据库写入、CRUD API 或 Frontend；
- Migration 或 Model 修改。

#### Task 4.2：Journal 创建 API

在 Task 4.1 验收通过后实现：

- 创建 Service；
- POST Router；
- 必要的 Session 注入；
- `main.py` 中的 Router 注册；
- 最小创建 API 测试。

本阶段只完成 `POST /api/journals` 创建链路，
不实现其他 CRUD、Frontend、额外架构层或 Stage 2 功能。
API Contract 与 Journal 数据模型保持不变。

---

### Task 5

实现并验证 Journal 读取 API。

Task 5 分两阶段实施，不扩展到修改、删除、分页、搜索或 Frontend。
以下定义记录已确定的开发范围，不代表当前已经实现。

#### Task 5.1：Journal 列表与日期筛选

包含：

- `GET /api/journals` 列表；
- 可选 `journal_date` 精确日期筛选；
- 对应的查询 Service 与 Router；
- 共用测试 fixture 与真实数据库 API 测试；
- Backend README 更新。

排序遵守 `docs/stage1-api.md`：

- 第一排序 `journal_date DESC`；
- 同日第二排序 `created_at DESC`。

排序与筛选在数据库查询中完成，不在 Python 侧过滤或排序。

API Contract、Journal 数据模型与数据库结构保持不变。

本阶段不包含：

- `GET /api/journals/{id}` 单篇详情；
- 分页、搜索或排序查询参数；
- `PATCH` / `DELETE` 或其他 CRUD；
- Frontend。

#### Task 5.2：Journal 单篇详情

在 Task 5.1 验收通过后实现并验证：

- `GET /api/journals/{id}`；
- 单篇不存在时返回 `404 Not Found`。

---

## 8. Backend Responsibilities

### main.py

负责：

- 创建 FastAPI Application；
- 注册 Journal Router。

---

### database.py

负责：

- DATABASE_URL；
- SQLAlchemy Engine；
- Session 创建；
- 数据库连接。

---

### journal/router.py

负责：

- 接收 HTTP Request；
- 调用 Service；
- 返回 HTTP Response；
- 处理 Route 参数。

---

### journal/schemas.py

负责：

Pydantic Schema。

例如：

- JournalCreate
- JournalUpdate
- JournalResponse

---

### journal/models.py

负责：

SQLAlchemy Journal Model。

对应 PostgreSQL：

`journals`

表。

---

### journal/service.py

负责：

Journal 业务操作。

包括：

- Create
- List
- Get
- Update
- Delete
- Date Filter

Stage 1 中：

Service 可以直接使用 SQLAlchemy Session。

---

## 9. Backend Layering

当前：

Router
→ Service
→ SQLAlchemy
→ PostgreSQL

暂时不增加：

Repository Layer。

原因：

Stage 1 只有简单 Journal CRUD。

Repository 暂时无法解决足够明确的问题。

以后复杂度增加时再重新评估。

---

## 10. PostgreSQL

Stage 1 使用：

一个 PostgreSQL 数据库。

### Local Development Database

本地开发数据库使用：

| 项目 | 取值 |
|---|---|
| 数据库名 | `seekjournal` |
| 用户名 | `seekjournal` |
| 宿主端口 | `127.0.0.1:5432` |
| 镜像 | `postgres:17` |

数据库数据使用 named volume 保存，
不随容器删除而丢失。

真实密码只存在于本机 `backend/.env`，
不写入文档、不提交 Git。

开发阶段只有一个数据库服务，
不划分多数据库、多 Schema。

核心业务表：

`journals`

字段：

- id
- title
- content
- journal_date
- created_at
- updated_at

---

## 11. PostgreSQL Constraints

### id

Primary Key。

唯一。

---

### title

Nullable。

---

### content

Not Null。

---

### journal_date

Not Null。

允许重复。

建立普通 Index。

不得设置 UNIQUE。

---

### created_at

系统创建。

---

### updated_at

系统创建并在修改时更新。

---

## 12. Time Rules

### journal_date

人的业务日期。

例如：

用户认为日记属于：

2026-10-02。

---

### created_at

系统真实创建时间。

---

### updated_at

系统最后修改时间。

created_at / updated_at：

使用带时区时间。

Stage 1 不要求用户理解复杂时区实现。

---

## 13. Default Day Rule

Frontend：

定义：

`DAY_START_HOUR = 4`

00:00 ～ 03:59：

默认前一天。

04:00 ～ 23:59：

默认当天。

用户可修改。

---

## 14. Database Driver

使用：

psycopg。

主要调用关系：

SQLAlchemy
→ psycopg
→ PostgreSQL

Stage 1 一般不直接操作 psycopg API。

例外：

Task 3 第一步在建立 SQLAlchemy 之前，
用 `backend/scripts/check_db.py`
通过 psycopg 直连数据库，
只验证连接是否可用。

安装方式：

使用 `psycopg[binary]`，
即预编译二进制发行版。

原因：

Windows 本机不需要额外安装
编译工具链与 PostgreSQL 开发库。

它安装的是同一个 psycopg 驱动，
只改变二进制分发形式，
不改变驱动本身。

该验证脚本不是产品代码，
不参与 Runtime 数据访问；
Runtime 数据访问仍由
SQLAlchemy 负责。

---

## 15. Alembic

Alembic 负责：

数据库 Schema Migration。

第一阶段至少创建：

`create journals table`

Migration。

以后数据库结构真正发生变化时：

新增 Migration。

不得：

- 每次改字段就删除数据库；
- 删除历史 Migration；
- 为未来需求提前增加大量字段。

---

## 16. Transaction

Stage 1 使用简单事务。

原则：

成功：

commit。

失败：

rollback。

不设计复杂跨模块事务。

---

## 17. Delete Strategy

Stage 1：

硬删除。

不添加：

deleted_at。

回收箱属于后续 Stage。

---

## 18. Configuration

### Backend

使用：

`DATABASE_URL`

Backend 的本机配置文件为：

`backend/.env`

它同时提供：

- `DATABASE_URL`：Python 连接数据库使用；
- `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD`：
  Docker Compose 初始化数据库容器使用。

Python 侧读取 `DATABASE_URL`，
不在代码中硬编码数据库地址或凭据。

Stage 1 不因此引入
Settings 类、配置层或数据库应用模块。

### Frontend

使用：

`VITE_API_BASE_URL`

敏感配置：

`.env`

`.env` 不提交 Git。

项目提交：

`.env.example`

仓库提交 `backend/.env.example`，
只包含占位符，
不包含真实密码。

---

## 19. Local Development

Frontend：

Windows 本机运行。

Backend：

Windows 本机运行。

PostgreSQL：

Docker / Docker Compose 运行。

Stage 1 不要求：

整个项目全部 Docker 化。

### Local PostgreSQL Service

仓库根目录提供 `compose.yaml`。

它只定义一个服务：

`postgres`

约束：

- 只包含数据库单服务；
- 不容器化 Backend；
- 不容器化 Frontend；
- 不提供整套开发环境编排；
- 端口仅绑定本机回环地址；
- 数据使用 named volume 持久化；
- 数据库名、用户名、密码从环境变量读取。

Compose 文件不写入默认密码。

缺少必需环境变量时应直接失败，
而不是使用隐含的弱默认值。

启动命令在仓库根目录执行，
并通过 `--env-file backend/.env` 提供配置。

数据库相关命令与验证步骤
记录在 `backend/README.md`，
不写入本架构文档。

---

## 20. Testing

Backend：

pytest。

至少测试：

- Create Journal
- List Journals
- Filter Journals By Date
- Get Journal
- Update Journal
- Delete Journal
- Journal Not Found
- Invalid Request

Frontend：

Stage 1 主要人工验收。

暂不建立：

复杂 E2E 自动化测试。

---

## 21. Stage 1 Excluded Architecture

Stage 1 不使用：

- Microservices
- Repository Layer
- Redis
- Celery
- Message Queue
- GraphQL
- LangChain
- LangGraph
- Vector Database
- Elasticsearch
- Kubernetes
- Redux
- Zustand
- React Query

---

## 22. Architecture Principle

增加新技术或新架构层之前必须回答：

1. 当前到底出现了什么问题？
2. 新技术解决什么问题？
3. 不使用会出现什么后果？
4. 是否可以以后再加？

如果当前没有明确问题：

保持现状。
