# S3-T08 独立测试报告（Independent Tester）— rev.4（补真实丢响应场景）

- **测试者角色**：独立测试者（本轮会话），未参与 T08 实现。
- **开发者 / 风险审核负责人**：Codex。
- **授权范围**：独立测试 + 隔离测试数据；**不授权**产品修复、其他 Task、Git 整合。
- **工作目录**：`C:\Programme\demo\SeekJournal`
- **分支 / HEAD**：`codex/s03-t08` / `b6fac52da99f70a5014f8fc96da85c2ed9269541`（与冻结开发起始 HEAD 一致）
- **测试日期**：2026-10-12
- **版本说明**：
  - **rev.4（当前）**：应 Codex 要求，**补测真实的「保存已提交、客户端未收到响应后重放」**场景（new_journal 与 append_source 各一），此前 rev.3 将其标为 UNVERIFIED，现已由独立探针验证。记录见 §8.5。
  - **rev.3**：第二轮 review 三项（`ai_checkpoints` 类型限定清理、独占守卫含 idle、丢响应说法纠正 + `both_in_flight` 入 PASS），记录见 §8.4。
  - **rev.2**：第一轮 review 三项（假并发、越界清理、报告失实），记录见 §8.1–§8.3。
  - rev.1 的内容与问题均**如实保留**，未粉饰。

---

## 0. 执行独立性与模型多样性

| 项 | 结论 |
|---|---|
| 执行独立性 | **满足**。本轮为新开会话，未参与任何 T08 实现、未运行开发者自测脚本（未调用 `http_probe.py`）。测试脚本（`independent_probe.py`）由本轮独立编写。 |
| 模型多样性 | **未核实**。按 `agents/multi-agent-workflow.md §1`，活动模型/客户端 ID 无法在本会话核实；上游模型以本地 MockTransport 合成，真实模型风格标为未验证，未做真实付费调用。 |

---

## 1. 冻结基线核对（只读）

| 核对项 | 结果 |
|---|---|
| `git rev-parse HEAD` | `b6fac52da99f70a5014f8fc96da85c2ed9269541` ✅ 与开发报告冻结 HEAD 一致；说明基线之后**无新提交**（仅未提交改动）。 |
| `git branch --show-current` | `codex/s03-t08`，未合入其他工作树改动。 |
| `docs/s3-t08-evidence/baseline.json` | **26 个文件 SHA-256 全部比对一致（ALL_MATCH）**，无漂移。 |
| `docs/s3-t08-evidence/tracked.diff` | SHA-256 `96e853e2…` 与记录一致。 |
| 未跟踪任务文件 | `app/ai/review.py`、`app/ai/review_save.py`、3 个 `tests/test_ai_review_*.py`、`docs/s3-t08-development.md`、`docs/s3-t08-evidence/` 均与冻结清单一致，已纳入待测基线。 |
| 运行前后产品散列 | **本轮运行前后产品文件散列一致**（见 §6），无漂移。 |

**结论**：待测基线完整、未漂移，可独立进行测试。

---

## 2. 环境与资源守卫（写入前证明）

- `SEEKJOURNAL_TEST_DB=seekjournal_test` 经 `scripts/prepare_test_db` 白名单解析；`current_database() = seekjournal_test` ✅。
- Alembic head = `3aa16300a58a`（与开发报告一致）✅。
- 独占性（rev.3 加固）：`pg_stat_activity` 统计该库**所有其它后端连接，含 idle**（不再用 `xact_start is not null` 过滤）；实测 **0 个其它会话** ✅。若有其他使用者（含空闲连接），探针**停止并报告**，**不终止任何连接、不清除任何数据**。
- 业务表基线（含 `ai_requests`/`ai_checkpoints`/`ai_usage`/`ai_settings`）写入前实测全 0 行；测试结束复核仍为全 0 行（无残留）。
- 个人库 `seekjournal` 全程只读，未触碰。
- 真实 HTTP 测试使用本轮独有 **8031** 后端（进程内 uvicorn + urllib），与开发者/其它测试串行，启动前已重查占用；结束后 **8031 已释放**（`netstat` 无 LISTEN）。

