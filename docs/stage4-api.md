# SeekJournal — Stage 4 API 契约

> 2026-10-30。目标契约，尚未实施。产品决定只在 [stage4.md](stage4.md) 维护，数据/事务见 [stage4-architecture.md](stage4-architecture.md)。本文件冻结技术接口，不授予开发、安装、迁移、真实付费调用或 Git 权限。过渡版本不得作为 Stage 4 整体可用版本交付。

## 1. 通用规则

沿用 REST/JSON、`/api`、文件身份 `(type,id)`、固定 20 条文件分页、ISO 日期和带时区时间。最终有效 `FileType` 仅 `journal | insight`；`JournalKind` 为 `writing | set | end`。UI 名称见产品 §2，不把 Set/End 当文件类型或独立整数 ID 空间。

GET 零写，不创建草稿、模板、占位、评论、检查点或“今日汇总”。请求输入使用严格字段校验，系统/作者字段不能被普通写入伪造。`expected_revision` 缺失 428、非法/显式 null 422、过期且实际意图不同 409；DELETE/Trash 恢复保留 `If-Match: "<revision>"`。实际修改 CAS 增版，无变化 200 不增版/改时间；软删/普通恢复保留原 `updated_at`。跨文件系统投影变化也增 revision，生命周期可见性投影不冒充用户编辑时间。

错误沿用 `detail` 字符串/422 验证列表，可补 `code` 与只含身份/版本的 `conflict`，保持现有前端错误解析可渐进升级。具体 code：`revision_conflict`、`ritual_slot_conflict`、`related_files_changed`、`anchor_changed`、`anchor_removed`、`source_unavailable`、`legacy_conversion_required`。错误不回显正文、提示词、Key 或供应商原始 body。

## 2. 正文 JSON 与投影

详情响应 Journal/Insight 增加 `content_doc`（Tiptap JSON doc）及 `document_schema_version:1`；Journal 增加 `journal_kind`。列表保持阅读投影 `content`、revision、身份、显示标题、日期/Folder/时间等字段，不携带完整 JSON。Trash 详情包含正文 JSON，仍只读。

**过渡期 NULL 响应**：数据库 `content_doc IS NULL` 时，详情 GET 返回 `content_doc:null`、`document_schema_version:null`、`document_format:"legacy"` 和原 `content`；Journal 同时返回原 `content_blocks`（原值可为 null），Insight 没有旧 blocks 则返回 `content_blocks:null`。非 NULL 有效文档返回 `content_doc`、`document_schema_version:1`、`document_format:"tiptap"`；旧 `content_blocks` 不作为当前正文使用。Trash 详情同理。GET 只读取原值，不转换、回填、增版或改变时间；不可安全转换时保持 legacy，用户可读原文，正文写入前需明确转换流程，不能用空 JSON 覆盖。此为 T01 目标响应而非当前已实现行为。

**T01 过渡选择（2026-10-30）**：非 NULL 详情的 `content_blocks` 明确返回 null，`content` 为新文档的阅读投影；旧 `content` / `content_blocks` 写入非 NULL 文档返回 409 `legacy_conversion_required`。NULL 且无 blocks 的文件，只接受单个 user `legacyText` 与原文逐字相同的等价转换；该次转换保留旧 content、检查点、引用和编辑时间。转换后用户可主动编辑 user legacyText 的 raw_text，但不能改变其 ID/作者；AI legacyText 受保护。带 blocks 的记录在有证据证明阅读投影、作者和检查点均可保留前拒绝自动转换，原字段不变；此限制不阻止旧格式继续使用旧接口。转换和普通写入均受原 revision CAS 约束。

**单 user block 保守子集（用户已批准，待验证）**：仅 writing Journal 的单个结构合法 user block，候选为沿用其 ID、原文和 user 作者的单个 `legacyText`，且旧 content、旧 R/U 与新 R/U 完全相等。为避免未经证明的引用和恢复语义，存在任何 AI 请求、该文件存在评论、正文包含字母数字和空白之外的字符、无法检查关联时拒绝；转换请求不能同时修改元数据。这是严格的临时限制，不代表其他正文不可安全转换。空数组、多块、AI、未知或损坏结构以及投影不一致均保留 legacy。转换使用原 PATCH 和 revision CAS，保留旧 blocks、content、C 和编辑时间，不自动执行批量转换；本条不宣称相关能力已验证。

