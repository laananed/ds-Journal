# SeekJournal — Stage 4 技术架构

> 2026-10-30。基于已确认产品约束编制的目标设计，尚未实施。产品事实只在 [stage4.md](stage4.md) 维护，接口以 [stage4-api.md](stage4-api.md) 为准；授权、文件所有权与执行记录见 [stage4-tasks.md](stage4-tasks.md)。不新增 Repository Layer、状态框架、服务、队列或调度框架。

## 1. 本轮真实基线与限制

只读核对 `C:\Programme\demo\SeekJournal`：实际分支 `codex/s04-t02`，HEAD `b07e515dc77fac1866d05226b9c0d42b9c009948`，不是上轮规划的 `codex/s04-t00 @ 8fb4eb5`。本轮开始已有：

- 修改 `frontend/src/App.tsx`、`components/JournalDetail.tsx`、`components/JournalEditor.tsx`、`hooks/useAutosave.ts`。
- 未跟踪 `frontend/src/components/JournalPage.css`。
- 既有 Work-01/02 登记分支为 worktree01/worktree02、HEAD 均 `47cdc444a704bb52401e13b2bff93a02dac96899`；本轮未进入其目录核验工作区，不据旧快照声称干净/空闲。

这些产品改动归属/授权不由本轮猜测，不回退、不补修、不当作下表 T02 已完成。此次只新增四份 Stage 4 文档及必要阶段入口/协作同步，不切分支/建 worktree/commit/merge/push/tag。写文档前对224个非文档文件（含已有新增 CSS）做只读 SHA256 快照，交付前比对以证明未改变产品基线。

已检查当前保存、页面导航、AI 调用/恢复、Journal/Insight/Inbox 模型、迁移链、查询消费者和测试守卫：当前仍是页面 hook 队列、导航 flush、AI 锁、Journal/Inbox blocks，Insight 无 blocks；没有 Tiptap、content_doc 或 Ritual 类型。最新 migration 文件为 `3aa16300a58a`，这不是本轮数据库现场 revision 证明。当前依赖为 React/TS/Vite、react-markdown/remark-gfm、FastAPI/Pydantic/SQLAlchemy/psycopg/PostgreSQL/Alembic/pytest。

用户已确认 Stage 3 最终验收通过。本轮未跑产品测试、未访问数据库/私人正文/Key、未启动服务/Agent或安装依赖。2026-10-13 的个人库数量和 revision 是历史快照，不充当2026-10-30数据库状态。实际升级前必须重新核验。

## 2. 高风险方案：Problem / Impact / Options / Recommendation

| Problem | Impact | Options | Recommendation |
|---|---|---|---|
| textarea/blocks 无法提供统一富文本与范围评论 | 仅改 UI 会丢作者、引用、投影和增量 | 只替换前端；原两表 JSON；合并 files 总表 | 原 Journal/Insight 增 JSON 权威，服务端校验与投影；避免搬迁所有文件身份 |
| hook 属于页面，当前导航等待 flush | 去掉 busy 按钮不能保证卸载后保存 | 永久挂载所有页面；应用级会话；CRDT/离线框架 | 应用级内存会话与单文件队列，复用现有纯状态机；页面只是订阅者 |
| AI 当前要求整篇 revision/blocks 未变 | 续写导致冲突，整篇返回又可能丢新字 | 保留锁；受控占位/Mark 应用；通用自动合并 | prepare/execute/apply 分开，调用冻结保存快照，应用只允许已知窄变化 |
| 每日名额恢复涉及两个文件与关联 | 双有效、替错文件、End 回答被覆盖 | 客户端分步写；短事务替换/手动复制；完整版本系统 | 部分唯一索引＋有版本的事务替换；双方都支持手动选择复制，不自动合并 |
| 关联目标或任一 Ritual 删除 | 误删回答或恢复时静默重连 | 解除关联并保留快照；保留关联自动恢复 | 按用户决定解除关联，保留 End 快照和回答；仅主动操作重连 |
| Inbox 关联含 JSON 私人快照 | DROP 表仍可能泄漏内容或迟到复活 | 只删表；裁剪一项 source；整请求隐私清理 | 清理所有含 Inbox 的请求/检查点、usage 匿名保持，旧执行者退出后再 DROP |
| Markdown 转换会改变 U 与 C 的含义 | 截断、AI 混入用户、重复付费/跳过新文 | 无条件 parse；保留原文兼容节点；清 C 重分析 | 可证明等价才原生转换，否则保留原文/作者/C；迁移零 AI，不盲目设 C=当前全文 |

