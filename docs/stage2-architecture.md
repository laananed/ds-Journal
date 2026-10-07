# SeekJournal — Stage 2 Architecture

> 2026-10-07。Stage 2 的技术设计依据 `stage2.md`，API 依据 `stage2-api.md`。
> 本轮是文档设计；未生成 Migration，未修改 Model、源码或依赖。产品 Pending 只在 `stage2.md` §15 登记。

## 1. 保留现有边界

React + TypeScript + Vite，在 Windows 本机运行；Component local State + 原生 fetch。
FastAPI + Pydantic + SQLAlchemy 2.x + psycopg，模块化单体；PostgreSQL Docker；Alembic 管理表结构；pytest。

```text
React 编辑/阅读/列表
  → HTTP JSON
  → Router（请求与状态码）/ Pydantic（输入验证）
  → Service（规则与事务）
  → SQLAlchemy → psycopg → PostgreSQL
```

无 Repository Layer、微服务、CQRS、Event Bus、Redis、队列、Elasticsearch、向量库、AI 框架。
没有当前问题需要 Redux、Zustand、React Query 或路由框架，继续本地 State 视图切换。

## 2. 对象存储方案与理由

| 方案 | 收益 | 本期成本 | 结论 |
|---|---|---|---|
| 保留 journals，新增 inboxes/insights/folders | 旧 Journal ID/字段不搬迁，沿用当前模块，可逐项验收 | 跨类型查询需要 UNION ALL | 推荐 |
| 把三类合并为一个 files 表 | 公共查询方便 | 搬迁旧 Journal、类型相关 Nullable 字段、较大的 CRUD 重写 | 本期不选 |
| 原三表外再增通用文件登记表/多态框架 | 全局身份可统一 | 双份身份、额外一致性事务与抽象 | 没有必要 |

跨类型使用 `(type, id)`，不制造全局 ID。只抽真正重复的小型验证/展示查询函数，不建立通用 CRUD 框架或新的架构层。

## 3. 数据对象关系

| 表 | 字段设计 | 新增/历史处理 |
|---|---|---|
| journals | 现有六字段 + folder_id Nullable FK、deleted_at Nullable timestamptz | 原六字段逐行保留；新增默认 NULL |
| inboxes | id、title Text、content Text Not Null、inbox_date Date Not Null、is_daily Boolean Not Null 默认 false、folder_id Nullable FK、created_at、updated_at、deleted_at Nullable | 新表，无旧数据；title 的 Nullable/写入约束待 P1 最终冻结，先用 Nullable Text 不损数据 |
| insights | id、title Nullable Text、content Text Not Null、folder_id Nullable FK、created_at、updated_at、deleted_at Nullable | 新表；没有所属日期/AI/来源字段 |
| folders | id、name Text Not Null | 新表，无 parent_id、颜色、图标、排序字段 |

时间均带时区，内容修改沿用 Python 生成时间的方式，不新增数据库触发器。
title/content 继续 Text，规则由请求 Schema 强制；不为旧 Journal 增长度或空白 CHECK，避免迁移失败或破坏旧数据。
各 folder_id 外键指向 folders.id，RESTRICT/NO ACTION；回收箱中的关联保留，不 cascade、不 SET NULL。
不建立 operation_logs、versions、links、tags 或其他未来表。

### Daily 身份

inbox_date 用于 04:00 业务日期，is_daily 区分默认 Daily 与额外 Inbox；两者不随用户改标题或移动 Folder 改变。
默认日期在前端计算并明确发送。有效保存前只有前端状态，不存在数据库占位行。
P2 推荐策略确认后，对 `is_daily=true` 的 inbox_date 建唯一部分索引，覆盖有效与已删除 Daily；普通 Inbox 不受该唯一约束。
该索引在 S2-T04 的 M3 新增，P2 未确认时不提前决定 deleted_at 是否参与条件。
本地单用户也可能双标签提交，唯一约束负责最终仲裁；409 后重读并提示，不覆盖已有正文。

## 4. Journal 编号与投影

Stage 1.5 修复完整列表上的升序计数，不改变 API/Model。
Stage 2 不能拉全量到浏览器只为计算当前页编号。

**P3 已确认（2026-10-07）：采用下面的动态编号设计，不再等待。**

