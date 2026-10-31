# Set / End 输入法组合与保存交互核查（第二轮）

- **目录**：`C:\Programme\demo\SeekJournal-Work-01`
- **分支 / HEAD**：`wb/writing` / `856d602`
- **工作区**：开始时干净；结束时仅新增未跟踪目录 `s04-qa-web-paths/`（证据与脚本），产品代码与公共入口未改动
- **隔离情况**：T12 在 `C:\Programme\demo\SeekJournal`（`codex/s4t12`）独立工作树运行，本轮未切换、未清理、未写入任何其他工作树
- **数据库 / 模型**：未连接 8000 与 PostgreSQL，未调用任何模型；全部写入落在自建内存 Mock（8039）
- **未提交、未合并、未推送**

## 0. 结论先行

| 编号 | 问题 | 严重度 | 是否有数据后果 |
| --- | --- | --- | --- |
| D1 | Set/End **每次自动保存都会重建编辑器**，导致焦点与光标丢失；此后的键入直接落空 | 高（日常阻塞） | 键入被丢弃（未上屏内容不会进正文） |
| D2 | Set/End 在**组合（拼音未上屏）期间触发自动保存**，保存时重建编辑器**静默打断组合**（无 `compositionend`），预编辑拼音作为正文落库并永久保留 | 高 | **已保存正文被写入 `nihao` 一类拼音**，需手工删除 |
| D3 | 同上，Set 的**自动转目标**会用当时的（含拼音）文本固化目标：目标变成「买ni」，刷新后仍在；用户随后上屏的内容完全丢失 | 高 | 目标文本错误且不可自愈 |
| N1 | Set/End 保存中导航整体置灰约 3s，点击无效；页面状态行有「正在保存」，按钮本身无提示 | 中低（体验） | 无数据丢失 |
| N2 | Writing 保存中导航可点但无即时反馈，最长等约 2.7s 才切换；状态行同样有「正在保存」 | 中低（体验） | 无数据丢失 |
| N3 | Writing 组合中切页会把预编辑拼音提交（点击导航使编辑区失焦 → `compositionend` → 离开前 flush 落库） | 低—中 | 拼音进入正文；更接近浏览器既定行为，产品未做防护 |

> **真实中文 IME 未验证。** 本轮所有组合都是 CDP `Input.imeSetComposition` / `Input.insertText` 产生的**浏览器层** `compositionstart` / `compositionupdate` / `beforeinput(insertCompositionText)` / `compositionend` 事件——事件种类与真实输入法一致，但**没有候选窗、没有输入法进程、没有真实按键到拼音的转换**。因此 D2/D3 的「机制」有代码与事件证据，但「真实输入法下的用户观感与最终文本」仍需人工复核（见 §5）。

## 1. 方法

1. `npm run build` / `npm run lint` 与 10 份纯逻辑测试沿用上一轮结果（构建 0、lint 0 error、600+ 断言通过）；本轮未改产品代码，产物仍指向 Mock 基址。
2. 真构建产物 + 同源内存 Mock（8039），Mock 记录每个写请求的**完整正文、抽取文本、到达时刻**，以及场景标记。
3. 无头 Chrome + CDP 驱动；页面内注入事件记录器（记录浏览器真实派发的 composition/beforeinput/input 事件及时间戳）。
4. 关键机制用 **10ms 采样 + DOM 节点身份标记** 复核，避免把 50ms 采样漏掉的短暂状态当成「没发生」。
5. 先做与产品无关的**输入法语义探针**（`probe-ime.mjs`），确认 CDP 命令到底能模拟到哪一步，再测产品。

探针结论（`probe-ime.json`）：

| 动作 | 产生的事件 | DOM 结果 |
| --- | --- | --- |
| `imeSetComposition("nihao")` | `compositionstart`、`compositionupdate`、`beforeinput/input[insertCompositionText]` | 预编辑文本进入编辑区 |
| `imeSetComposition("")` | `compositionupdate("")`、`input` 删除、`compositionend` | 恢复组合前文本（可模拟「取消选词」） |
| `insertText("你好")` | `compositionupdate`、`input[insertCompositionText]`、`compositionend` | 上屏正确 |
| `Escape` 按键 | 仅 `keydown` | **无法结束组合**，真实 IME 的 Esc 取消无法模拟 |

## 2. Set / End：组合期间的自动保存（D2）

### 2.1 实测（R1，Set）

前置：正文已保存「R1 已保存句。」（版本 1）。随后进入组合并保持 1.5s（不选词）。

