# 第一轮 UI 修复（独立测试缺陷 1/2/3 + 命名）· 开发交付

> 2026-11-02 · **开发者角色**（本轮修复由本对话实施，**不是**独立复测）。
> 状态：**修复与自测完成，未提交，等待未参与本次修复的新对话做独立复测。**
> 证据目录：`C:\Programme\demo\SeekJournal\s04-ui-round1-fix\`

---

## 一、八项简报

**任务**：修复第一轮独立测试发现的 4 类问题（空白速记阻止导航、空白速记本地草稿、`更多` 菜单读屏表达、目标页旧命名），完成后再选择性提交。

**基线（修复前）**：工作区 `C:\Programme\demo\SeekJournal`；分支 `wb/ui`；HEAD `2446435778f1a22963887b7abba18abc8ea19b20`（未变）；暂存区空；7 个已跟踪修改 + `AppNav.tsx/.css` 两个未跟踪新源码；9 个待测文件 SHA256 与独立测试 `baseline-sha256.txt` 逐条一致（`sha256sum -c` 9/9 OK），确认未在他人写入过程中开动。

**结果**：4 类问题均已处理。缺陷 1 修复并回归通过；缺陷 3 修复并验证；缺陷 4（命名）在页面标题层统一，文档与 T10 内部文案列出交 Codex；缺陷 2 在干净配置下**不可复现**，代码已有守卫，本轮将「空白」判定收敛为单一实现并给出取证。

**改动文件（16 改 + 2 新）**：详见 §二；本轮新增/修改的产品代码 10 个、测试 3 个，其余为第一轮既有改动。

**验证**：`tsc -b` 0；`vite build` 0（1,189.11 kB，仅既有 >500 kB 提示）；`npm run lint` 0（19 warnings / 0 errors，与基线同）；46 个 `*.test.ts` 全过；真实构建产物 + CDP 合成 Mock 跑 6 个浏览器场景全过；零真实写请求、未连后端/数据库/模型。

**问题**：见 §五（剩余旧名文案 18 处、文档不一致、`更多` 采用披露模式而非 menu、`完整复盘正文` 等产品文案未动）。

**需要决定**：见 §七。

**收尾**：HEAD 未变、暂存区空、未 commit/merge/push/切分支/删文件/清 worktree；自建 `5401` 静态服务与 `9225` 调试浏览器已停止。

---

## 二、根因与最小修复

### 1. 空白速记阻止导航（缺陷 1，必现）

**根因**（与独立测试一致，已用真实函数复现）：全新速记会话 `baseline.content_doc = null`，编辑器挂载后把空文档规范化成 `{type:'doc', content:[…末段+节点 ID]}`，于是 `draftEquals = false`。`planWrite` 在 `fileId === null` 分支里紧接着判 `isSavable`，空白草稿不满足 `writingSavable`（正文必须非空），返回 `blocked/invalid`；`store.flush` 把它折成 `blocked`，`App.navigate` 统一按「保存失败」弹窗拦截。

**修复**（`state/editSessions.ts`）：

```ts
if (draftEquals(session.draft, session.baseline)) return { kind: 'idle' }
// 新会话还没写过任何字：判 idle（无需保存），不是 invalid。
if (!draftHasContent(session.draft)) return { kind: 'idle' }
if (session.isSavable !== null && !session.isSavable(session.draft)) {
  return { kind: 'blocked', reason: 'invalid' }
}
```

新增 `draftHasContent(draft)`：只看**标题文字与正文文字**（`type:'text'` 的 `text.trim()`），不看结构、不看 `attrs.id`。副作用为零，判据单一。

**没有放宽的部分**：`status: failed/conflict/missing` 与 `inFlight`、`imeComposing` 都在这个分支之前返回；有标题无正文仍走 `isSavable` → `blocked/invalid`（保护真实输入）；已冻结的 `firstRequest` 在最前面重放，空白外观下不会退化成 `idle`。上述四条都有断言覆盖（`state/editSessions.test.ts`）。

### 2. 空白速记留下本地草稿（缺陷 2）

**结论：在干净配置下不可复现。** 取证方法：全新 Chrome 配置 → 点「速记」→ 不输入 → 每 250 ms 采样 IndexedDB，连续 3 s。

| 采样 | 本机草稿条数 |
|---|---|
| 进入前 | 0 |
| 进入后 0 ms（库尚未创建） | 0 |
| 250 / 500 / … / 3000 ms | **0 / 0 / 0 / 0 / 0 / 0 / 0 / 0 / 0 / 0 / 0** |

同一次观察：页面无「本机还有 N 份未提交的草稿」横幅，按钮显示「本地草稿（0）」，`ProseMirror` 文本为空，写请求 0 条。

**契约核对**：`useJournalDraftMirror.writeNow()` 先看 `inputSeq === 0 && localState === 'idle'`，再看 `isEmptyDraft`，空白不写；`WritingPage` 卸载时的 `needsLocalDraft(inputSeq > ackedSeq)` 最终也走同一个 `writeNow`，同样被挡。

**本轮改动**：把 `isEmptyDraft` 内部的私有 `documentHasText` 删除，改为共用 `draftHasContent`。理由：`planWrite` 与本地镜像必须是同一口径，否则要么留空记录、要么把空白报成保存失败。这是**收敛**，不是放宽——真实输入（有标题或有文字）仍然写本地记录。

**对独立测试所见「1 份」的解释**：其 `shots/21` 之前已在同一浏览器配置里输入过正文并制造过一次保存失败，失败场景**按设计**保留本地草稿；随后进入空白速记时横幅统计到的是那条真实遗留记录，不是空白稿自己写的。本轮 S1/S2/S3 用 `Storage.clearDataForOrigin` 隔离后逐场景验证：空白 0 条、输入并保存成功 0 条、保存失败 1 条。

> 装置自身缺陷（已修正，不计入产品问题）：探针若在应用建库之前 `indexedDB.open()`，会以 v1 建出**没有 object store** 的空库，使应用后续写入直接失败——看起来像「没写」，实测是「写失败」。现在两套脚本都先用 `indexedDB.databases()` 判断存在性，不存在就只报 `db_absent`，不 open。

### 3. `更多` 菜单关闭时读屏拿不到当前页（缺陷 3）

**先检查语义再动手**：弹层是 `role="group"` 的一组导航按钮，不是菜单；触发按钮原来写 `aria-haspopup="true"`（等价 `menu`），却配一个 `role="group"` 的弹层，语义不成立。子项在菜单**展开时**本来就有 `aria-current="page"`，问题只出在关闭后子项不在 DOM 里。

**修复**（`components/AppNav.tsx`）：
- 去掉 `aria-haspopup`，保留 `aria-expanded` + `aria-controls`（披露模式，符合实际结构）；
- 触发按钮的无障碍名称与提示在「更多」含当前页时变成 `更多（当前：日程）`；
- **不给容器加 `aria-current`**：那等于宣称容器本身是当前页，会把读屏引错；
- 菜单项点击后把焦点收回触发按钮——原来菜单项随关闭卸载，焦点掉到 `body`，读屏既不播报新页面、键盘也要从头 Tab。

### 4. 目标页旧命名

| 位置 | 改前 | 改后 |
|---|---|---|
| `utils/ritualView.ts` `KIND_LABEL` | 开始今天 / 结束今天 | **计划 / 复盘** |
| `displayTitle()` 默认标题 | 「开始今天 2026-11-01」 | 「计划 2026-11-01」 |
| `pages/WritingPage.tsx` 页眉与 `aria-label` | 写作 | **速记** |
| `pages/ReviewPage.tsx` 标题与 `aria-label` | 完整复盘 / 复盘模块 | **AI 复盘 / AI 复盘模块** |
| `utils/writingSession.ts` `candidateOriginLabel` | 本标签 · 写作 | 本标签 · **速记** |

`KIND_LABEL` 一处改动即带动页面眉标、默认显示标题、恢复对照文案；只改显示，不写库、不改 API。

---

## 三、验证记录

| 命令（工作目录 `frontend`） | 退出码 | 结果 |
|---|---|---|
| `node --experimental-strip-types <每个 *.test.ts>`（46 个） | 0 | **46/46 通过**，0 失败 |
| `npx tsc -b` | 0 | 类型构建通过 |
| `npm run lint` | 0 | 19 warnings / 0 errors（与基线同数，新增代码 0 告警） |
| `npm run build` | 0 | 1,189.11 kB / gzip 357.19 kB，仅既有 chunk 体积提示 |

新增用例（`state/editSessions.test.ts`，先失败后通过）：
1. `空白新草稿判为无需保存` — 复现时实测 `{"kind":"blocked","reason":"invalid"}`，修复后 `{"kind":"idle"}`；
2. `空白新草稿不阻断离开` → `{ kind: 'clean' }`，零请求；
3. `只有标题的新草稿仍阻断离开` → `blocked/invalid`，零请求；
4. `空白外观下仍重放已冻结的创建请求` → `create`，创建键不变。

测试断言更新（随改名，非放宽）：`utils/ritualView.test.ts` 默认标题 2 条、`utils/writingSession.test.ts` 候选来源标签 2 条。

---

## 四、浏览器验证（真实构建产物 + CDP 合成 Mock）

装置：`harness.mjs`。静态服务 `127.0.0.1:5401` 指向 `frontend/dist`；`Fetch` 域拦截 `127.0.0.1:8000/api/*`（含 OPTIONS 预检应答）；每个场景前 `Storage.clearDataForOrigin({storageTypes:'indexeddb'})` 隔离本机草稿。未启动后端、未连数据库、未调用模型。

| 场景 | 断言 | 结果 |
|---|---|---|
| S1 空白速记 → 记录 | 本机草稿 6 次采样皆 0；无横幅；`本地草稿（0）`；主区切到「记录」；弹窗 `open=false`；写请求 0 | **通过** |
| S2 输入「真实的速记内容」→ 保存成功 → 记录 | 1 次 `POST /api/journals`；保存后本机草稿 0；离开无弹窗 | **通过** |
| S3 输入 → 保存 500 → 记录 | 弹窗 `open=true`，文案「最新改动还没保存成功，确定离开？」；本机草稿保留 1 条；主区未切换 | **通过（保护未放宽）** |
| S4 首屏 POST 在途 + 继续输入 → 记录 | 挂起期间不误跳；释放后依次 `POST` → `PATCH /api/journals/501`；末次载荷同时含「第一段」「第二段」；最终切到「记录」 | **通过** |
| S5 更多 → 日程 | 展开：`aria-expanded=true`、聚焦首项「日程」；关闭：`aria-expanded=false`、`aria-label="更多（当前：日程）"`、`aria-haspopup=null`、`activeElement` 为触发按钮；重开：菜单内「日程」带 `aria-current="page"`；Esc：关闭且焦点回到触发按钮 | **通过** |
| S6 命名 | 速记页眉/`aria-label`=速记；计划页眉「计划 · 业务日 2026-11-01」、标题「计划 2026-11-01」；AI 复盘页 `<h2>`=「AI 复盘」 | **通过** |

截图：`shots/01-blank-quick-left.png`、`02-typed-saved-left.png`、`03-typed-save-failed-blocked.png`、`04-inflight-typed-more.png`、`05-more-menu-a11y.png`、`06-writing-naming.png`、`07-plan-naming.png`、`08-ai-review-naming.png`。

控制台错误仅 1 条，为 S3 故意制造的 `500 Internal Server Error`（Mock 应答），非产品异常。

---

## 五、未解决 / 未覆盖

1. **T10 与日程页仍有多处旧名**（本轮只改页面标识层，未做全量文案替换，共 18 处可见字符串）：
   `components/GoalActions.tsx:15`「加入结束今天」；`pages/RitualPage.tsx:911/1011/1035/1051/1062/1073/1077/1097/1111/1115/1116/1390/1415`；`pages/SchedulePage.tsx:671`「日程与「开始今天」的 Set 目标…」；`utils/ritualView.ts:633-634`「结束今天还没有有效文件…」。
   另有 2 处注释（`RitualPage.tsx:104`、`utils/theme.ts:43`）与 `ReviewPreview.tsx:141`「完整复盘正文」未动。
2. **共享文档未改**（按要求交 Codex）：`docs/stage4.md` §2 术语表与 §3 导航清单仍写「开始今天 / 结束今天 / 写作」；`docs/stage4-tasks.md` §1/§3.6/§3.11 同。
3. **`更多` 的语义选择需确认**：本轮按「披露（disclosure）」实现，未改成 `role="menu"`+`menuitem`。若产品要求菜单语义，需要连键盘方向键行为一起做。
4. **未验证（环境所限）**：真实数据库下「文件夹既有分类未被删除」、旧 AI 请求恢复、真实中文 IME、真机、真实后端数据下 Ritual/日程联动、读屏软件实测（只验证了无障碍树属性与焦点）。
5. **`invalid` 文案仍是「保存失败」语气**：只有标题、没有正文的新速记被拦时，提示仍说「最新改动还没保存成功」。行为正确（保护输入），措辞未改——需扩展 `FlushResult` 才能分档，超出本轮最小修复范围。

---

## 六、新基线（供独立复测）

- 分支 `wb/ui`，HEAD `2446435778f1a22963887b7abba18abc8ea19b20`（**未提交**，暂存区空）。
- 18 个变更文件（16 改 + 2 未跟踪新源码）的 SHA256：`after-sha256.txt`；`git status --short --branch`：`after-status.txt`；未暂存 diff：`after-unstaged.diff`。
- 证据目录内容：`harness.mjs`、`probe-blank.mjs`、`harness-report.json`、`probe-blank.json`、`shots/`、基线文件。均**不纳入提交**。
- 复测建议命令（工作目录 `frontend`）：

```bash
sha256sum -c ../s04-ui-round1-fix/after-sha256.txt
node --experimental-strip-types <每个 src/**/*.test.ts>   # 期望 46/46
npx tsc -b && npm run lint && npm run build
# 浏览器：python -m http.server 5401 --bind 127.0.0.1（在 frontend/dist）
#        chrome --headless=new --remote-debugging-port=9225 ...
#        node ../s04-ui-round1-fix/harness.mjs
```

> 复测注意：启动 Chrome 前先确认 `9225` 无监听；否则新实例会抢不到端口，脚本连到旧实例上的旧配置，IndexedDB 与 `tab_id` 会跨轮继承（本轮踩过）。

---

## 七、需要决定

1. T10/Schedule 的 18 处旧名是否在本轮一并替换（会扩大 diff 到 `RitualPage.tsx`/`SchedulePage.tsx`/`GoalActions.tsx`），还是留给 T10 或第二轮。
2. `docs/stage4.md` / `stage4-tasks.md` 的术语与导航清单由 Codex 何时同步；同步前本分支实现与文档不一致。
3. `更多` 用披露模式（现状）还是完整 `menu` 语义。
4. 提交范围：本轮新增 3 个测试文件改动（`editSessions.test.ts` + 两个改名断言）是否随产品代码一起提交（建议一起，否则改名后测试会红）。
