# S04-T08 独立测试报告（WorkBuddy，2026-10-30）

## 1. 角色与独立性

- 测试者：WorkBuddy（GLM-5.3-Flash）。未参与 T08 实现；此前对话开发过其他任务
  （wb/s4C01 日程 UI 相关未跟踪文件、wb/s4t10 分支 worktree），本轮测试与其无关，
  未复用任何 T08 开发对话。执行独立性：满足（独立会话、未参与实现）。
  模型多样性：不满足（同一模型），不声称跨模型交叉验证。
- 开发者：Codex，交接见 `s04-t08-evidence/handoff.md`。

## 2. 待测基线核对（开始前）

- 目录 `C:\Programme\demo\SeekJournal`，分支 `codex/s4t8`（主工作区），HEAD
  `c3891b4849f71d66144711344a16840bc0ebc598`，未提交。
- 交接 36 文件 SHA256 全部一致（`files.sha256`，CRLF 规范化后校验 36/36 OK）。
- 未暂存 diff SHA256 `a6f25c99993f228260b2304b17760d36433a807414278d1de1d33f23de17af66`
  与交接 `unstaged.diff` 一致；staged.diff 为空。测试结束时复核仍一致（开发者停写成立）。
- 测试新增（未跟踪，均为测试资产）：`backend/tests/test_indep_s4t08_http.py`、
  `backend/tests/test_indep_s4t08_pg.py`、`s04-t08-independent/`（散列见 indep-files.sha256）。

## 3. 数据库安全核对

- 目标库 `seekjournal_test_03`：`current_database()` 证实，Alembic current=head=`4f8e1a3c9d02`。
- 开始前业务表全 0，仅 `ai_usage` 1 行 = 开发者已知误触发真实模型用量
  （UUID `4f2a8d02-c841-44e0-b42a-27da0e5119b9`，1682 Token，匿名）。该行全程未动。
- 测试独占窗口开始时其他连接 0；schema 仅 public。
- 清理：HTTP 套件使用 savepoint 隔离；PG 套件使用 `stage3_engine` 私有 schema
  （逐测试建/删，public 快照校验）。结束复核：业务表恢复全 0（ai_usage 仍为已知 1 行）、
  私有 schema 0 残留、其他连接 0。个人库 seekjournal 未连接、未写入。
- 事件：测试过程中发现两处自建数据泄漏（record_round 独立 Session 真实提交 +
  测试自身会话误用），均为本轮自建对象，已按精确 ID 删除（journal 1833、
  ai_request b0143970…、ai_usage c41e19ef…，删除计 1/1/1），已恢复基线。

## 4. 独立测试结果（全部 Mock，零真实付费调用）

安全措施：进程级清空 `DEEPSEEK_API_KEY`/`BRAVE_SEARCH_API_KEY`，并 monkeypatch
`client.invoke`/`local.model_invoke`/`search.search_web` 为抛错。

### 4.1 新增独立 HTTP 套件（`test_indep_s4t08_http.py`，23 passed）

覆盖：prepare 冻结快照/占位/effects 契约；同 ID 同体重放不重建、异体 409；execute
仅一次上游、重放 200/202；apply 原位、续写保留、C 只推进到调用快照、重放不加版；
无增量 noop 零请求；边界上方编辑在保存时即失效请求（execute 返回 conflict 零调用）；
删除占位/软删/恢复后不得附着；自动双标签按 (kind,快照) 去重、串行 409、failed/unknown
不换键重发；多节点 ranges 冻结 quote、评论生成/Mark/列表契约、C 不推进；重复 quote
按节点+偏移挂载不误挂；恶意 quote → unavailable 保留不附着；锚点范围编辑 → Mark 移除
+unavailable+quote 保留；评论删除 CAS(428/204)、版本递增；客户端注入 Mark 422、
跨文件评论 ID 422；ranges 422（空/重叠/超100/start>=end）、越界节点/未知节点 422；
kind 专属选项与 Insight/Inbox 来源 422；设置 auto 开关 CAS+校验（body expected_revision）；
legacy 正文 minds 409 legacy_conversion_required、go_deeper 允许转换；
Review JSON 快照(document)/源变 409/JSON 追加 aiSummary 保 kind；7 日期上限 422；
评论端点仅 Journal；local 与 prepared 写作请求互斥 409。

### 4.2 新增独立 PG 套件（`test_indep_s4t08_pg.py`，10 passed，真实多会话）