浏览器事件：

```
dt=1ms   compositionstart
dt=1ms   compositionupdate  data="nihao"
dt=1ms   beforeinput        insertCompositionText  data="nihao"
dt=2ms   input              insertCompositionText  data="nihao"
（此后到 1597ms 之前没有任何 compositionend）
```

实际请求（Mock 记录的正文）：

```
dt=921ms  PATCH /api/journals/1  expected_revision=1
          text="R1 已保存句。nihao"        ← 拼音被当成正文提交
```

保存瞬间页面的 10ms 采样（`diag-recreate.json`，同结构场景）：

```
dt=0ms    mark=A  active=editor  contenteditable=true
dt=915ms  mark=NONE active=BODY   contenteditable=false   ← 旧编辑器节点被销毁
dt=925ms  mark=NONE active=BODY   contenteditable=true    ← 新节点已换成只读→可编辑
```

- `mark` 是开局打在编辑器节点上的身份标记，保存瞬间标记消失 ⇒ **不是重渲染，而是节点被替换（实例重建）**。
- `contenteditable` 在同一时刻 true→false→true，对应 `readOnly` 反转；`RichTextEditor` 的 `useEditor(..., [readOnly])` 依赖变化会重建实例。
- 重建没有触发 `compositionend`（事件列表里没有），组合被**静默打断**；预编辑拼音留在文档里。

### 2.2 组合打断后继续上屏（R1 后续）

| 时刻 | 动作 | 请求正文 | 服务器文本 |
| --- | --- | --- | --- |
| dt=921ms | 自动保存（打断组合） | `R1 已保存句。nihao` | 同左，版本 2 |
| dt=1684ms | 用户重新聚焦、末尾上屏「你好」 | — | — |
| dt=2600ms | 自动保存 | `R1 已保存句。nihao你好` | 版本 3 |

刷新后仍是 `R1 已保存句。nihao你好`。**拼音不是临时脏数据，已永久进入正文。**

### 2.3 对照矩阵

| 场景 | 组合时长 | 组合期是否发保存 | 请求正文 | 最终文本 | 判定 |
| --- | --- | --- | --- | --- | --- |
| R1 Set 跨窗口 | 1.5s | **是**（dt=921） | `…nihao` | `…nihao你好` | 拼音固化 + 上屏内容与拼音叠加 |
| R2 Set 窗口内上屏 | 0.3s | 否 | dt=1239 `…你好` | `…你好` | 正常 |
| R3 Set 窗口内取消 | 0.3s | 否 | 无请求 | 原文不变 | 正常 |
| R4 Set 跨窗口后取消 | 1.45s | **是**（dt=912） | `…shijie` | `…shijie`，刷新后仍在 | 取消已无法生效（焦点已丢），拼音留存 |
| R6 Set 跨窗口 + 503 | 1.7s | **是**（dt=909，返回 503） | `…shibai` | 编辑器保留文本；服务器仍为原文（版本 1） | 输入未丢，但拼音在本地/草稿里 |
| R7 End 跨窗口 | 1.5s | **是**（dt=918） | `…nihao` | `…nihao`，版本 2 | End 与 Set 一致 |
| R10 Writing 跨窗口 | 1.5s | **否**（1.5s 内 0 请求，焦点仍在） | 上屏后 dt=2325 `…你好` | `…你好` | Writing 的等待守卫有效 |

R4 的补充事实：跨窗口后 `focused=false`，此时再执行「取消」不会产生任何事件——**组合已经在保存时被结束，用户此时的取消动作无处可去**。

## 3. 已保存正文与目标的影响（D3 + 对照）

### 3.1 已保存正文被追加拼音（R8 / run13）

- R8：正文已有两段，组合跨窗口 → PATCH `text="第一段已保存。 第二段已保存。nihao"`（版本 3）；刷新后仍是该文本。
- run13：已存在目标「买牛奶」+ 备注段，组合跨窗口 → PATCH `text="备注段。nihao"`；刷新后仍是 `备注段。nihao`。
- **结论**：已保存正文会被追加未上屏拼音，且刷新不清除，需用户手工删除。

### 3.2 目标被拼音固化（R9，最严重）

Set 中新建清单条目「买」，随即进入组合并保持（拼音 `ni`），900ms 后：

```
dt=917ms  POST /api/journals            text="买ni"                  → 创建 Set（版本 1→2）
dt=942ms  POST /api/rituals/1/goals     expected_revision=1          → 自动转目标
服务器文档：goalItem.attrs.text = "买ni"
「今天的目标」面板：买ni
```

