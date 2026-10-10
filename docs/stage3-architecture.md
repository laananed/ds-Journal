# SeekJournal — Stage 3 技术架构

> 2026-10-10。技术推荐，待规划审核和 Task 实施授权。产品以 `stage3.md` 为准；接口以 `stage3-api.md` 为准。此文不代表字段或模块已经存在。

## 1. 本轮基线与复用

只读核对目录 `C:\Programme\demo\SeekJournal`，分支 `codex/s03-t00-决定stage3开发内容和task规划`，HEAD `e93816e3ccc113c738cbe6a577f13cc284ad3685`，规划前工作区干净。origin 对应用户给出的仓库；未 fetch，不声明本地与远端完全同步。既有 Work-01/02 分别在 worktree01/worktree02，不能当成已同步或无人占用。

源码已具备：三类 CRUD、Daily 部分唯一索引、动态 Journal 标题、Folder 混合分页、Search 的 UNION ALL、Journal/Insight Trash、Markdown 安全阅读与内部链接。Alembic 文件链末端 `18ecf7e09da6`；本轮未连接数据库，数据库实际 revision/数据状态未重新核验。
`stage2-tasks.md` §20 的 T14 是历史技术验收，不是本轮复测。S2-F01 对应代码已在 `markdownReading.ts` 中将空 href 渲染为 span，本轮独立运行阅读/内部链接纯逻辑分别退出 0（41/29 项）；不据此声称完整 Stage 2 已接受。README 的测试数量/无搜索等段落过时，Stage 3 实施时按实际功能更新，不用其判断功能缺失。

现有保存入口散在 `App.tsx`、`JournalEditor.tsx`、`JournalDetail.tsx`、`InboxPage.tsx`、`InsightPage.tsx`；目前为手动保存、Dirty 导航和 busy。三表 content 为纯 Text，服务直接 commit，**没有版本锁、AI 身份、检查点、usage 或设置**。不能只加 debounce 就认为安全自动保存已完成。

沿用 React/TS/Vite、local State + fetch、FastAPI/Pydantic/SQLAlchemy/psycopg/PostgreSQL/Alembic、pytest；Router → Service → SQLAlchemy，不加 Repository、状态框架、微服务、队列或模型 SDK。现有 requirements 的 HTTP 相关包名称不能据名字猜导入方式；推荐先用 Python 标准库 urllib.request 在同步路由工作线程发 HTTP，直接 JSON 调官方 API，避免新增依赖。T03 验证超时/错误注入后再决定是否实际需要其他 HTTP 包，不自动安装。

## 2. 自动保存：问题、选项与推荐

**Problem**：手动保存一旦自动触发，多个请求和两个标签会相互覆盖，新建重试会重复建文件。**Impact**：丢字、重复 Daily、已保存指示失真。

| 方案 | 成本与风险 | 推荐 |
|---|---|---|
| 只加 debounce、沿用最后写入覆盖 | 改动少；没有冲突保护，不满足安全要求 | 不采用 |
| 单文件串行保存 + revision CAS + 创建幂等 ID | 少量字段/公共逻辑，可用 PostgreSQL 验证 | 采用 |
| CRDT、离线队列、自动三路合并、版本历史 | 更强协作；与本地单用户目标不符 | 推迟 |

三张文件表增加 `revision bigint NOT NULL DEFAULT 1`、`client_create_id UUID NULL UNIQUE`。真实修改在同一事务 revision+1；相同内容不更新时间、不加版。创建键重放比对创建请求摘要；相同请求回原文件，键被不同请求复用返回 409。新增可空 `create_payload_hash text` 保存首次创建摘要，避免文件后来修改导致原创建重试不再可判定；首次请求正文不额外存第二份。旧行两列均 NULL。
PATCH 使用 expected_revision，UPDATE 的 WHERE 带旧 revision 与有效状态，0 行区分 404/409。完整保存意图与当前值完全相同可作为响应丢失后的安全 no-op 返回现有版本；不得因此覆盖其他字段。软删/恢复也加 revision、显式保留 updated_at；AI 块增删/总结修改属于真实内容修改。永久删除复用当前生命周期并清理私人 AI 附属数据，Token 账本保留匿名计量。

