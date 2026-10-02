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

### Frontend

使用：

`VITE_API_BASE_URL`

敏感配置：

`.env`

`.env` 不提交 Git。

项目提交：

`.env.example`

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
