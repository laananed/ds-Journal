# S04-T12 恢复入口修复交接

- 用户授权本轮修改共享恢复索引、陪伴写作组件、复盘页及相关测试；开始前开发者记录停写且交付冻结基线，HEAD `856d602307215204b992fdd3ea954e6d0fb88241`，交接散列一致。本对话原先参与独立测试，现为修复开发者，后续须由未参与本次修复的新对话独立测试。
- `aiRequestState.ts`：local/review 同源可并存，按类型查找，清除按 ID；未知条目保留，损坏或版本不明索引拒绝覆盖。`AiWritingActions.tsx` 只恢复 local 并检查返回类型；`ReviewPage.tsx` 在响应应用、轮询、手动恢复时检查 review 类型。不匹配时保留入口、显示未知且不自动重发。已有 T12 未提交改动保留。
- 新增测试 `frontend/src/utils/recoveryTypeIsolation.test.ts`，覆盖同源类型、分别清除、Journal、未知类型、损坏索引、未知版本和返回类型。先观察同源覆盖失败，再实现。`node --experimental-strip-types` 运行该测试、`aiRequestState.test.ts`（150 断言）、`reviewSelection.test.ts`（74 断言）、`state/aiRequests.test.ts`（50 断言）退出码均为 0；`npm run build` 退出码 0，Vite 有 chunk 大小提示。
- 隔离 Mock 浏览器：review 索引不出现在历史 Inbox 的陪伴写作中；复盘页可查询 review；Journal 同源双索引清除 local 后 review 仍可见。另用 `s04-t12-recovery-mismatch-server.py` 返回 local/applied 给 review，显示类型无法确认，刷新后入口保留；日志 `s04-t12-recovery-mismatch-requests.jsonl` 共 13 次 GET、无写请求。测试没有使用真实后端、数据库或模型；清除本地入口不删除服务端请求。
- 未验证：异常响应在真实浏览器轮询分支、真实服务、真实数据库、模型执行、完整 T12 数据收缩和独立验收。Insight 不接受此类恢复源且不含该组件，依据前轮独立测试；本轮未更改 Insight。
- 模拟服务已停止，无提交、合并或推送；需进行独立测试和规定风险复核，用户最终接受后才可宣布交付。

SHA-256：

```text
63BD9150A69ABCA70987F8BC2ED3DD0E503BAEC23263056F795D5D72601123D1  frontend/src/utils/aiRequestState.ts
FF6EF23F748CE35DAC2AB90B4CC57270EE132953511F2DBCC6D04436D65D2C22  frontend/src/components/AiWritingActions.tsx
9E7C7B1752D992F7DA04841F482CA17DA73915E78C537F9222CEB26B4258B80B  frontend/src/pages/ReviewPage.tsx
7D994B492CA2AC07D87EE152E80DF5D375C9DFAF74A5CECE885D9514594771E9  frontend/src/utils/recoveryTypeIsolation.test.ts
```
