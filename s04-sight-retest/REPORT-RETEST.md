# 独立复测：Insight / 独立日程 修复

测试者未参与本次实现（独立会话、独立执行）。本报告只记录实测，不改产品代码。

## 1. 基线与写入停止核对

| 项 | 交接声明 | 实测（开始） | 实测（结束） |
|---|---|---|---|
| 工作树 | `C:\Programme\demo\SeekJournal-Work-03` | 同 | 同 |
| 分支 | `wb/sight-check` | 同 | 同 |
| HEAD | `856d602` | `856d602307215204b992fdd3ea954e6d0fb88241` | 同 |
| 暂存区 | — | 空（`git diff --cached --stat` 无输出） | 空 |
| stash | — | 空 | 空 |
| 未暂存 | 4 文件 | 4 文件，357 insertions(+), 20 deletions(-) | 同 |

未跟踪：`frontend/src/state/insightLocalDrafts.ts`、`frontend/src/state/insightLocalDrafts.test.ts`、`s04-sight-check/`。

文件散列（`git hash-object`，开始与结束**完全一致**）：

```
47acd778fe3cf1a8801108e2dc154f69a9f4deb5  frontend/src/state/insightLocalDrafts.ts
9b955fbf95db4cf25f7e80c0c3a0ee24e6b0a33a  frontend/src/state/insightLocalDrafts.test.ts
b25762b684e77fc41f90d834d7b6c94625934a67  frontend/src/pages/InsightPage.tsx
37a884283a6fb6e2df1cd3a022c0223e84da07d4  frontend/src/pages/SchedulePage.tsx
adbd72dd541a866d73a2524aafdaf3f7816201e7  frontend/src/utils/scheduleForm.ts
42a772dc2d032147a9a19e2da2da0c0651095d72  frontend/src/utils/scheduleForm.test.ts
54b96b66f33b8a4289addd49df886b318c414764  s04-sight-check/fix-verify-run.mjs
```

开发者确已停止写入（无新增改动、mtime 停留在 19:55，复测期间无变化）。测试者未修改该工作树任何文件，证据全部写在本目录（`Work-02/s04-sight-retest`）。

## 2. 方法

- 重建产物，确保被测 bundle 对应上述源码：`tsc -b` 退出 0，`vite build` 退出 0。
- 自建预览服务 `vite preview --port 4194`（避开开发者的 4193），测毕已停止，端口已释放。
- 浏览器：Playwright + 系统 Chrome，headless；**全部 `**/api/**` 由 `mock-core.mjs` 拦截**（复制自 `s04-sight-check/mock-core.mjs`，散列 `d43b054fc3a3dab063f5c8c1729a6ff307306f9c`）。
- 22 个独立场景（每个场景独立 browser / context / state）+ 2 个定向探针。
- 运行：`node s04-sight-retest/retest-run.mjs`、`node s04-sight-retest/probe-storage.mjs`。

## 3. 结果总览

| # | 要求 | 场景 | 结论 |
|---|---|---|---|
| 1 | 新建记录：自动保存前刷新 | R1(100ms) R2(450ms) R3(750ms) R20(关标签页) R22(恢复后再刷新) | 通过 |
| 1 | 已保存后刷新不误报 | R4 | 通过 |
| 1 | 已有记录：追加后立即刷新 | R5 | 通过 |
| 2 | 冲突可见、恢复前不 PATCH | R6 | 通过 |
| 2 | 选择服务器版本 | R7 | 通过 |
| 2 | 恢复本机草稿后**保留双方内容** | R8 | **部分通过（见 P-A）** |
| 3 | 空内容取消 | R9 | 通过 |
| 3 | 仅标题 / 有正文取消，等待 2000ms | R10 R11 | 通过 |
| 3 | 确认框点“继续编辑”后自动保存恢复 | R11B | 通过 |
| 4 | 日程脏表单离开提示 | R12 | 通过 |
| 4 | 干净 / 已保存表单不误提示 | R13 R14 | 通过 |
| 5 | 创建成功 + 列表刷新失败 | R15 | 通过 |
| 6 | 回归：Insight 创建/编辑/自动保存/重开 | R16 | 通过 |
| 6 | 回归：日程编辑/完成/删除/409 | R17 | 通过 |
| 7 | 存储不可用 / 写入失败 | R18 R19 + 探针 | 通过 |

`pageErrors` 全部为 0。

## 4. 关键实测数据

**窗口内刷新（新建）**：100 / 450 / 750ms 三档都在刷新前 POST=0；刷新后列表出现「发现 1 份未提交的 Insight 草稿（只存在本机…）」；点「恢复」前 POST 仍为 0（不会自动恢复/提交）；恢复后标题与正文标记都正确；随后 1 次 POST、服务端有正文、草稿键清空。

**已保存后刷新**：`postBefore=1`、无横幅、无草稿键、列表可见。

**已有记录**：追加后 150ms 刷新 → 重新打开该记录出现「发现上次未提交的草稿…｜丢弃本机草稿｜恢复草稿」；选择前 PATCH=0、服务端未被改动；恢复后 PATCH=1、服务端含标记、键清空。