**旧多块兼容表示（用户批准，实施和验证中）**：schema 1 增加顶层原子节点 `legacyBlocks`，属性为 `id`、`format_version:1`、`blocks`。blocks 按原顺序严格保留 user `{id,kind,text}` 或 AI `{id,kind,text,request_id}`，不接受其他字段、类型或重复 ID。其内部按 Stage 3 原拼接规则计算 R/U，内部块间不插入新分隔；与其他顶层节点仍按既有规则分隔。候选由客户端提交，服务端从真实旧数据严格比对，普通写入不可伪造或删除该节点、改变块身份、顺序、类型或 AI 来源及 reply 正文；user 和 summary 文字可按既有权限编辑。当前转换路径仅尝试全部为 user 的多块，其他沿用单块限制；AI 块、无法验证来源、引用、请求或评论时拒绝并保留旧记录。转换前后 R/U 必须精确相同，C 不修改；此表示待验证，不授权丢弃旧列或自动批量转换。

最终 POST/PATCH 正文只接收 `content_doc`；`content` 是后端投影，`content_blocks` 不再可写。格式版本错误 422。T01～T12 过渡读写兼容必须拒绝旧客户端扁平化已转换文件，不能同时把 content、blocks 和 doc 当权威；最终旧正文写请求返回 409 `legacy_conversion_required`，不会偷偷覆盖作者。具体转换与收缩顺序见架构 §10。

公共节点包含基础 paragraph/heading/text/hardBreak/list/taskList/taskItem/codeBlock/blockquote/horizontalRule，以及：

| 类型 | 关键身份 | 写入权限 |
|---|---|---|
| `aiReply` | id、request_id，内容为 AI | 后端创建/替换占位；普通 PATCH 不改内容/来源，可专用删除 |
| `aiSummary` | id、request_id，内容为 AI | 复盘保存/受控复制创建；用户可编辑正文，来源不变 |
| `aiPlaceholder` | id、request_id | prepare 创建；下方 user 段可继续输入；删除后不复活 |
| `ritualQuestion` | id、template_question_id、插入文字快照 | 插入后正文可编辑，不影响模板；不作为用户事实 |
| `goalItem` | id、goal_id、text/checked | 仅开始今天；来源归属由后端确认；更新调用跨文件同步规则 |
| `goalReview` | id、link_id、目标镜像、系统标题、独立 answer 子树 | 系统字段由服务更新；answer 由用户编辑 |
| `legacyText` | id、原文、原作者上下文 | 保留无法证明安全的旧段；不会执行 HTML 或自动分析 |
| `mindComment` Mark | comment_ids，支持一段多个评论 | 仅引用属于该文件的已保存评论；不含评论正文 |

节点 ID 在文档内唯一；分段、粘贴、复制按来源规则生成/保留，不能把 AI 段改成 user、复用其他文件评论 ID 或伪造关联。恢复复制的新 AI 节点由服务从真实来源构造，外部剪贴板不授予 AI 身份。`origin` 恢复元数据是后端字段。

### 2.1 schema 1 字段和验证来源（T01 冻结入口）

本节是 Python/TypeScript 共同的接口来源，架构 §3 规定投影与权限；本节节点表继续是身份及作者权限的唯一来源，不以 fixture 另定契约。JSON 根为 `{ "type":"doc", "content":[节点...] }`，仅允许 `type`、`attrs`、`content`、`text`、`marks`；`content` 是子节点数组，`text` 仅 text 节点必填，marks 为 `{type,attrs?}` 数组；未知字段/类型、错误子树、重复 ID、伪造系统属性与非版本 1 在写入时报 422。空子数组按对应节点定义合法性检查，不允许直接执行 HTML。

基础节点及唯一允许 attrs：`paragraph` 无；`heading` 的 `level` 为 1–3；`text` 无；`hardBreak` 无；`bulletList`、`listItem`、`blockquote`、`horizontalRule` 无；`orderedList` 的 `start` 为正整数；`taskList` 无；`taskItem` 的 `checked` 为布尔；`codeBlock` 的 `language` 为字符串或 null。`doc` 直接包含块；段落/标题包含 text/hardBreak；列表包含对应 listItem/taskItem，项包含块；codeBlock 仅 text；原子 hardBreak/horizontalRule 无子节点。基础 marks 仅 `bold`、`italic`、`strike`、`code`（无 attrs）及 `link`（`href` 字符串，安全协议校验）；`mindComment` 的 `comment_ids` 为非空、去重且属于该文件的 UUID 数组。空缺 attrs 可视为默认值，其他 attrs 拒绝；基础节点如需稳定锚点仅允许 `id`（UUID）并在生成时确保全篇唯一。