产品 §2 的八项决定已经批准。表中推荐为当前技术设计，不再重复询问产品问题；执行中若发现无法满足原约束的重大替代方案，按根规则重新提交具体冲突，不能扩大范围。

## 2.1 C01 独立日程架构边界

C01 新建 `backend/app/schedule/` 的 router/service/model/schema 和专属前端页面/API/types；日程有独立身份、标题、起止时间/时区、完成状态、revision、创建键与持久化，列表/详情/创建/更新/删除及用户确认建议走独立 `/api/schedules` 路由。Set/End 不建立外键、自动生成或双向同步，删除及完成各自独立。模型建议与情绪只生成待确认候选，读取/取消零写；用户确认后再创建日程，非法或缺失时间需修改。最终字段约束/错误码由 API §13 消费契约确认，禁止直接从 UI 推测并写库。

迁移单写者为 Codex：T01 M4A 在隔离库验证、完成必要复核并获授权整合后，确认实际唯一 Alembic head，C01 才从该最新 head 开下一条迁移；不得在两个分支从旧 head 各开一条。C01 可提前做不碰迁移链和公共入口的设计/独立组件；`main.py`、迁移链、`prepare_test_db.py`/conftest、公共 types 和 `App.tsx` 的所有权和资源时段以 tasks §5–7 为准。

## 3. 正文 schema、作者与两种投影

### 3.1 单一正文权威

`journals`、`insights` 增加可空 `content_doc JSONB`，最终所有保留文件均可用 schema 1 JSON 表达。`content` 保留为阅读/搜索投影；`revision` 仍是整文件版本，不用 updated_at 当锁。schema 版本为 API 常量，不为未来功能增预留列。

后端 `app/writing/documents.py` 仅承担本阶段 JSON 校验、作者权限、投影与已知节点变更原语，不变为通用 CRUD/Repository。前端 `editor/schema.ts` 和扩展实现同一 schema；共享合成 golden fixtures 验证两端，不在客户端重建一套不同作者规则。

schema 1 字段、节点/属性白名单、作者权限、NULL GET 响应、版本与 fixtures 的唯一接口来源是 API §2/§2.1；共享样例由 T01 负责并冻结交给 T03。如独立复核发现歧义，先修订并复核受影响契约，不能由实现者自行选择。

基础段落/列表/标题内为用户文字；AI 回复/总结使用受保护容器；问题、目标镜像与系统标题是系统容器；答案是用户子树。稳定 ID 在编辑/序号中保留，复制/分裂的新身份由规则生成。UniqueID 的通用分裂/粘贴行为不能覆盖本项目的 AI/目标权限。AI 来源 request_id 不能因编辑总结被剥掉。外部粘贴丢弃不可信来源属性，受控恢复才可由服务复制真正 AI 节点。

### 3.2 阅读投影 R

R 从 JSON 确定性生成，基础结构用安全 Markdown 表达、AI 段保留来源标签/分隔，供当前 content 列、卡片、普通搜索、Folder/Trash 阅读复用。不会把正文 HTML 直接执行；内部链接只在普通文本位置激活，代码区域不激活。End 隐藏引用的系统标题不伪装成用户答案。无单独全文索引。

普通输入 R <=50,000 Unicode 码点，旧文未变或等价转换保留旧上限例外，不 trim/截断。外部链接、引用和 `[[显示标题]]` 语义延续既有安全规则；普通日记编号只计算 writing，包含回收箱现存记录，保持既有 P3 约束。Ritual 独立显示标题不占普通编号。

