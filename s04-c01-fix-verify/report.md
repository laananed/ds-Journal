# C01 日程后端「模型／迁移索引一致性修复」— 独立定向测试报告

- 角色：独立测试者（WorkBuddy 执行端）。**未参与本次修复**，未修改产品代码、迁移或共享守卫。
- 时间：2026-10-31 10:17～10:45（GMT+8）。
- 用途：C01 索引修复的**定向复测**，不是 C01 整体验收、不是 Stage 4 验收，也不代表用户接受。
- 独立性：**执行独立性满足**（独立会话、独立执行、未参与实现、未读开发者过程对话）；**模型多样性不满足**（与开发者同为 DeepSeek V4.1 Flash，仅换客户端，不构成跨模型交叉验证）。
- 结论速览：**索引修复通过｜整体 `alembic check` 在该私有 schema 内通过｜迁移守卫问题仍存在（且范围大于开发交接所述）**。

## 1. 基线（实测，非引用）

| 项 | 实测值 |
|---|---|
| 工作树 | `C:\Programme\demo\SeekJournal-Work-02` |
| 分支 | `wb/c01-test` |
| HEAD | `4d9960c9286b134e6367f3411e5c719d2bbc7ffb`（`fix(schedule): align model index with migration`） |
| HEAD tree | `c68248ab6d2821f5886d93aa0584be71b35dc28b` |
| 暂存／未暂存 | 空（`git status --porcelain` 仅本报告目录的未跟踪证据） |
| 其他 worktree | `SeekJournal` = `df8c41e [codex/Ritual]`；`SeekJournal-Work-01` = `2a454d5 [codex/t01-check]`（未接触） |

**与开发交接不一致（须记录）**：交接写的候选 HEAD 是 `d939ee5…`，实际 HEAD 是 `4d9960c…`。核对 `git log`/`reflog`：`4d9960c` 的父提交正是 `d939ee5`，提交时间 2026-10-31 10:17:24，`git diff --stat d939ee5 4d9960c` 只有本次修复的两个文件（+19/−2）。即交接快照早于修复提交，待测基线应为 `4d9960c`。本次全部结论基于 `4d9960c`，且测试前后 HEAD、tree、文件散列完全一致（见 §6），期间未观察到写入。

待测文件 SHA-256（测试前 = 测试后）：

| 文件 | SHA-256 |
|---|---|
| `backend/app/schedule/models.py` | `4c8cd387…bf9fb2a9` |
| `backend/tests/unit/test_c01_schedule_contract.py` | `34f654d4…dbe8b03c` |
| `backend/alembic/versions/c01a7e421b50_create_schedules.py` | `e42382c9…895395f5` |

## 2. 数据库与迁移基线

用户提示词未点名具体库，本轮按「白名单登记库 + 实际独占 + 私有 schema」自主选定并留下依据：

| 库 | 其他连接 | revision | 关键数据 | 本轮是否写入 |
|---|---|---|---|---|
| `seekjournal_test` | 0 | `9e7a6c42d011` | ai_usage 0 | 否 |
| `seekjournal_test_02` | 4（他人活动） | `c01a7e421b50` | schedules 0 行 | **否**（只读探针；测试结束时该库的连接/schema 变化来自其他执行者） |
| `seekjournal_test_03` | **0（独占）** | `4f8e1a3c9d02` | **ai_usage 1 行（既有匿名 usage）** | **是，但仅限自建 schema** |
| `seekjournal_test_04` | 0 | `4f8e1a3c9d02` | journals 54 / ai_usage 47 | 否 |

- 选定 `seekjournal_test_03`：白名单内、0 其他连接、public 无 `schedules`；其 `ai_usage` 1 行按 `docs/c01-followups.md` 要求保留。
- 每次连接实测 `current_database()=seekjournal_test_03`；Alembic 子进程另用探针实测 `('seekjournal_test_03', 'c01fx_b22d5ccd')`，证明迁移落在私有 schema 而非 `public`。
- 代码唯一 head：`c01a7e421b50`（链长 8，线性，`get_heads()` 仅一项）。
- manifest：`manifest.json`（创建对象仅 schema `c01fx_b22d5ccd`；未启动任何服务）。
- 清理：`DROP SCHEMA c01fx_b22d5ccd CASCADE`，已核验 `pg_namespace` 不存在该 schema；`public` 前后快照（revision / 表清单 / ai_usage 行数与 md5）完全一致。

## 3. 索引修复的独立复核（不采信开发者结论）

