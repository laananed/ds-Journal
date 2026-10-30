# C01 独立日程后端 — 独立测试报告

- 角色：WorkBuddy 独立测试者（未参与本轮 C01 后端实现；新对话）
- 时间：2026-10-30 22:20–22:37（GMT+8）
- 用途：C01 后端独立测试，非用户验收、非 Stage 4 整体验收
- 目标库：`seekjournal_test_03`，本轮全部写入限定在自建临时 schema
- 独立性：**执行独立性满足**（独立会话、独立执行，未参与本轮 C01 实现，未读开发者过程对话）；**模型多样性不满足**（与开发者同为 DeepSeek V4.1 Flash，仅换客户端，不构成模型交叉验证）

## 1. 待测基线（与开发交接一致）

| 项 | 实际值 |
|---|---|
| 工作区 | `C:\Programme\demo\SeekJournal-Work-01` |
| 分支 | `wb/s4C01` |
| HEAD | `2e274342d9f87f67491208c6e1568d2badfaafbd` |
| HEAD 树 vs main `ea2287b` | `git diff --name-status ea2287b HEAD` 为空（一致） |
| 已跟踪 diff | 仅 `backend/alembic/env.py` +1 行（注册 `app.schedule.models`） |
| 未跟踪 | 8 个后端文件 + 12 个 C01 前端文件（前端未改动、未清理） |

未跟踪文件 SHA-256 见 `untracked.sha256`（20 行），`tracked.diff`、`git-state.txt` 为同批证据。
测试结束后上述后端文件散列**全部与基线一致**，测试者未修改任何产品代码。

## 2. 数据库守卫与清理

| 检查 | 实测 |
|---|---|
| 进程数据库目标 | `current_database()=seekjournal_test_03`，`current_schema()=public`（只读探针） |
| 既有迁移版本 | public `alembic_version = 4f8e1a3c9d02` |
| public 表 | 12 张业务表 + `alembic_version`，**无 schedules** |
| `ai_usage` | 1 行，测试前后散列一致（未删除、未改写） |
| 其他连接 | 0（`pg_stat_activity` 仅探针自身） |
| 代码唯一 head | `c01a7e421b50`（线性，父 `4f8e1a3c9d02`） |
| 本轮自建对象 | `c01it_<8hex>`（测试）、`c01mg_<8hex>`（降级验证）、`c01chk_<8hex>`（alembic check），均 `DROP SCHEMA … CASCADE` |
| 结果 | 三个 schema 全部删除；public revision/表/行/散列与测试前完全一致 |

Alembic 子进程逐次通过 `select current_database(), current_schema()` 探针，确认迁移只发生在私有 schema（证据见 `run-final.log` 中 `migration.child_process_stayed_in_private_schema`）。

**需如实记录的一次自建残留（已清理）**：首个 psycopg 连接探针误用 URL 查询参数（`options=-csearch_path=`）而未生效，在 public 建出空表 `public.t`。发现后确认其 0 行，执行 `DROP TABLE public.t`，public 表清单恢复为 13 项（12 业务表 + alembic_version），`ai_usage` 仍 1 行。此后连接改为 `psycopg.connect(..., options=…)` 并在每次连接后断言 `current_schema()`。

## 3. 命令与结果

| 命令（backend 目录，`SEEKJOURNAL_TEST_DB=seekjournal_test_03`） | 退出码 | 结果 |
|---|---|---|
| `python -B ../s04-c01-independent/run_indep_tests.py` | 0 | 140 项检查全部 PASS（`run-final.log`、`c01-independent-results-20261030-223500.json`） |
| `pytest -q -p no:cacheprovider tests/test_c01_schedules.py tests/unit/test_c01_schedule_contract.py` | 0 | 4 passed（复跑开发者自测，`dev-selftest.log`） |
| `pytest -q -p no:cacheprovider tests/test_stage2_migrations.py` | 1 | 1 failed, 10 errors（`migration-regression.log`） |
| `alembic check`（私有 schema，head） | 非 0 | 唯一 diff：`remove_index ix_schedules_starts_at_id`（`alembic-check.log`） |