专用块一律含 UUID `id`；`aiReply`、`aiSummary`、`aiPlaceholder` 另含 UUID `request_id`；`ritualQuestion` 含 UUID 或 null 的 `template_question_id` 和字符串 `question_snapshot`；`goalItem` 含 UUID `goal_id`、字符串 `text`、布尔 `checked`；`goalReview` 含 UUID 或 null 的 `link_id`、字符串 `goal_snapshot`、布尔 `checked_snapshot`、字符串 `review_title`，其 answer 子树是用户块；`legacyText` 含字符串 `raw_text` 和 `author`（`user|ai`），保留原文，不可执行。`aiReply`、`aiSummary` 的 content 为一个或多个 paragraph；`goalReview` 的 content 为零或多个 paragraph，全部为 answer；`aiPlaceholder`、`ritualQuestion`、`goalItem`、`legacyText` 均为无 content 原子节点；专用节点不可嵌套、只置于 doc 层。字符串计 Unicode 码点；问题快照不超过 500，目标文字/标题分别不超过 2,000，原文兼容不截断旧值，普通写入整体 R 不超过 50,000（旧值例外见架构 §3）。保护规则：普通 PATCH 不创建/修改/删除 AI reply/placeholder 的来源和内容（专用删除除外）；summary 可编辑内容但不可改来源，系统镜像只由服务写，answer 用户可编辑；外部粘贴视用户输入。服务器对旧、新受保护节点逐 ID 比较；受控创建/复制由专用服务完成，拒绝伪造。

T01 独占建立共享合成样例目录 `tests/fixtures/stage4_documents/`（仓库根），包含 `valid.json`、`invalid.json`、`projections.json`、`legacy.json`：样例含 ID、输入、预期有效性或错误类别、R/U 和作者断言（适用时）。后端 `backend/tests/unit/test_s4_document_foundation.py` 与前端 `frontend/src/editor/documentProjection.test.ts` 读取同一份投影样例，不复制第二份。交接时记录文件 SHA256；T03 若发现字段歧义或需要扩展，报 T00 补齐并复核，不能自行定版。

**T01 锚点与归属边界（2026-10-30）**：锚点为 `{node_id,start,end,quote,quote_sha256}`；`node_id` 是用户 paragraph/heading 的 UUID，区间是该块文本的 Unicode 码点半开区间，摘要为 quote 的 UTF-8 SHA-256 小写十六进制。text 与 hardBreak 不分配 ID。前端必须将 ProseMirror 的 UTF-16 偏移与码点偏移显式转换。纯 schema 仅校验节点、UUID、区间、quote 与摘要；评论 UUID 属于文件必须由数据库服务校验。T01 期间普通写入拒绝 mindComment，直到带归属检查的服务接入；不能只凭 UUID 格式放行。

阅读投影 R 用于现有列表/Search/安全阅读；用户投影 U 用于 AI 增量。AI 节点、评论、占位、模板问题、目标镜像和系统标题排除于 U；用户答案/正文和开始今天目标文字进入 U。checked、Mark 与展示排序不改变 U。Unicode 码点及换行规则见架构 §3，前后端共享样例。R 上限沿用 50,000 码点，旧数据例外及空更新语义保留；目标联动使任一端超限时整体 422 回滚。

## 3. Journal、Insight 与今日读取