随后上屏「你好」**没有产生任何请求**（编辑器已被替换成目标节点，正文变成「目标 / 系统内容 · 由服务维护 / 买ni」）。刷新后目标仍是「买ni」。

- 触发放大器：`RitualPage` 的自动转目标要求 `status==='saved' && 无未保存改动 && !imeComposing`；由于 `imeComposing` 恒为 false，拼音一落库就满足条件，目标立即被固化。
- 已有目标不受影响（反向对照，run13）：目标仍为「买牛奶」，拼音只加在普通段落上；目标文本存放在 `goalItem.attrs.text`，正文编辑不会改写它，只有转目标那一刻会把当时的文本快照进去。

## 4. 保存中导航（N1 / N2，修正上一轮的错误判定）

上一轮用 `.dashboard` 判断概览是否出现，该类名不存在，结论作废。本轮改用导航按钮 `aria-pressed` 判断模块，并先做基线：

| 场景 | 导航可点 | 点击后切换耗时 | 等待期可见提示 | 数据 |
| --- | --- | --- | --- | --- |
| 基线（无保存在途，Writing→概览） | 是 | **16ms** | — | — |
| Writing 保存中（注入 3s 延迟）→ 概览 | 是 | **2684ms** | 状态行「正在保存到服务器…… 文件 #1 · 版本 1 本地草稿已保存」 | 已保存，无丢失 |
| Set 保存中（注入 3s 延迟）→ 写作 | **否（全导航 disabled）** | 未切换；保存完成后恢复，恢复后 4ms 切走 | 状态行「正在保存到服务器…… 本地草稿已保存」 | 已保存，无丢失 |

- **区分**：两者都是「等待」，不是数据丢失；差别在契约不一致——Writing 允许点击但要等，Set/End 直接置灰。
- 细节：置灰的导航按钮没有 `title`，点击也不会有任何说明；用户只能从页面状态行推断原因。Writing 侧按钮看起来可点，用户可能重复点击。

补充（N3）：Writing 组合中点击导航，PATCH 在 dt=812ms 落库 `…qiehuan`。原因是点击按钮使编辑区失焦、浏览器先发 `compositionend`（提交预编辑文本），随后离开前 flush 把它写入。真实输入法在失焦时通常也会提交预编辑串，因此这条更接近「产品未做防护的选择」，而非 Set 那种「App 自己打断组合」。

## 5. 真实中文 IME 未验证 —— 需要人工复核的部分

本轮无法操作真实中文输入法（无候选窗、无输入法进程）。以下结论**依赖真实 IME 复核**：

1. 编辑器被重建时，真实输入法的候选窗是否会残留、是否自动上屏、preedit 是否同样以拼音形式留在正文。
2. 真实 `Esc` 取消（不选词直接取消）在「保存已打断组合」后的表现——CDP 下 Esc 无法结束组合，本轮无法覆盖。
3. 真实 IME 每次按键都会发 `compositionupdate`，自动保存计时器会被不断重置；「连续输入中文时是否命中 900ms 窗口」需要真人手感验证（本轮用「保持不选词 1.5s」模拟）。
4. 切页/失焦时真实输入法的提交语义（是否提交拼音、是否提交首选词）。

### 人工复现步骤（Windows，微软拼音）

1. 打开 Web，进入「开始今天」。
2. 输入一句中文并等 1 秒以上（触发第一次自动保存），观察：**光标是否还在正文里**；不点鼠标直接继续打字，看字是否出现（D1）。
3. 点回正文末尾，输入 `nihao` 但**不要选词**，保持候选窗 1.5 秒以上（D2）：
   - 观察候选窗是否消失、光标是否丢失；
   - 等待状态行变为「服务器已保存」后刷新页面，检查正文是否出现字面 `nihao`；
   - 再点回末尾选「你好」，刷新，检查是否变成 `nihao你好`。
4. 重复第 3 步，但在候选窗出现后按 `Esc` 取消，刷新检查拼音是否仍被保存（§5 第 2 点）。
5. 「开始今天」中点击工具栏「☑ 清单」，输入「买」后立即打 `ni` 并保持不选词 1.5 秒（D3）：
   - 观察「今天的目标」是否出现「买ni」；刷新后是否仍在；
   - 再选词上屏，观察是否还能改回。
