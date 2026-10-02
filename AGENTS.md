# SeekJournal Agent Instructions

## 1. Project

SeekJournal 是一个以个人认知成长为核心、生活与情感记录为辅的个人记录与复盘软件。

当前开发阶段：

Stage 1 - Journal Local Web Demo

Stage 1 的目标不是完成完整 SeekJournal 产品。

当前只完成：

- Journal 创建
- Journal 查看
- Journal 修改
- Journal 删除
- 按日期查看
- PostgreSQL 数据持久化
- React → FastAPI → PostgreSQL 完整链路

---

## 2. Required Reading

执行任何 Stage 1 开发任务前，必须阅读：

1. `docs/stage1.md`
2. `docs/stage1-api.md`
3. `docs/stage1-architecture.md`

根据当前角色继续阅读：

GPT Lead：

- `agents/gpt-lead.md`

DeepSeek Developer：

- `agents/ds-developer.md`

涉及多 Agent 协作时：

- `agents/multi-agent-workflow.md`

---

## 3. Source of Truth

同一个项目事实不得在多个 Agent 文件中分别维护多个版本。

当前权威来源：

### 产品需求

`docs/stage1.md`

### API

`docs/stage1-api.md`

### 技术架构

`docs/stage1-architecture.md`

### Agent 行为规则

`AGENTS.md`

以及：

`agents/*.md`

如果文档之间产生冲突：

1. 停止实现；
2. 明确指出冲突位置；
3. 等待用户决定；
4. 修改权威文档；
5. 再继续开发。

不得自行选择其中一个版本继续实现。

---

## 4. Current Technology Stack

### Frontend

- React
- TypeScript
- Vite

### Backend

- Python
- FastAPI
- Pydantic
- SQLAlchemy 2.x

### Database

- PostgreSQL
- psycopg
- Alembic

### API

- REST
- JSON

### Testing

- pytest

### Local Development

- React：Windows 本机运行
- FastAPI：Windows 本机运行
- PostgreSQL：Docker 运行

---

## 5. Architecture

项目采用：

前后端分离。

Backend 采用：

模块化单体。

Stage 1 后端主要调用关系：

Router
→ Service
→ SQLAlchemy
→ PostgreSQL

Pydantic 负责 API 数据验证与 Schema。

psycopg 负责 SQLAlchemy 与 PostgreSQL 之间的实际连接。

不得引入微服务。

---

## 6. Simplicity Rule

本项目优先：

“当前阶段最简单、开发者能够理解、同时不会明显阻碍下一阶段”的实现。

不得单纯为了：

- Future Proof
- Enterprise Architecture
- Scalability
- Best Practice
- 看起来更专业

而增加当前阶段没有实际需求的复杂度。

增加新的：

- Library
- Framework
- Architecture Layer
- Service
- Abstraction

之前必须回答：

1. 当前存在什么实际问题？
2. 这个技术解决什么问题？
3. 如果不加入，会发生什么？
4. 是否可以推迟到以后？

如果没有明确问题：

不要加入。

---

## 7. Forbidden Without Approval

未经用户明确批准，不得：

- 修改技术栈；
- 修改 API Contract；
- 修改 Journal 数据模型；
- 改变前后端分离架构；
- 引入微服务；
- 引入 Repository Layer；
- 引入 Redis；
- 引入 Celery；
- 引入 Kafka；
- 引入 RabbitMQ；
- 引入 GraphQL；
- 引入 LangChain；
- 引入 LangGraph；
- 引入 Redux；
- 引入 Zustand；
- 引入 React Query；
- 实现 Stage 2 及以后的功能；
- 为未来功能提前增加数据库字段。

---

## 8. Scope Control

如果用户提出的需求不属于 Stage 1：

先记录需求。

不得直接实现。

如果需求确实需要进入 Stage 1：

先修改对应的 Stage 1 文档。

原则：

Documentation
→ Implementation

而不是：

Implementation
→ 再补文档。

---

## 9. Architecture Change Protocol

如果 Agent 认为当前设计存在问题：

不得直接进行架构级修改。

必须先提交：

### Problem

当前问题是什么？

### Impact

不修改会出现什么？

### Options

有哪些可选方案？

### Recommendation

推荐哪个方案？

为什么？

等待用户确认后再修改。

---

## 10. Learning Requirement

这是一个项目驱动学习项目。

Agent 不仅负责完成代码。

关键技术变化以后，需要帮助用户理解：

- 新增了什么；
- 为什么需要；
- 数据经过了哪里；
- 修改了哪些核心文件；
- 当前最值得理解的 1～3 个知识点。

不要一次性讲解大量当前尚未使用的未来知识。

---

## 11. Definition of Done

一个开发任务只有满足以下条件才算完成：

- 当前任务要求的功能已经实现；
- 必要测试通过；
- 没有擅自扩大 Scope；
- 没有未经批准修改架构；
- 没有无理由增加依赖；
- 修改文件已经说明；
- 测试结果已经说明；
- 用户能够知道本次修改大致发生了什么。