| Method | Endpoint | 请求与结果 |
|---|---|---|
| GET | `/api/journals` | 保留 journal_date/folder_id/page；新增 journal_kind=all/writing/set/end，默认 all，稳定排序沿用 Journal 契约 |
| GET | `/api/journals/{id}` | 有效 Journal 详情及受控关联所需身份/版本 |
| POST | `/api/journals` | title、content_doc、journal_date、journal_kind、folder_id、client_create_id；Ritual 还需 draft_started_at |
| PATCH | `/api/journals/{id}` | expected_revision、变化的 title/content_doc/folder_id；仅 writing 允许 journal_date，禁止 journal_kind |
| DELETE | `/api/journals/{id}` | If-Match；可选 JSON body `{related_revisions:[{type:"journal",id,revision}]}`；软删除，204；Ritual 同事务解除关联并保留 End 快照和回答 |
| GET/POST/PATCH/DELETE | `/api/insights[/{id}]` | 沿用 CRUD/创建键/CAS，正文换 content_doc；无日期，不开放本期写作 AI |
| GET | `/api/rituals` | `journal_date=YYYY-MM-DD`，返回 `{journal_date,set:JournalDetail|null,end:JournalDetail|null}`；缺失零创建 |
| GET | `/api/business-day` | 返回 `{timezone:"Asia/Shanghai",day_start_hour:4,server_time,business_date}`；只读时钟依据 |

Ritual 详情中的受控关联信息为 `related_revisions:[{type:"journal",id,revision}]` 和 `goal_links:[{link_id,set_id,end_id,goal_id,end_node_id}]`；仅列有效关联，供两端定位目标及提交版本，不包含回答正文。GET 只读。

Writing 左侧用 journals 的当日 writing 筛选；今日总览用当日 all 的分页结果与 rituals 状态，不另建总览实体。

新建 Ritual 的 `draft_started_at` 是打开草稿时捕获的带时区时间；服务端按上海 04:00 计算并核对 journal_date，相同创建键重放始终使用首次 payload，即使已跨日。没有 UI 历史日期新建入口，不因延迟保存重算为响应当天。已存在同日同类有效文件且不是同键重放，409 `ritual_slot_conflict`，返回 current_id/revision 供显式继续或恢复，不自动覆盖。

创建键同键同首次 payload：首次 201、重放 200 同一文件；异体 409。旧普通 Journal 全部为 writing，不按标题推断 Ritual。普通 Journal 自动标题编号只在 writing 集合按原全日期规则计算，包含软删现存行；新增 Ritual 不改变既有普通日记编号。Ritual 空标题显示“开始今天 YYYY-MM-DD”/“结束今天 YYYY-MM-DD”，不借标题决定类型。

## 4. 当前问题模板

`GET /api/ritual-templates` 返回 `{set:{questions:[],revision:0},end:{questions:[],revision:0}}` 的缺省或已存值，零写。`questions` 为 0～4 项 `{id:UUID,text:string}`，text trim 后非空且最多 500 码点，id 唯一。

`PATCH /api/ritual-templates/{kind}`，kind 仅 set/end，body `{expected_revision,questions}`。缺行用 revision=0 首次建立，否则 CAS；冲突 409，成功返回该模板。没有生成问题 API。模板 ID 仅供插入时记录来源，不以 FK/联动改正文。点击插入产生新的文档节点 ID，不复用模板 ID 当正文 ID。

## 5. Trash 与两种 Ritual 恢复

普通 `GET /api/trash`、详情、单条永久删除及普通恢复沿用 Stage 3，但详情换 JSON。`POST /api/trash/journal/{id}/restore` 仍用 If-Match；若 Ritual 同日同类有有效占位，409 `ritual_slot_conflict`，不修改任何对象。

2026-10-30 用户批准：Journal 软删除及 Trash 单条永久删除可携带 JSON body `{related_revisions:[{type:"journal",id,revision}]}`；存在受影响关联文件时必须提供完整身份与版本集合，缺少必需版本 428，版本陈旧或关联集合改变 409。无关联时允许省略 body，原 If-Match 和成功 204 不变。

### 完整替换

`POST /api/rituals/{source_id}/restore-replace`：If-Match 为回收箱来源 revision，body `{target_id,expected_target_revision,related_revisions}`。来源和目标必须为同日期同 kind 的两个 Ritual，来源已软删、目标有效。related_revisions 为受影响关联文件的身份/版本；无关联为 []。缺必要版本 428，陈旧或关联集合改变 409。

锁定并验证后，目标软删及其关联解除、来源恢复、各 revision 及投影在一个事务提交；返回 §10 FileMutation。保留双方原 ID/日期/Folder/用户正文/时间及 End 快照和回答；旧关联不因恢复自动重建。重复/丢响应先 GET 验证当前身份，不盲目换目标重做；CAS 保证不会第二次替换新文件。

### 对照与手动复制

左右对照使用普通有效详情与 Trash 详情 GET。没有自动 diff 合并写入。用户手动选定后调用 `POST /api/rituals/{source_id}/copy-content`：

