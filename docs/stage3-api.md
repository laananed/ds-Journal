# SeekJournal — Stage 3 API 契约

> 2026-10-10，规划契约，未实现。产品见 `stage3.md`；数据/算法见 `stage3-architecture.md`。除本文件明确升级项外，Stage 2 的分页、日期、标题、Folder、Search、Trash、Link 契约继续有效。开发时前后端配套验收，不将中间版本作为整体可用状态。

## 1. 通用规则与写保护

REST/JSON，`/api`，文件身份 `(type,id)`，ISO 日期/带时区时间，固定 20 条分页。纯读取不创建设置、块、检查点或 Daily。非法字段仍采用现有 Pydantic 422；新增 AI/结构化请求拒绝未知字段，不继承普通旧 Schema 的系统字段 ignore 来绕过作者验证。

文件完整响应新增 `revision: integer >=1`；Journal/Inbox **详情**新增 `content_blocks: Block[] | null`；Insight 没有 blocks。普通列表仍返回 content 阅读投影及 revision，不携带 blocks；Trash 详情包含原 blocks（只读）。写响应返回详情形状，AI 插入返回最新文件。原有 title/display_title/业务日期/Folder/created_at/updated_at/deleted_at 不改含义。

普通文件 POST 新增可选 `client_create_id: UUID`，Stage 3 UI 必须传；仅保留旧客户端无键创建的兼容性，不为其承诺防重复。键唯一范围为各文件表，相同键/首次创建 payload 回原文件（首次 201，重放 200），不同 payload 为 409；文件删除后不保证旧创建键永久有效，前端不得为新草稿复用旧键。
三类 PATCH 必须含 `expected_revision`；缺少返回 428，旧值返回 409，不能以 updated_at 当锁。title/content/日期/Folder 的省略与 null 语义沿用 Stage 2。空更新或提交意图与当前状态完全相同安全返回 200，不加版、不改时间；旧版提交若不同则 409。现有 API 测试需要显式增加版本字段并保留旧测试意图，不把缺版本兼容处理隐藏在 fixture。
DELETE 三类文件、Trash restore 与永久删除使用 `If-Match: "<revision>"` 必填（缺 428、非法 422、旧 409）。软删/恢复成功 revision+1，updated_at 原值；DELETE 204 空体，restore 200 新详情。Folder 不自动保存，保持 Stage 2 原契约。不存在/已软删普通文件 404。

错误保持简单 `{"detail":"..."}`，前端依据 HTTP 状态显示。AI 调用业务失败也可由请求查询返回带 status 的已持久化结果，不能只依赖 HTTP 状态判断是否已计费。

## 2. 结构化正文保存

Block 类型：

```json
[
  {"id":"11111111-1111-4111-8111-111111111111","kind":"user","text":"今天挺累的。"},
  {"id":"22222222-2222-4222-8222-222222222222","kind":"ai_reply","text":"是哪件事最耗你呀？","request_id":"33333333-3333-4333-8333-333333333333"},
  {"id":"44444444-4444-4444-8444-444444444444","kind":"user","text":"\n我好像一直担心做不好。"}
]
```

POST/PATCH Journal/Inbox 可以提交 `content` 或 `content_blocks`，不可同时提交。blocks 非 NULL 的文件：普通 content 写入返回 409（需要结构化编辑），不能让旧客户端扁平化并丢作者身份；仅改标题/日期/Folder可继续普通 PATCH。旧 NULL 文件按既有 content 规则写，首次转换 blocks 的拼接正文必须与旧 content 完全相同，或作为用户显式编辑后的新正文通过校验；不自动解读旧 AI 标记。
客户端只能新增/编辑 user、保持已有 AI 段、编辑已有 ai_summary.text；禁止新增 AI kind、篡改已有 AI ID/request_id/kind、删改 ai_reply.text 或重排已有块。AI 段删除走下面专用接口。局部封口只允许在最后 user 后添加一个空 user 续写段，不创建空文件。总结创建与来源身份由后端专用保存生成。
正文长度以服务端阅读投影计算，最大 50,000 Unicode 码点，不截断。普通保存至少有有效用户正文；服务端复盘新建可只含有效 ai_summary。旧超限正文未变的结构转换不拒绝、但新增内容必须满足新输入限制；只改其他业务字段不重新验证旧正文。