`useAutosave.ts` 持有文件身份、服务器基线、当前草稿、输入序号和单一 in-flight 请求。800ms 防抖；IME 组合结束后调度。请求携带提交时的快照，返回只确认该快照；较新输入继续排队，不替换整个草稿。首次创建成功只换身份，不重置新输入。失败停止自动重试，用户重试仍用原创建键；Daily 409 重读并提示，不将新草稿覆盖到既有 Daily。
各页面接入公共 hook，App 导航接入 flush；保存网络期间可继续输入，flush 等到最新有效草稿落库再切换。读取 stale/AbortController 保留现有机制。卸载/关页只作 best effort 与 beforeunload 提醒，不把 sendBeacon/keepalive 当成成功提交保证。暂不持久化本地草稿，避免多一份日记及恢复冲突。

## 3. 交错 AI 内容与旧数据

**Problem**：textarea 无法把部分文字独立着色；将 AI Markdown 混入用户正文会导致下一次分析把 AI 当事实。**Impact**：插入位置不可靠、删除难区分、总结后反复分析自身。

| 方案 | 取舍 |
|---|---|
| Markdown 标记/字符偏移边表 | 编辑前文易破坏锚点，标记可被误改，角色判断脆弱 |
| 原文件可空 JSONB blocks + Text 阅读投影 | 保留三表/旧字段，稳定块 ID，最少跨表一致性；推荐 |
| 富文本编辑器或通用块/版本表 | 依赖与编辑体系重构多，Stage 4 再评估 |

仅 journals/inboxes 增加 `content_blocks JSONB NULL`。结构为顺序数组，block 的 `id UUID` 稳定，kind 为 user / ai_reply / ai_summary；AI block 有 request_id，user 原文不 trim。用户正文段用原生 textarea，AI 段用蓝块；总结可用单独 textarea 修改，角色仍为 ai_summary。
`content_blocks` 一旦非 NULL 是该文件的权威正文；content 在同一事务由服务端投影，供当前普通搜索、卡片、Markdown、Trash 阅读复用。用户段逐字输出（不凭空加段落）；AI 回复以独立 Markdown 引用并标「AI 回复」，总结以 `\n\n---\n\n` +「AI 复盘」投影。`content` 不再用来推断作者。普通列表无需携带大块数组；编辑从普通详情读取 blocks。Search/Folder/Trash 查询继续使用 content，不拆建全文索引。
AI 前先把最后一个 user 段封口，并预留一个空 user 段在蓝块之后；回复插在该调用记录的边界，不按响应到达时的光标猜位置。块 ID 不因编辑改变，不自动合并相邻段，不做任意拖动/重排。删除蓝块由服务端按 block ID 操作。
服务端只接受用户段编辑、合法总结编辑和已有块保持；禁止客户端伪造 ai_reply、篡改 request_id 或把已有 AI 段改为 user。复制 AI 文字到用户 textarea 属用户主动采纳，不可能靠算法推断其思想来源。

旧行迁移时 blocks 保持 NULL，content/时间/ID 原样；GET 纯读且不给旧数据回填。第一次使用结构化写作时显式提交一个等价 user 块，版本变化但正文不变时保留 updated_at。旧正文里疑似 AI 标记不自动解析。Insight 仅新增保存版本/创建幂等字段，仍用普通 Text；AI 草稿经用户添加成为其编辑的 Insight，不建通用块系统。
新/改正文校验阅读投影总长度 50,000 Unicode 码点，且用户文本至少有一个非空白字符（新生成 Journal 可由总结块提供有效内容）；旧超长数据仍可读，未改正文时允许改标题/Folder，不能因拆块截断旧文。迁移及编辑纯转换不重跑正文新限制；调用 AI 可读取旧文，但追加超限必须保留结果并提示调整，不能截断。