```json
{
  "source_revision": 3,
  "target_id": 12,
  "expected_target_revision": 7,
  "copy_id": "11111111-1111-4111-8111-111111111111",
  "selection": [{"node_id":"22222222-2222-4222-8222-222222222222","from":0,"to":8}],
  "insert_after_node_id": "33333333-3333-4333-8333-333333333333",
  "related_revisions": []
}
```

2026-10-30 用户批准修正：文本范围以具有 ID 的 paragraph/heading 为单位，使用该块文字的 Unicode 码点半开区间（hardBreak 计一个换行）；text 节点不分配 ID。完整结构节点使用该项省略 from/to。不能选半个受保护 AI/目标结构来伪造身份；完整选择其容器由后端复制。必须同日期同 kind，来源仍在回收箱。插入位置必须存在；空选择/非法范围/作者伪造 422。服务端读取真实来源，不接收前端提交的“旧 AI 内容”。

新 ID 从 copy_id 和来源节点稳定派生，验证选择摘要；同一 copy_id 同选择已完整插入时返回当前结果不重复插入，异体 409；后续已修改/移除复制结果时陈旧重放 409，不能再次复制。原来源不恢复，当前 target 保留身份，已有回答不覆盖。复制目标使用新 goal_id；复制回顾保留文字/回答快照但不建立有效 link；评论只有合法受控复制能生成目标文件的新评论 ID，不能跨文件直接复用 Mark。

服务端持久化 copy_id、请求摘要、源/目标身份及复制结果校验信息，与目标修改同事务提交；记录不放在客户端可写的正文中。重放先核对请求和已插入结果，删除或改变结果后返回 409。记录用于幂等，不是正文版本历史。

两种恢复方式均适用开始今天和结束今天。当前本地较新输入由应用会话保留；用户必须明确选择采用/丢弃，不能把换 revision 当自动覆盖许可。

## 6. 目标关联与双向写入

`POST /api/ritual-goal-links`：body `{source_set_id,goal_ids,expected_set_revision,end_id,expected_end_revision,client_create_id,draft_started_at}`。goal_ids 非空、去重、必须属于有效开始今天。已存在结束今天时 end_id/revision 必填；不存在时 end_id=null、expected_end_revision=0、创建键和草稿时刻必填，创建日期必须等于来源日。新建带真实回顾内容的结束今天与 links 原子完成。重复关联同一目标返回既有关联，不产生重复回顾。

2026-10-30 用户决定：04:00 前实际捕获的加入草稿允许在换日后按原业务日提交。但当前接口没有服务端捕获凭证，无法区分真实延迟提交与伪造旧时刻；在解决该问题并批准相应契约前，不存在 End 的新建路径保持拒绝，不创建空壳。已有 End 的关联不受此限制。

`PATCH /api/ritual-goals/{set_id}/{goal_id}`：body `{expected_set_revision,expected_end_revision?,text?,checked?}`；text 非空、checked 为 bool，关联到有效结束今天时必须提供其版本。可从任一端发起，后端只允许开始今天 canonical 节点与关联镜像/系统标题变化，回答子树不在更新范围。成功返回 FileMutation；关联对象变化 409，来源失效 409 `source_unavailable`。

普通 Journal PATCH 中的 goalItem 变化也必须进入同一服务，并提供详情所列 `related_revisions`，不能绕过双向一致性。删除 goalItem/转换为普通文字、软删或永久删除任一关联 Ritual，均解除有效 link，并保留 End 的最后快照及回答、标记来源不可用；恢复不自动重连。用户手动删掉结束今天整个回顾是显式编辑，服务同时解除该 link；同步不能偷偷删 answer。

仅有效且主动关联的结束今天参与实时镜像更新；已删除/恢复的文件须由用户再次主动关联，不按相同文字或 ID 自动重连。GET 不通过写入修复关联。

## 7. 写作 AI 准备、执行、应用

仅 Journal；Insight 或 inbox 来源 422。kind 为 `go_deeper | minds_comments`，trigger 为 `manual | automatic`。现有完整复盘继续使用 `/api/ai/reviews` 与其一次确认保存，不改成自动总结。

### POST `/api/ai/writing/prepare`

