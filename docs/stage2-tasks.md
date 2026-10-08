# SeekJournal — Stage 2 Development Task Plan

> 2026-10-07。Goal：把已确认的本地基础记录规则落实为可独立 Review/Test/Commit 的任务。
> Architecture：保留三类独立文件表、一级 Folder、现有 Router → Service → SQLAlchemy；local State + fetch。
> Tech Stack：React/TypeScript/Vite、FastAPI/Pydantic/SQLAlchemy/psycopg/PostgreSQL/Alembic、pytest。
> T01/T02已完成；2026-10-08用户授权T03/T04并行实施。Lead负责共享规则与独立验收，后续任务未授权。
> 本轮使用既有T03/T04工作树，分别由两个实施Agent执行，不递归派发；不自动commit/merge/push/tag或清理工作树。

## 1. 阅读、范围与统一完成标准

每次先读 `AGENTS.md`、`agents/ds-developer.md`、`agents/multi-agent-workflow.md`；按任务读 `stage2.md`、`stage2-api.md`、`stage2-architecture.md` 和本文。
Stage 1.5 另读 `stage1.5-bugfix.md` 与 Stage 1 三份权威文档；Stage 1.5 任务全部在该文件，不与以下任务混执行。

- 先完成执行前检查清单、S1.5-T1→T2 的独立验收，再开始 S2-T01。
- 只改当前 Task 点名模块及必要测试/运行说明；新 API/字段严格按本轮文档，不能扩大范围。
- 每 Task 步骤：核对输入/输出与前置证据 → 最小失败/边界用例 → 最小实现 → 必要测试 → 人工演示 → 完成报告 → Lead Review/用户验收 → 可独立 Commit。
- 所有写测试指向独立测试库。真实开发库迁移只在该 Task 明确授权后执行；禁止清库或截断旧正文。
- Pending 的唯一登记处为 `stage2.md` §15；Developer 只停止相关分支，继续无依赖工作。建议不能自动变成需求。
- 统一 DoD：目标可验证、测试实际通过、对应人工步骤通过、旧数据保护、无新增范围/未批准依赖、文件/结果/限制/学习点已报告、Lead Review 通过。
- 表结构 Task 可用数据库演示；API Task 可用请求演示。中间 Task 通过不等于整个阶段完成。
- S2-T02 改列表/删除契约，T03 才配套旧 Journal UI；不要在二者之间宣布 Web 整体可用。合并或对外展示时将两者作为配套完成条件，仍可分别 Review/Commit。

## 2. 总览与推荐执行顺序

| Task | 单一目标 | 交付物 |
|---|---|---|
| S2-T01 | 建立保留旧数据的三类文件与 Folder 数据基础 | M1/M2、Model、迁移/隔离验证 |
| S2-T02 | Journal 接入分页、全范围标题和软删除 API | 已测试的新 Journal 契约 |
| S2-T03 | 建立导航/卡片/分页/Dirty，并接通新 Journal UI | Journal 的完整可用链路 |
| S2-T04 | 实现 Inbox/Daily 后端的有效保存与查询 | Inbox API、确认后的 M3 |
| S2-T05 | 实现 Daily 快捷入口和多 Inbox 使用流程 | Inbox 可用 UI |
| S2-T06 | 实现用户手动管理 Insight 的完整小闭环 | Insight API + UI |
| S2-T07 | 实现一级 Folder 的后端契约 | Folder CRUD/引用限制/混合分页 |
| S2-T08 | 接通 Folder 选择、移动和混合列表 | Folder 可用 UI |
| S2-T09 | 实现回收箱只读、恢复与永久删除 API | Journal/Insight恢复/永删契约 |
| S2-T10 | 接通单条回收箱操作与正常页刷新 | Trash 可用 UI |
| S2-T11 | 实现三类普通搜索与全局结果分页 | Search API + UI |
| S2-T12 | 实现最小 Markdown 阅读，保持源码编辑 | 渲染组件与源码往返验证 |
| S2-T13 | 实现 [[标题]] 的有效文件解析与跳转 | Link API + 阅读跳转 |
| S2-T14 | 完成迁移、回归和跨模块独立验收 | Stage 2 实际验收记录 |

## 3. S2-T01 — 数据基础与旧 Journal 升级

1. **Goal**：新增 Folder/Inbox/Insight 与 Journal 关联、软删除字段，保证旧六字段完整保留。
2. **Scope**：`backend/app/folder/models.py`、`inbox/models.py`、`insight/models.py`（拟新增）、`journal/models.py`、`backend/alembic/env.py`、新 migrations；`backend/app/main.py` 仅必要 Model 注册；`backend/scripts/prepare_test_db.py`、`backend/tests/conftest.py`、`tests/test_stage2_migrations.py`（拟新增）。
3. **Out of Scope**：API、UI、P2 唯一性分支、永久编号、历史内容清洗、任何未来字段。
4. **前置依赖**：Stage 1.5 已验收；阶段/根 AGENTS 执行导航明确；当前 revision 单 head。
5. **主要模块**：SQLAlchemy metadata、Alembic、测试库准备/残留守卫。
6. **DB/Migration**：M1 创建 folders + Journal Nullable folder_id/deleted_at；M2 创建 inboxes/insights；按此顺序线性衔接。Inbox title 先用 Nullable Text，不预替 P1 制定业务限制。
7. **后端行为**：Alembic 与应用运行时均注册新 Model，保证 Journal FK 指向的 Folder metadata 存在；不提前注册新业务 Router。FK 不 cascade，不给旧内容长度 CHECK；测试隔离扩展到四张业务表，遇到既有记录保留并报告。
8. **前端行为**：不改。
9. **测试要求**：从 `3a70890ddb10` 的合成旧数据逐步 upgrade；原 id/title/content/date/times 逐行一致，新 Journal 两列 NULL；FK/Nullable/metadata 正确；旧空白/超长数据可保留；测试库非空拒绝清理；单 head/check 无漂移。
10. **人工验收**：展示迁移前后旧行摘要、表结构和两库 revision，不展示私人正文；新增三表空白。真实库升级须该任务明确授权且测试升级先通过。
11. **执行步骤**：只读基线 → Model/M1/M2 → 合成旧数据升级测试 → 扩展隔离 → 核对 → 受授权的开发库升级/比对。
12. **Definition of Done**：M1/M2 可 Review，旧数据不变，所有业务表测试无残留；输出真实 migration IDs 与命令，不只说“生成成功”。