`DELETE /api/files/{type}/{id}/ai-blocks/{block_id}`：type 仅 journal/inbox，`If-Match` 必填；204。只删指定 AI 段，刷新原文件详情；不存在文件/段 404，user block 422，过期版 409。revision+1、updated_at 刷新；C 与 Token 不变。不追加「删除历史」。

## 3. 设置与计量

| Method | Endpoint | 请求 / 响应 |
|---|---|---|
| GET | `/api/ai/settings` | 200 默认或持久设置及配置状态；零写 |
| PATCH | `/api/ai/settings` | expected_revision、custom_prompt 可省略（空串清除，最多 4,000 码点）、web_enabled 可省略；200；冲突 409/缺版本 428 |
| GET | `/api/ai/usage` | 200 全局累计已确认模型 Token、未知子调用数与搜索请求数 |
| GET | `/api/files/{type}/{id}/ai-calls?page=1` | 200 固定 20 条该文件关联功能调用；源普通入口失效 404 |

设置响应固定字段：`custom_prompt, web_enabled, revision, model:"deepseek-flash", model_configured:boolean, search_configured:boolean, effective_web_enabled:boolean`。缺设置行 revision=0；首次 PATCH expected_revision=0 建单行，不改 Key。effective = preference && search_configured；调用还需模型 Key。请求不得提交 Key、模型、base_url 或真实执行端配置。
usage 字段：`prompt_tokens, completion_tokens, total_tokens, unknown_subcalls, search_requests`；仅 known 子调用求和，非人民币账单。calls 每项含 request_id/kind/status/created_at、上述计量字段、source identities、saved_target（可空）；不通过列表重复返回私人请求快照。一个多篇 request 在各文件出现同一 ID，全局 ledger 只算一份。

## 4. 局部互动与请求恢复

`POST /api/ai/local`：

```json
{
  "request_id":"33333333-3333-4333-8333-333333333333",
  "source":{"type":"journal","id":12,"expected_revision":5},
  "question":"我为什么老想着这件事？"
}
```

source 必须是有效 journal/inbox；expected_revision 必填。question 可省略，最多 2,000 码点，纯空白按无问题。后端从文件与 C 计算增量，不接收前端自报 delta/检查点/AI 回复。开始前前端已完成自动保存及块转换/封口。
正常调用同步完成返回 200 `AiRequest` 且 status=applied（蓝块已提交）；客户端处理期间锁该文件。无有效增量/问题：200 `{status:"noop",message:"要我分析啥啊？",request_id:null,usage:null}`，无请求登记/上游/文件写入。revision 冲突 409 且不调用上游。
同键同 payload 重放：pending 返回 202，其他状态 200；不再生成。同键不同 payload 409。源已有 pending 返回 409；进程同时调用限额超出 429。未配置模型 503，未调用时不产生 Token。上游失败/超时映射 502/504 并带可查询的 request_id；不透传 Authorization、完整供应商 body 或正文。

`GET /api/ai/requests/{request_id}`：200 下列请求结果，未知 ID 404，纯读取；pending 重复查询不重发。可按用户点击有限轮询（如每 2 秒，仅在页面可见/有在途状态时），不建永久监控服务。
客户端仅持久化恢复所需的请求 ID/kind/源身份，不持久化正文或 Key；404 移除该恢复入口，不重新 POST。详情页可从 ai-calls 查到其他未清除的历史调用。

```json
{
  "request_id":"33333333-3333-4333-8333-333333333333",
  "kind":"local",
  "status":"applied",
  "sources":[{"type":"journal","id":12,"revision":5}],
  "reply":"是哪件事一直拽着你呀？",
  "file":{"type":"journal","id":12,"revision":6},
  "review":null,
  "saved_target":null,
  "usage":{"prompt_tokens":90,"completion_tokens":18,"total_tokens":108,"unknown_subcalls":0,"search_requests":0},
  "web_status":"not_needed",
  "citations":[],
  "error":null
}
```

file 在 applied local 响应为完整详情（示例仅展示身份/版本）；查询已被永久删除的源不重建，file=null。status：pending、ready（完整复盘待保存）、applied、failed、conflict（结果存在但源不匹配）、unknown（上游/进程状态不明）。failed/conflict/unknown 的 error 为安全分类与说明。web_status 为 disabled/not_configured/not_needed/searched/failed/blocked；citations 为 title/url，纯 HTTP(S)，安全阅读沿用 Stage 2。
客户端 unknown 状态明确显示可能已消耗 Token，不自动新建 request_id 重试；点击新请求才授权重新发送。正常 request replay 不再插块或重复计数。