body：request_id UUID、kind、trigger、source `{type:"journal",id,expected_revision}`，可选 question（Go Deeper，最多 2,000 码点）、mind_preset_ids（Minds，1～3 个唯一合法预置）、scope（Minds，all 或节点范围）。不接收前端自报 delta/正文/检查点/回复/设置快照。

2026-10-30 用户批准扩展：Minds 的 `scope` 还可为 `{"ranges":[{"node_id":"UUID","start":0,"end":3}]}`，含 1～100 个范围；每项指向保存快照内的用户 paragraph/heading，使用节点内 Unicode 码点半开区间，同一节点的范围不得重叠。单节点对象 `{node_id,start,end}` 与 `"all"` 仍保留。服务端按范围从快照取文字并校验节点、边界和评论归属，不接收客户端文字或自报 delta。自动调度所依据的真实输入及激活基线仍由 T09 客户端维护；服务端不能仅凭范围证明输入事件来源。自动请求发送的范围须覆盖本次实际新增/修订范围，跨节点时使用 ranges。

先按request_id核对首次payload摘要：同键同体回既有状态/结果，不重复建占位；异体409。随后在短事务中校验版本/有效状态/同源在途调用，计算 U 和增量，冻结快照/设置。Go Deeper 在保存快照边界创建稳定占位并预留下方用户段，返回 FileMutation 与 `{request_id,status:"prepared"}`；Minds 只登记分析范围和侧栏等待状态，不创建行内回复占位。无增量/有效问题时 Go Deeper 返回原 noop 文案且零请求/Token/占位。自动触发阈值不满足时客户端不发送prepare；服务端验证冻结范围/去重键，重复快照返回既有请求，不产生第二次调用。

### POST `/api/ai/writing/{request_id}/execute`

无生成 payload，只执行已登记请求；prepared 原子转 pending，现有同步路由工作线程完成有界上游调用，客户端由应用级管理器持有 Promise。pending 重放 202，其余已有状态 200，绝不第二次执行；非原执行者不接管。无模型配置 503，实际未调用不计已知 Token。网络期间不持有数据库事务/行锁，不引入 BackgroundTasks/队列/worker。返回结果持久化后的 ready/failed/unknown；usage 按既有独立子调用事务记账。

### POST `/api/ai/writing/{request_id}/apply`

body `{expected_revision}`；由文件写队列在已保存最新输入的有限序号屏障之后调用。只应用 ready 的已存结果：

- Go Deeper：占位仍存在，调用边界之前 U 与冻结快照一致；下方续写允许不同。只替换对应占位，C=调用时 U，文件/请求/C 一次提交。
- Minds：验证节点/码点范围及 quote。合法范围生成 comment/Mark；不可靠范围形成侧栏 `anchor_state:"unavailable"`，不猜位置挂 Mark。评论不改 Go Deeper C。
- 已 applied 相同应用重放返回已有结果，不重复插入/加版/计 Token。来源软删、替换、旧范围修改/占位删除则记录 conflict，保留已有结果，不推进 C、不再生成。

GET `/api/ai/requests/{request_id}` 继续只读，增加写作 kind、prepared、锚点和 comments 结果；复盘 legacy kind local/review 的已存记录仍能安全查询。prepared 未执行可明确继续同一 ID；pending/unknown 先查询，不自动换键。进程重启 pending 变 unknown 的既有恢复政策保留，prepared 不冒充已调用。丢响应查询/重放不重新付费。软删/替换源、删除占位的写事务同时使关联prepared/pending/ready写作请求失效为conflict；即使源随后恢复，旧请求也不重新获得附着权限。上游若已执行仍记录真实usage/结果，不能因conflict抹账。

## 8. 自动 AI 设置与参数

`GET/PATCH /api/ai/settings` 在原设置/CAS 上增加 `auto_go_deeper:false`、`auto_minds_comments:false`、`mind_preset_ids:["gentle_reflection"]`。预置合法值：`gentle_reflection`（温和陪伴）、`alternative_perspectives`（换个角度）、`thinking_traps`（思维陷阱）。本期无自定义 Mind CRUD 或记忆预置。

初始技术参数由前端 `state/autoAi.ts` 的单一配置对象维护并在测试中引用：pause_ms=15000、min_increment_code_points=80、cooldown_ms=60000；不增加高级调参 UI 或额外参数表。可根据实际交互证据调整，更新本节与对应测试，不重新询问已确认产品开关。

