# SeekJournal — Stage 3 Development Task Plan

> 2026-10-10。Goal：在现有基础记录上交付 AI 陪伴写作、复盘与 Insight 草稿。
> Architecture：三表不合并；CAS 自动保存、可空 blocks、短事务检查点/幂等请求、官方模型与受限 Function Calling 搜索。
> Tech Stack：沿用现有技术栈，无新增运行依赖的默认方案。
> 状态：S3-T01 已获用户明确开始授权，执行状态见 §17；T02～T11 仍「规划，未授权开始」。规划和历史记录不自动授权其他任务；具体资源及 Git 权限以本轮用户执行指令为准。

## 1. 基线、阶段入口与共同 DoD

本轮源码/Git事实见 `stage3-architecture.md` §1，Stage 2 的实际验收历史见 `stage2-tasks.md` §20。T14 技术验收附接受/复核未闭环项，后续 S2-F01 修复在本轮有定向纯逻辑证据；没有重新跑后端/浏览器或个人库查询，不把历史报告数量当本轮验收。
S3-T01 开始前由 Lead 只读核对 Stage 2 实际集成基线、T14 用户接受/独立复核及 F01 修复后验证；未闭环先报告，受影响开发待确认，继续保持规划完成状态，不自动重新启动 S2 Task 或覆盖历史记录。
每 Task 必读根/角色/协作规范与当前阶段相关通用规则，前置功能需可使用且已独立验证；同批独立模块可从共同验收基线开始。开发先写有意义的失败/边界用例 → 最小实现 → 自测 → 停止写入交接 → 新对话独立测试 → 列明 Codex 风险审核 → 授权整合/回归 → 用户接受；未获 Git 权限保留 diff 并标待提交/整合，不伪造后续依赖已具备。
每项报告按协作 §6 八项；具体请求/SQL/浏览器证据、退出码、故障分类、旧数据保护、服务收尾与未验证项必需。所有任务包含 Stage 2 受影响回归，无无关重构或新增阶段功能。难度 1=简单局部，3=中等集成，5=跨模块一致性/高失败风险；不是工时或模型能力排名。

## 2. 总表、角色与依赖

模型/接入只在 `agents/multi-agent-workflow.md` §1 维护，采用本轮用户指定配置；执行者只读确认实际会话，配置未确认不能宣称多模型验证。

| Task | 可独立验收的目标 | 难度 | 开发 / 独立测试 | 前置 | Codex 审核 |
|---|---|---:|---|---|---|
| S3-T01 | 旧数据兼容、版本/创建幂等与 AI 数据基础 | 4 | Codex / 新 Codex 对话（本次用户指定） | Stage 2 入口闭环、规划审核；本次用户明确授权开始，历史未闭环项保留 | 迁移/写冲突/删除隐私 |
| S3-T02 | 三类稳定自动保存 | 4 | WorkBuddy / DSH | T01 | 乱序与导航防丢字 |
| S3-T03 | 官方模型接入、持久设置、Token 账本 | 3 | DSH / WorkBuddy | T01 | Key/usage/未知计量 |
| S3-T04 | 原生 textarea 与 AI 块编辑/阅读/删除 | 4 | WorkBuddy / DSH | T01、T02 | 作者身份与旧文投影 |
| S3-T05 | 局部增量互动与请求恢复 | 5 | Codex / DSH | T01、T03 | 检查点/幂等/跨事务，独立测试必需 |
| S3-T06 | 有界联网搜索与引用 | 4 | DSH / WorkBuddy | T03、T05 | 搜索隐私/注入/计费 |
| S3-T07 | Journal/Inbox 陪伴写作完整界面 | 3 | WorkBuddy / DSH | T04、T05；T06 集成前就绪 | 请求与编辑状态联动 |
| S3-T08 | 单/多篇复盘生成与一次保存事务 | 5 | Codex / WorkBuddy | T05、T06 | 多源/过期/一次落库，独立测试必需 |
| S3-T09 | 复盘选择、预览、一次确认与目标导航 | 3 | WorkBuddy / DSH | T07、T08 | 无（不改算法/契约；接口风险归 T08） |
| S3-T10 | 一观点一份 Insight 的自主添加闭环 | 2 | DSH / WorkBuddy | T02、T08 | 无（复用已审核创建幂等与普通搜索） |
| S3-T11 | 阶段组合回归、真实 API 验证与交付 | 4 | WorkBuddy 主验收 / DSH 交叉关键场景 | T01～T10 各自通过与约定整合 | Codex 全部列明风险收口 |

Codex 对自身开发项的设计自审不能替代独立测试，WorkBuddy/DSH 在新会话实际检查 diff、运行边界用例与必要集成；Codex 风险审核记录与开发自测区分。T11 不把 WorkBuddy 测其自身前端当全阶段独立性：各自开发项依赖对方的独立记录，DSH 对 WB 实施路径重新执行关键端到端；Codex 对迁移/跨模块安全定向核验。
复杂项交 Codex 是按数据/跨模块风险；UI 由 WorkBuddy 连续保持页面上下文，DSH 承担明确契约的后端接入与常规闭环，双方交叉测试，按首次实际产出与额度可经 Lead 调整，不声称已有性能对比。

## 3. S3-T01 — 数据与安全写入基础

