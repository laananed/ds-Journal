# 第二轮前端开发报告 · 沉浸式编辑与清单输入

> 分支 `wb/ui-2`，基线 `78c5ad8`（= `wb/ui` = `main`）。本报告只覆盖本轮交付；
> 独立测试与视觉验收均未完成，提交只作为开发检查点。

## 1. 基线与工作区

| 项 | 值 |
| --- | --- |
| 分支 | `wb/ui-2`（本轮新建，从 `wb/ui` 拉出） |
| 基线 HEAD | `78c5ad8`（`wb/ui`、`main`、`origin/main` 同点） |
| 开发前工作区 | 干净，无暂存/未暂存改动 |
| 其他工作树 | `Work-01 (wb/writing)`、`Work-02 (wb/sight)`、`Work-03 (worktree02)` 未触碰 |
| 会话模型 | 无法在本会话内核实实际选中的模型，按任务书建议使用 DeepSeek-V4.1-Flash，**未修改任何模型配置** |

## 2. 实际改动

### 2.1 产品代码（我负责的文件）

| 文件 | 改动 |
| --- | --- |
| `frontend/src/utils/taskListInput.ts` | **新增**。清单标记的纯判定：`TASK_MARKER_PATTERN`、`taskMarkerChecked`、`canConvertTaskMarker`（只放行 4 种形状：顶层段落、引用块段落、顶层 `listItem > L`、已在 `taskItem` 里）。 |
| `frontend/src/editor/schema.ts` | **新增** `TaskMarkerInput` 扩展（priority 110，高于 `TaskItem`/`BulletList` 的 100）。`[ ] ` 在列表里拆成「前列表 + 当前 taskList + 后列表」，在普通段落里直接 `toggleTaskList`，已在清单里只改勾选。注册在 `TaskList, TaskItem.configure({nested:true}), TaskMarkerInput, UniqueID` 之间；schema 本身没有新增节点类型。 |
| `frontend/src/editor/RichTextEditor.tsx` | 新增 `chromeHidden?: boolean`（纯视觉，不重建实例、不动 `doc`/`readOnly`/`locked` 语义）。工具栏容器补 `onFocus`/`onBlur`，焦点在工具栏里时不淡出。 |
| `frontend/src/utils/immersiveChrome.ts` | **新增**。显隐状态机 `INITIAL_IMMERSIVE` / `immersiveReducer`（`type`/`reveal`/`hold`/`release`）+ `isRevealKey`（Tab/Escape/F6/方向键/Home/End/PageUp/PageDown/⌘/Ctrl 恢复；字母、回车、空格、退格不恢复）。重复 `reveal` 返回同一引用，避免指针每移动一像素就重渲染。 |
| `frontend/src/hooks/useImmersiveChrome.ts` | **新增**。`useReducer` 接入，返回 `{ hidden, onType, reveal, onKeyDown, hold, release }`。 |
| `frontend/src/pages/WritingPage.tsx` | 渲染重写为 `.sj-write`：顶栏（返回入口 + `yy-mm-dd` + 工具）+ 纸面（无边框标题、编辑器、永远可见的状态行）+ 按需抽屉（今天列表 / 属性 / AI 写作 / 本地草稿）。新增 `onBack?` 接口（未接线不渲染）。 |
| `frontend/src/pages/WritingPage.css` | 追加 `.sj-write*` 一套样式；正文列 700px、无框、17px/1.95；顶栏与工具栏淡出；状态行常显、`.is-critical` 红框；窄屏让出右下角快捷入口。 |
| `frontend/src/pages/RitualPage.tsx` | 同样的 `.sj-ritual` 结构；「问题模板与目标」改为**默认收起、按需在正文上方展开**（原因见 §3.3）。新增 `onBack?`。 |
| `frontend/src/pages/RitualPage.css` | 追加 `.sj-ritual*` 一套样式；舞台改单列，正文恒 700px。 |
| `frontend/src/utils/taskListInput.test.ts` | **新增** 21 项断言。 |
| `frontend/src/utils/immersiveChrome.test.ts` | **新增** 30 项断言。 |