从三个互相独立的来源比对，未使用开发者新增的断言作为结论依据：

| 来源 | 实测 |
|---|---|
| `Schedule.__table__.indexes`（SQLAlchemy metadata） | 唯一索引 `ix_schedules_starts_at_id`，table=`schedules`，列=`['starts_at','id']`，`unique=False`，无 `postgresql_where`（非部分索引）、无自定义 `using`（默认 btree） |
| 迁移 `c01a7e421b50`（AST 解析 `op.create_index`） | 名称/表/列 = `ix_schedules_starts_at_id` / `schedules` / `['starts_at','id']`，无额外 kwargs；`downgrade` 对应 `drop_index` 同名 |
| 真实 DDL（私有 schema 内 upgrade head） | `CREATE INDEX ix_schedules_starts_at_id ON c01fx_….schedules USING btree (starts_at, id)`；另保留 `schedules_pkey(id)`、`schedules_client_create_id_key(client_create_id)` 唯一索引 |

- 查询与索引对应：`router.list_schedules` 为 `order_by(Schedule.starts_at, Schedule.id)` + `limit(21)/offset((page-1)*20)`，AST 实测列序 `['starts_at','id']`，与索引列序一致；`starts_at` 为 `NOT NULL`，无 NULL 排序歧义，`id` 为唯一列，分页排序键稳定。
- 修复前状态（证据 `models-before-fix-d939ee5.py` + `mutation-prefix-check.log`）：`d939ee5` 的模型 `__table_args__` 只有 `CheckConstraint`，实测 `prefix_indexes = []`，即开发者新增的那条断言在修复前会失败——**缺陷真实存在，修复确实改变了行为**，不是弱断言凑绿灯。
- 未改动迁移：`c01a7e421b50` 文件散列测试前后一致，`downgrade` 的拒绝逻辑（有数据即报错）保留。

## 4. 命令与退出码

工作目录 `C:\Programme\demo\SeekJournal-Work-02\backend`，统一 `SEEKJOURNAL_TEST_DB=seekjournal_test_03`、`PYTHONDONTWRITEBYTECODE=1`、`python -B`。

| # | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 1 | `pytest -q -p no:cacheprovider tests/unit/test_c01_schedule_contract.py` | 0 | **3 passed** |
| 2 | `pytest -q -p no:cacheprovider tests/test_c01_schedules.py` | 0 | **2 passed**（私有 schema 真实 HTTP + 提交） |
| 3 | `python ../s04-c01-fix-verify/probe_metadata.py` | 0 | metadata / 迁移 AST / order_by / 链 全部一致 |
| 4 | `python ../s04-c01-fix-verify/alembic_private_schema_check.py` | 0 | 私有 schema `upgrade head` 成功；**`alembic check` 退出码 0，输出 `No new upgrade operations detected.`，全文无 `ix_schedules_starts_at_id`**；`alembic current` = `c01a7e421b50 (head)` |
| 5 | `pytest -q -p no:cacheprovider tests/test_stage2_migrations.py` | 1 | **3 failed, 8 passed**（守卫过期，见 §5） |
| 6 | `pytest -q -p no:cacheprovider tests/test_stage3_migrations.py` | 1 | **2 failed**（同类守卫过期，见 §5） |
| 7 | `pytest -q -p no:cacheprovider "tests/test_s4_db.py::test_migration_preserves_old_data_and_refuses_lossy_downgrade"` | 1 | **1 failed**（硬编码 `4f8e1a3c9d02`，见 §5） |

对比上轮独立测试（`s04-c01-independent/report.md`）：此前 `alembic check` 非零且 `test_stage2_migrations.py` 为 1 failed + 10 errors。本轮**不再出现 errors**（`migration_check` fixture 内部的 `alembic check` 已通过），只余断言层失败——这正说明索引漂移已消除，剩余失败是守卫未同步。

## 5. 迁移守卫问题（**仍存在，未修复**）

失败均属「测试假设/守卫未同步新 head」，**不是**索引修复引入的产品缺陷；但会掩盖真实回归，必须由守卫 owner（Codex）处理。测试者未修改任何守卫，也未删除断言。