### S2-T01 执行记录（2026-10-07）

> 本节是**执行之后**补记的实际结果，供 Review / 验收对照，不是事前计划。

- 分支 `task/s02-t01-data-foundation`，起始 HEAD `aa19d65`（已含 T1 `c08db51`、T2 `7349a44`）。
- Model：新增 `app/folder`、`app/inbox`、`app/insight` 三个 Model 模块；
  `app/journal/models.py` 追加可空 `folder_id`（FK → `folders.id`，NO ACTION）与可空 `deleted_at`。
  在 `alembic/env.py` 与 `app/main.py` 两处显式注册；`main.py` 只导入 Model，**未注册任何新 Router**。
- Migration（实际 revision）：
  - M1 = `52c8e94a365c`，`down_revision = 3a70890ddb10`：建 `folders`，`journals` 加两列 + 外键；
  - M2 = `a8d98342e603`，`down_revision = 52c8e94a365c`：建 `inboxes`、`insights`。
  初始迁移未改；单 head；无 drop / 重建 / 数据清洗 / 额外表；本阶段**没有 M3**。
- 隔离：`prepare_test_db.py` 的「非空拒绝」检查从 `journals` 扩展到四张业务表，
  对尚不存在的表用 `to_regclass` 跳过；`tests/conftest.py` 的无残留检查同样改为逐表比对。
- 验证：`tests/test_stage2_migrations.py` 在一次性隔离验证库上，
  从 `3a70890ddb10` 用**旧六字段 SQL** 合成 8 条旧数据（NULL / 空字符串 / 纯空白标题、
  同日多篇、空字符串与纯空白正文、超长标题与超长正文、不同日期、2020 年历史时间戳），
  逐步升级到 M1、M2 并逐行比对原六字段（每行 digest 完全一致），
  同时校验新列为 NULL、列顺序、FK 与 ondelete、`is_daily` 默认值、索引与 metadata 一致，
  并在隔离事务里通过 ORM 读写三张新表。临时验证库跑完即删。
- 命令与结果：`prepare_test_db` `PASS`；
  `tests/test_stage2_migrations.py tests/test_test_database.py` → `10 passed`；
  全量 `314 passed`；`alembic heads` = `a8d98342e603 (head)`；
  对 `seekjournal_test` 的 `alembic current` = head、`alembic check` = No new upgrade operations detected.
- 开发库 `seekjournal` **未升级**，仍是 `3a70890ddb10`：行数、六字段 digest 与 sequence 与实施前一致。
  对开发库执行 `alembic check` 会显示 `FAILED: Target database is not up to date.`，属预期阶段状态。
- 结论：**S2-T01 实现与测试环境验证完成，开发库待升级 / 独立验收**；未进入 T02，未提交。

## 4. S2-T02 — Journal 新契约

1. **Goal**：把 Journal 读取/修改/删除升级为分页、统一标题投影与软删除。
2. **Scope**：`backend/app/journal/{schemas,service,router}.py`、相关 `backend/tests/test_journal_*.py`、拟新增 `test_journal_pagination_api.py`；必要小型标题投影函数。
3. **Out of Scope**：Trash 恢复/永删、Inbox API、前端、Search、内容历史。
4. **前置依赖**：T01；**P3 已于 2026-10-07 确认为动态编号**（见 `stage2.md` §15），本任务按此实现，不新增编号字段或 Migration。P1/P2 不阻塞本任务。
5. **主要模块**：Journal 读投影、分页、有效状态筛选、PATCH 与 DELETE。
6. **DB/Migration**：**P3 已确认为动态编号，本任务无新 Migration**；编号不进入表结构，不塞临时字段。若将来改回永久编号，必须先修改计划并批准新迁移。
7. **后端行为**：列表 envelope、固定 20 条、日期/Folder 条件；完整日期编号先算再过滤；详情 display_title 一致；普通已删除 GET/PATCH/DELETE 404；软删保持 updated_at。
8. **前端行为**：本 Task 不改 UI，T03 紧接迁移其 API 类型/调用；中间 Web 不按旧数组契约验收。
9. **测试要求**：0/1/20/21/41 条、页 0/非法/超范围、total、日期筛选；同日跨两页、跨 Folder 与空标题/手工标题混合、新增不改旧号、软删前后号一致（推荐方案）；onupdate 时间、空/相同 PATCH、旧非法字段未提交、404、204 空体、失败回滚与同日兄弟不受影响。
10. **人工验收**：测试库 API 展示 21 条翻页与同一 id 在列表/详情同标题；DELETE 后数据库行仍在、deleted_at 有值、原 updated_at 不变，普通详情 404。
11. **执行步骤**：将数组/硬删的原测试意图转换 → 补分页/编号/时间反例 → 实现 → 指定与全量后端回归 → API 演示。
12. **Definition of Done**：API 与文档一致、旧测试意图保留、没有客户端页内编号；T03 可直接消费此响应。

### S2-T02 执行记录（2026-10-07）

> 本节是**执行之后**补记的实际结果，供 Review / 验收对照，不是事前计划。

- 分支 `task/s02-t02-journal-api`，起始 HEAD `030bec7`（已含 S2-T01），工作区干净。
- **P3 同步**：`docs/stage2.md` 把 P3 记为**已确认＝动态编号**，与 P1/P2 一起移出「Pending」表；
  `stage2-api.md` / `stage2-architecture.md` 删除「P3 未定」措辞并冻结动态编号方案；
  根 `AGENTS.md`、`agents/*.md` 的当前授权从 T01 更新为 **T02**（Stage 2 仍未整体授权）。