- **目标/范围**：新增架构 §2～5 必要字段/四张 AI 表、原子 revision 条件写、创建幂等；GET 零写、软删恢复兼容、私人请求清理/匿名计量保留。只是存储与保存契约，不调用模型、不做自动保存 UI。
- **预计文件**：`backend/app/{journal,inbox,insight}/{models,schemas,service,router}.py`；`backend/app/trash/{schemas,service,router}.py`；新 `backend/app/ai/{__init__,models}.py`、`backend/app/writing/{__init__,schemas,service,router}.py`（只放真实共用块校验/投影，不做通用 CRUD）；`backend/app/main.py`、`backend/alembic/env.py`、新线性 Alembic migration（文件后缀 `_stage3_writing_ai.py`，revision 由执行时工具生成并登记，不编造）；`backend/scripts/prepare_test_db.py`、`backend/tests/conftest.py`、原相关 CRUD/Trash/迁移测试、新 `test_stage3_migrations.py`、`test_file_revisions.py`、`test_file_create_idempotency.py`。
- **前置/接口**：Stage 2 入口及四文档审核；产出 API §1～2 的后端文件详情、CAS、创建键及块操作原语，供 T02/T03/T05 使用。
- **步骤**：① 比对代码/测试/HEAD、fixture 与隔离库，确定迁移单写者；② 写旧数据/并发失败用例；③ 线性迁移+Model 注册+扩展残留守卫；④ 在各业务服务接 CAS/幂等/块投影与删除清理；⑤ 跑指定及受影响回归，提交 diff 给 WB 独立检查。原 CRUD 事务仍归对应 Service，不能复用会提前 commit 的 create 来完成未来跨模块事务。
- **验收**：Stage 1→M3→S3 合成升级各旧字段/ID/时间/digest 不变，blocks NULL；无 CHECK 截断旧内容；同时旧 revision 更新仅一方成功；失响应重放创建不双建；同键异体409；soft-delete/restore版增加但 updated_at不变；Inbox/永删清除敏感附属、已保存成果不被删、usage保留；单 head/check一致。
- **测试方法**：指定四份新测试+`test_stage2_migrations.py test_test_database.py test_trash_api.py`，真实 PostgreSQL 两 Session 竞争、事务 rollback、旧超长文、AI block 伪造/重排/超限、GET 前后摘要；只在分配库运行 migration。
- **风险/难度 4**：修改全部文件写契约与迁移；Codex 审核旧数据、并发 WHERE、更新时钟和删除私人数据；独立 WB 必须提供 DB/HTTP 证据。

## 4. S3-T02 — 三类自动保存

- **目标/范围**：800ms 防抖、单文件串行写、即时保存、状态、flush 导航、响应丢失创建重放、冲突保草稿；不做 AI 或本地持久草稿。
- **预计文件**：新 `frontend/src/hooks/useAutosave.ts`、`frontend/src/utils/autosave.ts`、`autosave.test.ts`；现有 `App.tsx`、`components/JournalEditor.tsx`、`JournalDetail.tsx`、`pages/InboxPage.tsx`、`InsightPage.tsx`、`api/{journals,inboxes,insights,trash}.ts`、`types/{journal,inbox,insight,trash}.ts`、`utils/dirtyState.ts` 与相关测试；必要 `App.css`。不改后端契约。
- **前置/接口**：T01 CAS/创建键已验；产出 useAutosave 的 draft/状态/flush/retry 与页面编辑锁接口，供 T04/T07/T09 接入。
- **步骤**：① 为草稿序号/队列/版本失败写纯逻辑测试；② 封装 hook 和 API 类型；③ 三页面串行接入同一保存逻辑；④ App统一所有离开出口await flush，失败停留；⑤ 故障/浏览器/重开验证，停止交 DSH。
- **验收**：三类新建一次、Daily无空记录；持续输入在旧保存响应后不丢；失败无自动重发/不清Dirty；两标签409保草稿；模块/卡片/Daily/内部链接/复盘入口保存后切换；列表500不重新POST；已保存后关闭重开一致、无未保存输入提示；IME不存半个拼音。
- **测试方法**：`autosave.test.ts`，Node 假时钟/可控Promise测乱序，不增加框架；build/lint与现有utils；浏览器延迟 PATCH、丢响应、500、创建409、键盘/390px/刷新重开。数据库 typed IDs确认只建一份。
- **风险/难度 4**：各页面内嵌编辑生命周期和 App busy可能循环阻止flush；Codex检查取消/导航/较新输入不被旧响应覆盖。替代与理由见架构 §2/8。

## 5. S3-T03 — 官方模型、设置与计量

- **目标/范围**：后端官方HTTP最小客户端、模型默认、Key状态、持久设置/CAS、模型子调用 usage账本/全局及单文件查询；无局部算法、搜索或复盘业务。
- **预计文件**：新 `backend/app/ai/{client,schemas,router,settings,usage}.py`；T01 `ai/models.py` 只按既定字段必要补充（不新迁移）；`backend/app/main.py`串行注册；新 `backend/tests/{test_ai_client,test_ai_settings_api,test_ai_usage}.py`；新 `frontend/src/pages/SettingsPage.tsx`、`api/ai.ts`、`types/ai.ts`、`components/TokenUsage.tsx`；`App.tsx`/`App.css`本批只由 T02 修改，T03交付接入片段由其停止后串行应用。忽略的真实.env不改；示例/README由Lead同步。
- **前置/接口**：T01表就绪；产出有界HTTP client、usage记录函数和 API §3 接口。T05使用其HTTP transport不复制Key逻辑。
- **步骤**：① 查官方参数/HTTP库实际可用性；② Mock认证失败/超时/usage；③ 实现服务器环境Key及固定地址、单行设置；④ ledger唯一子调用和聚合；⑤ Settings/Token最小UI，真实调用仅后续授权窗口。
- **验收**：固定官方deepseek-flash、非思考/非流式；无Key503但原手动功能可用；设置默认GET零写/修改重启保留/CAS；cache不二计、unknown不算0、删除来源不减累计；响应/浏览器/日志无Key；工具多轮计量能力可供T06使用。
- **测试方法**：新三份pytest，mock urllib边界、不真实收费；重复record/rollback/重启设置/匿名账本查询；浏览器设置与Token占位/真实Mock值。T11再测真实官方usage。
- **风险/难度 3**：密钥与计量状态；Codex审日志脱敏、未知统计与客户端超时。标准库替代SDK更小，实际必须新依赖时先报告，不擅自安装。

