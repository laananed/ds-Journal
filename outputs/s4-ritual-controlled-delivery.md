# S04 T10 Ritual 受控插入 / Set 目标创建 — 开发续做交付

日期：2026-10-31　　角色：WorkBuddy Developer（续做 Codex 未提交成果）
状态：**开发自测完成、已停写；独立测试、Codex 风险审核、用户接受均未进行。不构成 T10 或 Stage 4 验收。**

## 1. 任务与授权

用户批准新增受控问题插入 `POST /api/rituals/{id}/questions` 与 Set 目标创建 `POST /api/rituals/{id}/goals`（契约见 `docs/stage4-api.md` §4「2026-10-31 受控创建补充」）。本轮接手该未提交成果，审查身份归属、事务、CAS、模板并发、受保护节点、写队列与关联路径后继续实现。

未做：App.tsx 正式入口接线、依赖安装、迁移、真实库/服务、Git 写入。

## 2. 基线与工作区

| 项 | 值 |
|---|---|
| 工作目录 | `C:\Programme\demo\SeekJournal` |
| 分支 / HEAD | `codex/Ritual` / `df8c41ec85822b6422f81b5428e3d042daf9c9a5`（与交接一致，HEAD 未变） |
| 暂存区 | 空 |
| 未暂存 | 12 文件 +240/−38（含 Codex 原有 diff 与本轮增补） |
| 未跟踪 | 见 §7 |
| 其他 worktree | Work-01 → `codex/t01-check` @`2a454d5f`；Work-02 → `wb/test` @`72d9eb41`（本轮未进入、未改动） |

## 3. 结果摘要

已实现：

- 受控问题插入：服务端持「业务日锁 → 文件行锁 → 模板行锁」顺序，校验 `expected_revision`、`expected_template_revision` 与问题归属，服务端生成节点 ID/答案段落，把**当时模板文字快照**追加到正文末尾；模板后续改动不回写已插入内容。
- 受控目标创建：仅有效 Set；从**已保存文档**定位顶层 `taskList` 中指定 `taskItem`，转换为 `goalItem`（新 `node_id` + 稳定 `goal_id`，保留文字与勾选），多项清单在转换处拆分且前后身份/顺序保留；不创建 End、不建 link。
- 普通 Set 正文写入禁止**新增** `goalItem`（`require_existing_goals`，422）；普通 Writing/Insight 写入既不能新增 `goalItem` 也不能新增 `ritualQuestion`（`validate_author_changes` 受保护节点）。
- 事务：任一校验/构造/投影失败 → `rollback`，零写；阅读投影超限在写 row 之前失败。
- 前端：`api/rituals.ts` 新增两个受控命令封装（复用既有 `write()` 与 `JournalApiError.code`）；RitualPage 插入/转换走应用级写队列 `runFileCommand`（先保存用户正文、再过 CAS、再应用 FileMutation）；`types/ritual.ts` 的 ops 补齐 `node_id`/`nodes`；删除现在已失真的 `QUESTION_INSERT_AVAILABLE=false` 及其说明。
- 状态码：缺版本 428；显式 null／额外字段／坏 UUID 422（错误体不回显提交值）；版本过期、问题归属不符、重复提交 409；文件缺失/软删/类型不符 409 `source_unavailable`（与 `create_links`/`update_goal` 对齐，原为 422 `Ritual unavailable`）。
- 重放：不新增幂等表（架构 §5）。同一请求按旧 `expected_revision` 重发必然 409，不会产生第二个节点；客户端不自动重发，409 提示先核对服务器内容。

未实现 / 未覆盖（详见 §6）：产品 §7「Set 文字转 Checklist 后即形成目标」的**自动**语义；带格式、评论、嵌套条目的转换；App 正式入口；真实库/HTTP/浏览器/并发/故障注入验证。

## 4. 关键判断（供审查）