### 3.3 用户投影 U 与检查点 C

按文档存储顺序取真实用户段、答案、Set 目标文字；排除 AI、占位、问题模板、End 镜像、系统标题、评论和格式属性。原生块间采用确定的 `\n` 分界，hardBreak 为 `\n`，list 层级不引入虚构事实；legacyText 段原文和原边界逐字保留，由转换适配器明确拼接。checked、Mark、展示置底不改 U。不能按 UTF-16 code unit 实现 Python/TS 不同的码点边界。

T01 投影约定：原生用户块按顺序以单个换行连接，空用户段仍保留其边界，被排除的 AI/系统块不产生用户分隔符。单个 user legacyText 在 R 与 U 中均逐字保留；AI legacyText 保留原始属性、在 R 加 AI 标识且不进入 U。R 的顶层块以单个换行连接，基础格式输出安全 Markdown，AI 回复和总结输出来源标识。四份共享 fixtures 与其散列以实际交接版本为准。

C 沿用 consumed_user_text：无 C 首次读取 U；U 以 C 为前缀只取后缀，否则最长公共前缀后的当前内容为修订。保留纯删除/空白/独立问题和上下文边界；不把问题或旧总结写入 U。Go Deeper apply 时 C=调用快照 U，不包括下方续写；失败/冲突/unknown/删除回复不推进/回退 C。完整复盘保留生成成功且源一致时 ready+C 原子提交语义；Minds 不修改这份 C。

转换时必须同时验证 R、U、C、节点来源和引用：能证明映射则转换 C 的相应边界且保持原分析语义；不能证明则在 schema 1 的 legacyText/AI 容器中保留旧段与原 C，U 仍等于旧作者提取结果。不直接清 C、写 C=新全文或自动重发。旧引用文本/请求快照保留原格式标识，恢复时不能把不同投影版本当成同一源。

## 4. 应用级编辑会话与命令协调

`state/editSessions.ts` 持有会话、稳定创建键、首次 POST payload、服务端基线、最新草稿、inputSeq、in-flight 与错误/冲突。新建以 draft UUID 定位，收到 id 后在同一会话转换为 `(type,id)`，不重挂编辑器或清空较新输入。`useAutosave.ts` 改成订阅/接线，复用 `utils/autosave.ts` 中已验证的序号/创建重放/CAS 思路，不能照抄旧卸载清队列行为。

导航同步捕获最后编辑器内容与 IME 状态，立即改变视图，不等网络 flush。未提交 Journal 会话除留在内存外还保存到浏览器本地草稿；beforeunload 仅为辅助提示，不作为唯一恢复手段。不能承诺断电时最后输入必然恢复。

### 4.1 本地草稿持久化与恢复

T02 建议使用浏览器原生 IndexedDB，不增加依赖；每个编辑标签/草稿独立记录，保存 API §10 所列身份、版本、字段、输入序号及必要的创建请求快照。每次用户输入以有界短延迟异步写入，切页/隐藏时尽力立即写；本地写入成功与服务器提交分别显示。IME composition 期间记录编辑器可取得的临时状态但不发送半组合到服务端；组合结束后立即持久化最终值。若浏览器不能可靠提供组合中内容，只承诺最近一次成功本地提交，并提示状态；不以模拟代替真实输入法验证。

每次记录为独立事务与单调序号，较早异步写不能覆盖较新序号；多标签以独立 draft_id/tab_id 保存，发现时列出候选，不以时间最后写入覆盖其他标签。服务器确认后事务比较当前序号和确认序号，只删除无后续输入的对应记录；已发送但未确认的首次创建保留稳定键与原 payload，恢复时先重放并确认，再走版本比较/CAS。写入前将草稿及首次请求信息成功提交到本地；本地不可用时告警并保留内存内容，用户仍可明确继续服务器保存，但不声称崩溃可恢复。处理写入进行中的迟到确认、应用退出、幂等重放与另一个标签的 CAS 冲突。