- 代码：
  - 新增 `app/journal/titles.py`：`is_untitled()` / `untitled_predicate()` /
    `build_display_title()` / `numbered_subquery()`。
    编号用 `row_number() OVER (PARTITION BY journal_date ORDER BY created_at, id)`
    在**该日期完整现存集合**（**不过滤 `deleted_at`**）上计算，再由调用方 LEFT JOIN。
  - `schemas.py`：`JournalCreate` / `JournalUpdate` 增加可空 `folder_id`；
    `JournalResponse` 从六字段扩为十字段（`type` / `id` / `title` / `display_title` /
    `content` / `journal_date` / `folder_id` / `created_at` / `updated_at` / `deleted_at`），
    **不套用请求的长度/非空限制**；新增分页 envelope `JournalPage`。
  - `service.py`：列表改为固定 20 条分页（筛选、`count`、排序、`LIMIT/OFFSET` 全在 SQL，
    编号用窗口函数一次 JOIN 算出，不拉全量到 Python、不逐条查库）；
    `folder_id` 写入前校验 Folder 存在（`FolderNotFoundError` → Router 404，且在任何赋值之前）；
    删除改为**软删除**——单个 `UPDATE` 同时写 `deleted_at` 并显式
    `SET updated_at = journals.updated_at` 抵消 Model 的 `onupdate`；
    读取有效状态一律用 SQL 的 `WHERE deleted_at IS NULL`，不用 `Session.get()`（避免 identity map 漏检）。
  - `router.py`：`GET /api/journals` 增加 `folder_id` 与 `page`（`Query(1, ge=1)`，非法值标准 422）、
    返回 `JournalPage`；`PATCH` 接 `folder_id`；`DELETE` 改为软删除、仍返回 204 空体。
  - **Journal Model 与 Alembic Migration 未改动**；`alembic heads` 仍为 `a8d98342e603 (head)`。
- 测试：
  - 新增 `tests/test_journal_pagination_api.py`（**39** 例）：0/1/20/21/41 条、非法页码、
    超范围页、`total` / `has_next`、并列时间稳定排序与跨页无重叠、日期/Folder 筛选、
    同日跨页编号、手工/NULL/空串/纯空白标题混合、新增不改旧号、软删仍占原号、
    详情与列表/POST/PATCH 标题一致、已删除记录在所有普通入口隐藏、
    完整字段快照与 `updated_at` 精确不变、重复删除、204 空体、空/相同值 PATCH、
    Folder 原子更新 404、写失败 rollback。
  - 旧测试按「保留原意图」迁移，未删除任何用例：
    `test_journal_read_api.py` 数组断言 → 分页 envelope（19 例）；
    `test_journal_detail_api.py` 六字段 → 十字段 + 投影断言（22 例）；
    `test_journal_delete_api.py` 硬删除 → 软删除（行保留、仅 `deleted_at` 变化、
    `updated_at` 精确不变、普通入口隐藏、重复删除不改写 `deleted_at`）（27 例）；
    `test_journal_update_api.py` 六字段 → 十字段、列表断言改 envelope（67 例）；
    `test_journal_schemas.py` / `test_journal_update_schemas.py` 同步新字段集。
- 命令与结果：全量 `385 passed`；
  `tests/test_journal_pagination_api.py` 单独 `39 passed`；
  `alembic heads` = `a8d98342e603 (head)`，`alembic current` = `a8d98342e603 (head)`，
  `alembic check` = `No new upgrade operations detected.`
- API 演示（临时后端绑 `127.0.0.1:8100`，`DATABASE_URL` 指向 `seekjournal_test`，跑完即停）：
  21 条同日无标题记录 → 第 1 页 20 条（编号 21…2）、第 2 页 1 条（编号 1）、
  `total=21` / `has_next` 正确、两页编号并集覆盖 1..21 且无重复；
  `page=9` → 200 + 空 `items` 且保留页码，`page=0` → 422；
  手工标题 `display_title` 原样、清空标题后回退日期，详情与列表一致；
  `DELETE` → 204 空体、行仍在、原六字段 + `folder_id` 不变、`updated_at` 精确不变、
  `deleted_at` 由 `None` 变为带时区时间、详情 404、列表不含、重复删除 404 且不改写 `deleted_at`、
  被删记录仍占原编号。演示创建的 22 行已按本轮自建 id 清理（含软删除行）。
- 数据保护：开发库 `seekjournal` 本轮**零写入**——行数 **13**、六字段 digest
  `5e485912211255e0e01ff2f6343c94a7`、`journals_id_seq` **1651** 均在演示前后一致，
  且 `deleted_at IS NOT NULL` 的行数为 0。
  注意：开发库**当前 revision 已是 `a8d98342e603`（head）**，与本任务开始时观察到的一致，
  不是本任务执行步骤所为（本轮未对开发库执行任何 upgrade）；见「Problems / Unverified」。
- 结论：**S2-T02 实现与测试环境验证完成，待独立验收**；未进入 T03，未提交。

## 5. S2-T03 — 导航、卡片、分页和 Journal UI

