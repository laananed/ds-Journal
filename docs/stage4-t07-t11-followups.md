# Stage 4 T07 / T11 已知问题与后续排查

记录日期：2026-10-30。用户决定为加快开发，T07 按现有结果继续、T11 修复不再安排交叉复测，并允许提交。此决定不改变下列真实测试结果，不等于全部需求实现、专项风险审核或 Stage 4 验收通过。后续出现相关问题时，先核对当前版本，再参考本记录与各工作树 `.workbuddy` 报告；报告是当时快照，可能未被 Git 跟踪。

## T07 目标同步和生命周期

- 交叉测试基线 `codex/s4t7`，HEAD `6f12de2` 加未提交 diff；报告称 196 项聚焦测试及 11 项探针通过，测试前后散列一致，但缺开发者明确停写确认。详细报告：`C:\Programme\demo\SeekJournal\.workbuddy\s04-t07-independent\report.md`；开发交接在 `.workbuddy/s04-t07-codex/handoff.md`。
- `test_journal_update_schemas.py` 4 项因新增 `related_revisions` 后字段集合断言失败；须核对契约、保留原测试意图并补验证，不能仅删断言。全量回归另有 3 failed、38 errors 在干净原 HEAD 重现，涉迁移链/固定 revision 和 AI smoke 环境；排查时不得读取或使用真实 Key、未经授权触发付费调用。
- 缺 End 时 `end_id=null` 目前 fail-closed 422，不创建空壳；原目标的 End 与 links 原子创建尚未实现。API §6 记录了跨 04:00 草稿捕获真实性问题及当前限制；解决需先确定安全契约，不绕过该保护。
- 目标组件未接线，GoalItem NodeView 只读，页面/transport 尚未消费 PATCH 的 `file_mutation`，关联删除 204 后页面需重读；浏览器→HTTP→PG 闭环未验证。需在 T06/T10 接线后验证两端数据和回答保留。
- Trash 永久删除关联 Ritual、完整替换的第二条 End 分支、关联故障注入及所有跨日期/恢复/丢响应组合未充分验证；新 Codex 跨文件一致性专项审核未做。关联删除须保留 End 快照和回答，恢复不自动重连。
- 等价目标修改路径对 End `updated_at` 的行为不同；writing 详情可能省略关联字段；T02 未识别 op 由 ignored 改为 conflict，旧场景 7.5 需按新代码复测。定位保存冲突或意外时间变化时优先检查这些差异。
- 本工作树缺 Tiptap 依赖，本地 build 未通过；隔离副本借用另一工作树依赖构建通过，不等同本工作树通过。不要擅自安装依赖。
- T04 遗留：mindComment 受控复制保守拒绝；复制重放目标软删后的状态码需与 API 核对；T01/T04 专项审核仍待办。

## T11 Insight / 内部链接修复

- 原交叉测试基线 `wb/s4t11` HEAD `a583496` 加当时 diff：395 后端测试、31 HTTP 场景等报告通过，但 D1 同页创建 Insight 后重开详情可能丢输入，D2 JSON 内部链接不可激活。原报告：`C:\Programme\demo\SeekJournal-Work-02\.workbuddy\s4-t11-independent\report.md`。
- 修复基线 HEAD `9d34fce` 加 6 个修改和 2 个新文件。开发者报告 D1 以 `findInsightSession` 解析存活会话、D2 在 `RichTextEditor` 接入内部链接；真实浏览器/HTTP/PG 自测通过。证据：`C:\Programme\demo\SeekJournal-Work-02\.workbuddy\s4-t11-fix\report.md` 和 `baseline.md`。用户决定不再交叉复测：故 D1/D2 是开发者报告已修复，未获修复后独立验证。
- D1 排查线索：创建成功时队列键与会话草稿键可能不同；详情订阅、写入、冲突恢复、卸载清理应使用相同存活会话。多标签并发同一 Insight、阅读态使用草稿标题未单独验证。
- D2 排查线索：普通文本 `[[标题]]` 的链接装饰/点击，codeBlock 和 code mark 不激活；零候选不新建。编辑态 Ctrl/⌘+点击；检查回调更新、搜索/分页与 legacy 回归。
- 正常浏览器 5186 直连 8036 因 CORS 被拦；开发者报告同源 `/api` 代理 200。应先确定实际采用的本地网络配置并用正常浏览器验收，不以关闭 web security 代替；不得擅自放宽来源或暴露网络。
- T04/T07 的 Ritual 冲突恢复与关联解除尚未在 T11 整合版本验证；Review→Insight 真实 AI 链路未验证。个人库只读、真实模型付费调用均需独立授权。

## 共享资源和 T06

- T11 测试曾将 `seekjournal_test` 前向升级；`seekjournal_test_04` 的 `4f8e1a3c9d02` 对旧分支不可用。测试前核实当前数据库、迁移 head/current、数据基线、其他连接、清理逻辑及独占窗口，不降级、清空或重建未知库。
- 报告指出 `test_ai_settings_api._clear_settings` 有无条件删除风险；任何测试库写入前核查实际清理路径，仅清理本轮 manifest 创建的对象。
- T06 正式接线、原键原 payload 创建重放后 PATCH、真实浏览器/HTTP/PG 与恢复边界仍需按实际交付核查；T07 已改变 T02 op 处理，整合时核对共享会话核心并复测。