## 6. S3-T04 — 结构化 textarea/AI 块

- **目标/范围**：稳定段ID、user文本区、AI蓝块、总结来源保留、菜单/长按/右键删除、安全阅读、空尾段；使用合成蓝块测试，不调用模型、不计算增量。
- **预计文件**：新 `frontend/src/components/{WritingEditor,AiReplyBlock,WritingContent}.tsx`、`frontend/src/utils/{writingBlocks,writingBlocks.test}.ts`、`types/writing.ts`、`api/writing.ts`；现有 `JournalEditor.tsx`、`JournalDetail.tsx`、`InboxPage.tsx`、`TrashPage.tsx`、`App.css`。现有 MarkdownContent仅按需复用；App接入口串行。
- **前置/接口**：T01块校验/删除API、T02保存hook；产出结构化编辑器的blocks/onChange/封口/锁定props给T07。
- **步骤**：① 纯逻辑测Unicode、块投影与原文等价转换；② 原生textarea分段显示，复用autosave；③ 删除块请求及真实GET刷新；④ 阅读/Trash只读区分作者；⑤ 浏览器与旧源码往返验证。
- **验收**：无AI的旧正文逐字保留，光标与IME正常；已有AI不在user输入中；删除任一回复不删用户段/其他回复，不回退C；三种菜单交互和键盘可用；蓝字左竖线；总结可编辑但保持kind；raw HTML/危险URL继续受限；仅编辑标题不截断旧超长文。
- **测试方法**：writingBlocks纯逻辑、build/lint、现有Markdown/Link测试；合成blocks的HTTP保存/删除与浏览器390px/键盘，Trash恢复前后块一致。
- **风险/难度 4**：跨textarea的Markdown连续语法与来源标记；采用分段编辑、整篇阅读投影（阅读时user跨段还原），不搞单textarea覆盖层。Codex核对保存投影/作者验证。

## 7. S3-T05 — 增量局部互动

- **目标/范围**：API §4、架构 §4～5 的增量/修订/问题上下文、请求幂等/恢复、短事务AI插入/C更新、风格基础提示词。先不接搜索，T06按同一orchestration接口加入工具。
- **预计文件**：新 `backend/app/ai/{incremental,local,requests,prompts}.py`；`ai/router.py`、`ai/schemas.py`、`writing/service.py` 与 `main.py`必要注册；新 `backend/tests/{test_ai_incremental,test_ai_local_api,test_ai_request_recovery}.py`；不改前端页面。
- **前置/接口**：T01存储/投影、T03 client/ledger；产出POST local、GET request、有界模型轮次执行入口供T06和T08、稳定AiRequest契约供T07。
- **步骤**：① 为首次/追加/修订/全删/Unicode/总结后新增写确定性反例；② 实现C比较与user-only消息组装；③ 请求登记/重放/源锁与当前版检查；④ 模型结果/usage、文件插入/C原子落库与错误分类；⑤ 竞争/重启/丢HTTP响应验证后交DSH。
- **验收**：首次已有正文全读；第二次只新增；无新增有问题带有限上下文；无两者原句且零调用；修改前文明确修订、AI段永不进事实；同键无第二付费/蓝块；上游失败/源变/落库失败不跳C；过期pending的迟到结果只记usage/结果不再附着；锁释放不横跨HTTP；summary不改变后续增量模式。
- **测试方法**：三份新pytest、mock捕获模型消息和真实PostgreSQL两个会话；每个失败分别断言request/status/usage/C/blocks；源软删/硬删、并发pending/过期/重启unknown、结果已存HTTP丢失后查询。
- **风险/难度 5**：上游不是DB事务、UTF-16/码点与修订、作者隔离；Codex开发自测与DSH独立执行分开，核心通过条件是失败未越过检查点。最简单锁当前编辑，暂不做在途重定位。

## 8. S3-T06 — 联网搜索

- **目标/范围**：Brave普通Web Search、Function Calling有限轮次、公开query隐私拦截、citation和降级、所有模型子调用Token；不引入MCP/Answers/爬虫/供应商框架。
- **预计文件**：新 `backend/app/ai/search.py`、`tool_calls.py`、`backend/tests/{test_ai_search,test_ai_tool_calls,test_ai_search_privacy}.py`；T05 orchestration 中约定的 `ai/local.py` 接入点、`prompts.py`工具规则、`schemas.py`web_status/citations（先冻结契约，不边做边改）；本批这些后端文件由T06单写，T07只前端。
- **前置/接口**：T03/05已验；产出有界search executor供local/review使用。无搜索Key时可Mock开发但真实验收仍待验证。
- **步骤**：① 官方接入/成本只读复核；② Mock工具参数、重复/恶意/超限/失败用例；③ 固定endpoint和safe public query校验；④ 最多2搜索/3模型轮、tool关闭与usage累计；⑤ 引用/降级验证，获付费权限时小样本真实链路。
- **验收**：开关默认true但只必要搜索；关闭不给工具/零search；无配置准确说明；邮箱/电话/长原文/私密prompt拒绝外发；恶意网页无写工具/不泄密；安全http(s)引用对应真实结果；搜索失败不伪造已联网；重复工具不多计search，后轮失败保留首轮Token。
- **测试方法**：三份新pytest，捕获每次HTTP/模型消息、搜索关闭/关键词隐私回归；合成文案人工核对公共query、来源；真实Brave测试授权后记录请求数/时间/引用与模型usage。
- **风险/难度 4**：模型 query 可能包含私人语义，规则校验不是绝对隐私证明；不确定则跳过，必要公共主题用户单独问。Codex审核query样本/工具指令/计费上限；不以mock声称真实联网可用。