6. 在「写作」中重复第 3 步作为对照：候选窗保持 1.5 秒应**不触发保存**、光标不丢；上屏后再保存。
7. 保存中导航：把网络调慢（DevTools Slow 3G）后输入并立刻点导航——「写作」应可点但停留约 2–3 秒，「开始今天」应整排置灰（N1/N2）。

## 6. 代码依据

| 位置 | 事实 |
| --- | --- |
| `frontend/src/pages/RitualPage.tsx:1476`、`:1488` | `RichTextEditor readOnly={disabled}`；`disabled` 来自 App 的 `uiLocked` |
| `frontend/src/pages/RitualPage.tsx:749-750` | `busy` 含 `session.inFlight`，并通过 `onBusyChange` 上报；保存一开始就把整页置为锁定 |
| `frontend/src/App.tsx:449`、`:473`、`:512` | `uiLocked = busy \|\| aiLocked`，同时用于导航 `disabled` 与 RitualPage 的 `disabled` |
| `frontend/src/editor/RichTextEditor.tsx:302`、`:307` | `useEditor(..., [readOnly])`：`readOnly` 变化即重建实例；重建后新节点不可编辑→再可编辑 |
| `frontend/src/pages/RitualPage.tsx:344`、`:880` | 只**读** `session.imeComposing`，全文件没有 `setComposing` / `onCompositionStart`，守卫恒为 false |
| `frontend/src/pages/WritingPage.tsx:1016-1017` | Writing 包了 `onCompositionStart/End` → `store.setComposing`，所以等待守卫有效 |
| `frontend/src/state/editSessions.ts:496` | `planWrite` 本来就有 `imeComposing` 拦截（`reason:'ime'`），Set/End 因为从不置位而绕过 |
| `frontend/src/pages/WritingPage.tsx:785` | Writing 的 `locked = disabled \|\| busy`，`busy` 只含显式动作，不含自动保存 → 保存时不重建、不丢焦点 |
| `frontend/src/utils/ritualControlled.ts:34-36` | 自动转目标只在 `kind==='set' && ready` 时取候选；`ready` 依赖 `!imeComposing` |
| `backend/app/writing/documents.py`（`convert_ritual_task_item`） | 转目标时用服务器当前文档里的 taskItem 文本生成 `goalItem.attrs.text`；前端提交含拼音的文档后，目标即固化拼音 |

## 7. 判定边界

- **已验证**：Set/End 组合期自动保存（~915–921ms）、组合被打断且无 `compositionend`、拼音进入请求正文并持久化、目标固化拼音、保存后焦点丢失与盲打落空、Writing 等待守卫有效、Writing 切页提交预编辑、两类导航等待表现。
- **未验证**：真实中文 IME 全流程（见 §5）、真实后端 + PostgreSQL 的转目标与版本行为、`content_blocks` 旧文档、多标签并发、移动端/软键盘、读屏与视觉表现。
- Mock 的转目标规则按后端代码实现（纯文字 `taskItem` → `goalItem`），**目标固化结论在真实后端上属于「代码同构推断 + 前端请求证据」，未在真库复跑**。

## 8. 证据索引（均在本目录）

| 文件 | 内容 |
| --- | --- |
| `probe-ime.json` | CDP 输入法语义探针（事件种类、能否提交/取消） |
| `diag-recreate.json` | 10ms 采样：编辑器节点身份、`contenteditable` 反转、盲打落空 |
| `diag-save-focus.json` | 保存期焦点变化、Set/Writing 对照、组合跨保存 |
| `run10-results.json` | 首轮（S1–S6 因焦点丢失无效；S7 目标固化、W1/W2/W3 有效） |
| `run11-results.json` | 修正操作后的 R1–R13 矩阵（含请求正文与事件） |
| `run12-results.json` | 组合中切页（T1/T2）、已有目标弱对照（T3） |
| `run13-results.json` | 已有目标对照 + 正文追加拼音（clean） |
| `run14-results.json` | 导航耗时重测（基线 16ms / Writing 2684ms / Set 置灰） |
| `run11.log`、`run10.log` | 运行日志 |
| `r11-01-set-composition-interrupted.png`、`r11-05-set-goal-pinyin.png`、`r14-01-writing-nav-during-save.png`、`r14-02-set-nav-disabled.png` | 关键截图 |
| `r11-02-set-nav-during-composition.png`、`r11-04-set-fail-during-composition.png`、`r11-07-set-nav-disabled-during-save.png` | 补充截图（切页、失败、置灰） |