1. 按日期，对无标题（NULL/空字符串）Journal 以 `created_at ASC, id ASC` 计算序号。
2. 在完整日期范围计算序号，包含回收箱中的现存记录；软删除/恢复因此不改变其他现存记录的编号。
3. 再叠加有效状态、Folder、搜索、日期条件、排序与 LIMIT/OFFSET。
4. Service 的读取投影生成 display_title，原始 title 保持不变；详情、跨类型列表、回收箱和链接解析调用同一投影逻辑。
5. 用 SQL 窗口或等价数据库查询计算，不能先过滤一页后 rank，也不能按搜索命中子集编号；避免每个列表项分别查库。

S2-T02 的实现方式：一个 `ROW_NUMBER() OVER (PARTITION BY journal_date ORDER BY created_at ASC, id ASC)`
子查询（`title IS NULL OR title = ''`，**不过滤 deleted_at**），`LEFT JOIN` 到列表/详情查询，
再在 SQL 里做有效状态/日期/Folder 过滤、排序与 `LIMIT/OFFSET`，共两条查询（页码 + 总数）。

这种计算方案保证新建较晚记录不改变旧号，但 **永久删除、改日期、手工标题转换可能改变号**；不能声称具有永久稳定身份。
例如第一篇永久删除后，原第三篇可能变成 `(2)`，已有 `[[日期 (2)]]` 就可能打开另一篇。这已在 P3 中被用户接受；
手工重名仍依产品的多候选规则，不建立后台引用关系。
当前计划不预加序号、计数表或数据库锁框架。内部链接对 P3 的依赖在最终组合验收中检查。

## 5. 模块与文件责任（目标，不代表已经存在）

| 区域 | 责任 |
|---|---|
| `backend/app/journal/` | 沿用 models/schemas/router/service；Journal 日期、编号投影、CRUD、软删除 |
| `backend/app/inbox/` | 同样四文件；Inbox CRUD、Daily 查询/创建、身份唯一性 |
| `backend/app/insight/` | 同样四文件；手动 Insight CRUD |
| `backend/app/folder/` | Folder CRUD、引用检查、混合内容查询 |
| `backend/app/trash/` | 已删除三类列表、只读详情、恢复、永久删除；无需 Model |
| `backend/app/search/` | SQL 子串 AND 查询、跨类型排序分页；无需 Model |
| `backend/app/link/` | 精确 display_title 候选查询；无需关系 Model |
| `backend/app/main.py` | 注册 Router，保留 health/CORS；不塞业务逻辑 |
| `backend/app/database.py` | 继续 Engine/Session/Base；不额外增加配置层 |
| `frontend/src/api/` | 对应模块的 fetch 调用；204 不解析 JSON；取消请求不显示错误 |
| `frontend/src/types/` | FileType、分页响应、各对象类型；以 type+id 定位文件 |
| `frontend/src/components/` | FileCard、Pagination、普通源码编辑区、MarkdownContent；保持类型相关字段清晰 |
| `frontend/src/pages/` | Journal/Inbox/Insight/Folder/Search/Trash 视图，仅有实际视图才新增文件 |
| `frontend/src/App.tsx` | 视图选择、统一离开检查、变更后刷新；不建事件总线 |
| `frontend/src/utils/` | 输入验证、业务日期、Dirty/PATCH 比较、阅读链接的必要纯逻辑 |

开发前可在 Task 内细化文件名；不能为了目录整齐创建空模块。
新 Model 不仅在 Alembic env 注册，也要在应用运行时注册；T01 完成时 Journal 的 Folder FK 不能指向尚未导入的 metadata 表，不能等到 T07 才解决。
跨类型 SQL 组装可放在使用它的 service 或一个小型公共查询文件，仅用于复用真实重复逻辑；仍由 Service 直接用 Session，不是 Repository。

## 6. 读写与事务边界

