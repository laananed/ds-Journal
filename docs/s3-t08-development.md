# S3-T08 开发与自测记录

## 授权和基线

2026-10-12，用户附件明确授权原 T08 实施、自测和执行记录更新；单 Agent 串行，WorkBuddy 在新会话独立测试。Codex App；活动模型无法独立核实。分支 `codex/s03-t08`，HEAD `b6fac52da99f70a5014f8fc96da85c2ed9269541`，起始工作区干净。不提交、不整合、不切分支、不安装依赖、不修改前端/迁移/真实配置。

## 实施计划与设计核对

依据 stage3-api §5～6 / architecture §7 的已批准设计直接实施；不另设设计批准门。复用 T05/T06 的 client、tool_calls、usage、恢复和进程限额；保留公开 CRUD 自有事务。禁止调用自动提交 CRUD 完成跨模块保存。

- [x] 先补三个测试文件：生成边界、证据与一次保存，确认缺失接口失败（13 failed / 2 passed，退出 1）。
- [x] schemas 定义 typed sources、结构化结果与保存参数；prompts 发送所有用户正文，排除 AI。
- [x] review.py：登记、网络、计量、ready/C 分离；固定 `(type,id)` 源锁序，源变化保留结果。
- [x] review_save.py：源锁后请求锁，验证快照；目标与 applied/hash 同事务提交，失败整体回滚。
- [x] 聚焦测试、T05/T06 回归、全量测试、真实两会话与 TCP HTTP/DB 故障证据。
- [x] 风险自查、资源释放；停止产品代码写入，冻结清单见下文。

生成入口 `execute_review(db, payload) -> (response, status)`；保存入口 `save_review(db, request_id, payload) -> (response, status)`。结构化结果不接受任意 source/quote；固定三个角度，草稿 ID 服务端从 request ID 与索引稳定派生，不创建 Insight。保存新建显式业务日期；旧 user/AI 身份完整保留，空 user 续写段不纳入消费文本。

## 前置与环境核对

T05/T06 代码在当前目录可见。最初只在主树找到了 T05 阶段记录；补查 Work-02 后读取了下列开发和独立报告（只读，未修改其他 Worktree）：

- `C:\Programme\demo\SeekJournal-Work-02\.workbuddy\s3-t05\development-report.md`、`s3-t05-independent\independent-test-report.md`、`release-record.md`。
- `C:\Programme\demo\SeekJournal-Work-02\.workbuddy\s3-t06\interface-compatibility.md`、`file-sha256.json`、`s3-t06-independent\acceptance-report.md`。

两项历史报告均声明独立技术测试通过，并保留风险审核/用户接受门禁；T05 报告同时记录模型配置不符，T06 同模型不具模型多样性。这里只引用已有证据，不重新证明历史活动模型、真实付费连通性或宣布 Task 完成。本轮逐文件比较 T06 17 个交付文件：归档 SHA256 与 Work-02 文件一致，T08 起始 HEAD 的 Git blob 与归档正文 17/17 相同（仅忽略 CRLF/LF）；其中 15 个在本轮未改，另外 prompts/requests 仅增加 T08 提示词/错误分类，详见 `s3-t08-evidence/prerequisite-comparison.json`。本轮 T05/T06 自测回归另记，不冒充独立测试。

首次只读数据库核对退出 0：`seekjournal_test`、revision/head 均 `3aa16300a58a`，其他连接 0，八表均 0。fixture 在应用导入前按 SEEKJOURNAL_TEST_DB 白名单切库；本轮只使用 seekjournal_test。私有 schema 合成迁移测试沿用现有 fixture；不对 public 执行 prepare/upgrade。个人库未连接。

## 实际文件与行为

新建 `backend/app/ai/review.py`、`review_save.py`；修改 `ai/schemas.py`、`router.py`、`prompts.py`、`requests.py` 与 `writing/service.py`；新建三份 `test_ai_review_*`。无必要改动 journal/service.py：专用保存直接组合已锁 ORM 行、summary_blocks 无提交原语和只读 get_journal，公开 CRUD 的事务行为保留。

数据流：sources 输入 → 短事务锁源/登记 pending → 提交并释放所有行锁 → T06 有界工具循环/独立 usage → 验证结构和原文 evidence → 源锁后 request 锁 → ready 与所有 C 同事务提交。保存再次同序锁源并逐字段核对，写目标与 applied/saved_target/save_payload_hash 一次提交。新建 201、追加 200；相同 JSON body 的重放 200 同一目标，异体 409。

源永久删除按既有隐私契约清除整个请求；迟到调用仅保留匿名 usage，返回 404，不复活预览。软删或其他源变化则保留 review/conflict、不推进 C。截断输出 failed：有效结构预览可查看，无效/不完整 JSON 原始文本仅保存在私有 result.raw_review，不成为可保存正文，也不重新修 JSON。截断工具轮在 T08 invoke 入口终止，不进入搜索/第二个模型调用，T06 executor 未修改。