## 9. S3-T07 — 陪伴写作 UI

- **目标/范围**：Journal/Inbox局部按钮、独立提问、处理锁/恢复/本次usage/引用、自动插入与续写、noop文案。不做复盘选择器。
- **预计文件**：新 `frontend/src/components/AiWritingActions.tsx`、`utils/{aiRequestState,aiRequestState.test}.ts`；`WritingEditor.tsx`、`JournalEditor.tsx`、`JournalDetail.tsx`、`InboxPage.tsx`、`api/ai.ts`、`types/ai.ts`、`TokenUsage.tsx`、`App.tsx`、`App.css`。仅前端，不能与T04同时修改。
- **前置/接口**：T04/05；T06可并行开发，集成验收须联网接口实际可用；消费API§4固定schema。
- **步骤**：① flush/封口/处理中/成功/失败/unknown状态纯逻辑；② 接按钮/提问/90秒可见等待锁；③ 发送前持久化仅request ID/身份的恢复索引、用返回详情更新基线、下方续写/关页恢复（不存正文或Key）；④ noop/usage/citations/错误说明；⑤ 浏览器端到端交DSH。
- **验收**：写作→调用→蓝块→下方继续→自动保存→刷新重开，第二次真实payload仅新增；无增量无问题原句；显式问题续聊；重复点击单调用；关页重开查询已发request、不自动付费；409保草稿/结果，列表刷新失败只读取；Token本次各轮合计。
- **测试方法**：aiRequestState.test、build/lint、浏览器真实HTTP+Mock模型（不可仅mock前端返回）；验证无请求noop、迟到响应/unknown与文件切换、网络断开、菜单删除与真实DB内容。
- **风险/难度 3**：autosave和AI两类busy误解锁；Codex定向检查基线刷新与重复调用。暂不做流式显示/边写边响应。

## 10. S3-T08 — 复盘后端与一次保存

- **目标/范围**：单/多源用户正文复盘、7日期/15file限额、结构化结果/证据/Insight草稿、ready检查点、一次save原子追加或新建Journal。不是UI或自动生成Insight。
- **预计文件**：新 `backend/app/ai/{review,review_save}.py`、`backend/tests/{test_ai_review_api,test_ai_review_evidence,test_ai_review_save}.py`；`ai/{router,schemas,prompts,requests}.py`、`journal/service.py`内必要可组合事务原语（现有公开CRUD事务保留）、`writing/service.py`；不改T06 search executor。
- **前置/接口**：T05/06；消费官方/工具/ledger、块投影；产出API§5～6的review对象、draft_id与保存接口给T09/T10。
- **步骤**：① 边界/去重/软删/快照/证据不实/一次保存失败用例；② 固定顺序短事务读取源、拼user-only全文；③ structured output验证与三个角度、ready+C；④ 保存锁/源快照/目标正文限制及幂等事务；⑤ 真实PostgreSQL竞争/rollback后WB独立测试。
- **验收**：1/15file与7日期通过、16/8拒绝且零模型；same-date多篇不误限；AI段/总结不作事实；quote可回源；源变后不保存旧总结；单Journal`---`追加、Inbox/多篇建Journal源不动；同save双击只一个目标；无效Folder/超限/DB失败零半写；summary后新增仍增量。
- **测试方法**：三份新pytest+增量回归；两会话竞争、源删除/日期改/正文改、实际SELECT/DB投影、确认丢响应重放、无效JSON/截断/usage unknown、Insight零/多草稿；真实模型风格另在T11授权样本验证。
- **风险/难度 5**：多源稳定性与事务，不能调用已有自动commit服务导致半写。Codex开发、WB新会话独立验证，审核记录明确旧正文完整、C与预览同步、save仅一次。

## 11. S3-T09 — 复盘 UI

- **目标/范围**：单篇入口、Journal/Inbox分页跨页选源、去重计数/日期计数、显示文本量、可编辑预览、默认目标、一次确认及恢复，不实现模型算法。
- **预计文件**：新 `frontend/src/pages/ReviewPage.tsx`、`components/ReviewPreview.tsx`、`utils/{reviewSelection,reviewSelection.test}.ts`；`api/ai.ts`、`types/ai.ts`（本批由T09单写）、`App.tsx`、`JournalDetail.tsx`、`InboxPage.tsx`、`App.css`。T10不改这些共享入口。
- **前置/接口**：T07/08；产出可复用 `ReviewPreview` 的 onAddInsight 回调，由T10组件串行接入。
- **步骤**：① 选源纯逻辑/跨页保留/7日期15file；② flush后进入复盘、明确外发所选正文量；③ 生成/恢复/编辑预览；④ 确认保存一次、返回目标导航；⑤ DSH浏览器独立测。
- **验收**：源身份用type+id不撞号，7非连续日期正确；生成不创建Journal；取消原文不变；一次确认成功，失败保留；新建默认发起业务日期/无Folder、可修改；关闭重开恢复ready；冲突不能保存旧预览；成功后刷新500不重保存。
- **测试方法**：reviewSelection.test/build/lint；浏览器1/15file、7/8日期、双击确认、目标日期/标题、Inbox与多篇源快照前后、迟到结果及失效源。与T10集成后复查添加回调。
- **风险/难度 3**：页面状态/选中跨分页/确认不是生成；无独立新Codex算法门禁，T08接口高风险已审核，缺陷仍按共同流程升级。