1. **Goal**：建立后续模块复用的最小交互框架，并恢复新契约下的 Journal 完整使用流程。
2. **Scope**：`frontend/src/App.tsx`、`App.css`、`api/journals.ts`、`types/journal.ts`、Journal 三组件；拟新增 `types/file.ts`、`components/FileCard.tsx`、`Pagination.tsx`、`utils/dirtyState.ts` 与对应纯逻辑测试。
3. **Out of Scope**：未来路由/状态框架、富文本、实时预览、尚未完成模块的伪数据实现。
4. **前置依赖**：T02。
5. **主要模块**：导航状态、(type,id)、请求生命周期、编辑基线、卡片/分页。
6. **DB/Migration**：无。
7. **后端行为**：消费 T02，不变 API。
8. **前端行为**：服务端 display_title；whole-card 打开真实详情；键盘入口；日期条件回第一页；total 提示当天记录数；软删后有效页回退；所有切换统一 Dirty 提醒，保存失败保留，成功与刷新失败分开；导航未实现模块显示明确未开通态，不假装有功能。
9. **测试要求**：分页状态/页数计算、Dirty 与 PATCH 比较、默认值无 Dirty；保留日期/详情纯逻辑；build/lint；浏览器快速切换请求、保存失败、写成功刷新失败、软删文案/204、21 条翻页。
10. **人工验收**：Journal 新建/阅读/修改/软删全流程；编辑后点击另一卡片/模块/列表均提醒；最后一页最后一条删除回最近有效页；桌面/窄屏标题一行、摘要三行。
11. **执行步骤**：更新 TS/API 响应类型 → 最小共享交互组件 → 接通 Journal → 纯逻辑/构建检查 → 浏览器验证。
12. **Definition of Done**：Journal Web 完整可用，框架真实被 Journal 使用，未引入复杂路由/状态依赖；后续页面复用导航守卫。

## 6. S2-T04 — Inbox / Daily API

1. **Goal**：有效正文保存才创建Inbox；普通/Daily完整CRUD与分页，所有Inbox硬删除，同日Daily可重建。
2. **Scope**：仅SeekJournal-T04；backend/app/inbox/{schemas,service,router}.py、models.py必要唯一索引映射/注释；app/main.py路由注册；相关Schema/Service/API/并发/迁移测试；新M3与必要backend运行说明。共享docs/agents由Lead修改。
3. **Out of Scope**：前端、状态/过期/Inbox→Journal、AI、操作历史、Trash/Restore/Permanent Delete、Search、其他后续功能；不删除既有deleted_at列。
4. **前置依赖**：T01/T02已完成，P1/P2/P3已确认；不再等待旧回收箱决策。
5. **主要模块**：请求字段语义、Inbox CRUD/Daily只读查询、硬删除、数据库唯一性与事务。
6. **DB/Migration**：新增线性M3接a8d98342e603；inbox_date唯一部分索引条件仅is_daily=true，无deleted_at条件；不改旧Migration；只升级seekjournal_test，不升级个人库或T03专属库。
7. **后端行为**：POST省略title默认存inbox_date，显式null/空串原值保存、display_title回退日期；非空含纯空白title不trim/80码点，正文同现有空白集合且50,000码点/原样Markdown；PATCH仅title/content/folder_id，日期/is_daily依extra=ignore不可修改；空/相同PATCH时间不变。Daily身份不依赖title，GET零写；重复并发创建409并rollback。所有Inbox DELETE物理删除204空体，之后详情/PATCH/重复DELETE404，Daily可同日重建。未启用deleted_at不参与筛选、不赋值，响应恒null。
8. **前端行为**：不改前端，提供T05后续消费契约。
9. **测试要求**：Schema/Service/API、title省略/null/空串/纯空白/80/81与emoji、content空白集合/50,000/50,001/Markdown原样；分页0/20/21/41/日期筛选/排序；系统字段忽略、空/相同PATCH、日期/Daily身份不可变；零写GET、唯一性冲突及两个独立Session并发创建；普通/当日/往日Daily硬删除、404及同日重建；Folder不存在/写入故障rollback、Session可继续；旧迁移不变、新M3元数据一致，全量后端回归、库隔离。
10. **人工验收**：8014实际连接seekjournal_test；GET不存在Daily行数不变；POST→改名/清空→GET同id；普通同日多篇；重复/并发409；DELETE204零字节与物理不存在→GET/PATCH/DELETE404→同日创建新Daily成功；只清理本轮自建typed IDs。
11. **执行步骤**：最小失败用例→Schema/Service/Router→M3人工检查/测试库升级→指定及全量测试→真实HTTP演示→独立验收。
12. **Definition of Done**：全部确认规则有实际证据，M3线性/旧迁移不变，个人库与T03库不变，零残留/零新依赖；无Trash或其他后续API；无自动Git写入。

## 7. S2-T05 — Inbox 使用流程

1. **Goal**：提供容易找到的 Daily 和可长期保存的额外 Inbox。
2. **Scope**：拟新增 `frontend/src/api/inboxes.ts`、`types/inbox.ts`、`pages/InboxPage.tsx`，复用 FileCard/Pagination/源码编辑；`journalDate.ts` 的必要共享使用与测试，App 导航。
3. **Out of Scope**：自动草稿、来源关系、任务状态按钮、Checkbox 自动写库。
4. **前置依赖**：T03、T04；P1/P2已确认：标题允许清空、全部Inbox硬删除。
5. **主要模块**：Daily 快捷入口、新建/详情/编辑、同日多 Inbox。
6. **DB/Migration**：无。
7. **后端行为**：消费 T04；通过只读 Daily 查询判断编辑器状态。
8. **前端行为**：未保存 Daily 显示日期+空编辑器，离开无输入不提醒且不 POST；有效保存创建一次；已存在则打开；额外 Inbox 独立创建；Daily 无论当前列表页码都可到达；跨 04:00 不重置编辑中内容；删除Inbox明确不可恢复；删除Daily后允许同日有效保存重建，不增加trashed/recovery或回收箱入口。
9. **测试要求**：03:59/04:00、跨月/年/闰日、草稿初始 Dirty、有效保存/失败输入/重复按钮/409重读；分页/条件复用；build/lint、真实浏览器。
10. **人工验收**：当天无记录进入后查行数不变；输入有效正文保存，再进同 id；另建两个自定义标题 Inbox；翻至第 2 页还能打开 Daily；Dirty 切换提示正确。
11. **执行步骤**：接 API → Daily 临时编辑状态 → 普通 Inbox UI → 失败/日期/分页检查 → 演示。
12. **Definition of Done**：Daily 与普通 Inbox 流程可展示，没有每日空记录、自动重置或整理语义。

## 8. S2-T06 — 手动 Insight CRUD 闭环