- 每次写请求一个原子事务。正文/title/日期/Folder 同次 PATCH 要么全部成功，要么 rollback。
- GET 纯读取，不 flush/commit，不创建 Daily、不创建链接、不改变时间。
- 创建/内容修改按当前模式 commit 后回读；空 PATCH 直接返回；相同值不强制更新时间。
- 软删除/恢复 **必须显式将原 updated_at 写回同一个 UPDATE**，或采用经验证不会触发 onupdate 的等价写法。仅改 deleted_at 的 ORM 赋值会触发现有 onupdate，不能沿用为正确实现。
- 永久删除只接受 deleted_at 非空目标；失败 rollback、Session 可继续用；不删除 Folder。
- Folder 删除：锁住目标 Folder 行，检查三张文件表全部引用（含已删除），真空才删除；FK 防止竞争写入造成孤儿。并发引用失败转换为明确冲突，不泄漏 DB 内部错误。
- 文件写入先验证 Folder 存在，在同一事务完成 FK 写入；Folder 并发删除时整个 PATCH 回滚，不能先保存正文再失败移动。
- Daily 唯一性冲突回滚后查询；不在事务失败状态继续使用 Session。
- 不自动重试写请求；写成功与之后列表刷新失败分开反馈。

## 7. Search / Folder / Trash / Link 的组合读取

三类各形成同形投影，用 UNION ALL 组合，在数据库进行共同排序、count、分页。
type 固定顺序 Journal→Inbox→Insight；同时间加 id，避免三个表 id 撞号或分页并列不稳定。
普通列表/详情、Folder、Search、Link 都必须显式加有效状态条件；Session.get 命中 identity map 也不能跳过已删除检查。
Trash 只读 deleted_at 非空，采用独立入口，不给普通详情开 include_deleted 参数。

Search 按空白词组 AND，各词在 title/content 间 OR；用参数化 ILIKE/等价不分大小写子串，转义通配符。没有全文索引、分词服务或 relevance 算法。
Folder 排序用 updated_at；Trash 用 deleted_at；Search 用 updated_at；Journal 原排序保留。
每页固定 20；条件变化前端设 page=1；数据操作后 total 减少导致越界则最多按最近有效页再查询，不建立后台分页快照。

## 8. Markdown 与链接的前端职责

普通 textarea 保留源文本。阅读渲染器只消费源文本，不将生成 HTML 写回数据库。
依赖选择在 S2-T12 审核：问题是指定 Markdown 语法的正确阅读与 Checklist；候选为小型成熟渲染器配最小扩展，替代为受限手写解析。推荐小型渲染器，不推荐完整编辑器或自建复杂语法系统。
本轮不锁定包名/版本，不安装；执行时查官方文档，说明体积、许可证、是否满足指定语法及 raw HTML/URL 处理，并获得批准。
禁止直接将用户原始 HTML 送入 dangerouslySetInnerHTML；渲染器应转义/禁用 raw HTML，普通超链接拒绝 javascript 等可执行协议。
图片不作为核心支持，不增加附件读取/上传链路。

`[[Title]]` 在阅读文本节点识别，跳过 code/fenced code；可使用渲染器现有扩展点，无自建 AST 平台。
点击→离开提醒→后端精确解析→单结果详情/多结果选择/无结果提示。
目标改名不改源文本；恢复后重新解析即可，无引用表、关系图或后台引用更新。
回收箱正文可以阅读和跳转到已有有效文件，但不能修改该文档或新增关系。

## 9. 前端状态与错误

视图状态包括当前模块、(type,id)、Folder、搜索词、筛选、page；每个列表保留自己的条件。
统一导航函数检查 Dirty，再改变视图；新建与编辑都比较初始快照，默认 Daily 日期标题不算改动。
所有出口包含模块/列表/文件/Search/Folder/内部链接/Daily，不只在“取消编辑”时检查。
写入中禁止切换；保存失败保持输入与 Dirty；成功以返回对象重置基线。
AbortController 或请求序号使迟到旧响应失效；点击卡片真实读取详情，不拿过期列表冒充当前内容。
正常软删成功提示可恢复，永久删除明确确认；普通入口 404 清除过期文件，回收箱详情不提供编辑控件。

## 10. Migration 顺序与数据保护