保存摘要身份为 ai_summary，旧 blocks/逐字用户原文不变；新 Journal 带空 user 续写段、revision=1，日期显式接收。投影超过 50,000 码点拒绝，边界正好 50,000 可成功；摘要编辑仍是 AI，不增加 U。草稿 ID 由 request UUID + 索引稳定派生，不写 Insight。

stage3-tasks §15 与 architecture §8 的固定选库描述按既有批准能力同步；历史 §17 记录保留。新增 `docs/s3-t08-evidence/http_probe.py` 仅为必要 TCP/DB 证据工具：独立于 pytest 启停自有 8031 服务，进程仅用合成 Mock，按 manifest 清理。未扩展任何产品模块/运行依赖。

## 命令、退出码与覆盖

以下命令均在 `C:\Programme\demo\SeekJournal\backend`，先设置 `$env:SEEKJOURNAL_TEST_DB = 'seekjournal_test'`；解释器为现有 `.\.venv\Scripts\python.exe -B`。pytest 公共前缀为 `-m pytest -q -p no:cacheprovider`。日志位于 `docs/s3-t08-evidence/`。

| 命令（上述解释器/前缀） | 退出码与本轮结果 | 日志 |
|---|---|---|
| 三份 `tests/test_ai_review_api.py tests/test_ai_review_evidence.py tests/test_ai_review_save.py` | 0，最终 62 passed，10.44s | focused.log |
| `tests/test_ai_incremental.py tests/test_ai_local_api.py tests/test_ai_request_recovery.py` | 0，34 passed，4.29s | incremental-regression.log |
| `tests/test_ai_search.py tests/test_ai_tool_calls.py tests/test_ai_search_privacy.py tests/test_ai_usage.py tests/test_ai_data_deletion.py` | 0，136 passed，4.53s | search-ledger-regression.log |
| `tests` | 最终轮 0，1185 passed，107.89s；早期轮 1181 / 1184 通过，但不作为最终基线 | full-regression-final.log（最终） / full-regression.log（早期） |
| `..\docs\s3-t08-evidence\http_probe.py`（不带 pytest 前缀） | 0；实际 TCP/DB 检查与基线恢复通过 | http-db-evidence.json / manifest.json |
| 根目录 `git diff --check` | 0，最终文档更新后再核对 | baseline.json 的 diff_check_exit_code |

聚焦覆盖：0/1/15/16 文件、同日多篇/7/8 日期、混合源、重复/Insight/缺失/删除/过期/同源 pending 零模型；75 万用户码点完整发送，AI 排除；三个角度与事实/推测/evidence 结构、外部源/伪造 quote 拒绝；零/多草稿稳定 ID；同键/异体重放；生成和保存的正文/标题/日期/Folder/删除/blocks 变化；生成期间第二 Session 无长事务和无行锁；ready+C 故障全回滚；新增/追加并发双确认；无效 Folder/参数/Unicode 长度；真正 PostgreSQL 除零故障发生在目标 INSERT/UPDATE 后仍零半写；失响应重放；迟到 unknown 槽升级仅一行 usage；硬删匿名计量；总结编辑后 noop、新增仅增量；隐私拦截和两轮 usage；截断工具零后续调用。

TCP 证据不是 TestClient：独立 uvicorn 8031 + urllib 请求 + PostgreSQL 独立 Session。双确认得到 `[200,201]` 且同一目标；保存后 DB 目标/状态/hash 一致。故障得到 500，目标未创建且 request 仍 ready/hash null，同 body 后续 201。child 由本轮 terminate，Windows exit=1 为主动终止；8031 可重新 bind。没有停止其他进程。

## 失败分类与处理

- 初始缺失接口（13 failed）为 TDD 实施前预期失败，非环境故障。
- 长度测试第二次生成复用了第一次 Mock source ID，导致证据拒绝（409）而非预期长度 422；定位并重置 Mock 后通过。分类：测试脚本错误，未改产品。
- 截断结果未保留原始输出：补反例，`truncated-red.log` 退出 1；保留私有 raw_review 后 `truncated-green.log` 退出 0。分类：本轮产品缺陷，已修复，不续写/不推进 C。
- 截断工具轮仍进入搜索/下一模型：最初探针 fake 返回 None 导致 500，改为有效 SearchOutcome 后稳定复现 ready 而非 failed（`truncated-tool-red.log`，退出 1）；T08 invoke 保留 usage/finish reason 并剥离不可执行的 tool_calls 后最终聚焦通过。分类：初版探针错误 + 已修复产品缺陷，未改 T06 executor。
- 缺少上游输入过大时减少选择提示：反例 `context-message-red.log` 退出 1，补安全说明后最终聚焦通过。无自动分批/重试。

## Codex 开发者风险自查（不是独立审核）