重开发现候选并显示来源、时间与状态，用户明确选择恢复、稍后或丢弃；显示内容时避免向日志输出。对已有文件先 GET 服务端 revision/内容，同版才允许恢复编辑并按 CAS 保存；不同版或再次变化展示两方并保留两方，用户可对照、复制或明确采用一方，不能自动合并/覆盖。离线、404、软删、Ritual 名额冲突均保留本地候选，不自动新建；创建响应未知的恢复按 API §10。同一个浏览器配置和来源才可发现，不实现跨设备同步或每次保存的历史。

默认只保存恢复必需内容；不存 Key、私密提示词、整个 AI 请求、服务端凭据，不上传备份或输出正文到日志。浏览器同源、同设备用户可访问，默认无应用级加密；浏览器隐私模式、站点数据清理/驱逐、配额或故障可能丢失，UI须说明。用户可按草稿确认删除或清空本应用草稿；仅删除本应用命名空间，失败可重试；不能自动清除未知或其他标签未提交草稿。存储不可用/QuotaExceeded/损坏/版本不兼容均保留原记录（可读时）、显示告警和可操作恢复路径，不伪称已本地保存。

所有文件写入、AI prepare/apply、目标联动和恢复命令进入同一协调入口：

1. 按 typed key 排序预约关联文件队列，等待该会话已有在途提交。
2. 捕获有限 inputSeq 屏障，提交至这批序号，不等待用户永久停止输入；后来输入继续保留。
3. 用真实返回 revision 执行命令，命令不重新从页面 closure 读取可变 payload。
4. 使用 FileMutation 确认服务端基线和对应已知 effects；只对本地较新草稿应用稳定 ID 定位的窄系统变化。
5. 继续保存更高序号。未知服务器差异进入 CAS 冲突，不仅提升 revision 后重发整篇。

全局失败入口分别显示文件、保存/AI状态与操作，不因任一文件失败锁全应用。若完整恢复使当前文件变为回收箱，原较新输入仍以原会话保留待用户恢复/复制，不能转移到新 ID。保存成功但列表刷新失败只重读，不重发创建/命令。

`state/aiRequests.ts` 持有在途 Promise、查询、恢复入口与结果；页面卸载不取消实际执行。请求索引仅存 ID/kind/源；Review 的选源/预览编辑会话也移出页面，以支持切页恢复，真正预览保存仍需要用户确认一次。

## 5. Ritual 唯一、日期、模板与恢复

Journal 增 `journal_kind text NOT NULL DEFAULT 'writing'`，检查枚举；在 `(journal_date,journal_kind)` 上建 `WHERE deleted_at IS NULL AND journal_kind IN ('set','end')` 唯一索引。普通日记仍可同日多篇。日期来自草稿捕获的带时区时刻，经固定上海 04:00 计算并在服务端校验；不是数据库提交时重新计算。不能 PATCH Ritual date/kind，也不能根据标题变类型。

模板表按 kind 两行，questions JSONB、revision；缺行读空列表/revision0，首次 PATCH 创建。模板不是正文外键，插入为当时文字快照；内容编辑不回写模板。0～4 的上限在 Schema 和服务校验，模板请求不生成 AI。

2026-10-31 用户批准 API §4 的问题插入与 Set Checklist 转换命令。服务端持锁读取已保存节点及模板、验证版本后构造受控节点并在同一事务维护投影；不接受客户端提供系统快照或目标文字。复用既有文件写队列和 FileMutation；不支持安全合并的较新草稿进入冲突。丢响应先读取核对，不以过期请求重复创建；不新增持久幂等表。

所有 Ritual 跨文件变更以业务日期短事务锁协调，接着按 Journal ID 升序锁对象，再锁 link/request，统一生命周期入口复用这个顺序；多日期复盘按日期排序后锁源。HTTP 期间不持锁。通用 Journal PATCH/Delete、Trash Restore/Purge 也接入对应 Ritual 处理，不能另写绕过唯一/关联的分支。