## 5. 完整复盘生成

`POST /api/ai/reviews`：

```json
{
  "request_id":"55555555-5555-4555-8555-555555555555",
  "sources":[
    {"type":"journal","id":12,"expected_revision":6},
    {"type":"inbox","id":9,"expected_revision":3}
  ]
}
```

1～15 个唯一 typed sources，仅 Journal/Inbox；服务端依据各实际业务日期计算 distinct <=7。不接收用户自报日期/全文。0、16、8 日期、重复源、Insight 为 422；不存在/删除 404；版本过期/在途同源调用 409；所有校验在付费请求前完成。
1 源为单篇，2～15 为多篇。默认生成全部用户正文复盘，设置/联网/模型与局部相同。正常 200 AiRequest status=ready；重放/失败/恢复语义同 §4。预览生成成功且源未变才更新源 C，原文件正文不变。发生源冲突则保留预览但 status=conflict，不更新 C。
review 对象包含：`facts[]`、`emotion_hypotheses[]`、`possible_explanations[]`、`angles[]`（固定三个标题，内容可承认证据不足）、`logic_chain[]`、`follow_up_questions[]`、`insight_drafts[]`、`markdown`。facts 每项 text/evidence[]；推测每项 text/evidence[]/uncertainty；evidence 固定 source `{type,id}` + 原文 quote，服务端校验 quote 是对应用户正文子串，不允许用 AI 回复当依据。Insight 每项 draft_id/title/viewpoint/evidence[]/content，一个 viewpoint 一份；无适合观点时为空数组。数组/输出按生成预算限定，不给前端推理链，不要求揭露模型隐藏 reasoning。

## 6. 总结一次确认保存

`POST /api/ai/reviews/{request_id}/save`：

```json
{
  "markdown":"用户审核并编辑后的完整复盘",
  "target":{"mode":"append_source"}
}
```

或 `target:{mode:"new_journal", title:null, journal_date:"2026-10-10", folder_id:null}`。markdown 必填有效，不能另指定不相关源文件。append_source 仅单篇 Journal；默认方式由产品 §5 决定。默认日期由前端在发起复盘时捕获，保存参数显式发送，后端不按午夜猜日期；标题可用户编辑，未填使用「AI 复盘 YYYY-MM-DD」。默认 Folder null。
锁所选源，比对请求快照（revision/用户正文及源状态）；新建/追加 + request.saved_target/status 在同一事务。首次新建返回 201，追加返回 200，payload 完全相同的保存重放返回 200 同一 target；保存 body 与已成功 body 不同 409，不再自动添加另一篇。未 ready（pending/failed/conflict/unknown/local）409。FK/长度/正文失败 404/422，事务不产生半篇；源变化 409 保留预览，需重新复盘，不能静默忽略。
追加生成 ai_summary，服务端写 `---` 阅读投影；新 Journal 为 ai_summary + 空 user 续写段，revision=1。返回 `{request_id,status:"applied",target:<Journal详情>}`，前端导航目标与刷新失败分开。不通过自动保存直接提交预览以绕过唯一一次确认。
保存后同一请求还可查看 Insight 草稿；「取消预览」只是 UI 离开，ready 结果可恢复，不需要删除/取消上游接口。

## 7. Insight 草稿添加

不新增 AI 写 Insight API。用户选中 review.insight_drafts 的单项后进入 Insight 编辑器，沿用 `POST /api/insights`：title/content/folder_id/client_create_id（初次从 draft_id 派生的稳定 UUID）；首次有效自动保存才创建，重试同键回原文件。相同草稿若用户明确要另加一份，使用新创建键，不自动语义判重。后续 PATCH 使用 expected_revision。
普通搜索保持 `GET /api/search`，界面只帮助填入观点关键词，用户查看相似结果，不替换为模型相似度。来源记录在普通 Markdown 内容，未新增强关系/API。

## 8. 契约验证门禁

T01/T02 测文件版控/创建重放与旧数据，T03 测设置/usage/Key，T04/T05 测块校验与增量请求，T06 测工具上限/隐私/计量，T08 测复盘边界与保存事务，T09/T10 测浏览器确认与自主添加；具体方法和文件见 `stage3-tasks.md`。检查实际调用 payload 与 DB 提交，不仅检查返回文字。所有 Key/真实日记排除证据。