## 12. S3-T10 — Insight 草稿自主添加

- **目标/范围**：展示零/多独立观点草稿，用户选单观点后进入现有Insight编辑，添加多事实/修改/放弃，普通搜索相似，复用创建键与自动保存；不语义去重、不自动加关系。
- **预计文件**：新 `frontend/src/components/InsightDrafts.tsx`、`utils/{insightAiDraft,insightAiDraft.test}.ts`；`pages/InsightPage.tsx`、`api/insights.ts`、`types/insight.ts`；ReviewPreview/App/App.css由T09停止后交接串行接入，T10提供组件和回调不并行改入口。无后端新表/迁移/API。
- **前置/接口**：T02/08；消费API§7/draft_id和普通Search；对T09给出草稿选择回调与Insight编辑输入对象。
- **步骤**：① 观点到草稿映射/创建键反例；② 用户主动选添加才初始化编辑；③ 修改与有效自动保存、放弃未建稿、关键词搜索；④ 一观点一份多事实演示；⑤ WB新会话独立验证及串行UI接入。
- **验收**：查看草稿零写、无合适观点可零份；一个草稿创建一次，重复响应不双建；用户能修改观点/加事实、多观点分别新建；只搜索不自动合并；已有手动Insight/Folder/Trash正常；来源删除后独立文本仍在。
- **测试方法**：insightAiDraft.test与Insight现有utils/build/lint；浏览器添加/取消/复试/多事实/多草稿与真实DB数量/内容；普通搜索实际命中，不将前端模拟相似当后端实现。
- **风险/难度 2**：草稿查看误触发autosave、来源与多观点混淆；复用既有创建幂等更小，无额外Codex风险审核项。

## 13. S3-T11 — 独立组合验收与阶段交付

- **目标/范围**：S3-A01～A12、Stage2 A01～A13受影响回归、迁移旧数据/资源安全、真实DeepSeek/Brave合成样本、风格/分析限制及学习验收；不修功能，缺陷退回原负责Task。
- **预计文件**：Lead维护 `docs/stage3-tasks.md`执行记录区、必要 `docs/s3-acceptance.md`、`README.md`实际运行/状态说明；测试者保存忽略的脱敏证据目录。新增必要测试仅验收缺失场景，产品代码零修改。
- **前置/步骤**：① 各项独立记录/风险审核/获授权整合到同一基线；② 查Git/依赖/服务/库并固定独占时段；③ 迁移合成旧数据和后端全量/前端build/lint/utils；④ HTTP/DB/浏览器组合/故障；⑤ 获付费测试权限后真实局部→搜索→单/多复盘→Insight→usage（建议最多8个功能调用、每项2搜索，记录实际；大型样本用Mock，不真实发送750k字）；⑥ 收尾摘要与未验证、用户接受。
- **验收/测试方法**：逐项产品验收表给命令/退出码/真实HTTP/DB与浏览器证据；Mock和真实各列。手工核对至少孤单/冲突/疲惫/证据不足/外部资料五种合成情境的语气、具体行为边界与引用，不声称模型永远遵守。不同实现者关键端到端交叉重跑，Codex抽查高风险失败与DB一致性。无真实API/Key/费用权限则相应项未验证。
- **风险/难度 4**：不可用历史数量或某开发者自测替代；无Key/环境错误/产品缺陷分开。个人库不升级；用户真实使用前另授权升级/运行配置，并完成必要验证。Task全通过、风险审完、整合完成及用户接受后才可宣布Stage完成。

## 14. 执行顺序与并行波次

| 波次 | 推荐安排（最多两个开发者） | 文件/资源隔离与整合门槛 |
|---|---|---|
| 0 | Stage 2 入口/规划审核，T01 串行 | 迁移/公共契约单写；T01独立验后建立共同基线 |
| 1 | T02 WorkBuddy ∥ T03 DSH | 前端编辑页面 vs后端AI+独立设置组件；App/CSS由T02持有，T03接入最后串行 |
| 2 | T04 WorkBuddy ∥ T05 Codex | 前端blocks vs后端incremental；T01块契约先冻结；T04依赖T02、T05依赖T03 |
| 3 | T06 DSH ∥ T07 WorkBuddy | 后端工具 vs前端调用；schema先冻结、T07完整验收等T06接入完成 |
| 4 | T08 Codex 串行 | 复盘/跨模块保存集中单写；另一方可独立测试已交付T07，测试库不重叠 |
| 5 | T09 WorkBuddy ∥ T10 DSH | 复盘入口/preview/API ai vsInsight组件/页面/API insights；共享App/CSS/preview接入串行交接 |
| 6 | T11 验收窗口，暂停产品开发 | 主验收与交叉复测按数据库资源串行，风险审核/用户接受收口 |

∥ 是条件并行：各依赖已独立验收、实际目录/资源空闲且无未提交冲突才开始；不为并行抢改schema或Main。T05无需等前端T04完成即可后端Mock验收；T07不能在T04仍写同文件时启动。前端纯逻辑/build可与后端pytest并行，两个后端DB测试不能默认并行。