普通恢复校验有效名额，冲突仅返回身份。完整替换同时软删 current、解除其关联、恢复 source 并增版；旧关联不自动恢复。AI/C 的原文身份保留，但在途旧请求不因恢复被自动应用。左右对照是两个只读/编辑视图，复制需用户明确选择，后端只按源 revision 与真实节点构造新内容、重新分配 ID/受保护来源；不做自动合并。

复制节点的 copy_id、来源节点和选择摘要确定性生成目标节点身份，陈旧重放不能第二次插入。复制 Set 目标是新目标；复制 End 回顾保留快照/答案但无活动关联。UI 取消零写；普通外部剪贴板仍视用户主动输入，不给予伪造来源权限。

2026-10-30 用户批准：选区采用 paragraph/heading ID 与块内 Unicode 码点半开范围，兼容 T01 不给 text 分配 ID 的约束；复制命令的服务端持久记录保存 copy_id、请求摘要、源/目标身份及结果校验信息，并与正文写入同事务提交，用于重放和已修改结果检测。线性迁移由 Codex 独占，真实库升级仍须单独授权。

## 6. 目标链接、解除与快照保留

不建立独立目标文本事实表。Set JSON 的 goalItem 为 canonical，goal_id 为 UUID；End JSON 保存历史镜像/系统标题及独立回答。`ritual_goal_links` 记录 link_id、set_journal_id（可空 FK，永久删除时 SET NULL）、end_journal_id（FK，目标 End 永删时 CASCADE）、goal_id、end_node_id；同一 End/goal 唯一。服务验证双方 kind/date、节点归属和 active 状态。

主动加入才创建 link，缺 End 时可原子创建有目标内容的 End。新 End 的捕获日期必须与 Set 同日；历史 Set 只有已有同日 End 才可新关联，不能通过“加入”伪造过去创建日期。历史文件正文/现有关联仍可编辑，跨日失败保留输入，不偷偷换日。

目标文字/状态从 End 修改也提交到 Set，再更新 End 的受控字段与 R。普通整篇 PATCH 也检查 goal 差异并进入该事务。要求相关有效对象版本，任何失效/超限/SQL错误都零半写。回答子树在更新前后做实际相等断言；系统标题只包含模板化目标文本，不生成/改写回答。

生命周期执行：

- 删除 goal、Set 或 End（软删/永删）：事务内解除有效 link，End 保留最后镜像和答案并标记来源不可用；End 本身永删时按用户明确的永久删除操作处理其正文。相关 revision 和投影原子更新，生命周期变化不冒充用户编辑时间。
- 恢复任一文件：不自动重建 link 或同步旧快照；用户可主动再次关联，不能按同名文字推断。恢复旧 End 时保留其原答案和快照；重关联不得覆盖答案。
- Set 永删时同时按既有契约清理该源敏感 AI 请求/评论/检查点，不删除 End 已存回顾。

不把 GET 变成关联修复器。来源状态、可见性和投影在写事务维护，读取只投影。展示置底在目标列表/NodeView 的派生视图实现，正文顺序/分析顺序保持；不能移动 answer 子树实现排序。

## 7. AI 快照、原位回复与评论

### 7.1 三阶段执行

当前 `app/ai/local.py` 的 register/account/attach 拆为明确的 prepare/execute/apply，但继续现有同步工作线程、总截止与账本，不引入 BackgroundTasks、任务队列或新运行服务。进程仍单实例运行，功能调用并发上限沿用2，同源写作/复盘在途互斥。

prepare 由文件队列执行：取得真实已保存 U/版本/设置与范围，登记 prepared、Go Deeper 占位及其后用户段；返回窄效果，允许继续写。execute 只对 prepared 抢占为 pending、写 started_at，释放事务后才调用；重放不能再次上游执行。每个子调用先独立记 usage，持久化业务 ready/failed，与文件应用分开。