1. **Goal**：用户可创建、阅读、修改、软删除认知沉淀文件。
2. **Scope**：拟新增 `backend/app/insight/{schemas,service,router}.py`、`tests/test_insight_api.py`；`main.py`；拟新增前端 `api/insights.ts`、`types/insight.ts`、`pages/InsightPage.tsx` 与 App 接口。
3. **Out of Scope**：AI、Journal 来源关系、所属日期、版本历史。
4. **前置依赖**：T01、T03；可复用已验证的通用编辑/卡片交互，不引入通用 CRUD 框架。
5. **主要模块**：Insight 完整小闭环（字段少、UI 复用），可一个独立 Review/Commit。
6. **DB/Migration**：无，使用 M2。
7. **后端行为**：统一正文验证、可空标题、原样存储、updated_at DESC 分页、空/相同 PATCH不更新时间、软删保护时间。
8. **前端行为**：无日期选择；空标题显示未命名 Insight；CRUD/分页/Dirty 与已有模块一致；不显示 AI 入口。
9. **测试要求**：Schema/API 边界、空标题、21条分页、编辑后排序、GET/PATCH 已删除404、软删时间、原样 Markdown、回滚；浏览器 Dirty/失败/完整 CRUD。
10. **人工验收**：创建一篇原则和一篇长期思考、修改其中一篇后列表排前、清空标题仍可识别、移入回收箱后正常列表消失。
11. **执行步骤**：Schema/API 最小用例 → 后端 → UI 复用 → API回归/build/lint → 小闭环演示。
12. **Definition of Done**：纯手动 Insight 可完整管理，无未来字段和 AI 隐性依赖。

## 9. S2-T07 — Folder API 与引用约束

1. **Goal**：支持一级分类、混合读取与真空 Folder 删除。
2. **Scope**：拟新增 `backend/app/folder/{schemas,service,router}.py`、`tests/test_folder_api.py`；三文件 service 的 folder 检查/跨类型投影、main 注册。
3. **Out of Scope**：级联删除、多级 Folder、拖动、图标、Folder 回收箱、批量移动。
4. **前置依赖**：T02、T04、T06。
5. **主要模块**：Folder CRUD、三表引用、混合排序/分页、文件 PATCH folder_id。
6. **DB/Migration**：无，使用 M1/M2 FK。
7. **后端行为**：Folder name 校验/改名；查看混合有效文件；不存在 Folder 404；非空（含 Trash 引用）409；锁目标行+FK竞争仲裁；移入/移出与内容同事务，移动更新文件 updated_at。
8. **前端行为**：不接新页面，T08 消费接口。
9. **测试要求**：name 空白/80/81、空 PATCH/404；三个同 id 不撞类型；21条混合分页，隐藏已删；引用存在/清空后可删；只有 Trash 引用仍409；Folder并发删除/移入无孤儿/半截正文更新，失败rollback。
10. **人工验收**：创建 Folder、三类型移入、混合列表；逐条移出有效文件后空 Folder 删除成功；另一 Folder 中硬删 Inbox、软删 Journal/Insight 后正常列表空但删除409。恢复后移出/永久删除释放引用的组合行为留到 T09/T10，不依赖尚未实现的回收箱 API。
11. **执行步骤**：CRUD 用例 → 引用/事务限制 → 混合查询 → 竞争验证 → API演示。
12. **Definition of Done**：删除不会破坏恢复的原Folder关系；混合文件按(type,id)可辨认；无额外层。

## 10. S2-T08 — Folder 页面与文件归类

1. **Goal**：用户可以创建/改名/浏览 Folder，并保存文件归属变化。
2. **Scope**：拟新增 `frontend/src/api/folders.ts`、`types/folder.ts`、`pages/FolderPage.tsx`；三文件编辑表单 Folder 字段、App 入口。
3. **Out of Scope**：拖动移动、多选、图标/颜色/排序与子Folder。
4. **前置依赖**：T03、T05、T06、T07。
5. **主要模块**：Folder选择器、混合卡片、CRUD反馈与导航守卫。
6. **DB/Migration**：无。
7. **后端行为**：消费 T07，文件 PATCH 携 folder_id/null。
8. **前端行为**：“无Folder”可选；选择字段未保存算Dirty；移动/移出刷新原/新Folder及列表total；Folder改变回第一页；删除409明确说明含回收箱引用，不在UI假删。
9. **测试要求**：Folder PATCH 差异/Dirty、跨类型卡片type+id、页越界回退；构建/lint；浏览器取消修改/移动失败保留输入/非空删除拒绝。
10. **人工验收**：三文件移动入同Folder、混合打开正确详情；编辑时改Folder后离开提醒；移出后不再显示；删除空Folder，只有Trash引用时显示原因。
11. **执行步骤**：API/选择器 → 页面混合列表 → 刷新/Dirty → 浏览器演示。
12. **Definition of Done**：Folder与文件修改在统一保存模型下可用，无额外移动接口或隐性写请求。

## 11. S2-T09 — Trash API 与时间保持

1. **Goal**：Journal/Insight的软删除能只读查看、原样恢复和单条永久删除；排除Inbox。
2. **Scope**：拟新增 `backend/app/trash/{schemas,service,router}.py`、`tests/test_trash_api.py`；必要Journal/Insight service协作、main 注册。Trash 不新建 Model。
3. **Out of Scope**：编辑、Folder改动、批量操作、定时清除、历史日志。
4. **前置依赖**：T02、T06、T07；Inbox已硬删除，不参与本Task。
5. **主要模块**：Journal/Insight跨类型已删除投影、恢复/物理删除事务；不存在Inbox恢复。
6. **DB/Migration**：无。
7. **后端行为**：deleted_at排序全局分页；只读详情；restore只清删除字段并保留原updated_at/id/正文/日期/Folder；purge仅已删除对象；普通入口一直404；Folder引用随物理删除释放。
8. **前端行为**：本任务API验收，T10接页面。
9. **测试要求**：Journal/Insight生命周期逐字段快照；空/21条/类型筛选/重复操作；有效对象永删404；回收箱编辑无接口；普通列表/详情/Folder隐藏；onupdate陷阱；restore/purge失败回滚，兄弟记录不变；原Folder关系保留；Inbox类型不得进入Trash接口。
10. **人工验收**：Journal/Insight各软删→查库行/时间→Trash详情→恢复→原六字段/Folder一致；再软删→永久删→物理行消失及普通404，Folder可重新判断是否真空。
11. **执行步骤**：生命周期快照用例 → 列表/详情 → 恢复/永删 → 故障注入/回归 → API演示。
12. **Definition of Done**：完整时间保留有真实DB断言，204空体不丢，物理删除只在明确Trash入口发生。

