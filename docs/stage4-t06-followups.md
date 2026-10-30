# Stage 4 T06 未验证项与排查线索

2026-10-30：用户反馈 T06 交叉测试通过，授权提交；本记录编写时尚未找到该轮交叉测试报告及其精确基线，具体覆盖和结果待补证据。此前 `.workbuddy/s4-t06-independent/T06-independent-test-report.md` 是早期页面级测试，不能代表后续接线版本通过。开发者自测见 `C:\Programme\demo\SeekJournal-Work-01\.workbuddy\s4-t06-wiring\T06-delivery.md` 和 `e2e-replay-result.json`；这些本地报告可能不受 Git 跟踪。

## 开发者交付时明确未验证

- 真实中文输入法 IME 组合期间的输入、切页和保存：此前浏览器仅以 `Input.insertText` 输入中文。
- 上海 04:00 跨日的实际边界；两真实标签同时恢复/保存；浏览器中创建后 PATCH 发生 409 的冲突保留。
- Dashboard 正式浏览器路径和真实数据断言，在该轮报告未重跑；本分支未复跑 T11 Insight 测试。最终整合后应在实际版本核对。
- 真实浏览器完整关闭/进程意外结束及重开、存储权限/配额/失败；开发者 22/22 测试使用 `Page.reload`，不应扩大成全部关闭/崩溃场景已验证。

## 恢复与会话排查

- 开发者报告真实浏览器→HTTP→隔离库测试：服务器提交 POST 后丢弃响应，重放同创建键与首次 payload，再 PATCH 新输入；22/22 通过。必须保持原 `first_request` 及其真实 seq、恢复 `inputSeq`，不能以新输入替换首次 payload，不能让旧响应清除较新的草稿。
- 曾发现本地镜像先于首次请求冻结导致 `first_request` 为 null，空编辑器 system 同步产生本地空草稿，以及 ackedSeq 错把新输入当成已确认。若出现重复记录、草稿残影或丢字，检查 `useEditSession.ts`、`localJournalDrafts.ts`、`pendingCreateReplay.ts`、`editSessions.ts` 及本轮交付报告。
- 创建成功后的会话仍可能以 draft 键存在；T11 使用 `findInsightSession` 适配。本轮未修改该核心身份策略；合并 T11 后应核对真实创建→重开→编辑及导航不会丢字。
- T07 的 `applyNarrowOps`/`applyFileMutation` 已修改会话核心；本 T06 分支 HEAD `a583496`，开发者报告手动同步了相关文件而非合入整个 main。与包含 T07/T11 的主线整合时，检查最终 diff、冲突和完整会话行为，不以复制个别文件宣称已整合。

## 资源与后续

- 开发者自测使用 `seekjournal_test_02`，报告称本轮 manifest 对象已清理。以后测试须重新确认实际目标、迁移、数据/连接基线、清理逻辑和独占窗口；个人库 `seekjournal` 默认只读。
- T06 是否完成用户视觉接受、整合后的全路径复测及 T02 防丢字专项审核，按后续实际证据记录；T07/T11 未完成项另见 `docs/stage4-t07-t11-followups.md`。