apply 再进入文件队列：保存到序号屏障、锁有效源/请求，验证占位和调用前用户前缀；允许其后新增。只替换占位并原子更新 C/request/file。下方新输入即使未在调用中也保留，C 只到 frozen U。返回 FileMutation，不能用完整 file 回填覆盖新草稿。

源旧范围改变、占位删除、软删/替换、已 unknown 的迟到结果只保留结果/账本，不附着、不推进 C。源软删/替换及删除占位的同一写事务将对应prepared/pending/ready写作请求置conflict，保留已发生的usage/结果；恢复原文件不能让旧请求重新获得权限。这比仅检查恢复后的deleted_at为空更严格，避免软删再恢复后迟到误附着。短暂网络失败先 GET 原 ID；prepared 尚未执行与 pending/unknown 费用状态区别显示。用户明确新请求才再次生成，不用自动重试修复上游 JSON。

### 7.2 Minds 与标记

同一请求使用当前用户快照和全篇/选区范围，三个固定预置由提示词常量定义，不建自定义 Mind 模型表。一个请求统一返回多个合规评论，不为每个预置暗中独立发起功能请求；受限搜索工具与子调用预算沿用 Stage 3。

评论锚点使用稳定用户 paragraph/heading 块 ID、块内 Unicode 码点半开范围、quote 与摘要，不能只用绝对编辑器 offset 或全文字符串首次匹配；text 不假定具有可持久 ID，ProseMirror UTF-16 偏移需显式转换。apply 校验当前块对应 quote；无法证明位置时落库 unavailable 侧栏结果，不挂错误 Mark。前端 Mark 的 ProseMirror transaction 映射用于正常编辑跟踪，不能替代后端来源/quote 校验。多个评论用 comment_ids 集合分段表达，Mark 不存正文；UUID 形状校验不替代文件归属查询。

2026-10-30 用户批准 API §7 的多节点 ranges：后端逐项从已保存快照提取并校验范围，同节点重叠拒绝；单次功能请求仍只执行一次受控调用。客户端 T09 负责由激活基线和真实用户输入计算范围，后端不凭客户端范围声称已独立验证输入事件或激活基线；正文和 delta 不由客户端传入。

评论存 `ai_comments`，journal_id FK（源永删 CASCADE）、request_id 可空 SET NULL、mind_preset_id、text、quote、anchor JSONB、anchor_state、created_at。软删源保留其恢复数据，普通入口隐藏；删除评论同时清 Mark，usage 不回退。删除锚点不把评论误挂邻近重复词；评论生成不改变 Go Deeper C。

### 7.3 自动触发与去重

配置参数唯一见 API §8。开关启用/编辑会话激活时记录客户端调度基线，已有旧文不冒充刚输入的80码点；这不是后端 C，不把未分析内容标为已消费。真实用户输入后的调度增量达到阈值，IME结束/可见/保存成功/冷却/同源空闲才请求。实际 Go Deeper 分析仍按 C 计算，首次可以读取完整用户正文。

所有 change 具有 `origin=user_input|system`，加载、AI、模板、目标联动、恢复复制、格式化等明确为 system；只有真实用户文字事务增加触发序号。两种模式各自调度基线与冷却，同源串行，Go Deeper 优先；Minds 自动消费范围按该模式上次成功自动范围/激活基线计算，不读写 Go Deeper C。

服务以唯一 auto_dedupe_key 防同源/同模式/同用户快照/范围/预置的多标签重复；settings 变化本身不触发。failed/conflict/unknown 同键不生成新请求，停止自动重复；新真实输入能形成新的合法快照，手动重做由显式点击授权。系统写入再多也不能产生付费循环。

### 7.4 保留现有复盘与计量

完整复盘输入剩 Journal，15文件/7日期上限、证据校验、ready+C 与一次保存事务保留；来源用户快照变化仍冲突，不能因即时导航改成静默接受过期分析。新目标 writing，追加原 Ritual 不改类型/日期。Insight 仍主动添加，纯查看零创建，另加一份换键，普通相似搜索不语义去重。