只有真实用户文本变更后调度；保存成功、当前可见、IME 已结束、无同源在途调用、增量达到阈值并满足停顿/冷却才 prepare。开关启用/打开会话时记录调度基线，旧文不冒充新增80码点；该客户端基线不是后端C，不把未分析旧文标为已消费。自动GoDeeper不读取未提交的独立提问栏，问题续聊仍由手动触发。冷却从该模式上次实际执行登记计时。两个模式均开启时同文件串行，Go Deeper 优先；Minds 的去重与消费范围独立，不能因 Go Deeper 推进 C 而跳过。

自动请求以 `(journal_id,kind,用户快照hash,有效分析范围,预置集合)` 派生非正文 `auto_dedupe_key`，数据库唯一；同快照的多标签/重挂载/重放返回已有状态，不增加占位或收费。手动明确“再请求”使用新 request_id，不复用自动去重键。切页仅取消未执行的自动调度；已 prepared/在途请求由应用接续状态查询，不因 remount 新建付费请求。AI/模板/同步/恢复/格式/初次加载事件均无 user_input 标志，不能触发循环。

## 9. 评论与既有 AI 能力

`GET /api/journals/{id}/comments?page=1` 返回该有效文件评论，固定20条；项含 id、request_id（可空）、mind_preset_id、text、quote、anchor、anchor_state、created_at，按 created_at ASC/id ASC 稳定排序。只有当 request 的真实 source 与文件一致才生成 Mark，原文是数据不是系统指令。

`DELETE /api/journals/{id}/comments/{comment_id}`：If-Match 文件版本；评论记录/对应 Mark 原子删除，204，usage/C 不回退。删除锚点正文可使评论 unavailable，但不能误挂其他位置；再次查看零模型调用。

`DELETE /api/files/journal/{id}/ai-blocks/{block_id}` 保留专用 AI 段删除，改为定位 JSON 节点；支持已保存回复/总结/占位，删除占位使该请求不得附着，真实上游费用不保证取消。Inbox/Insight 路径不开放。

完整复盘源最终仅 Journal，1～15 个 typed 唯一文件、最多7不同 journal_date；包括 writing/set/end，Insight 仍非法。来源快照和引用规则保持，JSON 作者提取排除 AI/系统内容；生成成功且源一致时 ready+C 的旧语义保留，确认保存时仍校验源变化，源变 409 保留预览。新建复盘目标为 writing；若追加到 Ritual，不改 kind/date、不创建第二个名额。Insight 草稿仍用户主动添加，一观点一文件、另加换键，正文用统一 JSON，来源作为文本/安全链接而非强事实图。

Token、已知/未知 usage、子调用唯一计量、受限搜索与 Key 隐私沿用 Stage 3。自动模式不扩大工具权限、上下文、搜索预算或模型供应商。真实有界验证权限另行授予。

## 10. FileMutation 与前端写队列

多文件命令和 AI prepare/apply 返回：

```json
{
  "files": [],
  "effects": [{"type":"journal","id":12,"base_revision":7,"revision":8,
    "ops":[{"kind":"replace_placeholder","node_id":"44444444-4444-4444-8444-444444444444"}]}],
  "request_id": null
}
```

files 为受影响完整详情，effects 是与这些详情对应的受控变化描述，ops 允许 replace_placeholder、comment_marks、goal_fields、goal_visibility、copy_nodes、restore_identity，实际内容/ID 由后端结果提供，不能由任意客户端写系统 ops。普通单文件 CRUD 保留详情响应形状。

应用用 files 确认对应提交快照，较新本地输入只接收与已知 base_revision 对应的窄 effects；不能整篇 setContent 覆盖较新草稿，不能在未知差异时只抬 revision 重发。多个文件会话按相同 typed key 顺序取得写队列；保存/命令失败保留输入和命令首次 payload。导航不等待这些队列。

2026-10-30 用户批准：普通 Journal PATCH 若实际导致多文件目标变化，仍返回 Journal 详情，并在可选 `file_mutation` 字段附带本节格式的受影响文件与 effects；无多文件变化时该字段为空。会话处理需避免把发起文件的普通保存确认重复应用，并对其他文件采用同一版本及草稿保护规则。

### Journal 本地草稿恢复契约