1. **格式/评论/嵌套只能拒绝**：schema 1 的 `goalItem` 属性仅 `id/goal_id/text/checked`（API §2.1），装不下 Mark、评论 ID 或子块。转换时丢弃即为静默毁数据，故 `convert_ritual_task_item` 一律拒绝并保留原文；前端 `checklistCandidates` 用同一口径过滤，避免「点了才报错」。
2. **空白草稿**：受控命令只对已存在且已转换的 Ritual 生效（API §4 明文）。写队列在执行前先保存用户正文，因此有可保存内容时会先落库再插入；完全空白时不创建空 Journal（产品 §4「点击插入空问题模板，不创建空 Journal」），页面提示「请先写入并保存正文」。
3. **命令在途的较新草稿**：`narrowOps.mergeNarrowOps` 不合并 `copy_nodes`，因此「命令期间继续输入」的结果是**冲突**而非覆盖：服务器已提交、本地草稿逐字保留、本地基线版本不推进。符合 API §4「不能安全应用则保留草稿进入冲突」。若日后决定窄合并纯插入，需 T02/T09 会话核心变更（本轮未改该文件）。
4. **模板锁顺序**：`update_template` 只锁模板行、不取日锁，因此「日锁 → 文件 → 模板」不会与它形成环。

## 5. 验证（自测）

```text
# 后端（无数据库）
cd backend
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/unit
→ 65 passed, 14 subtests passed（接手时 47 passed / 14 subtests）
.\.venv\Scripts\python.exe -B -m unittest tests.unit.test_s4_controlled_http \
    tests.unit.test_s4_controlled_command tests.unit.test_s4_ritual_controlled_nodes
→ Ran 28 tests, OK

# 前端纯逻辑（无框架、无 DOM）
node --experimental-strip-types src/utils/ritualControlled.test.ts   → 13 项
node --experimental-strip-types src/state/controlledMutation.test.ts → 18 项
node --experimental-strip-types src/utils/ritualView.test.ts         → 132 项（原 133，删 1 条已失效断言）
全量 src/**/*.test.ts：39 个文件通过，1 个失败
  FAIL src/editor/documentProjection.test.ts → ERR_MODULE_NOT_FOUND '@tiptap/core'（缺依赖，非本轮改动）

npm run lint → 0 errors, 20 warnings（均在既有代码行，无一条来自本轮新增代码）
npm run build → 退出 1，102 个 TS 错误
  TS2307×21：@tiptap/{core,pm/model,pm/state,pm/view,react,starter-kit,extension-list,extension-unique-id} 未安装
  TS7006×59 / TS7031×21 / TS2591×1：上述模块缺失导致的隐式 any 与 node 类型缺失
  本轮改动文件（RitualPage/api/rituals/types/ritual/ritualView/ritualControlled/controlledMutation）无类型错误
```

本轮新增/扩展的断言（无数据库）：

- 问题插入：追加到末尾、原节点与 Mark 不变、快照取自模板、空快照拒绝、重复 node_id/结构合法性经 `validate_document`。
- 目标转换：保留前后项与勾选、拆分后前半保留原清单身份、后半新身份、带格式/评论/嵌套/无勾选状态全部拒绝。
- 受保护节点：普通 `document_content` 无法新增 `goalItem` / `ritualQuestion`，同路径仍可正常编辑用户段落。
- 命令失败语义：缺版本 428、显式 null 422、坏 UUID 422、额外字段 422、文件版本过期 409、模板版本过期 409、问题归属不符 409、文件缺失 409 `source_unavailable`、End 上创建目标 422、清单条目不存在 422。
- 重放：同一 `expected_revision` 第二次调用 409 且 `_write_doc` 仅执行一次。
- 回滚：`_write_doc` 在投影超限时不改 `revision`/`content_doc`/`content`；写失败时 `commit` 未调用、`rollback` 调用一次。
- 写队列：无较新输入 → 整篇采用（版本+1、问题节点进入草稿）；有较新输入 → 冲突、版本不推进、较新文字逐字保留、不把未合并节点塞进草稿；`base_revision` 不符 → 冲突；未打开的文件 → 记入 `ignoredSessions` 不影响其他会话。
- OpenAPI：`/api/rituals/{journal_id}/questions`、`/api/rituals/{journal_id}/goals` 均已注册（`app.openapi()['paths']`）。

## 6. 对照验收逐项状态

T10（`docs/stage4-tasks.md` §3.11）：