复用现有请求ID/hash、官方 usage、unknown、子调用唯一账本、独立计量事务、受限搜索与密钥位置，不新增模型SDK/供应商/工具权限。自动模式调用同一安全链；真实测试仍须单独预算且使用合成正文。

## 8. 数据影响

| 对象 | 变化 |
|---|---|
| journals | content_doc、journal_kind；有效 Ritual 部分唯一；原 ID/date/Folder/时间/创建键/版本保留 |
| insights | content_doc；保持无日期；不加局部 AI 字段或事实图 |
| ritual_templates | kind 主键、questions JSONB、revision；两份独立 CAS 模板 |
| ritual_goal_links | 窄关联，不重复保存目标 canonical 文本；源永删 SET NULL，End 永删删 link |
| ai_comments | Journal 范围评论；Mark 引用其 ID；保留恢复和不可用锚点 |
| ai_requests | kind/status 目标枚举、started_at、auto_dedupe_key 可空唯一；sources/result 使用带格式/锚点的快照 |
| ai_checkpoints | 保留 consumed_user_text 与源身份语义；收缩后去掉 inbox type；不将 Minds 混入 C |
| ai_settings | 两个自动 bool 默认false、固定预置集合；保留原 CAS/Key隔离 |
| ai_usage | 不改变已知/未知和匿名累计原则；request 删除后 SET NULL |
| inboxes | 最后收缩删除；历史 migration 中的建表步骤保留，不再注册当前 Model/API |

Model 注册、Alembic metadata、BUSINESS_TABLES/fixtures 与残留摘要同步新增表；收缩再移除 inbox。`SEEKJOURNAL_TEST_DB` 当前白名单是 seekjournal_test/seekjournal_test_02，不因最多三路就扩白名单或建第三库。

## 9. 依赖与不引入方案

T03 安装前提交精确版本和批准记录，所有 @tiptap 包锁定同一兼容3.x版本；本轮不安装、不修改 package/lock。拟采用 core、react、pm、starter-kit、extension-list（taskList/taskItem）和 extension-unique-id；自定义节点/Mark 自建。starter-kit 已含的能力不重复装独立扩展。若发现特定免费包的版本/许可证不适用，先核验官方定义，不能静默换付费服务。

实际问题是富文本、稳定锚点、Checkbox 和原位回复，现有 textarea/react-markdown 不满足；该编辑核心不能推迟。界面保持原 CSS/local State+fetch，不加Redux/Zustand/React Query、UI组件框架、Repository、CRDT/Yjs/协作服务、Redis/Celery等。Markdown 扩展目前Beta，非必装运行依赖；转换优先验证现有能力和原文兼容节点，需要新增解析依赖须另说明实际问题与权限。

官方依据见产品 §13。官方可用能力不意味着本项目已安装，也不把 Tiptap 云端 Comments/AI 平台带入本地数据流。

## 10. 迁移、切换和回滚

### 10.1 M4A 扩展与安全转换（T01）

接在当前单 head 之后新增线性 revision，具体 ID 由实施工具生成后登记，不编造 ID、不改历史 migration。新增字段/表/索引/元数据注册。旧 Journal 全写入 writing，不按标题分类；旧AI/日期/幂等摘要保留。

在隔离合成 schema 中验证 Stage1→Stage3→M4A，包含普通/交错AI/总结、旧空白/超长、Unicode/内部链接/已有C/ready与applied请求；保存各字段/序列/投影摘要。转换采用“先证明原生映射、否则带原作者的原文兼容节点”；所有保留文件最终应可表达为 schema1，不因失败清空。M4A 不代表已经完成全部转换：当前带旧 blocks 的文件仍以 legacy 原样保存并拒绝自动转换；可证明无损的 blocks 兼容映射及检查点 C、引用和 AI 来源的处理，是 T12 收缩删除 `content_blocks` 之前的前置条件。不能安全回填的意外结构使该次转换事务回滚，原文/旧字段仍在，不把迁移标记为成功。