未改动：`App.tsx`、`AppShell`、`AppNav`、`DashboardPage`、时间线/洞察页面及其样式、后端、迁移、`docs/`、`agents/`、公共 `App.css`。

### 2.2 证据装置（`s04-ui-round2/`，非产品代码）

`lib/mock-api.mjs`（合成 API）、`lib/cdp.mjs`（CDP 驱动 + Fetch 拦截）、`run.sh`（临时静态服务 + 无头 Chrome，只回收自己启动的进程）、`repro-checklist.mjs`、`verify-checklist.mjs`、`verify-session.mjs`、`shots-immersive.mjs`、`probe-*.mjs`，以及 `repro/`、`checklist/`、`shots/`、`*.json` 结果。

## 3. 问题与决策

### 3.1 目标二：`- [ ] ` 变成「圆点 + 字面 `[ ]`」

- **复现（修复前，真实构建 + 合成数据）**：输入 `- [ ] 买牛奶` 后 `bulletLists: 1 / taskLists: 0 / checkboxes: 0`，文本是 `"[ ] 买牛奶"`，保存载荷 `doc > bulletList > listItem > paragraph`。
- **根因**：`- ` 先被 `BulletList` 的输入规则吃掉，这一行已经是 `bulletList > listItem > paragraph`；此时 `TaskItem` 的内置规则（`wrappingInputRule` + `findWrapping`）找不到合法包裹——`listItem` 的第一个子节点必须是段落——规则返回 `null`，于是标记原样留在文字里，圆点来自外层列表。
- **修复**：不再依赖 `findWrapping`。在 `TaskMarkerInput` 里按路径判断位置，删掉标记后直接构造 `taskList > taskItem`（列表项被替换而不是再嵌一层），并把光标放进新项第一段。
- **边界**：`canConvertTaskMarker` 只放行 4 种形状；嵌套列表、表格单元格、受保护容器一律返回 `false`，此时**保留原文**（宁可不转，不猜结果）。`[ ]` 后必须有空格才触发，避免打断正常的方括号文字；粘贴不走输入规则，因此不会被静默改写。

### 3.2 沉浸式的触发时机（本轮自查发现并修掉的缺陷）

第一版把「淡出」挂在 `onUserChange` / `handleBodyChange` 上，结果**页面一打开就是淡出状态**（截图证据：第一次跑 `shots-immersive.mjs` 时 `writing-idle.immersed=true`、`barOpacity=0`）。

原因有两层：编辑器挂载会把服务端文档回传一次；全新草稿还会被规范化成「带空段落 + 节点 ID」的空文档。因此「有回调」和「内容与基线不同」都不能证明是用户输入。现在淡出只认正文/标题上的**真实 DOM `input` 事件**（挂载不产生该事件，中文 IME 上屏会）。

### 3.3 布局：正文必须真的是主体

- 计划页原来是「268px 上下文 + 1fr 正文」的栅格，而外壳正文列上限是 760px → 正文只剩 **460px**，且整体右偏；上下文淡出后位置仍被占着，正文就一直窄。
- 速记页的「今天」抽屉同理：252px 一列，淡出后留下一条看不见的空白。
- 处理：计划页舞台改单列，上下文默认收起、按需在正文上方展开（与正文同宽 700px）；速记抽屉不再淡出，改为**开始输入即收起**。
- 随之而来的行为变化（需要 review）：计划页的「问题模板与目标 / 今天的目标 / 同日旧版本」不再常驻，要按一下顶栏按钮；速记的「今天 N 篇」列表同样改为按需打开。

### 3.4 其他收敛