独立测试通过真实 uvicorn 进程 + 真实 HTTP + 真实提交（非 savepoint 回滚），测试专用应用只挂载 `app.schedule.router` 并复用 `app.main` 中同一份 `WritingError` / `RequestValidationError` 处理器。

### 已覆盖

- 分页：每页 20、`has_next`（21 行→True、恰 20 行→False、越界页→空且 False）、按 (`starts_at`,`id`) 稳定排序、跨页无重复、`page=0/-1/abc/1.5`→422。
- 详情：200 与字段集合、404、非整数 id 422、GET（详情/列表/404）零写（`xmin` 不变 + `pg_stat_user_tables` 不增长 + `updated_at` 不变）。
- 创建：201、`revision=1`、`timestamptz` 存储、UTC 偏移 0、Asia/Shanghai 回显 09:00、`created_at==updated_at`。
- 标题：80 码点（含 CJK / 星际平面 emoji）通过、81 拒绝、空白/空串/缺失 422。
- 时间：naive、数值 epoch、非法字符串、缺失→422；`ends_at` 等于/早于 `starts_at`→422；`ends_at=null`→201；省略 `ends_at` 键→422。
- 字段：`completed` 非布尔、多余字段、非法 UUID、`title` 非字符串→422；缺 `completed`/`client_create_id`→422。
- 幂等：同键同 payload→同一 id、不增版、不改 `updated_at`、单行（重放 200）；同键不同 payload→409 且不新增行；同一时刻不同偏移的等价 payload→同一行。
- PATCH：缺 `expected_revision`→428；null/0/字符串/超 bigint→422；无变化（含时间同值、同一时刻不同偏移）→200 且 revision/`updated_at`/`xmin` 均不变；实际变化→+1 版且 `updated_at` 前移并落库；清空 `ends_at`→+1；越过结束时间边界→422 且行不变；未知字段/空 body/`title=null`/81 码点/空白→422；404。
- 并发：两路同版本 PATCH→一个 200、一个 409，仅 +1 版；同键同 payload 并发创建→同一行（201+200），单行；同键不同 payload 并发→201+409，单行。
- DELETE：缺 If-Match→428；未加引号/非数字/`"0"`/空→422；过期→409 且行仍在；404；成功 204 且响应体为空、物理行消失、相邻行保留；重复删→404；无软删列。
- 独立于 Set/End：完整 CRUD（含 `completed` 切换）后 journals/insights/folders/ritual_*/ai_* 各表行数不变；`schedules` 无任何外键；日程模块不导入 ritual/journal/link。
- 持久化：新建连接可见；真实进程重启后（停旧 uvicorn、起新进程）GET 仍返回同一行。
- 迁移：私有 schema 内 `upgrade head` 成功、有数据时 `downgrade` 被拒绝、清空后 downgrade 删表、再 upgrade 恢复。
- 正式入口：`app.main` 路由表与 OpenAPI 均**无** `/api/schedules`。

### 未覆盖 / 未验证

- 正式 `app.main` 入口联调（未注册，本轮未获授权修改 `main.py`）。
- 前端联调、`App.tsx` 接线、浏览器端时间显示（前端文件属他人，未改动）。
- 真实模型调用、建议端点、情绪推测契约（API §13 明确尚未定义，模块内也不存在相关代码）。
- 真实开发库 `seekjournal` 升级、`seekjournal_test`/`_02`/`_04`（未接触）。

## 4. 结论与问题

**独立测试技术结论：通过（后端契约行为符合 API §13 已定义部分），伴随 1 项产品缺陷与若干契约/守卫缺口，需开发者与 Codex 处理后才可谈整合。**