| 序号 | Task | 内容 | 为什么在此时 |
|---|---|---|---|
| 基线 | 执行前检查、S1.5-T1～T2 | 无 Migration；起点 `3a70890ddb10` | 输入验证/CSS/全量前端编号不改表 |
| M1 | S2-T01 | 建 folders；为 journals 加 Nullable folder_id/deleted_at 及 FK | 被引用表先建；旧 Journal 新列 NULL，无删改原六字段 |
| M2 | S2-T01，接 M1 | 建 inboxes/insights 与 folder FK、业务日期/Daily 身份字段 | 先有 Folder，再建两个文件类型；不提前含 P2 唯一性分支 |
| M3 | S2-T04，接 M2 | P2 确认后的 Daily 唯一部分索引 | 唯一性覆盖范围取决于回收箱后的 Daily 行为 |

M1/M2 作为同一基础 Task 的两份线性 revision，可逐步核对旧数据。revision ID 在执行时由 Alembic 产生，文档代号不伪造实际 ID。
**P3 已确认为动态编号（2026-10-07），因此 S2-T02 不需要新 Migration，编号不参与表结构。**
若将来改为永久编号，需先更新本表/任务/API，再批准持久化序号与回填 Migration。

执行次序：

1. 读取 heads/current，确认单 head；对开发库只读记录旧 Journal 六字段的逐行校验摘要、行数、revision，摘要不贴正文。
2. 在隔离测试环境从真实 Stage 1 revision 建立合成旧 Journal（包含空白/超长/同日多篇/null/空字符串），运行 **已有初始迁移→M1→M2→M3**，逐步比对原六字段。
3. 核对新增默认 NULL/FK/索引、实际 Model metadata；多模块 Model 在 `alembic/env.py` 显式注册。
4. 通过测试库迁移和后端回归后，在该任务明确授权的开发库上执行同一迁移，并做前后摘要对比。
5. 不通过 drop database/table、create_all/drop_all、stamp head、改历史 revision、重新初始化数据卷来代替升级。

测试 prepare 脚本目前只检查 journals，fixture 无残留也只数 journals；S2-T01 必须扩展为所有新业务表，不得因为新增表而自动清空测试库。
破坏性 downgrade 不在真实开发库演练；回退能力在专用空白/合成迁移库验证，任何真实数据回退另行授权。
开发库出现既有非法值不会让迁移截断或失败，因为长度/非空新规则不作为旧数据 CHECK。

## 11. 测试与验收策略

| 层次 | 必测重点 |
|---|---|
| Schema/纯逻辑 | 80/50,000、空白、Unicode、PATCH 省略/null、原样 Markdown、04:00 边界、Dirty |
| PostgreSQL API | 三类 CRUD、分页和 total、编号不依赖过滤、软删/恢复时间、永删、Folder FK/非空、Daily 唯一性、Search、Link |
| 故障/竞争 | 写失败 rollback、Session 继续可用；Daily 并发冲突；Folder 检查后竞争引用；软删不触发 onupdate |
| Migration | 从 Stage 1 六字段数据升级，旧非法内容完整保留，无默认伪日志，单 head/metadata 一致 |
| 前端 build/lint/纯逻辑 | 沿用 Node 类型剥离，无必要不加测试框架；新规则、分页/Dirty 状态转换 |
| 真实浏览器 | 卡片/窄屏、三模块、分页、Folder/Search/Trash/Link 联动、Markdown 源码往返、离开提醒、重新打开数据仍在 |

不删 Stage 1 测试。契约变化时修改原测试预期并保留意图；硬删除物理消失断言转交 Trash 永久删除覆盖。
API 写测试用 seekjournal_test + 外层事务/savepoint；schema 迁移验证用隔离合成数据，不混入正在运行的测试基线。
浏览器所有写请求指向测试库后端，先证明所连库名；仅清理自己创建的 (type,id)，恢复四表空白基线，不能整库清理。
测试结果须记实际命令、退出码、数量，真实成功与合成错误状态分开，不把历史 232 或 README 预期当新证据。

## 12. 开发前治理说明

根 `AGENTS.md` 目前仍保留 Stage 1 的必读/禁止项。本轮只授权文档与必要 agents 文件，未改根文件。
Stage 1.5 执行前检查中，先由用户明确授权并同步根文件的阶段与权威文档导航，保留技术栈/架构变更审批；之后 Developer 只执行被点名的 Task。
这不是重新确认已经批准的产品方向，而是避免后续执行 Agent 同时看到“只准 Stage 1”和 Stage 2 Task。
本规划不自动授权实际修改 Journal Model/API、执行 Migration、安装渲染依赖或开始功能编码。