- 正文编辑区去掉 `:focus-visible` 的 3px 焦点环（来源是 `AppShell.css` 的 `.sj-shell :focus-visible`；只在两个页面的作用域内覆盖，没改公共样式）。
- 本地草稿提醒条不再把「正在编辑的这一份」算进去（它的本机镜像必然存在，否则输入时每几秒就弹一张卡片）；提醒条改成细竖线，不再压紫底。入口计数仍然包含全部。
- 状态行（保存失败 / 版本冲突 / 本地草稿写不进去）永不淡出，`.is-critical` 用红框。沉浸态下实测 `statusOpacity=1`。

## 4. 验证

### 4.1 命令与结果

| 命令 | 结果 |
| --- | --- |
| `npx tsc -b`（在 `frontend/`） | 退出码 0 |
| `npx vite build` | 退出码 0，`index-*.js` 1,192.85 kB / gzip 358.51 kB（>500 kB 告警是既有问题） |
| `npx oxlint` | 0 errors / 19 warnings（全部是 `set-state-in-effect`，`SettingsPage`/`App.tsx`/`ReviewPage` 等未改动文件同样存在；新增文件无告警） |
| `node --experimental-strip-types src/utils/**.test.ts`（49 个文件） | 全部通过；新增 `taskListInput` 21 项、`immersiveChrome` 30 项 |

### 4.2 浏览器验证（真实 `frontend/dist` + CDP；**不连后端、不连数据库、不调模型**）

全部请求由 `Fetch` 域拦截并返回合成数据。**「断网」是请求层失败注入（`Fetch.failRequest`），不是真实网卡断开**。

- **清单**（`checklist/checklist-report.json`）：S1 `- [ ] `→`taskList/taskItem`；S2 `[ ] `；S3 `1. [ ] `；S4 `- [x] `→`checked:true`；S5 回车分成 2 项；S6 勾选/取消/撤销/重做（两次撤销回退两次点击）；S7 普通列表不被改写（`bulletList(第一项,第二项) + taskList(第三项)`）；S8 粘贴不转换；S9 既有字面文本保留；S10 IME **模拟**（组词期间 `writes:0`，正文 `pinyin`；上屏后 `writes:1`，正文 `中文`）；S11 刷新后 `checked:[true]` 保留。
- **沉浸式**（`immersive-report.json`）：三种页面都是「空闲显示 → 输入淡出 → 鼠标移动恢复 → 方向键恢复」；`date=26-11-02`；`statusOpacity=1`（含保存失败、409 冲突场景）；窄屏 560px 正常。
- **会话与保存**（`session-report.json`）：S1 空白速记不拦截导航（`navigated=true`、`writes=0`、本地草稿计数前后都是 0）；S2 请求失败时状态行显示「保存失败 / Failed to fetch / 本地草稿已保存（仅本机浏览器）/ 重试保存」且 `is-critical=true`；S3 重试后保存成功；S4 保存中继续输入 → 释放后最后一次 `PATCH` 同时包含两段文字；S5 未提交内容刷新后「本地草稿（1）」+ 提醒条可见；S6 保存载荷 `doc > taskList > taskItem > paragraph`。

### 4.3 未验证（不得视为通过）

1. **真实 Windows 中文输入法**：只用 CDP `Input.imeSetComposition` 模拟。真实输入法的候选窗、`compositionend` 时序、全角标点未验证。
2. **本地草稿不可用**（IndexedDB 被禁用/写满）：代码有 `quota / unavailable / corrupt / version_incompatible` 四类告警路径与「本地草稿写不进去」的常显状态，但本轮没有在浏览器里制造该故障，未复现。
3. **保存中关闭标签页 / 断网后恢复**：只在单页内验证，未覆盖 `pagehide` 真实关闭。
4. **真实后端联调**：`POST /api/journals` 的 `client_create_id` 幂等在 Mock 里不做校验（S3 里看到两次 POST，其中第一次失败）。
5. **读屏与键盘全流程**：只做了静态可达性（`aria-label`、`aria-expanded`、`aria-live`、焦点环），没有用真实读屏软件跑一遍。
6. 其他浏览器（Firefox/Safari）未测。
7. 目标转换的端到端（勾选清单保存后自动成为日目标）属于 T04/T07 范围，本轮只验证了保存载荷形状与既有 `ritualControlled.test.ts`（24 项）通过。