1. **产品缺陷（开发者处理）— 模型与迁移的索引漂移**：迁移 `c01a7e421b50` 建了 `ix_schedules_starts_at_id`，但 `app/schedule/models.py` 的 `__table_args__` 只有 CheckConstraint，未声明该索引。后果：`alembic check` 非 0，提示 `remove_index`；既有守卫 `tests/test_stage2_migrations.py` 因此整体失败。修复方向（列给开发者，不自改）：在模型补 `Index('ix_schedules_starts_at_id', 'starts_at', 'id')`，或从迁移移除该索引，二者择一保持单一事实来源。
2. **集成守卫未同步（Codex / 迁移链 owner）**：`test_m3_extends_m2_and_original_migrations_are_byte_unchanged` 断言链尾为 `4f8e1a3c9d02`，`EXPECTED_TABLES` / `conftest.BUSINESS_TABLES` 也都不含 `schedules`。新 head 合入前必须由 owner 同步这些守卫，否则“测试无残留”护栏对新表是盲区。
3. **API §13 未定语义（需用户/Codex 决定，测试者不替代）**：
   - 删除后复用同一 `client_create_id`：实测**新建一行、新 id、revision=1**（201）。§13 未说明删除后该键是否可复用、是否应 409/404，属未解决契约问题。
   - 重放状态码：新建 201、同键重放 200；§13 只要求“返回同一资源”，未固定状态码。
   - `ends_at` 虽然是可空字段但**必须出现**（省略键→422）；前端当前总是发送（含 null）故未破，但契约未写明“键必填”。
   - 数据库 `title` 为无长度约束 `text`，80 码点仅在 API 层强制；契约未要求 DB 侧约束，仅记录。
4. **正式入口不可用**：日程路由未注册到 `app.main`，因此当前前后端**未接通**；本次专用测试应用不构成接通证据。若后续授权临时入口，应登记范围与清理方式。

## 5. 收尾

- Git：`## wb/s4C01`，HEAD `2e27434` 未变；仅新增未跟踪证据目录 `s04-c01-independent/`；产品文件散列与基线一致；无 pyc / `__pycache__` 残留；未 commit / merge / push / 切分支 / 清理 worktree。
- 数据库：无 c01* schema（`pg_namespace` 仅 `public`）、public 无 schedules、revision `4f8e1a3c9d02` 与 `ai_usage` 1 行均未变；其他连接 0。
- 服务进程：本轮自建 uvicorn 均以临时端口启动并终止，无残留。`127.0.0.1:8000` 的 uvicorn 为**既有进程**（PID 48852，启动于 10:12:47，工作目录 `C:\Programme\demo\SeekJournal\backend`，非本工作区），不属于本轮任何操作，未接触、未终止。
- 文件：`run_indep_tests.py`（编排+断言）、`c01_test_app.py`（测试专用应用）、`probe_db.py`、`debug_*.py`（环境问题定位留档）、日志与 JSON 结果。

## 6. 验收对照（§6 统一清单）

| §6 检查 | 本轮证据 | 状态 |
|---|---|---|
| 需求与范围 | 行为逐条映射 API §13 已定义部分；未改 `main.py`、未动前端/T06/T09/T10/App.tsx；无擅自扩张 | 符合 |
| 测试与回归 | 自建编排 140/140 PASS（退出码 0）；开发者自测复跑 4 passed；既有迁移回归 1 failed + 10 errors（缺陷归因见 §4-1） | 通过，含 1 产品缺陷 |
| 架构与重复 | 复用 `WritingError`/`RequestValidationError` 处理器，未复制实现；`schedules` 无跨模块外键、模块无 ritual/journal 导入 | 符合 |
| 数据与环境 | 迁移仅在私有 schema；public 结构/版本/行数散列前后一致；测试对象 manifest 与清理已记录；自建服务已收尾 | 符合（含 §2 已披露的一次自建误建表并清理） |
| 文档 | §13 未定语义（删除后键复用、重放 200/201、`ends_at` 键必填）已列待 owner 决定；本报告不改权威文档 | 待 owner |
| Git 与 Worktree | `wb/s4C01` HEAD `2e27434` 未变；无 commit/merge/push/切分支/清理 worktree；产品文件散列 20/20 一致 | 符合 |

**风险项需 Codex 审核（未完成不得宣布验收）**：① 模型/迁移索引漂移修复后的复审（含 `alembic check` 与迁移回归转绿）；② 迁移守卫（链尾、`EXPECTED_TABLES`、`BUSINESS_TABLES`）同步；③ §13 上述三处语义裁定；④ 若授权，将 `schedule.router` 接入 `app.main` 后的入口联调。

**下一手（交开发者）**：修 `models.py` 索引声明 → 复跑 `alembic check` 与 `tests/test_stage2_migrations.py` → 回报后由独立测试者做定向复测（无需重跑全量）。