## 12. S2-T10 — Trash 页面与单条操作

1. **Goal**：用户能安全区分移入回收箱与永久删除，逐条阅读/恢复/删除。
2. **Scope**：拟新增 `frontend/src/api/trash.ts`、`pages/TrashPage.tsx`；类型/卡片复用；App刷新与三类删除文案。
3. **Out of Scope**：批量选中、清空、恢复后自动编辑、编辑Trash正文。
4. **前置依赖**：T03、T05、T06、T08、T09。
5. **主要模块**：只读详情、删除确认、操作后Journal/Insight列表/Folder刷新；不刷新已不存在的Inbox恢复分支。
6. **DB/Migration**：无。
7. **后端行为**：消费T09的Journal/Insight契约，不接Inbox恢复。
8. **前端行为**：只显示读取/恢复/永久删除；永久删除明确不可恢复；取消不请求；成功后清过期详情并按有效页重读；恢复后更新Journal/Insight正常模块与Folder；失败不伪装删除。
9. **测试要求**：204不解析JSON、取消零请求、404/500、写成功刷新失败分开、分页类型变化回1、最后页回退；浏览器确认/只读UI。
10. **人工验收**：Journal/Insight移入、查看全文、恢复原Folder；Inbox不出现；永久删取消不动数据，确认后正常页/Folder均不能打开。
11. **执行步骤**：只读页面 → 单条动作与文案 → 跨视图刷新 → 异常/分页验收。
12. **Definition of Done**：不存在Trash编辑/移动入口，单条操作正确，无批量/定时扩张。

## 13. S2-T11 — 普通搜索闭环

1. **Goal**：一次搜索覆盖三类有效文件，按确定排序全局分页。
2. **Scope**：拟新增 `backend/app/search/{schemas,service,router}.py`、`tests/test_search_api.py`；main；前端 `api/search.ts`、`pages/SearchPage.tsx`，复用卡片/分页/Dirty。
3. **Out of Scope**：AI/语义搜索、FTS基础设施、relevance、日期/Folder名搜索、高级表达式。
4. **前置依赖**：T03、T05、T06、T08、T10。
5. **主要模块**：参数化跨表子串查询、合并排序/count/page、搜索交互。
6. **DB/Migration**：无；不为了小型子串搜索加索引服务或第三方库。
7. **后端行为**：每词title/content OR，多词AND；英文忽略大小写/中文子串；排除deleted；空q空结果；LIKE通配符转义；updated_at/type/id排序；全局20条。
8. **前端行为**：关键词/类型变化回第一页；新请求取消旧请求；无输入/无结果/失败分别显示；整个结果卡片打开真实对象，并执行Dirty离开提醒。
9. **测试要求**：中文、AI/ai、跨字段AND、空白分词、重复词、%/_/反斜杠字面匹配、已删隐藏/恢复重现/永删消失；三类型各有>20匹配仍总页20；相同时间/type+id排序；无结果/最后页，快速输入竞态。
10. **人工验收**：`AI 培训` 在标题/正文分别命中三类文件；Journal/Insight软删后找不到、恢复后找到；Inbox硬删后找不到且不能恢复；翻页总数正确，清关键词无全库列表；点击正确详情。
11. **执行步骤**：后端条件/排序用例 → 查询API → Search页面 → 回收箱/分页联动演示。
12. **Definition of Done**：搜索规则和排序一致，没有额外搜索语法；不拿前端已加载内容作全库搜索。

## 14. S2-T12 — 最小 Markdown 阅读

1. **Goal**：三类文件阅读时支持指定Markdown语法，编辑仍保留原源码。
2. **Scope**：拟新增 `frontend/src/components/MarkdownContent.tsx`、阅读样式与三类/Trash详情接入；批准后才允许更新 `frontend/package.json`/lockfile；必要渲染用例。
3. **Out of Scope**：富文本/Block编辑器、实时预览、图片附件、Checkbox点击写源码、表格/LaTeX核心验收。
4. **前置依赖**：T03、T05、T06、T10；具体依赖先按agents规则提交问题/收益/替代/体积与官方依据，批准后才安装。
5. **主要模块**：源码输入与阅读呈现；不新建Backend渲染服务。
6. **DB/Migration**：无，仍存Text Markdown。
7. **后端行为**：保持原样存/读，不存HTML，不执行Markdown。
8. **前端行为**：渲染# / ## / ###、Checklist、数字列表；Checklist只读；raw HTML不执行；合法普通链接可读；没有源码改写/自动完成移动；预留小型文本链接扩展点供T13。
9. **测试要求**：标题/Checklist/数字列表、代码/普通文本、HTML可执行内容被禁用、危险URL不执行；编辑保存读取原始空格/缩进/换行完全一致；点击Checkbox不PATCH；构建/lint与真实视觉验收。
10. **人工验收**：将产品文档示例保存到三类文件，阅读渲染正确，进入编辑仍是原源码；修改再读完整；Trash详情同样阅读且不能编辑。
11. **执行步骤**：依赖审核 → 最小渲染组件 → 只读详情接入 → 源码往返/视觉验证。
12. **Definition of Done**：指定语法可用、源码未变、批准的依赖理由完整，没有大型编辑器或额外核心验收语法。

## 15. S2-T13 — 简单内部链接