| 验收点 | 状态 |
|---|---|
| 全前端「开始今天／结束今天」命名 | 未验证（本轮未改、未跑浏览器） |
| 左右上下文只当前模板、最多四问 | 模板 0–4 上限有 schema 级证据（纯测试）；页面展示未验证 |
| 点击插入 | 服务端与页面已接线；无 DB 的 HTTP 形状/状态码通过；真实 HTTP→PG→浏览器**未验证** |
| 改模板不回写历史正文 | 快照复制语义有单测；端到端未验证 |
| 历史有效正文可改 | 未验证（本轮未改动该路径） |
| 两种 Ritual 完整替换／手动复制／取消零写 | 未验证（T04 既有实现，本轮未动） |
| 无自动合并 | 通过（算法层：不做 copy_nodes 窄合并，冲突保草稿） |
| 删除解除关联且 End 快照／回答保留 | 未验证（T07 既有，需数据库） |
| 恢复不自动重连 | 未验证（同上） |
| CAS／重读失败保本地草稿 | 算法层通过；HTTP 层未验证 |
| 跨 04:00 保持输入与捕获日期 | 未验证（本轮未触达） |

产品 §7 / S4-A07：

| 验收点 | 状态 |
|---|---|
| Set 中 Checklist 形成带稳定 `goal_id` 的目标 | 已实现（显式命令），单测覆盖身份生成 |
| 其他 Journal/Insight 的 Checklist 不自动进入 Set | 通过（普通写入无法创建 `goalItem`，已测；页面只在 set 渲染转换入口） |
| 未加入 End 零同步 | 保持（`create_links` 未改，仅显式调用） |
| 文字/完成状态双向同步、回答不变、删除解除、恢复不重连 | 未验证（T07 既有代码未改，需数据库回归） |
| 「文字转换为 Checklist 后形成目标」的自动语义 | **未实现**：改为显式「转为目标」命令，依据 2026-10-31 已批准 API §4 |

T04 相关（模板 CAS、每日唯一、两种恢复）：本轮未改动其行为，未复验。

## 7. 问题与遗留

需要 Codex / 用户协调：

1. **产品 §7 自动语义 vs 已批准显式命令**：产品原文是「开始今天内普通用户文字转换为 Checklist 后形成目标」。已批准的 API §4 是显式 `POST .../goals`。若产品要求「勾成 Checklist 即成为目标」，需新增「普通 Set PATCH 中把 taskItem 变成 goalItem」的受控路径或改 Schema —— 属契约变更，本轮未擅自实施。
2. **格式/评论/嵌套清单无法覆盖**：受 `goalItem` 只有 text/checked 限制。若要覆盖，需要 Schema 扩展（例如允许目标带 Mark 或子块），属 T01 级契约变更。
3. **`source_unavailable` 语义**：文件缺失/软删由 422 `Ritual unavailable` 改为 409 `source_unavailable`（与既有目标命令一致），若文档需要明确记录请 Codex 决定是否补一句。
4. **共享文件改动待审**：本轮改到 `frontend/src/api/rituals.ts`、`frontend/src/types/ritual.ts`、`frontend/src/utils/ritualView.ts`(+test)（T04/T10 边界）——均为追加或删除已被替代的死代码，未改公共入口、写队列核心、编辑器扩展。`state/editSessions.ts`、`state/narrowOps.ts`、`App.tsx`、`WritingDraftRecovery`、C01 相关文件均未改。
5. **`docs/stage4-t10-followups.md` 旧结论已过期**：其中「后端缺受控 `ritualQuestion` 插入及 `goalItem` 创建能力…按钮保持禁用」已被本轮取代；同文件 2026-10-31 条目仍成立（实现中、缺真实验证）。文档归 Codex，本轮未改。

必须由后续轮次补齐：