---

## 3. 实测证据（本轮执行，非引用开发报告）

### 3.1 开发者自带测试（真实 PostgreSQL，本轮重跑 62 项全过）
```
cd backend && ./.venv/Scripts/python.exe -B -m pytest -q -p no:cacheprovider \
  tests/test_ai_review_api.py tests/test_ai_review_evidence.py tests/test_ai_review_save.py
→ 62 passed in 8.44s   (api 20 / evidence 15 / save 27)   退出码 0
```
该组使用真实 TestClient + 引擎 + 合成模型 MockTransport，覆盖边界、证据/检查点回滚、双会话并发、保存重放/冲突、投影边界、真实 DB 故障回滚——属真实行为测试，非纯函数或日志读取。

> **覆盖归属**：本节 62 项为**开发者测试**（`tests/test_ai_review_*.py`），由本轮重跑确认，**不是**独立探针覆盖。

> **并发归属（rev.3 补充）**：双会话并发确认（`http_two_session_double_confirm_once`）在本报告中归为**开发者聚焦测试**所覆盖的能力，同时**独立探针 #9 以真实 barrier 并发复现**。本报告**不**把单次 `append_source`（#7）当作独立并发验证——#7 只证明「追加只发生一次」，不含并发语义。

### 3.2 本轮独立探针（真实 uvicorn HTTP + urllib + 故障注入，19/19 通过）
脚本：`backend/.test-evidence/s3-t08-independent/independent_probe.py`（本轮已修订）。运行日志：`independent-run.log`。命令与退出码见 §7。

| # | 检查（probe 名称） | 结果 | 实测要点（取自 `independent_probe.json` 实际字段） |
|---|---|---|---|
| 1 | `db_guard_exclusive` | PASS | `other_backends_incl_idle=0`；baseline 八表全 0 |
| 2 | `http_model_input_full_user_and_excludes_ai` | PASS | 用户正文进入合成模型；AI 蓝块/总结未进入 |
| 3 | `http_generate_zero_sources_422` | PASS | `status=422` |
| 4 | `http_generate_16_sources_422` | PASS | `status=422` |
| 5 | `http_boundary_zero_model_calls` | PASS | 被拒请求 `calls=0`（无静默补调用） |
| 6 | `http_generate_single_200` | PASS | `status=200 body.status=ready` |
| 7 | `http_append_preserves_source` | PASS | **`status=200`，`revision 1→2`**，同 id，`delta_journals=0`，源 content 前缀 `用户甲😀\n\n---` |
| 8 | `http_source_not_moved_after_save` | PASS | 保存后源 Journal 仍存在且用户块完整 |
| 9 | `http_two_session_double_confirm_once` | PASS | **真实并发**：barrier 同刻放行两请求，`codes=[200,201]`，**target 同一**，`delta_journals=1`，**`both_in_flight=True`（已纳入 PASS 条件）** |
| 10 | `http_replay_after_success_idempotent_same_target` | PASS | **成功后重放**（客户端已收到 201）：首次 201 → 同 body 200（同 target）→ 不同 body 409，`delta_journals=1` |
| 11 | `lost_response_new_journal_replay_same_target_once` | PASS | **真实丢响应（rev.4 新增）**：raw socket 发送后**不读响应即中止**（`client_rcvd=None(aborted)`）；独立连接确认 **`db_committed=True`（`req_status=applied`）**；恢复后重放**同 body → 200 同 target**，`journals_delta` 保持 **1**（未重复建）；不同 body → **409** |
| 12 | `lost_response_append_source_replay_single_append_once` | PASS | **真实丢响应（rev.4 新增）**：同上中止机制，独立连接确认 **`db_committed=True`**；重放**同 body → 200 同源**；`revision 1→2`（**只 +1**）、`ai_summary 0→1`（**只 +1**）；不同 body → **409** |
| 13 | `http_nonready_save_rejected_409` | PASS | `status=409` |
| 14 | `http_draft_ids_stable_no_insight` | PASS | 2 份草稿 `draft_id` 稳定且重放一致，未创建 Insight |
| 15 | `http_scoped_cleanup_no_owned_residual` | PASS | 按 manifest 精确清理后 residual=none |
| 16 | `fault_ready_checkpoint_rolls_back_all` | PASS | **`status=failed`、`error_category=storage`，预览保留（`review_kept=True`），检查点全部回滚（`cp_a/cp_b=False`）** |
| 17 | `fault_save_zero_half_write` | PASS | `http=500`，`delta_journals=0`，源 `revision=1` 不变，`req_status=ready`，`saved_target=False` |
| 18 | `fault_save_recover_201` | PASS | 故障消除后重试 `status=201` |
| 19 | `final_scoped_cleanup_no_owned_residual` | PASS | 结束时 residual=none，八表全 0 |