1. **Goal**：点击 [[标题]] 可定位有效文件，正确处理重名与不存在。
2. **Scope**：拟新增 `backend/app/link/{schemas,service,router}.py`、`tests/test_link_api.py`；main；前端 `api/links.ts`、`components/LinkCandidates.tsx`，MarkdownContent扩展与统一导航。
3. **Out of Scope**：AST平台、引用表、自动重命名、Backlink/图谱/Block/Heading跳转、自动创建。
4. **前置依赖**：T02、T05、T06、T08、T10、T12；P3显示编号规则冻结。
5. **主要模块**：精确display_title查询、候选轻量分页、阅读文本识别/跳转。
6. **DB/Migration**：无，不存引用关系。
7. **后端行为**：全部有效类型等值匹配当前display_title；排除已删；单/多/零候选统一envelope与total；候选类型/id/日期时间完整；全范围Journal编号。
8. **前端行为**：只在阅读文本激活，代码/未闭合不激活；单目标开真实详情，多目标选择可翻页，无目标提示；点击统一Dirty检查；改名不改源正文。
9. **测试要求**：三类型单目标、跨类型同标题同id、多目标>20、零目标、Journal自动日期/编号跨页/Folder、软删/恢复/永删、重名其他有效对象仍匹配；Journal/Insight验证软删/恢复/永删，Inbox验证硬删后不命中；候选选中前目标已删除；code/fence/HTML边界与导航取消。
10. **人工验收**：源文含单、多、零三种链接；候选显示类型+标题+时间，选中准确；改名后原链接失效；回收箱目标不命中；代码块内[[文本]]不可跳转。
11. **执行步骤**：精确解析用例 → Backend → 文本渲染扩展/候选UI → 跨模块与Dirty演示。
12. **Definition of Done**：文件级跳转达标，正文未自动修改，没有引用系统或关系维护副作用。

## 16. S2-T14 — 全阶段独立验收

1. **Goal**：证明Stage2整体可用、迁移保留旧数据、没有范围扩张。
2. **Scope**：只读Review、已有测试/构建执行、测试库浏览器验收；在本文件验收区追加实际记录，必要更新README已实现范围。发现Bug另列修复Task，不顺手重构。
3. **Out of Scope**：AI/云/账号/Android、UI重构、新需求和未批准修复。
4. **前置依赖**：T01～T13全部完成，P1/P2/P3处理结果落在权威文档；Stage1.5验收证据可查。
5. **主要模块**：所有基础对象和组合行为；独立Lead验收，不照抄Developer报告。
6. **DB/Migration**：不新建；核对单head、current/check、四表隔离和Stage1→新head升级证据。
7. **后端行为**：全量回归、空/相同PATCH、时间/事务/404/204、数据保护。
8. **前端行为**：真实UI全链路、Markdown源码往返、所有Dirty出口、基础响应式，重新打开仍持久化。
9. **测试要求**：逐项映射stage2.md A01～A13；真实成功与合成错误分开；记录命令/退出码/数量，不能把历史232当本次结果。
10. **人工验收**：按下一节顺序；开发库只读前后摘要一致，测试库仅清本轮自建对象并恢复四表基线，用户既有服务不动。
11. **执行步骤**：独立文件/契约Review → 自动检查 → 迁移证据 → 浏览器组合验收 → 记录限制 → 用户功能/学习验收。
12. **Definition of Done**：A01～A13实际通过、用户知道核心数据流/修改/结果；未完成的检查明确标记，不先宣布Stage2完成。

## 17. 依赖图、Migration 与执行检查点

```text
执行前检查清单 → S1.5-T1 → S1.5-T2（阶段验收）
  → S2-T01（M1 → M2）
  → S2-T02（P3 gate）→ S2-T03
  → S2-T04（已确认硬删除与空标题 → M3）→ S2-T05
  → S2-T06
  → S2-T07 → S2-T08
  → S2-T09 → S2-T10
  → S2-T11
  → S2-T12（渲染依赖批准）
  → S2-T13
  → S2-T14（独立整体验收）
```

上图是推荐串行执行次序；每任务的前置依赖栏是最小依赖，不自动派并行 Agent。
P1/P2已确认，T04不再等待；与T03分别在自己的工作树/数据库并行。共享规则由Lead同步，两个Agent不得同时维护。
P3 已于 2026-10-07 确认为**动态编号**：S2-T02 按「新增/软删/恢复不改其他现存记录编号」实现，
永久删除/改日期/改标题允许重新编号，不新增永久编号字段或 Migration。

Migration当前计划只有T01的M1/M2与T04的M3。先建被引用Folder，再扩Journal，再建新文件表；Daily唯一性按已确认硬删除语义落地，条件仅is_daily=true。P3选择不同方案必须先修此链。
每一份Migration先人工Review，再在隔离数据上升级与检查，最后在明确授权的开发库执行；不把autogenerate结果直接视为正确。

## 18. 验证命令与人工验收顺序

PowerShell，各命令单独运行；按当前授权Task执行。T03只运行前端检查，T04与其独立验收独占seekjournal_test后端检查；不升级个人库。

在backend/：

```powershell
.\.venv\Scripts\python.exe -B -m alembic heads
.\.venv\Scripts\python.exe -B -m alembic current
.\.venv\Scripts\python.exe -B -m alembic check
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests
```

按Task选择相应文件（均为拟新增，任务到达时再创建）：

| Task | 指定pytest文件，命令统一加 `-B -m pytest -q -p no:cacheprovider` |
|---|---|
| T01 | `tests/test_stage2_migrations.py tests/test_test_database.py` |
| T02 | `tests/test_journal_pagination_api.py` 与全部原 `test_journal_*.py` |
| T04 | `tests/test_inbox_api.py tests/test_daily_inbox_api.py tests/test_stage2_migrations.py` |
| T06 | `tests/test_insight_api.py` |
| T07 | `tests/test_folder_api.py` |
| T09 | `tests/test_trash_api.py` |
| T11 | `tests/test_search_api.py` |
| T13 | `tests/test_link_api.py` |