1. `tests/test_stage2_migrations.py::test_revision_chain_is_single_head_and_unchanged_base`：`chain` 断言硬编码到 `4f8e1a3c9d02`，实际多出 `c01a7e421b50`。→ **链尾断言未同步**。
2. `tests/test_stage2_migrations.py::test_only_expected_tables_exist`：`EXPECTED_TABLES` 缺 `schedules`，实际多出该表。→ **`EXPECTED_TABLES` 未同步**。
3. `tests/test_stage2_migrations.py::test_m3_extends_m2_and_original_migrations_are_byte_unchanged`：`chain[4:]` 少一项。
4. `tests/test_stage3_migrations.py::test_stage3_has_one_new_linear_migration_after_m3`：断言 `4f8e1a3c9d02 == 3aa16300a58a`（硬编码阶段 3 尾）。
5. `tests/test_stage3_migrations.py::test_stage1_m3_s3_preserve_all_existing_fields_and_sequences`：`pg_sequences` 快照多出 `schedules_id_seq`（序列守卫未覆盖新表）。
6. `tests/test_s4_db.py::test_migration_preserves_old_data_and_refuses_lossy_downgrade`：降级被拒后断言版本为 `4f8e1a3c9d02`，实际停在 `c01a7e421b50`（断言应改为「版本不变」，而非硬编码旧 head）。
7. **`BUSINESS_TABLES` 未同步（守卫盲区，不会报红）**：`scripts/prepare_test_db.py` 与 `conftest.py` 的 `BUSINESS_TABLES` 均不含 `schedules`，因此 `api` fixture 的「无残留」断言和 prepare 脚本的「非空拒绝」对 `schedules` 完全失效——绿色不代表新表零残留。
8. **同类盲区**：`test_stage2_migrations.py` 的 `test_database_matches_model_metadata` 断言 `set(Base.metadata.tables) == EXPECTED_TABLES` **本轮通过**，只是因为该模块没有导入 `app.schedule.models`，`Base.metadata` 里本就没有 `schedules`；这条断言对 C01 新表既不校验也不报警。

## 6. 收尾复核

| 项 | 结果 |
|---|---|
| HEAD / tree | `4d9960c` / `c68248ab…`，测试前后一致 |
| 关键文件散列 | 6/6 与测试前一致（含 `conftest.py`、`prepare_test_db.py`、`test_stage2_migrations.py`） |
| 工作区 | 仅新增未跟踪目录 `s04-c01-fix-verify/`；无 `__pycache__`、无 `.pyc` |
| 数据库 | `seekjournal_test_03`：0 连接、仅 `public`、revision `4f8e1a3c9d02`、`ai_usage` 1 行、无 `schedules` —— 与测试前基线**完全一致** |
| 服务 | 本轮未启动任何 uvicorn/FastAPI 进程，无需停止 |
| Git 权限 | 未 commit / merge / push / 切分支 / 清理 worktree；`seekjournal` 个人库全程未连接 |

## 7. 结论与限制

- **索引修复：通过**（模型与迁移的名称/表/列序/唯一性/方言行为一致，真实 DDL 与 `alembic check` 双证）。
- **整体 `alembic check`：在 `seekjournal_test_03` 私有 schema、head `c01a7e421b50` 下通过（退出码 0，无差异）**，先前 `remove_index: ix_schedules_starts_at_id` 已消失，且没有其他模型/迁移差异残留。限定：未在 `public` 或真实库验证，未覆盖其他库的既有状态。
- **迁移守卫：仍存在**（8 处，见 §5），其中 6 处会报红、2 处是静默盲区；因此 `pytest tests/test_stage2_migrations.py`、`tests/test_stage3_migrations.py`、`tests/test_s4_db.py` 整体仍非绿。
- 未验证（不因本报告视为通过）：`app.main` 未注册 `/api/schedules`（正式入口仍不可用）；前端/浏览器链路；API §13 未定语义（删除后键复用、重放 200、`ends_at` 键必填）；全量 pytest；真实库升级。
- 需 Codex 审核的风险项：① 上述守卫同步（含 `BUSINESS_TABLES` 与 phase-3/`s4_db` 断言）；② 索引修复的整合与 after-merge 复核；③ §13 语义裁定。

## 8. 证据清单（本目录）

`git-baseline-before.txt` / `git-baseline-after.txt`、`db-baseline-before.json` / `db-baseline-after.json`、`metadata-probe.json`、`alembic-verify-results.json`、`alembic-check.log`、`alembic-upgrade-head.log`、`alembic-current.log`、`alembic-child-schema-probe.log`、`pytest-*.log`、`guard-gap.txt`、`models-before-fix-d939ee5.py`、`mutation-prefix-check.log`、`manifest.json`、以及本报告 `report.md`。