## 15. Worktree、资源与 Git 权限

以下是待核实/待授权的资源建议，不创建或占用：

| 所有者 | 建议目录/分支 | FE/BE端口 | 隔离库/责任 |
|---|---|---|---|
| Codex复杂Task | `C:\Programme\demo\SeekJournal-S3-Codex`，`codex/s3-tXX-*` | 5181/8031 | UI `seekjournal_s3_codex_ui_test`；迁移/后端pytest独占seekjournal_test |
| WorkBuddy | 优先核对可复用Work-01，否则 `SeekJournal-S3-WorkBuddy`，`codex/s3-tXX-wb` | 5182/8032 | UI `seekjournal_s3_wb_ui_test`；后端pytest预约seekjournal_test |
| DSH | 优先核对可复用Work-02，否则 `SeekJournal-S3-DSH`，`codex/s3-tXX-dsh` | 5183/8033 | UI `seekjournal_s3_dsh_ui_test`；后端pytest预约seekjournal_test |

工作目录完整新路径均位于 `C:\Programme\demo\`；现有两树有分支/HEAD，先核对所有者与dirty，未经授权不切换/清理。每个同时写代码Agent自己分支/Worktree；Codex规划目录保持文档单写，main只集成。实际Task启动前填写真实HEAD、完整路径、空闲端口/服务PID、文件责任、DB与环境配置和测试者时段，不能直接把本表建议值当实测值。
使用进程 `VITE_API_BASE_URL`/`DATABASE_URL`，不改真实.env，不占8000/5173/5432，不自动启动Compose。UI写入前查询实际current_database与revision；测试端口CORS若需要，只在授权fixture/临时包装处理，不放宽生产CORS。已有node_modules/.venv不假定跨树共享，缺环境报告，不擅自安装。
当前 `get_test_database_url()` 强制seekjournal_test、conftest导入时覆盖DATABASE_URL：后端pytest/迁移/prepare同一时间仅一个Owner。不能设置新库环境就声称pytest隔离；纯Mock后端测试若加载conftest也需预约，不擅自新增配置层。迁移测试用已指定库内私有schema（执行前验证守卫），迁移链单写；独立UI库各自迁移需明确授权。只清自己manifest列出的typed IDs/schema，不清不明数据/重置sequence。

本段记录规划轮权限：文档改动、只读检查、已有无DB写纯逻辑验证；规划轮禁止业务代码/迁移执行/依赖安装/启动开发Task、创建或调其他Agent、commit/merge/push/tag、切换/新建/清理Worktree或分支。后续 Task 的实际授权与执行见 §17，本次 S3-T01 以用户明确执行指令为准，不沿用规划轮禁止实施作为阻断。后续「开始Task」只覆盖明确点名功能及当轮资源权限；创建Worktree、测试库迁移、真实付费测试、commit、main merge逐项写入授权表，未列即不执行。个人库seekjournal升级单独批准，push/tag/删除分支/工作树清理独立授权。
前置集成等待Git权限时，保留diff与证据，不偷偷把diff复制覆盖到别树来绕过授权。共享docs/agents/根由Codex维护，Main/App/CSS和API公共类型在每波明确单写者，交接停止写入后再合并；整合后各树由所有者显式同步并复核基线。

## 16. 测试命令与执行提示词交付

以下供未来获授权执行时使用，本轮未跑数据库测试或构建。先定位Task目录并证明目标库；prepare有建库/升级副作用，只T01/明确迁移授权窗口执行。命令每条单独运行，不预填通过数量。

backend目录：
```powershell
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_file_revisions.py tests/test_file_create_idempotency.py
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_ai_incremental.py tests/test_ai_local_api.py tests/test_ai_request_recovery.py
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_ai_review_api.py tests/test_ai_review_evidence.py tests/test_ai_review_save.py
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests
.\.venv\Scripts\python.exe -B -m alembic heads
.\.venv\Scripts\python.exe -B -m alembic current
.\.venv\Scripts\python.exe -B -m alembic check
```
current/check只在明确进程目标测试库执行，不加载个人库后再声称测试隔离。
frontend目录：
```powershell
npm run build
npm run lint
node --experimental-strip-types src/utils/autosave.test.ts
node --experimental-strip-types src/utils/writingBlocks.test.ts
node --experimental-strip-types src/utils/aiRequestState.test.ts
node --experimental-strip-types src/utils/reviewSelection.test.ts
node --experimental-strip-types src/utils/insightAiDraft.test.ts
Get-ChildItem .\src\utils -Filter *.test.ts | ForEach-Object { node --experimental-strip-types $_.FullName; if ($LASTEXITCODE -ne 0) { throw "纯逻辑测试失败" } }
```
新文件尚未创建；其他Task的准确pytest文件已列于各节，实际提示词逐条给出完整命令而非让执行者猜测。浏览器必须有真实后端和隔离DB，HTTP模型可Mock；写入结果用DB对照，不只看UI成功提示。

启动各Task前按协作 §3～5 交付七项安排以及开发者/独立测试者两份完整可复制提示词：实际模型核对、用途/新会话理由、用户授权、真实路径/branch/HEAD/已有结果、必读具体章节、前置证据、文件/接口/验收、端口/DB/时段、风险审核、Git/迁移/费用权限、精确命令/故障升级和八项简报。独立测试使用未参与该次实现的新会话，写实现前停止原开发者；不得用当前未来资源表编造实测HEAD。此次交付正式阶段规划，具体启动提示词在授权开发前基于最新只读状态填写，不以规划自动派发或启动。

## 17. 执行记录

2026-10-10：完成 Stage 3 四份规划文档及阶段/Agent配置引用修订；所有S3 Task未实施，数据库/依赖/开发服务未变。实际本轮文档校验、Git状态与定向纯逻辑结果以规划交付报告为准；这里不预写开发验收结果。后续由Lead按任务追加基线、授权、开发/独立证据、风险审核、收尾、整合与用户接受，不覆盖Stage2历史。

### S3-T01 开始授权与环境前置检查（2026-10-10，Codex 开发）

- 用户粘贴的本轮执行指令已明确授权 S3-T01，单写者串行，当前目录/分支复用；独立测试改由未参与实现的新 Codex 对话执行。不启动 T02、不调用其他 Agent、不 commit/merge/push/tag 或变更 Worktree。
- 实际基线：`C:\Programme\demo\SeekJournal`，`codex/s03-t01`，HEAD `45c0276f9661e9271a3d86f863f7673f2e19c3e4`，开始工作区干净。精确活动会话模型 ID 未获得可核验证据，不宣称已确认 GPT-6.1-Sol。
- Stage 2 §20 的用户最终接受、学习验收及独立复核未闭环记录保留；本次开始授权不构成 Stage 2 整体验收，也不重启历史任务。
- 环境失败：测试库只读 psycopg 探针 `connect_timeout=5` 超时，退出 1；沙箱外同一探针仍超时，退出 1。Docker 只读查询退出 0，确认现有 `seekjournal-postgres-1` 为 `Exited (255)`。测试库存在性、实际 revision、业务数据、独占条件和个人库保护基线均未验证。未启动/重启/重建容器，未运行 prepare、迁移或数据库写入。
- 已先准备三份新增测试的无数据库入口用例；迁移保留、真实两 Session 并发、HTTP/隐私与完整回归尚待数据库恢复后补齐并执行，当前不是完整验收覆盖或产品实现交付。结果和交接证据存 `.workbuddy/s3-t01-codex/`（已核对被 Git 忽略）。
- 初始 RED 实测：在 backend 执行 `.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_stage3_migrations.py tests/test_file_revisions.py tests/test_file_create_idempotency.py --tb=short`，退出 1，31 failed。用例没有请求数据库；失败原因为源码尚无 S3 migration、expected_revision/client_create_id 被现有 Schema 忽略。属于预期 TDD 红阶段，不是修复失败或已完成实现的回归缺陷。数据库相关命令均未执行。

### S3-T01 开发自测交付（2026-10-10，Codex）

- 用户自行启动既有 PostgreSQL 后通知继续；本轮只读复核测试库实际为 M3、四张既有业务表空、无其他会话，再串行实施。用户另行明确授权 `backend/app/search/service.py` 与 `backend/app/folder/service.py` 仅补 revision 查询/响应投影；这两文件没有其他业务改动。
- 分支/HEAD 保持 `codex/s03-t01` / `45c0276f9661e9271a3d86f863f7673f2e19c3e4`。新增线性 migration 为 Alembic 实际生成的 `3aa16300a58a_stage3_writing_ai.py`，接 M3 `18ecf7e09da6`，历史四份 migration 与 HEAD 完全一致。仅 seekjournal_test 升级；旧数据逐字段/sequence、M3 Inbox/Insight 及 downgrade 在本轮自建私有 schema 验证。
- 实现：三类 revision/创建键/首次 payload 摘要；Journal/Inbox 可空 blocks 与同事务阅读投影；四张 AI 存储表及注册；原子 CAS、创建唯一约束重放、If-Match 删除/恢复/永删；块身份/顺序校验及专用删除；硬删清理多源私人请求/检查点、usage SET NULL 保留、独立已保存成果不级联删除。列表含真实 revision、不带 blocks；GET 不 flush/commit。旧 API 测试逐处显式补版本，fixture 不注入版本。
- 本轮指定 T01 三文件测试退出 0（47 passed；后补软删创建键两用例已在完整回归验证）；Stage 2 指定三文件退出 0（60 passed）；最终完整 `.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests` 退出 0（855 passed，71.25s）。真实 8031 HTTP/DB 60 个检查退出 0，非独立验收；命令由忽略目录包装器在明确测试库进程环境中执行，完整命令/退出码见证据。
- prepare、alembic heads/current/check 均退出 0；单 head/current 均 `3aa16300a58a`，check 无漂移。初次 prepare 子进程退出 0，但日志包装输出编码失败；修正包装器后收尾 prepare 退出 0。其余测试编辑/fixture 脚本错误、旧契约断言差异及实际产品边界失败均保留日志；软删创建键重放误返回 500 经 RED 复现后最小修复为 409，GREEN 两项及完整回归通过，不恢复已删文件。
- 自审风险项：迁移旧数据、原子 CAS/创建并发、时钟、AI 块身份与删除私人数据/账本保留已按本轮实测核对；此为开发自审，不能代替新 Codex 对话独立测试。测试库收尾八表 0、临时 schema 0、其他会话 0；测试 sequence 正常前进未重置。8031 自建进程已停，用户 PostgreSQL 保持运行；个人库仍 M3、18 Journal/1 Inbox，数量/逐表 SHA256/sequence 与本轮起点一致。
- 状态：**实现与开发自测通过，待新对话独立测试、待提交/整合及用户接受；不宣布 Task 或 Stage 整体验收完成。** 未安装依赖、改前端、调用模型/其他 Agent、提交或整合；不开始 T02。个人库升级仍需单独授权，旧前端写入还待 T02 配套，本分支不代表完整 Web 已可用。
- 证据：`.workbuddy/s3-t01-codex/delivery-report.md`、`independent-test-handoff.md`、`commands.jsonl`、`db-closeout.json`、`http-db-evidence.json`、`changed-files-sha256.json`；目录已核对忽略。交接记录精确文件摘要及未提交 diff，开发者交付后停止写入。

### S3-T01-IT-01 最小修复开发自测（2026-10-10，Codex）

- 用户明确授权仅修复超长 If-Match 返回500；分支/HEAD仍 `codex/s03-t01` / `45c0276f9661e9271a3d86f863f7673f2e19c3e4`，保留全部既有未提交T01实现。仅修改 `backend/app/writing/router.py`、新增聚焦测试 `backend/tests/test_if_match_limits.py` 及本记录；不覆盖原独立失败报告。
- 保留严格双引号/正整数正则，提取数字后在 `int()` 前拒绝超过19位，使用现有 WritingError 422；19位以内仍核对 bigint 上限。不改全局整数转换限制、依赖、数据库结构、API契约或其他业务。
- TDD：新增回归修复前退出1（8 failed、10 passed），失败为原始ValueError及六入口500；最小修复后退出0（18 passed）。六类入口验证缺头428、非法422、20/4300/4301/4500位及max+1拒绝，并逐次比对八表全部行，正文/revision/删除状态/关联数据不变；合法小版本和bigint最大值保持解析。
- 指定三文件回归退出0（89 passed、12.91s）；完整 `pytest -q -p no:cacheprovider tests` 仅运行一次，退出0（873 passed、96.62s）。用户另行明确允许既有测试在seekjournal_test私有schema内做合成迁移验证；未独立运行prepare/迁移命令，未迁移public或个人库。
- 本轮开始确认seekjournal_test实际S3、八表空、无其他会话，串行测试；个人库只读摘要。收尾摘要/原报告保护、修复diff及新57文件SHA256见 `.workbuddy/s3-t01-codex/if-match-fix/`；修复报告见 `.workbuddy/s3-t01-codex/if-match-fix-report.md`。
- 状态：**最小修复与开发自测通过，待未参与修复的新Codex对话独立复测、待提交/整合及用户接受。** 本开发对话不能作为本次修复的独立测试者。停止修改，不进入T02、不调用其他Agent、无Git整合操作；Stage2历史未闭环状态保留，不宣布T01或Stage验收完成。

### S3-T04 独立 HTTP/UI 测试库资源准备（2026-10-11，Codex，仅环境隔离）

- 用户明确授权新建 `seekjournal_test_02`，仅在本轮新库执行当前已整合 Alembic 迁移；T05 继续独占 `seekjournal_test`，T04 独占 `seekjournal_test_02`，用途限后端服务与 HTTP/UI 测试。本记录不改变 T04/T05 功能授权、历史验收或完成状态。
- 开始只读核对：main / `faf4c14ebad9422719ff7a96cd197326b5877c3e`，工作区干净；Work-01 / `wb/s03-t04`、Work-02 / `codex/s03-t05` 登记 HEAD 同 main。本轮没有修改两个 Worktree、切分支或 Git 提交/整合操作。
- 复用既有 PostgreSQL 17.11，通过 `postgres` 管理库只读查询确认新库不存在后创建。迁移前实际连接证明 `current_database()=seekjournal_test_02` 且无表。Alembic 子进程沿用既有连接信息，仅替换 database；真实 `.env` 未修改，没有连接 `seekjournal_test` 或个人库 `seekjournal`。
- 创建脚本退出 0；`alembic heads`、`upgrade head`、`current`、再次 `heads`、`check` 各退出 0。实际 revision/current/head 均 `3aa16300a58a`，无 schema 漂移；八表 `folders/journals/inboxes/insights/ai_requests/ai_checkpoints/ai_usage/ai_settings` 各 0 行，另有 `alembic_version`。main 与 Work-01 各自已有虚拟环境运行独立只读探针均退出 0，核对实际 app engine 的目标库、checkout head、revision 与表基线。
- `Get-NetTCPConnection` 和 Docker 状态查询受权限限制，未启动 Compose；`netstat -ano -p tcp` 退出 0，8032/5182 无监听。T04 启动指令运行前再次检查端口，冲突时报告且不停止他人进程；后端使用 Work-01 已有 `.venv`，进程 DATABASE_URL 指向新库，前端进程 VITE_API_BASE_URL 指向 8032。既有 CORS 仅允许 5173，说明中提供运行时内存追加本地 5182 来源的临时包装，不改产品代码/真实配置；指令尚未启动服务或验证 HTTP/UI。
- pytest 隔离仍未支持新库：`get_test_database_url()` 固定为 `seekjournal_test`，conftest 导入时覆盖 DATABASE_URL，迁移 fixture 同样固定库名。T04 不得运行加载此 conftest 的 pytest；本轮未执行 pytest 或 `prepare_test_db.py`，未改测试框架/固定库名守卫。
- 收尾：新库保留给 T04，无业务数据写入、服务未启动、依赖未安装、无其他 Agent 调用；仅追加本资源记录，未提交/整合。此为本轮环境实测，非产品自测或独立验收，不宣布 T04/T05/Stage 完成。
- 脱敏证据与可复制启动/核验指令：`C:\Programme\demo\SeekJournal\.workbuddy\s3-t04-db-isolation\`，包括 `database-evidence.json`（创建前后、列/约束、迁移输出与退出码）、`probe.py`、`T04-commands.md` 和收尾证据；不含凭据、连接串、Key 或正文。