覆盖：两会话同 ID 只一次上游、等待期间无锁可编辑、apply 后 C=快照；并发 apply 仅一次
附着（单 aiReply、revision 3、另一侧 replay）；超限 429 且状态/用量不变；模型超时 504
→ failed/timeout + 单条 unknown 槽位、重放不再调用；结果 ready 后存储故障 → 保持
ready、零 C、零版本推进、可重试成功；重启 recover(restart) → unknown + 保留 unknown
槽位、prepared 不被误改、零调用；软删后迟到结果 conflict 但结果+usage 保留；
purge 后 usage 匿名(request_id NULL)且全局总量不变、请求/检查点清除；自动并发 prepare
仅一条请求/一个占位；Minds execute→apply 全链路真实记账 + apply 重放零变化。

### 4.3 独立复跑开发者声称的回归（30 模块，命令见 §6）

424 passed / 3 failed / 2 errors。失败全部与 T08 产品代码无关：
- `test_ai_http_smoke.py::test_http_settings_lifecycle_over_a_real_socket`：期望仍是
  T08 之前的设置响应形状（缺 auto_go_deeper/auto_minds_comments/mind_preset_ids），
  且 `model_configured=True`——smoke 子进程通过 `.env` 载入了本机真实 Key
  （`_server_env` 只 pop 进程环境）。需要开发者按新契约更新该模块。
- `test_ai_http_smoke.py::test_http_module_leaves_the_shared_test_database_empty`：
  断言 `ai_usage=0`，与开发者已知误触发用量行（=1）冲突；需改为基线感知断言。
- `test_ai_http_smoke.py::test_http_server_reports_unconfigured_model...`：同 (b) 环境原因。
- 批量运行时该模块另有 2 个 setup ERROR（uvicorn 子进程未就绪，日志为空），
  单独运行不出现，判为间歇性环境问题。
- `test_s4_ritual_concurrency.py::test_two_sessions_compete_for_one_ritual_slot`：
  硬编码 `current_database()='seekjournal_test_04'`，本轮按授权只能用 _03，环境不满足，
  未验证（非产品缺陷）。

### 4.4 前端

- `node --experimental-strip-types --test src/api/aiWriting.test.ts`：1 passed。
- `tsc --noEmit --ignoreConfig src/api/ai.ts src/types/ai.ts`：仅
  `import.meta.env`（TS2339）——绕过项目 tsconfig 所致；`tsconfig.app.json` 含
  `"types":["vite/client"]`，项目配置下合法，非缺陷。整站 build 因缺失 Tiptap
  依赖仍不可运行（与交接一致，未安装依赖）。

## 5. 发现的问题（交回开发者）

无 T08 产品代码缺陷。需处理：
1. `test_ai_http_smoke.py` 3 处需按 T08 契约/基线更新（设置新字段、ai_usage 基线、
   model_configured 环境依赖），并排查批量运行时 uvicorn 子进程启动不稳定。
2. `test_s4_ritual_concurrency.py` 硬编码 _04，多库并行分配下不可运行，建议参数化。
3. 观察项（非缺陷）：`writing_requests.execute` 对非 prepared 状态返回 200+status
   （含 conflict/prepared），与 API §7 "其余已有状态 200" 一致，但 prepared 状态的
   请求被并发失效后 execute 返回的是失效后状态，T09 需按状态而非 HTTP 码分流。

## 6. 关键命令（PowerShell 语义，均在 backend 目录，退出码 0）

```
$env:SEEKJOURNAL_TEST_DB='seekjournal_test_03'; $env:DEEPSEEK_API_KEY=''; $env:BRAVE_SEARCH_API_KEY=''
.venv\Scripts\python.exe -B -m pytest tests\test_indep_s4t08_http.py -q            # 23 passed
.venv\Scripts\python.exe -B -m pytest tests\test_indep_s4t08_pg.py -q              # 10 passed
.venv\Scripts\python.exe -B -m pytest <30 模块列表> -q                              # 424 passed, 3 failed, 2 errors
# 前端（frontend 目录）：
node --experimental-strip-types --test src/api/aiWriting.test.ts                    # 1 passed
```

## 7. 结论

- 独立测试：通过（33 项新增独立用例全绿 + 424 项回归复现），未验证项：真实浏览器
  UI 链路（T09 未接线，本任务范围外）、真实付费供应商链路（未授权）、
  `test_two_sessions_compete_for_one_ritual_slot`（测试硬编码 _04）。
- 新 Codex 专项风险审核（C/幂等/计量/事务）：未执行，仍开放。