| 风险 | 实现与本轮证据 | 状态 |
|---|---|---|
| 旧正文完整/AI 来源身份 | summary_blocks 深拷贝旧 blocks；旧 content 逐字 user 转换；追加/50,000 边界/摘要编辑/增量测试 | 自查通过，待 WB 复核 |
| ready 与所有 C 原子 | finish_review 一事务；真实 PostgreSQL checkpoint INSERT 故障使所有 C 回滚，预览与已提交 usage 保留 | 自查通过，待 WB 复核 |
| save 仅一次 | source→request 锁 + 保存 body hash；双 Session 新建/追加 + TCP 双确认/重放 | 自查通过，待 WB 复核 |
| 固定锁序/无长锁 | 每阶段 `(type,id)` 排序后 source→request；网络前提交；另一 Session lock_timeout 500ms 全源可锁、pg_stat_activity 无其他事务 | 自查通过，待 WB 复核 |
| 无半写/失败计量 | 目标 SQL 后真实数据库除零，Journal/request 全回滚、ready 保留；usage 独立提交；迟到/硬删/截断工具边界 | 自查通过，待 WB 复核 |

## 未验证与学习点

真实 DeepSeek/Brave 连通性、风格和检索质量留 T11；无真实付费调用、无浏览器/UI/T09/T10 实施。官方参数只读核对：DeepSeek [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) 支持 max_tokens/非思考及截断语义；[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/) 标注 1M token 上下文。码点不等于 token，本轮 Mock 证明全文未裁剪，不证明 75 万任意 Unicode 输入可被真实模型接受；供应商拒绝返回安全失败并提示减少选择，不隐式分批。

核心知识点（3）：U 只取 user blocks，C 是成功消费的 U；上游计量不可回滚，所以 usage 与 ready/目标分事务；目标与保存请求状态/hash 同事务及源→请求锁序共同保证一次确认不双写。

## WorkBuddy 独立测试交接

使用未参与本次实现的新会话；模型按 agents/multi-agent-workflow §1，在开始时核对实际客户端/活动模型，无法核实如实注明。独立测试授权由用户在新会话发送，不由本轮自动调用/创建 Agent。

必读根 AGENTS.md、agents/ds-developer.md、agents/multi-agent-workflow.md；阶段文档按用户原 T08 提示词与 docs/stage3-tasks §10、stage3-api §1～2/4～8、architecture §3～8 及适用 Stage 2 契约。范围仅 T08 独立测试/证据，不修改产品、前端、迁移、依赖、真实 .env、私人配置或其他 Worktree；产品缺陷交回开发者，禁止 commit/merge/push/tag/切分支/清理 Worktree。

待测目录与分支为本报告基线；测试前核对 HEAD、tracked diff 与所有未跟踪任务文件散列，具体清单见 `s3-t08-evidence/baseline.json`、`tracked.diff`。开发者已停止产品代码写入；实际冻结后若不一致先识别归属，不重置/覆盖。本轮独立性和模型多样性分别记录，不能把开发者这 62 项或全量数量当独立验收。

只用 seekjournal_test 串行独占；每次数据库写入前重新核对 fixture 实际目标/current_database/revision/head/八表与其他连接。非独占/版本不符则暂停 DB 写入；不自动换库，不执行 prepare/公有 schema 升级/建库/清洗，不启动 Compose、不动 8000/5173/5432，不做付费调用。允许本轮隔离库私有 schema 及合成测试数据，仅清自己 manifest 对象。真实 HTTP 仅在 8031 空闲时用独有进程，DATABASE_URL 显式指测试库、上游 Mock；pytest 与该服务分时执行，只停自己的进程。

独立运行上表四组 pytest 和根 git diff --check；检查实际模型消息/SQL/DB 及单独编写真实两会话/TCP/故障场景，不仅采信开发者 HTTP harness。重点重新证明旧文完整、ready/C 原子、一次保存、固定锁序/无半写，以及截断工具停止、源删除隐私、summary 后增量。交付按协作 §6 八项，逐项通过/失败/未验证，保留命令/退出码、实际待测基线、资源释放及风险结论。技术通过仍待风险证据审核、约定整合及用户接受，不宣布 Stage 整体验收。

## 最终收尾与冻结

**结果：开发自测通过，待 WorkBuddy 独立测试、风险证据审核、约定整合及用户接受。** 不宣布 T08 或 Stage 3 整体验收完成。

最终资源探针退出 0（`resource-final.json`）：seekjournal_test revision/head `3aa16300a58a`，八表全部 0、其他连接 0，仅 public schema，8031 可重新 bind。HTTP 故障/双确认探针在最后产品修复后再次运行，退出 0，数据基线完全恢复。pytest 与自建 HTTP 服务串行；只清理本轮 owned typed IDs/request/usage/schema，未重置 sequence。个人库未连接/迁移/写入，未执行 prepare、公有库升级、建库或 Compose，未改 .env，未动他人服务。

分支/HEAD 保持起始值，任务修改全为未提交 diff/新文件。`baseline.json` 记录 HEAD、分支、原始 tracked.diff SHA256、所有未跟踪任务文件清单及任务文件散列；tracked.diff 保存 Git 原始字节，逐文件散列保存工作区字节。baseline.json 自身不散列以避免自引用，其余报告/代码/测试/证据文件均纳入；冻结后停止本轮文件修改。Git 的全局 ignore 路径权限警告没有改变 status/diff 命令结果。

已释放 seekjournal_test；发布后本开发会话不再连接该库。独立测试必须重新核对资源，不沿用本轮释放记录作为当前独占证明。