### 3.3 T05/T06 回归 + 全量回归（**此前实测，本轮未重跑**）
```
g2: test_ai_incremental + local_api + request_recovery      → 34 passed
g3: test_ai_search + tool_calls + search_privacy + usage + data_deletion → 136 passed
full: pytest tests (全量)                                    → 1185 passed in 132.37s
```
> **归属说明**：以上 34/136/**1185** 均为**本轮会话早前批次**的实测结果，日志保存在同目录 `regression-g2.log` / `regression-g3.log` / `full-regression.log`。按授权「不重复全量」，本轮**未重跑**，仅保留为既有证据。其中 62 项（§3.1）本轮已重跑复核。

---

## 4. 九项强制检查映射

| 项 | 覆盖证据（区分来源） | 结论 |
|---|---|---|
| 1 校验边界/状态码 | 开发者测试 §3.1 api + 独立探针 §3.2 #3–6 | 通过 |
| 2 模型输入捕获/伪造拒绝/恢复语义 | 独立探针 §3.2 #2,#5,#14 | 通过 |
| 3 生成不写源 / **ready 与检查点 C 同事务** / 无行锁 | 开发者 §3.1 evidence + 独立探针 §3.2 #6,#16 | 通过 |
| 4 保存前改源旧预览不可存 | 开发者测试 §3.1 save | 通过 |
| 5 追加保留源 / 新目标块正确 | 开发者 §3.1 save + 独立探针 §3.2 #7,#8,#12 | 通过 |
| 6 双会话并发 / 重放 | **并发**：开发者聚焦测试 §3.1 + 独立探针 §3.2 #9；**成功后重放**：§3.2 #10；**真实丢响应重放**：§3.2 #11,#12 | 通过 |
| 7 注入失败零半写 / 回滚查实 | 独立探针 §3.2 #17 | 通过 |
| 8 非 ready 不可存 / 草稿可读 / 增量 | 开发者 §3.1 save + 独立探针 §3.2 #13 | 通过 |
| 9 恢复/删除/usage/回归/架构一致性 | 既有回归 §3.3（34/136/1185） | 通过（此前实测） |

---

## 5. 语义与覆盖的精确表述（rev.2 纠正）

- **追加语义**：`append_source` 保存返回 **HTTP 200**，目标 `revision` **由 1 递增到 2**，源正文保留并追加 `\n\n---\n\n` 分隔，**不新建 Journal**。（rev.1 曾误写为「200/201、revision 不变」。）
- **生成事务**：生成成功时 `status=ready` 与检查点 C（`ai_checkpoints`）在**同一事务**内提交；保存阶段**不再推进 C**，只读取/校验。
- **检查点故障语义**：`ai_checkpoints` INSERT 故障 → `AIRequest.status='failed'`、`error_category='storage'`，**已生成的预览 payload 保留**，检查点行**全部回滚**。（rev.1 曾误写为「`status=ready`、源未变化」。）
- **保存故障语义**：`UPDATE ai_requests` 故障 → HTTP 500，零半写，源不变，请求回到 `ready`，`saved_target=None`。
- **重放语义（rev.4 更新）**：分两种，均已实测。
  1. **成功后重放**（探针 #10）：保存已成功、客户端已收到 201，再发同 body → 200 同 target；不同 body → 409。
  2. **真实丢响应重放**（探针 #11 new_journal、#12 append_source，rev.4 新增）：raw socket 发送 save 后 **不读取任何响应字节即中止连接**，客户端确实**未获知**成功结果；由**独立 DB 连接**确认服务端已提交（`req_status=applied`、`saved_target` 有值）；随后重放**完全相同**的 body → **200 且同一 target/source**，且 **new_journal 只产生一个目标**、**append_source 只新增一个 `ai_summary`、`revision` 只 +1**；**不同 body → 409**。
  - **纠正历史**：rev.2 曾称「真正丢响应由开发者 TCP 证据覆盖」，此说法**不成立**（`docs/s3-t08-evidence/http_probe.py:124` 亦为收到成功响应后重放）；rev.3 据此标为 UNVERIFIED；**rev.4 已由本探针自行验证，现不再标未验证**。
- **覆盖归属**：62 项/1185 项为**开发者测试覆盖**；**19 项**为**独立探针覆盖**；并发能力归**开发者聚焦测试 + 独立探针 #9**；两者分列，不混同。

---

## 6. 产品文件未改动证明 / Git 待提交状态

- `git status`（`codex/s03-t08`，HEAD `b6fac52`）：与 rev.1 完全一致，仅含 **Codex 原始未提交改动**：
  - 已修改：`backend/app/ai/{prompts,requests,router,schemas}.py`、`backend/app/writing/service.py`、`docs/stage3-architecture.md`、`docs/stage3-tasks.md`
  - 未跟踪：`backend/app/ai/review.py`、`backend/app/ai/review_save.py`、3×`tests/test_ai_review_*.py`、`docs/s3-t08-development.md`、`docs/s3-t08-evidence/`、`backend/.test-evidence/`
- **运行前后产品散列（SHA-256 前 16 位）**：
  - `backend/app/ai/review.py` → `e21ccbe0272b8167`
  - `backend/app/ai/review_save.py` → `24898d8316180184`
  - `backend/app/writing/service.py` → `94d3fbf2b6df5b98`
  - 本轮未修改任何产品代码 / 契约 / 共享 docs / 真实 .env / 依赖 / Migration，未撤销任何人修改，未 commit/merge/push/tag、未切分支或清理 Worktree。

---

## 7. 命令 / 退出码 / 清理 / 服务收尾（rev.4）

| 步骤 | 命令 | 退出码 | 清理 / 收尾 |
|---|---|---|---|
| 开发者聚焦测试 | `cd backend && ./.venv/Scripts/python.exe -B -m pytest -q -p no:cacheprovider tests/test_ai_review_api.py tests/test_ai_review_evidence.py tests/test_ai_review_save.py` | 0（62 passed，rev.3 已重跑） | 测试自管事务回滚；未建持久行 |
| 独立探针（含丢响应场景） | `cd backend && ./.venv/Scripts/python.exe -B .test-evidence/s3-t08-independent/independent_probe.py`（日志见 `independent-run.log`） | 0（19/19） | 按 manifest 精确清理自建 rows；residual=none |
| 运行后核对 | 八表计数复核 + `netstat :8031` | 0 | 八表全 0；8031 已释放；`other_backends_incl_idle=0` |

> **只跑新增场景**：本轮只跑独立探针（新增两条丢响应检查），**未重跑全量**；开发者聚焦 62 项沿用 rev.3 结果。

**清理机制（rev.4）**：
- **不再有任何无条件整表 `DELETE`**。探针启动前**只读**记录真实基线（八表实际行数）与其它连接数，不写库。
- 运行期用 `manifest` 记录本轮创建的**每一种自建对象**：`journals`（源 + 保存新建目标，含丢响应场景新建目标）、`inboxes`（源）、`ai_requests`（request_id）。
- 结束（含 `finally`）只按 manifest ID 精确删除，且 **`ai_checkpoints` 按 `(file_type, file_id)` 类型限定**：
  ```
  (file_type='journal' AND file_id = ANY(<本轮 journal ids>))
   OR (file_type='inbox'   AND file_id = ANY(<本轮 inbox ids>))
   OR (last_request_id = ANY(<本轮 request ids>))
  ```
  随后 `ai_usage(request_id)` → `ai_requests(id)` → `journals(id)` → `inboxes(id)`。
- 若清理后仍有**非本轮的残留**，探针 **FAIL 并报告 residual，不清空**（供人工处置）。
- 丢响应场景用 **raw socket**，同样纳入 manifest：new_journal 目标 id 与 append 的源 id 均已记录。

---

## 8. 复审整改记录

### 8.1 问题一：假并发（rev.2 已修复）
- **rev.1 缺陷**：`r1, r2 = pool.submit(post_save).result(), pool.submit(post_save).result()`。Python 元组按序求值，先 submit 第一个并 `.result()` **阻塞等待完成**，再 submit 第二个 —— **实际串行**，`codes=[200,201]` 不能证明并发。
- **rev.2 修复**：先 `f1 = pool.submit(w); f2 = pool.submit(w)` **提交两个任务**，worker 内用 `threading.Barrier(2)` 让两请求**同刻放行**再发 HTTP，最后 `f1.result(), f2.result()` 等待两者。
- **rev.3 加固**：`both_in_flight` 已**纳入 PASS 条件**（`ok = ... and both_in_flight`），字段名由 `barrier_released` 改为 `both_in_flight`。
- **本轮实测**：`codes=[200,201]`、`same_target=True`、`delta_journals=1`、`both_in_flight=True` —— **new_journal 只建一个目标**；`append_source`（#7）`revision 1→2` 且 `delta_journals=0` —— **只追加一次**（单次追加，不含并发语义，不作为独立并发验证）。

### 8.2 问题二：越界清理（rev.2 已修复并如实记录）
- **rev.1 缺陷**：`cleanup()` 无条件 `DELETE FROM ai_usage/ai_checkpoints/ai_requests/journals/inboxes`，且在启动前与 `finally` 共三处调用；属**越界清理**，与「只清本轮自建对象」原则不符。
- **rev.2 修复**：删除全部无条件整表删除；改为 §7 所述「只读基线 + manifest 精确清理 + 残留即 FAIL 报告」。清理键按**真实 schema** 校正：`ai_requests.id`（非 `request_id`）、`ai_checkpoints(file_type,file_id|last_request_id)`。
- **rev.3 加固**：见 §8.4（检查点按 file_type 类型限定）。
- **如实说明**：**rev.1 曾对 test 库执行过整表 DELETE**。该数据库为测试独占库、本轮写入前实测为空、且这些删除未触及个人库或其它工作树数据；但**行为本身越界**，本报告**不将其补写为「安全清理」**，仅作既往事实记录。

### 8.3 问题三：报告失实（rev.2 已纠正）
| 项 | rev.1 错误 | rev.2 更正 |
|---|---|---|
| 追加结果 | 「`revision=1` 不变，`http=201`」 | **`http=200`，`revision 1→2`**（对齐 JSON `status=200 rev=2`） |
| 检查点故障 | 「`request.status=ready`、源未变化」 | **`status=failed`、`error_category=storage`，预览保留、检查点回滚** |
| ready/C 事务 | 未明确 | **生成成功 ready 与 C 同事务；保存不再次推进 C** |
| 覆盖归属 | 62/17/1185 混同 | **开发者测试 62/1185 与独立探针 17 分列** |
| 重放命名 | 「丢响应后同 body 重放」 | **改称「成功后重放」** |

### 8.4 第二轮 review 三项（rev.3 已修复）
| # | 问题 | rev.3 修复 |
|---|---|---|
| 1 | `purge_owned()` 清理 `ai_checkpoints` 把 journal/inbox 两类 IDs 合并后只按 `file_id` 删除；两类 id 可能数值碰撞，会误删他人检查点 | 改为**类型限定**：`(file_type='journal' AND file_id IN 本轮 journal ids) OR (file_type='inbox' AND file_id IN 本轮 inbox ids) OR (last_request_id IN 本轮 request ids)`；**绝不按 file_id 单列删除** |
| 2 | 独占守卫使用 `xact_start is not null`，会**漏掉 idle 连接** | 移除该条件，统计该库**所有其它后端，含 idle**；有他人（含空闲）即**停止并报告**，不终止连接、不清数据 |
| 3 | 报告称「真实丢响应由开发者 TCP 证据覆盖」失实；且并发 PASS 条件未含 `both_in_flight`；单次追加被当作独立并发验证 | **纠正**：核实 `docs/s3-t08-evidence/http_probe.py:124` 亦为「收到成功响应后重放」，故真实丢响应标 **UNVERIFIED**；`both_in_flight` **纳入 PASS 条件**；报告明确**并发归开发者聚焦测试 + 独立探针 #9**，单次追加（#7）不作独立并发验证 |

### 8.5 rev.4：补真实丢响应场景（此前 UNVERIFIED → 已验证）
- **背景**：rev.3 结论曾将「保存已提交、客户端未收到响应后重放」标为 **UNVERIFIED**。本轮按要求补测。
- **方法（测试侧丢弃响应，未改产品）**：
  1. 用 **raw socket** 手动拼 HTTP 请求（含正经 Content-Type/Length），`sendall` 后**不读取任何响应字节**，直接 `shutdown(SHUT_RDWR)` + `close()` —— 客户端**确实无法获知**保存结果。
  2. 发送后由**独立 DB 连接**轮询 `ai_requests`，直到观测到 **`status='applied'`**（并核 `saved_target` / 源 `revision` / `journals` 计数），**证明服务端已提交**后才继续。
  3. 再用正常 HTTP 客户端重放**完全相同**的 body，并追加不同 body 的冲突请求。
- **实测结果**：
  | 场景 | 客户端收到响应 | DB 已提交 | 重放同 body | 不同 body | 重复创建/追加 |
  |---|---|---|---|---|---|
  | new_journal | `None`（中止未读） | `True`（applied） | **200**，同 target | **409** | `journals_delta=1` 全程不变 |
  | append_source | `None`（中止未读） | `True`（applied） | **200**，同源 | **409** | `revision 1→2` 只 +1、`ai_summary 0→1` 只 +1 |
- **结论**：真实丢响应路径**已被独立验证**，不再是 UNVERIFIED；产品在「首次已提交但客户端未知」下重放正确幂等。

---

## 9. 结论

- **本轮实测（rev.4）**：独立探针 **19/19 通过**（含真实 barrier 并发、`both_in_flight=True`、类型限定精确清理、**两条真实丢响应场景**）；开发者聚焦 62 项沿用 rev.3 结果；34/136/1185 为**此前实测**，按授权未重跑。
- **九项强制检查**：均获证据，其中 #6 含并发 + 成功后重放 + **真实丢响应重放**，#9 依赖既有回归证据。
- **资源收尾**：测试库八表全 0、含 idle 在内无其它连接、8031 已释放；产品散列无漂移。
- **限制**：模型多样性未核实；未做真实付费调用。（真实丢响应已由本探针验证，**不再列为限制**。）
- **待办**：交回 Codex 核对实际 diff 与风险证据；最终接受状态由用户决定。

*报告区分：§3.1/§3.2/§7 为实测（§3.1 为 rev.3 重跑、§3.2 为 rev.4 本轮）；§3.3 为**此前实测**；开发报告/开发者自测结论仅作交接输入，未替代本轮证据。*