## 5. 截图索引（`s04-ui-round2/shots/`）

| 文件 | 内容 |
| --- | --- |
| `01-writing-idle.png` | 速记·空闲（顶栏 + 工具栏在，正文 700px） |
| `02-writing-typing.png` | 速记·**输入中**（只剩标题 + 正文 + 状态行） |
| `03-writing-after-move.png` | 速记·鼠标移动后（顶栏与工具栏恢复） |
| `03b-writing-after-key.png` | 速记·方向键恢复（键盘用户） |
| `04-writing-save-failed.png` | 速记·保存失败在沉浸态下可见 |
| `04b-writing-conflict.png` | 速记·409 版本冲突在沉浸态下可见 |
| `05-plan-idle.png` / `06-plan-typing.png` / `07-plan-after-move.png` | 计划·空闲 / 输入中 / 鼠标移动后 |
| `08-review-idle.png` / `09-review-typing.png` / `10-review-after-move.png` | 复盘·空闲 / 输入中 / 鼠标移动后 |
| `11-narrow-typing.png` | 窄屏 560px 输入中 |
| `12-writing-offline.png` | 请求失败时的状态行 |
| `13-writing-after-reload.png` | 刷新后本地草稿入口可见 |
| `14-writing-checklist.png` | 清单渲染（方框可勾选） |
| `15-plan-context-open.png` | 计划·「问题模板与目标」按需展开（正文仍 700px） |

第一轮缺陷（空白速记拦截导航 / 留空白本地草稿）在 §4.2 S1 复测通过；代码层修正是第一轮已进 `main` 的 `planWrite` 早返回，本轮未再改动会话核心。

## 6. 需要上游处理的事

### 6.1 `App.tsx` 待接线（我不改该文件）

两页都已提供最小接口 `onBack?: () => void`，**未接线时不渲染按钮**（避免点下去没反应）。接线只需在现有渲染处各加一行：

```tsx
// module === 'writing'
<WritingPage
  disabled={uiLocked}
  onDirtyChange={setDirty}
  onFlushReady={registerFlush}
  onOpenLegacy={openLegacyJournal}
  onBack={() => changeModule('dashboard')}   // ← 新增
/>

// module === 'set' | 'end'
<RitualPage key={module} kind={module} disabled={uiLocked}
  onDirtyChange={setDirty} onBusyChange={setWriting} onFlushReady={registerFlush}
  onOpenTrash={() => changeModule('trash')}
  onBack={() => changeModule('dashboard')}   // ← 新增
/>
```

`changeModule` 内部已经走 `navigate`（先 flush 最新草稿，flush 失败停留），因此「返回时保护未保存输入」与左栏导航完全同一套逻辑，页面自己不判断能否离开。

### 6.2 文档命名冲突（请 Codex 裁定后再改实现）

用户已确认叫法为「计划 / 复盘 / 速记」，但权威文档仍在用「开始今天 / 结束今天 / 写作」，具体位置：

- `docs/stage4.md` §2 术语表、§3 导航清单（"开始今天 / 结束今天 / 写作"）；
- `docs/stage4-tasks.md` §1、§3.6、§3.11（同上一组词）。

本轮实现按用户口径只改界面文案（`KIND_LABEL`、`aria-label`、按钮文字），**没有改 API 路径、数据字段或业务规则**（仍是 `journal_kind = set | end | writing`）。文档未改动，等协调结果。

## 7. 提交

- commit：`feat(ui): redesign writing and ritual editors`
- 内容：§2.1 的产品代码 + 两个新增测试 + `s04-ui-round2/` 证据（与第一轮证据目录同样入库）
- 提交前检查：无 `.env`、无凭据、无数据库备份、无私人日记；证据目录里全部是合成数据与自动截图
- 提交后即停止写入；本轮**不** merge / push / tag / 清理其他工作树
