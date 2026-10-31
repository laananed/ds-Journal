# S04-T12 退役盘点（开发中，2026-10-31）

基线：`codex/s4t12`，`856d602307215204b992fdd3ea954e6d0fb88241`。这是静态盘点，不是删除授权或数据库内容台账。

| 对象／路径 | 后续处理 | 必须保留或验证 |
|---|---|---|
| `backend/app/inbox/`、`main.py`、`alembic/env.py`、inboxes 表 | 退役 API、运行时模型与表；历史迁移保留 | 旧路径 404；未知依赖拒绝；不能使用 CASCADE |
| `frontend/src/App.tsx`、`pages/InboxPage.tsx`、`api/inboxes.ts`、`types/inbox.ts`、`utils/inboxDraft.ts` | 移除导航、页面、客户端入口和 Inbox 恢复索引 | Journal 恢复索引与未提交草稿不受影响 |
| `folder/{service,schemas,models}.py`、`search/{service,schemas}.py`、`link/{service,schemas}.py` | 移除 Inbox 查询和类型 | Folder 行及有效/回收箱文件保护；同标题链接不改写或误删 |
| `trash/service.py`、`frontend/src/pages/TrashPage.tsx` | 核对 Inbox 提示及恢复投影 | Journal／Insight 回收箱及旧正文读取保持 |
| `ai/{schemas,router,local,review,requests,usage,models}.py`，前端 `api/ai.ts`、`utils/aiRequestState.ts`、复盘与来源组件 | 清理 Inbox 来源/恢复入口；按来源识别整条请求 | 混合请求整行及所有私人快照清理；Journal 请求不误删；未知来源拒绝 |
| `ai_checkpoints` | 删除 Inbox C | Journal C 原样保留，即使其 `last_request_id` 指向被清理请求；该字段没有 FK |
| `ai_usage` | 对待删请求断开引用，保留计量行 | 匿名累计与 unknown 保持；当前 FK 是 `ON DELETE SET NULL`，仍须验证实际库约束 |
| `ai_comments` | 核查待删请求引用并显式纳入台账 | 评论文本、锚点、Journal 均保留；FK `ON DELETE SET NULL`，需验证实际库约束 |
| `journals.content_blocks`、`writing/{service,schemas,router}.py`、Journal 编辑/投影 | 保留旧字段和无法安全转换的原文 | 转换及删除需证明作者、R/U/C、引用及备份恢复；当前无此证明 |

## 并发与恢复门槛

`ai/local.py` 和 `ai/review.py` 的远程调用与数据库事务分离；迟到执行者仍可能尝试记账和完成请求。`unknown` 只描述状态，不能证明旧进程停止。切换前须证明所有旧执行者停止或被可靠隔离并保持独占；未证明时拒绝。来源格式不明、未知表/外键/触发器、未验证备份恢复、无法核对保留数据或回滚边界时均拒绝。普通 downgrade 不能恢复已删除数据。

## 上轮只读数据库检查

2026-10-31：实际 `current_database()` 为 `seekjournal_test_03`，事务只读，revision `c01a7e421b50`；其他连接 4。`public.ai_usage` 有 1 条既有记录，其余已列业务表无记录。无法证明独占及该记录归属，未写入、迁移或清理。检查结果是瞬时快照，不能代替下一轮重新核实。

## 尚未完成

实际数据删除台账、数据库约束与隐式依赖核验、全量转换及恢复证据、收缩迁移、后端消费者退役、独立测试和风险审核均未完成。空过渡 revision 已移除；`retirement_preflight.py` 仅分类来源，尚未接入未来收缩迁移，不提供切换安全证明。

## 2026-10-31 过渡调用链

导航 `App.tsx → InboxPage → api/inboxes.ts → inbox/router.py` 保留为历史访问；Folder、搜索和链接保留 Inbox 查询与打开；Web 不再展示新建、编辑、删除和新的 Inbox AI 选源入口，保留既有请求查询恢复。后端 AI local/review 及旧 API 仍接受 Inbox 来源，`aiRequestState.ts` 保留恢复索引。旧客户端仍可使用旧写 API；以上为源码和无库检查，并非浏览器/数据库端到端验证；最终退役必须同步移除后端路径及处理历史请求。
