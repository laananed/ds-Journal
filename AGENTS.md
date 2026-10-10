# SeekJournal Agent Instructions

## 1. Project

SeekJournal 是以个人认知成长为核心、生活与情感记录为辅的个人记录与复盘软件。
当前为 **Stage 3：AI 陪伴写作、复盘与 Insight 辅助提炼（规划，未授权开发）**；Stage 1 / 1.5 已完成。Stage 2 技术验收及用户接受/独立复核状态引用 `docs/stage2-tasks.md` §20，不因进入规划宣布整体验收完成。阶段路线唯一来源为 `docs/stage3.md` §1；Task 完成不等于 Stage 整体验收，不提前实施未来阶段。

## 2. Required Reading

- 始终读取根 `AGENTS.md`、适用角色规范（Codex：`agents/gpt-lead.md`；WorkBuddy：`agents/ds-developer.md`；DSH：`agents/dsh-developer.md`）及 `agents/multi-agent-workflow.md`，单 Agent 执行也适用。
- 按当前 Task 选择性读取 §3 中当前阶段相关产品需求、API、架构、任务计划章节及实际代码；包含适用的通用规则、范围、依赖、验收标准、执行记录与引用条款，不要求每次完整读取四份阶段文档。Stage 3 规划已获授权，只改文档；具体开发 Task 仍待确认开始。
- 历史文档仅在追溯历史行为、兼容性或 Bug 时读取相关内容，包括任务所需的迁移、回归和引用依据；不默认完整读取 Stage 1 / 1.5 文档。
- 已读且未变化、上下文仍可用的内容无需重复加载；范围不明或存在依赖引用时先检索、补读。按需读取不改变文档权威性，不得跳过本任务需要的契约。
- 当前 Stage 3 任务涉及复用、兼容和回归时补读 Stage 2 对应契约/验收；后续经用户确认进入新阶段后沿用同一机制，不把未闭环验收视为已完成。

## 3. Source of Truth

同一事实只在对应权威来源维护，角色文件和提示词引用它，不另建版本。

| 领域 | 当前 Stage 3 权威来源 |
|---|---|
| 产品需求及当前阶段路线 | `docs/stage3.md` |
| API 契约 | `docs/stage3-api.md` |
| 技术架构 | `docs/stage3-architecture.md` |
| Task 范围、依赖、验收与执行记录 | `docs/stage3-tasks.md` |
| Agent 行为与协作 | 本文件及适用的 `agents/*.md` |

Stage 2 基础行为依据：`docs/stage2.md`、`docs/stage2-api.md`、`docs/stage2-architecture.md`、`docs/stage2-tasks.md` 及相关验收记录；Stage 3 仅覆盖明确升级项，其他既有行为保留。更早历史依据：`docs/stage1.md`、`docs/stage1-api.md`、`docs/stage1-architecture.md`、`docs/stage1-acceptance.md`；Stage 1.5 修订见 `docs/stage1.5-bugfix.md`。已授权的文档规划不自动授权 API/Model 变更实施。

出现未明确解决的文档冲突时，停止受影响的实现，指出冲突位置并等待用户决定；已获批准的修订由 Codex 先同步权威文档，再继续，不重复索取同一批准，不自行选版本实施。
T03/T04 的历史分工与资源边界见 `docs/stage2-tasks.md` 的历史记录及 `docs/s2-t03-acceptance.md`、`docs/s2-t04-acceptance.md`，不作为新 Task 授权。

## 4. Technology Stack & Architecture

- 前端：React、TypeScript、Vite；后端：Python、FastAPI、Pydantic、SQLAlchemy 2.x；数据库：PostgreSQL、psycopg、Alembic；接口：REST / JSON；测试：pytest。
- React / FastAPI 在 Windows 本机运行，PostgreSQL 在 Docker 运行。
- 保持前后端分离、后端模块化单体；调用链为 Router → Service → SQLAlchemy → PostgreSQL。Pydantic 负责验证与 Schema，psycopg 负责数据库连接。

## 5. Simplicity Rule & Forbidden Without Approval

优先当前阶段最简单、开发者能理解且不明显阻碍后续阶段的实现；不为未来扩展、规模或形式上的专业增加复杂度。
新增库、框架、架构层、服务或抽象前，说明实际问题、解决方式、不引入的影响及能否推迟；没有实际需求就不加入。

未经用户明确批准，不得：
- 改变技术栈、API 契约、Journal 数据模型或架构；引入微服务、Repository Layer。
- 引入 Redis、Celery、Kafka、RabbitMQ、GraphQL、LangChain、LangGraph、Redux、Zustand、React Query。
- 实施未授权 Task 或未来阶段功能，或为未来功能提前增加数据库字段。
- 安装或升级依赖、修改个人记忆；Git 操作按 §10 的授权边界执行。

## 6. Scope Control & Database Safety