content_doc 成为权威后旧块列只作冻结回退资料，普通旧客户端不能写坏新文；不双向同步旧 blocks 作为第二权威。GET 不懒回填。已成功转换的文件后续真正编辑从 JSON生成 R，旧源码不要求逐字往返，备份保留原貌。

### 10.2 M4B 退出 Inbox 与旧正文列（T12）

先完成所有消费者/新测试/AI恢复适配，确认未处理在途请求为零或已受控unknown，并停下旧执行进程；未核实进程归属不擅自终止。记录每个待删 Inbox、含其快照的混合请求与用量归属，备份及恢复演练通过后再进入收缩。

删除所有 inbox C，删除 sources 含 inbox 的 ai_requests 整行，usage FK SET NULL 保留累计；不删其他 Journal C、不删已保存 Journal/Insight/AI总结；不裁剪 JSON 单项后保留私密 question/result。清理 Inbox 客户端索引和类型/查询/路由/当前Model，DROP inboxes，所有保留文件JSON验证通过后才DROP旧content_blocks列。未知引用、未转换结构或陌生测试对象使收缩拒绝，不用CASCADE掩盖依赖。

历史 migration 文件保留Inbox建表以支持旧库升级。普通内部链接是按显示标题动态解析，不是强关系；不重写用户文本或误删同标题其他文件。Folder保留，只有剩余Journal/Insight包括回收箱引用决定是否为空。

### 10.3 权限与实际回滚

本轮不连接数据库、不备份、不迁移。未来真实 seekjournal 升级必须用户单独授权，全库备份→隔离恢复验证→冻结写入→升级→前后摘要与关键路径核验；备份不进Git、不上传。隔离测试库也要核实实际DATABASE_URL/current_database/revision/连接/manifest，不能只设名字变量。

M4A 未发生新格式写入时可在合成库演练结构退回；新富文本、评论或关联写入后Stage3不能完整表示，不能直接降级造成丢失。优先保留当前备份后向前修复；无损下转或整库恢复必须验证并另获真实数据操作授权。M4B DROP提交后普通downgrade不能恢复Inbox正文，必须使用验证过的备份，并处理切换后的新增数据；不允许用旧备份静默覆盖新增日记。

## 11. 验证策略与风险通过条件

开发先失败场景、最小实现、聚焦测试；独立测试新会话读取冻结HEAD+diff，真实执行所需HTTP/PG/浏览器。新前端纯逻辑仍使用现有node测试方式，不为文案/低影响样式新增测试框架；Tiptap行为用实际浏览器验证，Windows中文IME不能只以合成composition替代。

必须覆盖创建丢响应后切页续写的真实PATCH与最终UI/DB相等；本地草稿重开/崩溃/版本冲突/多标签/存储异常/IME；三路文件响应隔离；同日唯一和恢复事务故障；关联双端CAS及answer不变；删除解除关联且恢复不自动重连；GoDeeper原位+下方新增/C快照；Minds重复引用/失锚不误挂；自动触发边界/系统0调用；Inbox混合请求隐私、累计及已存成果保护。每个关键故障保留HTTP/SQL摘要和命令退出码，不能只统计通过数量。

最高风险（正文迁移、全局保存、Ritual恢复、目标同步、AI应用/计量、Inbox收缩）需要表列独立测试与未参与实现的新Codex风险复核；本轮不启动该复核。常规UI由开发/独立测试双方完成技术交付，Codex只审必要交叉影响，不重复整套回归。

## 12. 学习与实现边界

阶段交付保留三个学习点：①编辑器JSON、阅读投影R与用户事实U为什么分开；②应用会话如何把“页面切换”与“保存/请求生命期”分开；③外部AI消耗无法回滚，为什么usage、ready结果、文件/C应用分事务而最终业务应用原子。仅讲实际采用方案，不扩讲尚未引入的分布式系统。
