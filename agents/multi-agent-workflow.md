# SeekJournal Multi-Agent Workflow

> 2026-10-07：Stage 1 与 Stage 1.5 已完成；当前阶段权威入口为四份 `docs/stage2*.md`。
> 当前按 `docs/stage2-tasks.md` 逐任务执行，授权到 **S2-T02**，S2-T03 及之后未授权。
> 保留 User → Lead → DeepSeek → Lead Review → User 验收的单任务循环，不自动启用并行 Agent。

## 1. Purpose

本文档规定 SeekJournal 开发过程中：

User

GPT Lead

DeepSeek Developer

三者如何协作。

目标不是模拟一个人数很多的软件公司。

目标是：

利用不同模型的优势，

同时控制：

- 技术方向；
- 开发成本；
- Scope；
- 代码质量；
- 学习效果。

---

## 2. Roles

### User

身份：

- Product Owner
- Final Decision Maker
- Learner

负责：

- 提出真实需求；
- 决定产品方向；
- 批准重大技术变化；
- 决定是否接受功能；
- 学习关键技术；
- 最终验收。

---

### GPT Lead

身份：

- Technical Lead
- Architect
- Reviewer
- Learning Mentor

负责：

Think
→ Design
→ Break Down
→ Review
→ Explain

---

### DeepSeek Developer

身份：

Implementation Agent。

负责：

Implement
→ Test
→ Debug
→ Report

---

## 3. Core Principle

GPT 主要负责：

高错误成本决策。

例如：

- 架构；
- 数据模型；
- API；
- 技术选型；
- 复杂 Bug 判断；
- Review。

DeepSeek 主要负责：

低错误成本、可以测试验证的具体执行。

例如：

- 创建文件；
- 编写 CRUD；
- 修改 Component；
- 写测试；
- Debug；
- 执行明确任务。

---

## 4. Standard Development Loop

完整开发循环：

User
↓
提出需求
↓
GPT Lead
↓
确认 Scope
↓
检查现有 Documentation
↓
判断是否需要调整设计
↓
拆成小 Task
↓
DeepSeek Developer
↓
实现
↓
测试
↓
输出 Completion Report
↓
GPT Lead
↓
Code Review
↓
检查 Scope / Architecture / Correctness
↓
向 User 解释关键知识
↓
User
↓
验收
↓
Commit
↓
下一 Task

---

## 5. Before Coding

任何代码任务开始前：

GPT Lead 应确认：

### 1

这个需求是否属于当前 Stage？

### 2

现有文档是否已经定义它？

### 3

是否需要修改：

- Product Requirement；
- API；
- Architecture；
- Database Schema。

### 4

是否可以拆成更小任务？

---

## 6. Task Size

一个 Task 应尽可能只有一个明确目标。

推荐：

### Task 1

初始化 Backend。

### Task 2

配置 PostgreSQL。

### Task 3

创建 Journal SQLAlchemy Model。

### Task 4

创建 Alembic Migration。

### Task 5

实现 POST `/api/journals`。

### Task 6

测试 POST API。

---

不推荐：

### Task

完成 Stage 1 后端。

---

更加不推荐：

### Task

帮我把 SeekJournal 做完。

---

## 7. Task Specification

GPT Lead 给 Developer 的任务至少应该包含：

当前完整 Task 格式见 `docs/stage1.5-bugfix.md` / `docs/stage2-tasks.md`：
Goal、Scope、Out of Scope、前置 Task、模块/路径、DB/Migration、后端/前端行为、
测试、人工步骤、DoD。下方旧 Stage 1 示例仅说明写法，不是当前待执行任务。

### Goal

这次完成什么？

### Allowed Scope

允许修改哪些部分？

### Requirements

具体行为是什么？

### Constraints

哪些东西不能改？

### Acceptance

做到什么算完成？

例如：

```text
Goal:
实现 POST /api/journals。

Allowed Scope:
backend/app/journal/
相关测试文件。

Requirements:
遵守 docs/stage1-api.md。

Constraints:
不得修改 Journal Schema。
不得增加 Repository Layer。
不得开发其他 API。

Acceptance:
POST 创建成功返回 201。
数据库中存在记录。
pytest 测试通过。
```

---

## 8. Developer Workflow

DeepSeek 接到 Task：

### Step 1

阅读相关文档。

### Step 2

检查当前代码。

### Step 3

只实现当前 Task。

### Step 4

运行必要测试。

### Step 5

输出 Completion Report。

---

## 9. Completion Report

Developer 必须报告：

### Changed Files

修改文件。

### Implemented

实现内容。

### Tests

测试内容和实际结果。

### Problems

遇到的问题。

### Decisions Needed

是否需要新的技术决策。

---

## 10. GPT Review

GPT Lead Review 时重点检查六个方面。

### A. Correctness

功能是否真的正确？

### B. Scope

有没有实现当前任务之外的内容？

### C. Architecture

有没有违反：

当前 Task 所属阶段的权威 architecture 文档？

### D. API

有没有违反：

当前 Task 所属阶段的权威 API 文档？

### E. Simplicity

有没有：

为了“专业”

增加不必要设计？

### F. Tests

Developer 是否真的测试？

---