- 仅执行用户已确认方案中点名授权的 Task / 子任务；文档中的规划和历史执行记录不构成实施授权。既有明确授权与分工保持有效，包括尚未完成的 S2-T07：保持原范围、分支与授权，不重分配、不重新启动。
- 超出当前阶段的需求先记录；若获准纳入，先同步阶段权威文档，再实现（Documentation → Implementation）。不顺便重构或扩大范围。
- 测试与实施轮迁移使用明确分配的隔离测试库，写入前核实实际目标库；真实开发数据库 `seekjournal` 默认只读，**升级必须由用户单独授权**。
- 不清理不明数据，不以删库、重建或清洗旧数据代替迁移；只清理本轮自建对象。环境、服务和共享测试资源按协作规范协调，不擅自更改既有实例或暴露凭据。

## 7. Architecture Change Protocol

认为设计需要架构级调整时，先提交 **Problem / Impact / Options / Recommendation**：问题、不改的影响、可选方案及推荐理由。用户确认后先修订权威文档，再修改实现。

## 8. Learning Requirement

这是项目驱动学习项目。关键技术变化后，Agent 必须帮助用户理解新增了什么、为什么需要、数据经过哪里、修改了哪些核心文件，并保留最多 **1～3 个核心知识点**；常规文案和小修复不强制长篇学习说明，不讲解大量尚未使用的未来知识。

## 9. Definition of Done

开发任务完成必须同时满足：
- 授权功能与原 Task 验收标准落实，必要测试通过；无范围扩张、未经批准的架构变化或无理由依赖。
- 开发者与独立测试者按协作规范完成需求、架构、重复实现、回归与必要集成验证及约定整合；常规任务可由双方完成技术交付，用户最终接受。需 Codex 审核的风险项必须显式列出，未完成前不得宣布验收完成；自测不替代独立测试，缺失证据标为未验证。
- 文档按需同步；核对 Git 分支、HEAD、工作区、Worktree 与约定整合状态。
- 开发与测试按 `agents/multi-agent-workflow.md` §6 的统一八项简报交付，默认约 300～500 字，复杂任务只增必要内容；落实适用的学习要求。完成结论基于实际代码与本轮证据，不以计划、历史数量或开发者声明代替验证，不因简报缩短减少测试或省略必要审核、用户接受条件。

## 10. 多 Agent 协作与开发入口

- Agent / 模型配置及分配策略统一维护于 `agents/multi-agent-workflow.md`：Codex 为 Lead + Developer，承担重要决策、复杂实现、疑难调试与升级处理；WorkBuddy 和 DSH 为同级 Developer，常规任务优先由一方开发、另一方独立测试，按上下文、能力适配和额度选择，可互换。此为项目策略，不是模型性能排名。
- 新开发 Task 先只读检查，输出任务分配、串并行安排和每项开发 / 独立测试完整提示词，用户确认开始后实施；既有明确授权继续有效。
- 通用并发配置引用协作规范；本次 Stage 3 按已确认规划要求默认最多两个 Agent 同时开发，具体波次见 `docs/stage3-tasks.md`。不因人数许可启动 Agent 或 Task。Codex 按需介入，不要求亲自开发或重复运行每个常规任务的完整测试；重要、高风险、跨模块架构任务及升级处理交 Codex，触发与证据要求见协作规范。
- 每个具体 Task 仍须只读检查、依赖分析、明确资源分配和用户确认开始；并发人数批准不授权新 Task 或自动启动 Agent。每个同时写代码的 Agent 使用自己的分支和 Git Worktree，同目录单写者，无法隔离的资源串行，main 原则上用于集成。不引入任务调度服务、自动编排框架或新的运行依赖，不擅自调用或创建其他 Agent。
- Codex 统一协调共享 `docs/`、`agents/` 和本文件；执行者只改分配范围，不覆盖他人修改，交叉变更先协调。
- 局部验证后，仅按已确认 Git 权限提交、审核和整合；未授权的 commit / merge / push / tag、切换或清理他人 Worktree、删分支不自动执行。未获提交或整合授权时交付 diff，明确待提交 / 整合。
- 详细分配、提示词模板、升级处理、资源隔离、Worktree 同步和统一验收执行 `agents/multi-agent-workflow.md`。本次用户已批准的协作分工与审核机制优先于任务文档中的旧通用协作流程；原 Task 的功能、测试、专项审核门禁和既有授权不因此改变，根文件不重复维护细节。

## 11. Context Management

同一功能、同一执行角色可连续推进；提示词的 Agent / 模型、用途、对话建议与原因，以及轮次判断、新对话自包含要求，统一执行 `agents/multi-agent-workflow.md` §4。独立测试使用未参与该次实现的新对话，不沿用开发者对话；用户指定例外时按共同流程如实说明独立性。交接保留授权、基线、决定、证据与待办，不为节省 Token 省略必要契约或验证。