**冲突**：提示「它基于 v1，服务器当前是 v2」；等待 1200ms 仍 PATCH=0，服务端仍是 v2。选「使用服务器版本」→ PATCH=0、草稿键删除。

**取消新建**：空内容 → 无面板确认、无应用级对话框、面板关闭、POST=0，页面无“保存失败”。仅标题 / 有正文 → 出现「放弃这条未保存的 Insight？…不会创建记录。｜继续编辑｜放弃并关闭」；等待 **2000ms**（远超 800ms 自动保存窗口）`postWhileWaiting=0`；点放弃后关闭、POST=0、无残留草稿键。点「继续编辑」→ 确认框消失、编辑器仍在、1 次 POST 且服务端有正文（保存链路未被永久阻断）。

**日程**：改标题后刷新触发 `beforeunload`，PATCH=0；空新建表单、未改动的编辑表单刷新均不触发；已保存后刷新不触发、POST 仍为 1（无重复创建）、列表 3 条一致。创建成功且 `GET /api/schedules` 返回 500 时：服务端 3 条、列表里能看到新条目、「已创建「刷新失败-R15」（不影响 Set 目标）。」、横幅为中文且含“重新读取 / 避免重复创建”；点「重新读取」后 POST 仍为 1（未重复发送创建）、横幅消失。

**回归**：Insight 创建→自动保存→列表→重开标题一致→再编辑，服务端同时含两段正文；日程编辑标题、完成状态 true→false、删除后仅剩 id 1、409 时表单保留且输入框仍为「冲突-R17」、页面出现冲突说明。

**存储失效**：`localStorage` 访问抛 `SecurityError` 与 `setItem` 抛 `QuotaExceededError` 两种注入下，页面无 `pageerror`、编辑可用、服务端保存正常（POST=1）；界面文案为「未提交到服务器 / 仍在编辑器中，尚未提交到服务器。」→「服务器已保存 / 内容已同步到服务器。」，文案限定在“服务器”，未出现本地草稿已保存的错误宣称；也没有出现假的“保存失败”。

## 5. 问题

**P-A（新发现，需产品确认）冲突恢复后不保留对方内容**

- 复现：本机草稿 `base_revision=1`，服务器已到 v2（正文 `SERVER-V2-CONTENT`）。打开该 Insight → 出现冲突提示 → 点「恢复我的草稿」。
- 实测：PATCH 带 `expected_revision=2`（服务器当前版本）→ 成功；服务端 revision→3，正文变为 `OLD-DRAFT-CONTENT`，`serverStillHasV2=false`。
- 影响：不出现“静默”覆盖（有提示、有明确选择、选择前零 PATCH），但用户选择恢复后，服务器较新的 v2 正文**没有任何副本或对比可找回**。复测要求中的“保留双方内容”未满足。
- 分类：产品行为/设计取舍，非脚本或环境问题。若需要保留双方，需另行设计（例如恢复前保存服务器版本到本机、或提供对比视图）。
- 下一步：交用户/Lead 判断是否接受当前“仅警告、不保留”的口径。

**P-B（观察项）本地草稿写入失败无任何提示**

`writeInsightDraft` 写失败返回 `false`，调用方未使用返回值。存储写满/被禁时用户不会被告知“本机恢复不可用”，只能靠界面文案未误称来兜底（已实测文案如实）。不影响服务器保存，也不产生错误宣称。

## 6. 未验证

- **真实 HTTP / PostgreSQL 全链路**：全程 Mock 拦截，真实后端 CAS 语义、事务、CORS 预检、真实网络中断均未验证。
- **真实 Chrome 原生关闭提示 UI**：只断言 `beforeunload` 事件被触发并被脚本接受；未验证真实弹窗外观与用户操作。
- **多标签并发**：Insight 草稿存 `localStorage`，未按标签页隔离，多标签同时编辑同一记录未测。
- **移动端 / 触屏**；**中文 IME 组词过程中刷新**；**0.8s 防抖临界点逐毫秒**（只取 100/450/750ms 三档）。
- 浏览器隐私模式、真实配额耗尽（本次用抛异常模拟）。
- 用户视觉/交互验收。

## 7. 命令与收尾

| 命令 | 退出码 | 结果 |
|---|---|---|
| `tsc -b` | 0 | 无输出 |
| `vite build` | 0 | 仅 chunk 体积提示 |
| `oxlint` | 0 | 19 warnings / 0 errors；告警均分布在 WritingPage、RitualPage、ReviewPage、WritingAiPanel 等**未改动文件**，改动文件 0 告警 |
| 43 个 `*.test.ts` 逐个 `node --experimental-strip-types` | 全部 0 | 43 通过 / 0 失败 |
| `retest-run.mjs` | 0 | 22/22 场景执行成功，`pageErrors` 全 0 |
| `probe-storage.mjs` | 0 | 2 种存储故障模式，`pageErrors` 全 0 |

Git 收尾：HEAD、分支、暂存区、未暂存 diff、散列与复测前完全一致；未 commit / merge / push；测试者未改动待测工作树。自建预览服务已停止，4194 端口已释放；未连接数据库、未写入个人库、未调用任何模型。