## 4. 增量检查点与局部事务

**Problem**：简单长度游标不能处理改前文、Unicode 或全文总结；上游调用与数据库无法原子提交。**Impact**：跳过文字、重复计费、AI 内容回流、回复附错位置。

新增 `ai_checkpoints`：`file_type, file_id` 唯一、consumed_user_text Text、last_request_id UUID、updated_at。此快照只为判定增量，覆盖上一份，不是历史或长期记忆；删除源文件时清除。服务限定 type 为 journal/inbox，跨表身份由事务检查，不建 files 总表。
用户序列 U 为按顺序拼接 user 块的原始文本；AI 段全排除。旧 NULL blocks 视 content 为 U。C 是最后成功消费的用户快照。

1. 无 C：本次输入为 U。
2. U 以 C 为前缀：本次输入为新增后缀，包括原始空白；全空白且无问题不调用。
3. 否则按 Unicode 码点找最长公共前缀，发送当前 U 从首个差异开始的后缀并标为修订。仅删除尾部时发送「旧内容被删」及差异位置的修订说明；没有剩余有效文字、没有问题则不调用，C 不推进。不能用 UTF-16 code unit 的长度混算。
4. 有问题时可加最多最近 3 轮（6 消息、合计最多 4,000 码点）对话上下文，按新到旧选完整消息，不混入旧全文；仅剩问题也可调用。摘要不是自动上下文。
5. 成功附着回复后 C=本次捕获 U；失败/冲突保留原 C。删除 AI 回复不回退 C。单篇完整复盘成功生成预览后将其源检查点更新为本次 U（源仍一致时）；多篇完整复盘对全部源各自更新。后续新增仍走后缀；失败或源改变不更新。

局部调用串行最小实现：前端 flush 保存 → 封口/快照 → 90 秒内锁定当前编辑/导航 → 后端短事务登记请求/源版本并释放事务 → 上游模型/可选搜索 → 持久化结果和 usage → 短事务锁源并比对 revision/U、原子插入蓝块/更新 content/revision/检查点 → 返回最新文件。上游 HTTP 期间不得持有数据库行锁或未提交事务。
另一标签修改源则记录 conflict，保留 AI 结果但不插入、不推进 C；用户可以查看/复制已有结果或基于最新正文重新请求（新的付费调用必须由用户点击）。正常局部回复不弹确认。实现阶段若需开放调用时继续写作，作为更复杂替代另行评估，不本期预做自动重定位。

## 5. 请求、设置与计量存储

- `ai_requests`：UUID 主键（客户端幂等键）、kind local/review、payload_hash、status pending/ready/applied/failed/conflict/unknown、sources JSONB（typed identity、revision、用户快照、标题/日期/Folder）、question/settings 快照、结构化结果、saved_target、错误分类、created_at/completed_at。只保存业务恢复必需信息，不保存推理链或任意日志。总结保存另存 save_payload_hash，键复用必须验证 body hash。
- `ai_usage`：独立 UUID 主键、request_id（可空 FK，源私人数据删除后 SET NULL）、subcall_index、官方 response_id、prompt_tokens/completion_tokens/total_tokens、计量 known/unknown、search_requests、created_at。request_id+subcall_index 唯一（非 NULL），按官方每次 HTTP usage 加总；cache hit/miss 仅详情，不能再加到 prompt_tokens；无需第二份累计计数器。
- `ai_settings`：单行 id=1、custom_prompt Text 默认空、web_enabled 默认 true、revision 默认 1。GET 缺行返回默认值不创建；首次 PATCH 建行，之后 CAS。Key 不在表内。