首次/已有新Migration后，在T01/T04获授权且隔离检查通过的前提下：

```powershell
.\.venv\Scripts\python.exe -B -m scripts.prepare_test_db
```

此命令有建库/升级写入效果；不能当只读状态检查。真实开发库的`alembic upgrade head`在迁移Task明确授权后执行，本轮未执行。

在frontend/：

```powershell
npm run build
npm run lint
node --experimental-strip-types src/utils/journalDate.test.ts
node --experimental-strip-types src/utils/journalDetail.test.ts
node --experimental-strip-types src/utils/journalTitles.test.ts
node --experimental-strip-types src/utils/contentValidation.test.ts
node --experimental-strip-types src/utils/dirtyState.test.ts
```

从S2-T02起，S1.5的journalTitles测试验证原修复/显示格式即可；真正跨页编号由后端API测试证明，不能继续依赖前端数组计数。
现有纯逻辑接口重命名时同步文档命令，保留原测试意图，不运行已不存在路径。
期望命令退出0、pytest显示实际 passed；check无待生成操作、heads/current一致。数量不预填。

整体验收顺序：

1. 只读核对branch/HEAD/工作区、四表测试隔离与两个库revision，记录开发库保护摘要。
2. 审核Stage1.5回归及真实迁移保留旧值证据。
3. 三类基础CRUD、输入边界、旧值读取/逐字段修改、空/相同PATCH、持久化。
4. 21条以上分页、排序/筛选变页、跨页Journal号，Daily04:00与无空创建。
5. Folder混合移入/移出/空/回收箱引用限制。
6. Journal/Insight软删/恢复/永删及时间/Folder；Inbox硬删、Daily同日重建。
7. Search跨字段AND、类型/全局分页与回收箱排除。
8. Markdown阅读/源码完整往返、链接单/多/零/改名/删除/代码边界。
9. 所有Dirty出口、失败保留输入、写成功刷新失败、卡片/窄屏；收尾保护与无残留。

## 19. 风险与Review重点

| 耦合 | 必须检查 |
|---|---|
| 编号×分页/Folder/Search/Link | 先完整日期编号再过滤；P3决定永久删除等是否改号，不能把动态display_title当永久ID |
| Soft Delete×onupdate | 显式保留原updated_at；软删/恢复不是内容修改；普通Session.get也不能漏掉deleted检查 |
| Folder×恢复 | Trash引用仍算非空；不能先删Folder再说恢复时移出；锁/FK在同一事务 |
| Daily×清空标题/硬删/并发 | 用inbox_date+is_daily身份；标题清空不改身份；硬删释放唯一键可同日重建，deleted_at不参与索引条件 |
| Markdown×数据验证×旧值 | trim检查不能破坏缩进/空格；输出不收紧旧值；读取HTML不执行；编辑仍是源码 |
| Link×标题变化/重名 | 精确display_title、类型/id分开；旧链接允许失效；无关系自动维护 |
| Search×三表分页 | count/排序/page在合并后；字面通配符处理、title/content每词OR再AND，排除Trash |
| 新表×测试隔离 | prepare/fixture不能仍只看journals；不能清库来满足空基线；清理只用自建typed IDs |
| 新API×旧前端 | T02/T03配套验收，不能把后端API任务通过说成完整Web已通过 |

## 20. 验收记录区

当前状态：**Stage 2 尚未整体验收；T01/T02已完成，T03/T04在各自工作树实施完成且独立验收已通过，尚未提交/合并/集成。本轮个人库只读，起始已处M2，本轮未升级它。**
T14实际执行后在此追加日期、branch/HEAD、命令/退出码/实际数量、A01～A13证据、迁移与开发库保护结果、真实/合成区分、未验证项、用户学习/最终验收情况。
不得提前填“全部通过”。

## 本轮并行执行记录入口（2026-10-08，Lead维护）

- 共同起始HEAD：01bf8a86a875332b590ef6e5c0f0d087ac44c50b。
- T03：SeekJournal-T03，task/s02-t03-journal-ui；只改前端；5175/8013，seekjournal_t03_ui_test；不得运行后端pytest。
- T04：SeekJournal-T04，task/s02-t04-inbox-api；只改Inbox后端/测试/新M3；8014，seekjournal_test；不升级个人开发库。
- 实施Agent不改共享docs/agents；共享规则由Lead从主仓库单一版本同步到两树，并核对SHA256一致。
- 两个实施Agent不得递归启动子Agent，不覆盖他人修改；共享文件需求先报告Lead。
- 独立验收在实施停止后进行，按各自端口/库隔离，T04测试库同一时刻只允许一个测试/验收流程。
- helper/.env/.venv/node_modules/构建产物保持忽略；不启动Compose、不动原服务、不安装或升级依赖。
- 本轮不自动commit/merge/push/tag、删分支、清理工作树；结束报告实际Git状态/服务收尾/数据保护，未集成前不宣称完整Web或Stage2完成。

## S2-T03 / S2-T04 本轮验收结果（2026-10-08，Lead）

- T03：独立build/lint退出0，六份纯逻辑145项，独立浏览器171项；报告见 `s2-t03-acceptance.md`。
- T04：独立指定105、全量481通过；heads/current/check一致；实际HTTP stdout39项；报告见 `s2-t04-acceptance.md`。
- M3实际revision18ecf7e09da6接a8d98342e603，仅seekjournal_test升级；T03专属库与个人库仍M2。
- Lead最终只读确认个人13篇/原字段摘要/revision/sequence未变，两个测试库四表0、临时schema0，11份环境/helper/依赖指纹未变。
- 三仓库HEAD均01bf8a86a875332b590ef6e5c0f0d087ac44c50b，任务源码保留未提交；本轮自建5175/8013/8014已停，原服务PID保持。
- 两项可分别整理commit；本轮不提交/合并/推送。未验证跨任务合并组合，不宣布完整Web或Stage2完成，后续任务未授权。