恢复数据存浏览器本地，不新增服务端草稿 API。保存草稿记录 schema 版本、独立草稿/标签身份、Journal 类型/业务日期、文件 ID（如有）、基线 revision、最新未提交字段/正文、输入序号，以及新建首次 `client_create_id` 和已发首次 payload；不存 Key 或 AI 私密提示词。POST 响应未知先用同键同首次 payload 重放取回 ID/revision，再比较服务器并以 CAS 保存后续输入；不能换键或把新输入改成首次 payload。

重开先列出本地候选并由用户选择恢复/稍后/明确丢弃；已有 ID 时 GET 当前服务端详情及 revision：基线相同才允许用户恢复并按既有队列保存，版本不同进入冲突界面保留服务器和本地两份；读取失败/404/软删/名额冲突不自动创建或覆盖，保留草稿供复制、稍后处理或明确丢弃。选择服务器版本也须明确确认；冲突解决再次写入携带实际 revision，期间再变化仍返回 409。恢复本身不触发 AI。

服务器成功确认仅允许清理对应草稿中不超过已确认序号且无较新输入的记录；旧响应不能删除更新后的草稿。多标签各有独立记录和序号，清理仅针对自身身份；故障与隐私边界见架构 §4。该恢复不提供每次自动保存历史。

## 11. Inbox 退出与旧请求

最终 `/api/inboxes` 及 Daily 路由从 OpenAPI/注册中消失，旧路径404；type=inbox 的 Search/Folder/AI/Link 等过滤值422。Search/Folder/Link 只查询 Journal/Insight；Folder 仍保护有效和回收箱引用，不能因为 Inbox 退出删掉 Folder 或其他文件。

删除全部 Inbox 检查点和 sources 包含任一 Inbox 的 ai_requests 整行；包含 Journal 的混合请求也整行清除，不能只删 sources 中的一项而遗留 question/result/settings 快照。ai_usage 断开 FK 保留匿名累计，其他 Journal 的 C 不因 request 消失被重置。已保存独立 Journal/Insight/总结文本保留，旧 AI 来源缺请求时显示记录已清除；内部标题引用不自动重写、猜测或新建。

切换前所有在途请求完成或受控标为 unknown 并停旧进程，旧执行者不得在清理后重新写回私人快照。客户端只清除 Inbox 恢复入口并保留其他文件的请求入口。禁止用数据卷重建、stamp 或修改历史 migration 代替升级。

## 12. 契约验证

T01 证明格式/作者/C/旧文/幂等/CAS，T02 证明即时导航/序号隔离，T04/T07 证明名额/恢复/目标生命周期原子性，T08/T09 证明快照/锚点/自动去重/计量，T11/T12 证明消费者与隐私退出。T13 必须跑真实浏览器→HTTP→PostgreSQL，关键输入丢失直接判失败；Mock 与真实供应商证据分开。测试和回滚矩阵以任务文档为执行入口。

## 13. 结题日程 C01 的边界草案

日程是独立资源，与 Set 目标没有自动创建、更新、完成或删除同步，不复用目标关联接口。目标契约：`GET /api/schedules?page=1` 返回 `{items,page,has_next}`，按开始时间与 ID 稳定排序、每页20；`GET /api/schedules/{id}` 返回详情。对象字段 `id`、`title`（非空、最多80 Unicode码点）、`starts_at`（带时区 ISO 时间）、`ends_at`（同格式或 null，若有须晚于 starts_at）、`completed`（布尔）、`revision`、`created_at`、`updated_at`；时间存储为 UTC，显示按 Asia/Shanghai 转换。`POST /api/schedules` 接受 title、starts_at、ends_at、completed 及 UUID `client_create_id`；相同键和首个 payload 返回同一资源，不同 payload 409。`PATCH /api/schedules/{id}` 接受 `expected_revision` 和变化字段，实际变化原子增版；缺版本428、无效字段422、过期409；`DELETE` 以 If-Match 携版本，成功204、过期409。不存在返回404，GET零写。删除为硬删除且仅删除该日程，不触及 Set/End；若另需回收站须另行决定。

建议/情绪经 AI 只产生候选供用户确认，查看或取消零日程写；保存统一走上述 POST。时间不足或非法需修改。模型失败不阻断手动日程；调用/幂等/unknown 与 usage 沿用 AI 现有契约，具体建议端点和付费预算在 C01 实施前单独补充，不引入自动保存猜测。此处不授权新接口、迁移或付费调用。