请求登记有唯一幂等键；同键同 payload 再次 POST 只返回已有状态/结果，绝不再调用上游；不同 payload 409。同文件仅允许一个 pending AI（local/review，包括多篇中同源），短事务以固定 type/id 顺序锁源并检查，避免两个调用共享旧 C。跨不同文件默认最多两个功能调用并发，简单进程限额，不引入调度服务；本地单进程运行是阶段前提。
同步 POST 路由执行完整调用，正常完成返回结果；pending 可由重放/查询观察。无后台 worker/队列。上游总截止 90 秒、搜索单次 10 秒，结果大小/输出有上限；请求登记 120 秒后视为状态不明，应用重启把先前 pending 记 unknown（仅在已授权运行环境）。不自动重发，用户显式重试用新键并知道可能已计费；GET 不做状态写入，逾期状态由 POST/启动恢复处理。
前端在发送前只将 request_id、kind 和源 typed IDs 登记到 localStorage 的小型恢复索引，不存日记、问题、提示词、预览或 Key；关闭重开先按该 ID 查询后端。已完成结果保留最近一次入口，用户可清除入口，删入口不删除后端结果或账本。若迟到上游返回时 request 已 unknown/不再拥有 pending 状态，记录已知 usage/结果供查看，不附着正文或推进 C，不能覆盖较新调用。
每个已完成子调用先写 usage；失败的后续搜索/模型轮不抹去先前 usage。官方 usage 缺失或进程在落账前中断只能报告未知，无法承诺软件累计等于供应商账单。结果已持久化但回复 HTTP 丢失可查询恢复，重复确认不再次计 Token。

## 6. 官方 API 与搜索

后端环境 `DEEPSEEK_API_KEY`、`BRAVE_SEARCH_API_KEY`，模型/官方地址固定，不接受前端任意 base_url。只有服务器调用 `https://api.deepseek.com/chat/completions`；`model=deepseek-flash`、`thinking={type:disabled}`、`stream=false`，局部 max_tokens=512、复盘=4096、timeout 总 90 秒。输出 finish_reason=length 视为不完整，保留预览/usage但不附着或推进 C；不隐式再花费续写。
多篇输入允许达到 15 份现有 50,000 码点正文（最多 750,000 码点），UI 显示实际选中文本量；不私加小于产品上限的隐藏裁剪。官方上下文限制与模型参数实施前再核实；超限拒绝并提示减少选择，不自动分批再总结。大型输入成本高，用户点击明确的「复盘所选 N 篇（X 字）」才发送，不自动批量调用。
搜索仅注册一个 function `web_search`，入参 public_query（1～120 码点），最多 2 次搜索/功能调用、每次最多 5 条结果、摘要每条最多 600 码点；最多 3 个模型子调用（工具前、必要第二轮、最终答案），达到搜索额度后工具关闭再生成。重复工具请求复用本次结果，非法工具/参数拒绝且有界结束，不执行任意 URL/命令。
Brave 使用固定 HTTPS Web Search endpoint、服务端认证头；模型只看到标题、HTTP(S) URL 和摘要。无 Answers 服务、无网页抓取。搜索前提炼公共问题；服务端拒绝邮箱/电话号码/证件样式、长段与日记连续匹配的原文（阈值 12 码点），避免 private prompt 被放入 query。该检查是可验证拦截，不能宣称语义上绝无隐私泄漏；敏感人名/私事或安全性不明确的 query 默认跳过，提示用户把需要查询的公共主题单独提问。绝不自动退回发送全文。
自定义 prompt、源正文、搜索摘要各作为低于固定安全规则的内容；检索片段内「忽略规则」「上传日记」等视为数据。模型没有写数据库、删除文件或读取 Key 的工具。联网 off 或 Key 缺失不给工具；Key 缺失状态与 user preference true 区分。搜索失败可继续不联网回答并显式标记，依赖外部事实的问题则承认无法核实。