## 11. Learning Loop

Review 完成后：

GPT Lead 不能只回复：

“代码没问题。”

至少需要告诉 User：

### 1

这次程序新增了什么。

### 2

用户执行操作以后：

数据怎么流。

### 3

最重要的代码在哪里。

### 4

当前值得理解哪些概念。

通常控制在：

1～3 个核心知识点。

---

## 12. Documentation First

如果需求变化影响项目事实：

必须：

先修改 Documentation。

然后：

修改 Implementation。

例如：

User 决定：

Journal 增加某字段。

流程：

User
↓
GPT Lead 分析
↓
修改 stage1.md
↓
修改 stage1-api.md
↓
修改 stage1-architecture.md（如果需要）
↓
Developer 修改代码
↓
Alembic Migration
↓
Tests

---

## 13. Conflict Rule

如果：

User 新指令

和：

已有文档

冲突：

Agent 应明确指出（没有批准对应修订时）：

### Current Documentation

当前文档怎么规定。

### New Requirement

用户现在提出什么。

### Conflict

二者冲突在哪里。

然后等待用户决定未确认的部分；已明确批准的变更直接先更新权威文档，
不重复请求同一授权，不让无依赖工作一起停下。

不得：

悄悄按照新要求修改代码，

但让文档保持旧版本。

---

## 14. Architecture Change Rule

Developer 不拥有重大架构修改权。

如果发现：

当前设计存在问题。

Developer 提交：

Problem
↓
Impact
↓
Options
↓
Recommendation

GPT Lead：

分析。

User：

最终决定。

---

## 15. New Dependency Rule

如果 Developer 认为需要新 Library：

不能因为：

“通常大家都这样用”

就直接安装。

需要说明：

- 名称；
- 当前问题；
- 为什么当前已有工具不能解决；
- 新依赖的收益；
- 是否能推迟。

---

## 16. Git Workflow

建议每个开发任务使用：

```text
task/<task-name>
```

例如：

```text
task/journal-model
task/create-journal-api
task/journal-list-ui
```

标准流程：

```text
main
↓
创建 task branch
↓
Developer 开发
↓
允许多次临时 commit
↓
Developer 测试
↓
GPT Review
↓
User 验收
↓
最终 commit / 整理 commit
↓
merge main
↓
删除 task branch
```

一个 Task：

可以有多个 Commit。

不要求：

一个 Branch 只能有一个 Commit。

---

## 17. Commit Principle

Commit 应描述：

“完成了什么”。

例如：

```text
feat: add journal create API
```

```text
test: add journal API tests
```

```text
docs: define stage 1 architecture
```

避免：

```text
update
```

```text
fix things
```

这种无法理解的 Commit Message。

---

## 18. Public Repository

以下内容建议提交 Git：

- AGENTS.md
- docs/
- agents/
- README.md
- source code
- tests
- Alembic migrations
- `.env.example`

不得提交：

- `.env`
- API Key
- 数据库真实密码
- Token
- 私人日记数据库
- 用户隐私数据
- 私密 Prompt / 个人账号信息

---

## 19. Stage Transition

Stage 1 完成后：

不要删除 Stage 1 历史设计。

当前 Stage 1 与 Stage 1.5 都已完成（Stage 1.5 见 `docs/stage1.5-bugfix.md` 的执行记录）。
现按 `docs/stage2-tasks.md` 从 **S2-T02** 起逐任务执行 T01～T14，一次只下发一个已授权 Task。
路线与取消项只在 `docs/stage2.md` 维护。
原操作记录和 Inbox → Journal 规划已取消，不执行旧讨论里的八任务提案。

建议保留：

```text
docs/stage1.md
docs/stage1-api.md
docs/stage1-architecture.md
```

Stage 2 已建立（规划完成不代表实现完成）：

```text
docs/stage2.md
docs/stage2-api.md
docs/stage2-architecture.md
docs/stage2-tasks.md
```

这样可以保留项目演进历史。

根 `AGENTS.md` 的阶段导航已在 S1.5-T1/T2 与 S2-T01 中同步为 Stage 2 / 仅授权当前 Task，
技术栈、API/Model/架构变更的范围批准规则与禁止项保留不变。
产品 Pending 唯一登记在 `docs/stage2.md`，Lead 下发任务时注明具体 gate；Developer 不代产品经理决定。

---

## 20. Agent Evolution

不要一开始建立大量 Agent。

Stage 1：

只使用：

- GPT Lead
- DeepSeek Developer

等以后真正出现：

- 并行开发；
- Frontend / Backend 同时推进；
- AI 模块明显复杂；
- Testing 工作量明显增加；

再考虑拆分：

- Frontend Agent
- Backend Agent
- AI Agent
- Test Agent

新增 Agent 必须解决实际协作问题。

---

## 21. Stage 1 Final Principle

当前阶段优先级：

1. 正确；
2. 简单；
3. 用户能理解；
4. 可测试；
5. 可以继续扩展。

不是：

1. 企业级；
2. 技术最多；
3. 架构最复杂。

Stage 1 的成功标准是：

开发者真正跑通并理解第一次完整：

React
→ FastAPI
→ PostgreSQL

软件开发闭环。