- App.tsx 正式 Ritual 路由接线 → 真实用户入口。
- 依赖（@tiptap/* 6 包 3.32.1、node 类型）恢复后跑 build/lint 与真实浏览器。
- 隔离测试库独占窗口：两种 Ritual 插入、0/4/5 问、模板改动后快照不变、目标创建、过期版本、重复/丢响应、SQL 故障注入、关联后同步/删除解除/恢复不重连、命令在途继续输入。
- 缺 End 的 `end_id=null` 仍 fail-closed 422（本轮未改，已确认代码路径未变）。

## 8. 收尾与资源

- 分支/HEAD 未变：`codex/Ritual` @ `df8c41ec85822b6422f81b5428e3d042daf9c9a5`；未 commit / merge / push / tag / 切分支 / 清理 worktree。
- 本轮未读 `.env`、未连接数据库、未启动服务、未执行迁移、未触发任何付费调用；**未在数据库创建任何对象**，无需清理。
- 未跟踪文件（全部）：

```text
backend/app/ritual/controlled.py
backend/tests/unit/test_s4_controlled_command.py
backend/tests/unit/test_s4_controlled_http.py          ← 本轮新增
backend/tests/unit/test_s4_ritual_controlled_nodes.py
frontend/src/state/controlledMutation.test.ts          ← 本轮新增
frontend/src/utils/ritualControlled.test.ts
frontend/src/utils/ritualControlled.ts
outputs/s4-ritual-controlled-handoff.md                ← 上一轮交接
outputs/s4-ritual-controlled-delivery.md               ← 本文件
```

- 交付文件 SHA-256（本轮结束时实测）：

```text
398eaaa9f15b25799eb7ace8fe064efb23496556b7df9848f244526623233494  backend/app/ritual/controlled.py
aa3f1ff362b9171846ccd71d1310d238778d6ce5033905010063a3d1fe9d2c4f  backend/app/ritual/goals.py
14476baad937eb84ef438cdbc1d3ddc654a277447b2a24bb38390e31e1edeccb  backend/app/ritual/router.py
f6e47ac528943a05f673f7796a51ad1c2b7644a47eb0955e1c79b6ee10932b97  backend/app/ritual/schemas.py
bb7e13aa4cc92781aa862a8c7998eee879d1831733f131c791a709a2dfedad37  backend/app/writing/documents.py
f8e9e596cb366d701eda755e1cdaee7901c24e12021e769aa7c44f454115c9b2  backend/tests/unit/test_s4_controlled_command.py
57a2404bdaa6891b518c105d8b69326bd3447deed6bf161a6fefe40f4df130b0  backend/tests/unit/test_s4_controlled_http.py
0da7f0474b1b18125a0c514f739413da428aff5c9d3f02b62d7bea767cbc1c77  backend/tests/unit/test_s4_ritual_controlled_nodes.py
171fe7f2a38a87c97c223e4ac597da087439ed146314b349308a71d0d4cfd9eb  frontend/src/api/rituals.ts
426ebac4a2df03f1d0bfa6fe976c10d3308d07926c6780efb6abc799780d53b8  frontend/src/types/ritual.ts
2c8607b201d847fa36a7a63a29b8315a30d48c901ba19363cbaf4a6e32dfd43f  frontend/src/pages/RitualPage.tsx
d661f1a35111d6bf9fccaff189a765ae602c1275e4d93a1a06b246ae9b1111d5  frontend/src/utils/ritualControlled.ts
7c5434d417b257f9df6b0c7882a7f8f2a62d0f648308d00b4cd11e9fe1234db8  frontend/src/utils/ritualControlled.test.ts
67be1f95d9fa9f2e94e330db2fd530df68182286694a42a6765bc9340a637055  frontend/src/utils/ritualView.ts
5af96046df11a918cd97fe3c14c35c64bac18de4dba0c0b112ebe3c66383fb2b  frontend/src/utils/ritualView.test.ts
bd701ad6120f0b1e4706067c6c5dcea62b6c8e22adc0866901687964eaba71ee  frontend/src/state/controlledMutation.test.ts
666bf6c3ebcd3aa9d9adb2dcfdc5b4de5e9eada67dcd0e455859fcce2bb11ce4  docs/stage4-api.md（未改，与交接一致）
e23ca8ed4132c2c31924d918c098756fa6ce1e120105b821ae9d96ecfcb4c2a0  docs/stage4-architecture.md（未改，与交接一致）
323dc4f722e846b95b981e661a5fcf4f7dbcec72fb76e03a185323d7142a3d6b  docs/stage4-t10-followups.md（未改，与交接一致）
```

## 9. 状态

| 环节 | 状态 |
|---|---|
| 开发实现 | 本轮范围完成，已停写 |
| 开发者自测（无 DB） | 完成，见 §5 |
| 真实 PostgreSQL / HTTP / 浏览器 / 并发 / 故障注入 | 未进行（无分配的隔离库与独占窗口） |
| 独立测试（未参与实现的新对话） | 未进行 |
| Codex 专项风险审核 | 未进行 |
| 用户接受 / T10 / Stage 4 验收 | 未进行 |