官方核对（2026-10-10）：[DeepSeek 模型入口](https://api-docs.deepseek.com/)、[Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)、[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) 支持上述默认模型、函数工具与 usage；[Brave Web Search](https://api-dashboard.search.brave.com/documentation/services/web-search)、[价格](https://api-dashboard.search.brave.com/documentation/pricing) 用作接入依据。Brave Search 当前标价 $5/1,000 请求，额度/条款实施前复核；不是免费无限搜索承诺。本轮未注册账户、读 Key 或进行付费调用。

## 7. 复盘、Insight 与删除事务

复盘用同一个请求生命周期，sources 在固定顺序的短事务中读取；最多 7 distinct 日期/15 typed files。模型结果为事实/推测/依据/三角度/逻辑链/追问/Insight 数组，Pydantic 验证后形成可编辑 Markdown 预览；无效 JSON/虚构 source ID 是失败，保留 usage，不偷偷再调用修 JSON。
复盘生成成功且源仍一致：请求 ready 与各源 C 在同一事务落库；不写文件正文。确认只接受预览对应用户编辑后的正文及目标参数，锁源重新验证；单篇 Journal 追加 ai_summary，Inbox/多篇新建只含 ai_summary 的 Journal 并带空 user 续写段。目标与 request.applied/saved_target 同一事务提交。任何 FK/版本/长度失败全部 rollback；确认重放回同一结果。检查点停留在生成时消费的 U，摘要编辑或确认不把摘要计为用户事实。
Insight 草稿由 review 结果提供，每项有稳定 draft_id、一个观点、多个事实引用。用户主动添加后用现有 Insight 新建（client_create_id 复用 draft_id），正文可改；已有 Insight API负责幂等，不为草稿建立状态机/新事实表。取消不创建，首次有效自动保存后才成为文件；使用创建返回的 target ID 导航，后续人工新增仍可正常新建。
源 soft-delete 保留 blocks/C 以便恢复，但普通 AI 入口不可访问；revision 使在途结果失效。Inbox 硬删或 Journal/Insight 永删时清理其 C 与含该源快照/问题/结果的 ai_requests（可能是多源请求）；保留生成后已保存的独立 Journal/Insight 正文，不自动级联删除用户成果；ai_usage 断开请求 FK 保留匿名全局计量。锁源顺序一致，避免结果在删除后重新落库；缺失 request 的旧蓝块只显示文本与「调用记录已清除」。不建后台清扫任务。

## 8. 迁移、风险与验证

T01 一次协调线性 Stage 3 Migration 接 M3，字段/四张 AI 表一起建；不修改历史迁移，不回填正文，不新增触发器。Model 注册、测试无残留清单扩展到新表，保存散列/旧 JSON 空值/sequence/时间快照。本期默认 pytest 仍独占 seekjournal_test；不为并行改测试配置层。个人库升级单独授权并先准备备份与恢复检查，不在规划轮进行。

| 高难度点 | 难处 / 本阶段必需理由 | 更简单替代及舍弃原因 |
|---|---|---|
| 保存一致性（T01/T02，4） | 每页生命周期不同、响应乱序/创建重试/跨标签；否则自动保存会丢字 | 仅手动保存不满足需求；CAS 比自动合并简单，采用 |
| 块与旧数据（T04，4） | textarea 局限、身份校验/原文投影、旧超长文；否则增量分不清 AI | 整篇末尾 AI 面板更简单但不满足交错；JSONB 比富文本小 |
| 增量与上游状态（T05，5） | 修订/Unicode、检查点原子性、上游计费不可回滚；为核心陪伴体验 | 每次全文更简单但不满足已确认增量；锁当前编辑省去重定位 |
| 安全搜索（T06，4） | 模型工具有界、隐私检索词/引用、故障计量；已确认联网 A | 始终不联网不满足需求；摘要比网页爬虫便宜 |
| 复盘保存（T08，5） | 多源限额/过期、跨模块一次确认、防双建；为正确保存总结必需 | 只给复制文本最简单但不能满足目标落库；单事务比队列小 |
| 阶段验证（T11，4） | 真实付费链路与 Mock/旧迁移/组合回归需分开 | 只有 Mock 不能证明模型、风格与实际联网 |

核心学习点最多三个：revision 条件更新防覆盖；blocks 的作者身份与用户投影；上游请求幂等/usage 与数据库事务的边界。其余未来技术不提前教学或实现。
