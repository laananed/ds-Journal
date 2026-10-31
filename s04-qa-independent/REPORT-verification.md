# 独立复测报告：Set／End 输入法组合与保存焦点修复

- **工作区**：`C:\Programme\demo\SeekJournal-Work-01`
- **分支 / HEAD**：`wb/writing` / `856d602307215204b992fdd3ea954e6d0fb88241`
- **被测改动**：工作区 6 个已修改文件（未提交），与开发者交接 `s04-qa-web-paths/REPORT-ime-fix.md` §6 散列**逐字节一致**
- **其他工作树**：`SeekJournal`（`codex/s4t12`）、`SeekJournal-Work-02`（`wb/sight`）、`SeekJournal-Work-03`（`wb/sight-check`）未切换、未写入、未清理
- **数据面**：仅自建内存 Mock（127.0.0.1:**8041**，与开发者的 8039 隔离），未连 8000 / PostgreSQL，未调用模型
- **本对话角色**：独立复测。**未修改任何产品代码**（测试前后散列一致，见 §9）

---

## 0. 结论

| 维度 | 判定 |
| --- | --- |
| 组合期不提交预编辑、不提前转目标 | **通过**（Set / End / 清单 / 标题四类均零写入） |
| 保存前后节点、焦点、光标稳定 | **通过**（25ms×64 / 20ms×137 采样，无重建、零失焦、可盲打续写） |
| 取消、503、409、重试、目标转换失败 | **通过**（输入全部保留，无重复目标，版本号正确） |
| 在途继续输入 / 在途开始组合 | **通过**（旧响应不覆盖较新输入，`expected_revision` 1→2 递增，无 409） |
| 模板保存、目标命令、切页/卸载 | **通过**（锁只作用于显式动作，命令前先落库，卸载后标记已清） |
| Writing 回归 | **通过** |
| Insight 回归 | **未验证**（Mock 未实现 Insight 接口，入口 404） |
| 残留问题 | **2 项**（对照视图仍按 `disabled` 锁编辑器；失焦/弹窗导致预编辑被提交并落库），均**非本次修复引入**，见 §5 |
| 真实中文 IME | **未验证**（CDP 模拟，见 §6） |

断言总计：**100 / 104 通过**；4 条失败＝1 条环境不可达 + 3 条残留问题断言（有意保留为失败，不做“调绿”）。

---

## 1. 基线核对（测试前）

```
pwd    C:/Programme/demo/SeekJournal-Work-01
branch wb/writing
HEAD   856d602307215204b992fdd3ea954e6d0fb88241
status M frontend/src/editor/RichTextEditor.css
       M frontend/src/editor/RichTextEditor.tsx
       M frontend/src/pages/RitualPage.tsx
       M frontend/src/pages/WritingPage.tsx
       M frontend/src/utils/ritualControlled.test.ts
       M frontend/src/utils/ritualControlled.ts
       ?? s04-qa-web-paths/
diff   6 files changed, 147 insertions(+), 23 deletions(-)
```

散列（测试前，与开发者交接一致）：

```
44c717e3…e17c0  frontend/src/editor/RichTextEditor.css
10cd75de…44a2   frontend/src/editor/RichTextEditor.tsx
2eb6ef63…a907   frontend/src/pages/RitualPage.tsx
ecab1074…284b   frontend/src/pages/WritingPage.tsx
2a5c4692…f7b0   frontend/src/utils/ritualControlled.test.ts
8cec0e6b…d070   frontend/src/utils/ritualControlled.ts
```

**已停写确认**：6 个文件的最后修改时间为 19:32–19:40，本机时间 20:14 起进入复测，全程文件 mtime 未变；测试结束再次散列完全一致（§9）。

---

## 2. 方法

- 用**真实构建产物**：`VITE_API_BASE_URL=http://127.0.0.1:8041 npm run build`（退出 0，含 `tsc`）；
- 夹具放在**独立目录** `s04-qa-independent/`，`cdp.mjs` 原样复制（散列与开发者那份一致），`mock-server.mjs` 复制后**只增不改**：新增 `templateDelayMs` / `goalPatchDelayMs`、记录 `/api/ritual-goals` 请求、回收箱旧版本路由（对照入口需要）；
- 驱动：无头 Chrome（CDP 端口 9262），每场景 `reset` + 清 localStorage，断言全部基于「Mock 收到的请求正文 / 服务器最终文档 / DOM 节点身份 + contenteditable + 焦点采样 / 刷新后内容」；
- 采样：组合场景 25ms，保存场景 20ms，对照场景 25ms。

> **方法学修正（重要）**：首轮 19 场景里有 6 条失败经定点诊断（`diag-extra-write.mjs`）确认是**我的夹具缺陷**——种子文档用了非 UUID 的节点 id，而 `editor/schema.ts:serverAttrs` 只保留 UUID 形态的 id，于是打开页面时投影清掉 id、触发一次“规范化 PATCH”，导致版本号整体偏移。改用 UUID 种子后全部消失。报告中不含这类伪失败。

---

## 3. 逐场景结果

| # | 场景 | 结果 | 关键证据 |
| --- | --- | --- | --- |
| I1 | Set 组合保持 1.6s | 8/8 | 64×25ms：`marks=["A"]`、`editable=["true"]`、失焦 0；期间 **0 请求**；上屏后仅 1 次 PATCH `I1 已保存句。你好`（2599ms），rev 1→2；刷新一致 |
| I2 | End 组合保持 1.6s | 5/5 | 同上（`marks=["B"]`） |
| I3 | 清单组合 2s 不转目标 | 6/6 | 期间 0 请求、服务器无 `goalItem`；上屏后 PATCH（3001ms）→ POST goals（3007ms），目标 `买牛奶`、无拼音、刷新仍 1 个 |
| I4 | 组合 1.4s 后取消 | 3/3 | 取消前后均 0 请求，正文回原文，刷新无 `shijie` |
| I5 | 组合 300ms 内上屏 | 3/3 | 1 次 PATCH、版本只 +1 |
| I6 | 标题组合 1.5s | 3/3 | 组合期标题未落库；上屏后标题 `标题目`，正文未被污染（标题与正文共用会话状态，守卫同样生效） |
| I7 | 组合中失焦到标题框 | 3/3 | `compositionend` 在 426ms（失焦触发）；1344ms PATCH 内容 = 编辑器可见文本；随后继续输入仍能保存（标记未卡死） |
| I8 | 上屏后 503 | 5/5 | 组合期 0 请求；503 后正文完整、服务器 rev1 未变、状态行「保存失败 本地草稿已保存（仅本机浏览器）」；重试→200、rev2 |
| I9 | 真实 409 | 7/7 | 外部推进到 rev2；本地 PATCH 409（911ms）→ 冲突提示 →「保留本地草稿并基于最新重写」→ 200（expected 2）rev3，本地文本只出现一次，刷新一致 |
| I10 | 目标转换 500 后手动重试 | 6/6 | 失败时无 `goalItem`、清单文本保留、出现「转为目标」；重试后恰好 1 个目标，刷新无重复 |
| I11 | Set 普通保存焦点稳定 | 6/6 | 137×20ms：`marks=["C"]`、`editable=["true"]`、失焦 0；保存后不点击继续打字并落库（`…追加句。盲打续写`），两次 PATCH 均 200 |
| I12 | Writing 自动保存 + 立即保存 | 4/4 | 采样无重建/零失焦；「立即保存」不重建；内容落库 |
| I13 | Writing 组合对照 | 3/3 | 组合期 0 请求，上屏后 1 次 PATCH |
| I14 | 在途继续输入 | 7/7 | PATCH1（917ms，expected 1）→ 在途输入「在途二」可落字、节点未换、焦点未丢 → PATCH2（4843ms，expected **2**）200；无 409；rev3；文本顺序正确 |
| I15 | 在途时开始组合 | 5/5 | 在途响应到达时未把 `nihao` 写库；settle 后仍「未提交」；任何请求正文均不含 `nihao`；上屏后 PATCH `…先保存。你好` |
| I16 | 目标勾选与脏草稿并发 | 7/7 | 勾选期间 `contenteditable` 全程 `false`（采样 12×100ms）；PATCH 正文（18ms）**先于** ritual-goals PATCH（30ms）；目标勾选成功、仅 1 个 |
| I17 | 模板保存期间锁定 | 7/7 | 保存期间锁定、节点标记 `H` 不变、解锁后可编辑；正文未丢；模板已更新；无正文写请求 |
| I18 | 组合中真实鼠标切页 | 5/5 | 事件序 `compositionstart(1ms) → … → compositionend(422ms)`，PATCH 426ms（`…qiehuan`），无「未保存」拦停框；回切后继续写并保存 |
| I19 | Insight 回归 | 1/2 | 页面可开，但 `editors=0`：Mock 未实现 Insight 列表（HTTP 404）→ **未验证**（代码级：`InsightPage` 未在本次改动内，`locked` 默认 false） |
| I20 | 对照视图右侧编辑器 | 3/4 | 输入落库、节点未重建；**保存期间 `editable` 出现 `false`、213 次采样中 176 次失焦** → 残留问题 P3-1 |
| I21 | 组合中程序化切页（不失焦） | 3/5 | 拦停框出现（文案「最新改动还没保存成功，确定离开？」）、确认后可离开、回切可继续保存；但弹窗抢焦点后 **PATCH 携带 `chengxu`（1357ms）**，最终正文为 `I21 已保存句。chengxu回切。` → 残留问题 P3-2 |

控制台异常（`Runtime.exceptionThrown`）：**0**。

---

## 4. 修复目标达成情况（逐条对应用户要求）

1. **组合期不自动保存、不转目标**：I1/I2/I3/I6 组合期请求数均为 0；I3 期间服务器无 `goalItem`，转换只发生在保存之后的 6ms。守卫链路（`.ritual-main` 组合事件 → `setComposing` → `planWrite` 的 `ime` 分支 → `goalConversionReady`）确实生效。
2. **保存不重建、不丢焦点、不打断连续输入**：I1/I2/I11/I12 采样中节点身份标记恒定、`contenteditable` 恒为 `true`、焦点丢失 0 次；I11 保存完成后**不点击**直接打字并落库。根因（`readOnly` 进 `useEditor` 依赖）已被 `locked` 通道切断。
3. **上屏 / 取消 / 失败 / 冲突 / 切页保持输入安全**：I4（取消）、I8（503）、I9（409 + 保留本地）、I10（转换失败）、I18（真实鼠标切页）全部保留输入且版本自洽。
4. **锁与 `disabled` 解耦后的边界**：I14/I15 证明在途输入不被旧响应覆盖（`baseline=快照`，`status=unsaved`，下次用新 `revision`）；I16/I17 证明显式动作仍会锁编辑器且命令前先 drain；I18/I21 证明切页与卸载后组合标记不残留（回切可保存）。
5. **较新输入 / 重复目标 / 版本错误**：I14 两次 PATCH `expected_revision` 为 1→2 且无 409；I3/I10/I16 目标数恒为 1；I9 恢复后本地文本仅出现一次。

---

## 5. 残留问题（非本次修复引入，未修改代码）

### P3-1 对照视图右侧编辑器仍按 `disabled` 锁定，保存期间失焦

- **位置**：`frontend/src/pages/RitualPage.tsx:1531` — `<RichTextEditor doc={document} locked={disabled || compareBusy} …>`，与主编辑器的 `locked={editorLocked}` 口径不一致。
- **复现**：Set 页存在同日旧版本（回收箱）→「打开对照」→ 在右侧编辑器输入 → 等待自动保存（Mock 注入 2.5s 延迟便于观察）。
- **实测**：`contenteditable` 出现 `false`；213 次 25ms 采样中 **176 次焦点不在编辑器**；文字仍落库（无数据丢失）。
- **影响**：对照过程中每次自动保存都会短暂锁编辑器并丢焦点，属于本次修复要消除的同一类体验问题，只是发生在对照分支。
- **说明**：`compareBusy` 期间锁定是设计意图；问题在于把 App 回流的 `disabled`（含在途保存）也算了进去。

### P3-2 失焦/弹窗抢焦点时，未确认拼音被浏览器提交并随后落库

- **复现 A（切页）**：组合中输入 `qiehuan` → 真实鼠标点「概览」。事件序 `compositionstart → … → compositionend(422ms)`，PATCH 426ms 写入 `…qiehuan`（I18）。
- **复现 B（只切到标题框）**：组合中输入 `shiqu` → 点标题输入框（不离开页面）。`compositionend(426ms)`，1344ms PATCH 写入 `…shiqu`（I7）。
- **复现 C（拦停弹窗）**：组合中输入 `chengxu` → **程序化**点「概览」（不失焦）→ 出现「最新改动还没保存成功，确定离开？」→ 弹窗 `showModal()` 抢焦点 → 浏览器提交预编辑 → 1357ms 自动 PATCH 写入 `…chengxu`（I21）。
- **性质**：浏览器在失焦时提交 composition 是标准行为，Writing 同样如此；不是本次修复引入，也与“应用主动打断组合”不同（修复前是 App 重建编辑器打断）。C 中弹窗随后仍显示“还没保存成功”，与实际已发生的保存不一致，属文案/时序瑕疵。
- **影响**：用户在组合未确认时移开焦点或点导航，拼音会进入正文并被保存（可撤销、可见，不是静默丢失）。
- **建议（未实施）**：需要产品决策——要么在弹窗/导航前先 `blur` 并等待 `compositionend` 再 flush（让顺序确定），要么对“仅由失焦提交的预编辑”做一次提示。

### 观察（非缺陷）

- 组合期间状态行显示「未提交到服务器」，因为草稿包含预编辑文本；取消后回到原文（I4 已验证），不会误保存。
- 在途保存期间 `disabled` 仍会禁掉标题输入框与页面按钮，而正文可编辑——同一页面两种口径，但不影响数据安全（I14/I15）。

---

## 6. 未验证项

1. **真实中文输入法未验证**。全部组合由 CDP `Input.imeSetComposition` / `Input.insertText` 驱动，产生真实的 `compositionstart/update/end` 与 `insertCompositionText` 事件，但**没有候选窗、没有输入法进程、没有按键到拼音的转换**；无头环境按 `Esc` 无法结束组合，因此「真实 Esc 取消」未覆盖。
2. **真实后端 + PostgreSQL 未复跑**：Mock 的 `convert_ritual_task_item` 与后端同构实现，但未在真实库验证。
3. **Insight 编辑入口未验证**：Mock 缺 Insight 接口（404）。代码级确认 `InsightPage` 不在本次改动内，且 `locked` 默认 `false`，行为应不变。
4. 未覆盖：`content_blocks` 旧格式、多标签并发、移动端/软键盘、读屏与视觉回归、`aiLocked` 与 Ritual 编辑器的组合（导航在 AI 锁期间被拦，实际不可达）。

### 真实 IME 人工复现步骤（建议在真实后端或 Mock 均可）

1. 打开「开始今天」，正文输入「前缀。」并等待状态变为「服务器已保存」（约 1s）。
2. 输入法输入 `nihao`，**不要选词**，让候选窗保持打开 **≥2 秒**。
3. 观察：状态行不应出现「正在保存到服务器」；刷新页面后正文不应出现 `nihao`。
4. 选词上屏「你好」，等待保存，刷新确认正文为「前缀。你好」。
5. 重复步骤 2，然后按 `Esc` 取消候选：正文应回到「前缀。」，服务器不应新增版本。
6. 重复步骤 2，在候选窗打开时用鼠标点「概览」：记录是否弹出「最新改动还没保存成功」，以及刷新后是否出现 `nihao`（对应 P3-2）。
7. 把光标停在正文末尾连续输入 20 个汉字（不触发表情/标点面板），确认保存后光标仍在末尾、无需重新点击即可继续输入（对应焦点稳定性）。

---

## 7. 不写库的构建与测试（本次实际运行）

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 构建（Mock 基址） | `VITE_API_BASE_URL=…:8041 npm run build` | 退出 0 |
| Lint | `npm run lint` | 退出 0，19 warning / 0 error（与修复前同量） |
| 纯逻辑测试 | `node --experimental-strip-types` × 39 份 | 39/39 通过，0 失败 |
| 浏览器复测 | `verify.mjs`（21 场景） | 100/104 断言通过，控制台异常 0 |

---

## 8. 证据索引（均在本目录）

- `verify.mjs` — 21 场景复测脚本（散列 `38f80efc…76d6`）
- `verify-results.json` — 全量结果（含每个场景的请求正文、采样、刷新后内容）
- `verify-final2.log` — 最终一次完整运行日志
- `mock-server.mjs` — 隔离 Mock（散列 `414c0342…2c4a`，在开发者版本上仅新增故障注入与回收箱路由）
- `cdp.mjs` — CDP 驱动（散列 `fc8901e6…248f`，与开发者版本一致）
- `diag-extra-write.mjs` / `diag-extra-write.json` — 「打开页面即 PATCH」的定点诊断（证明是种子 id 非 UUID 引起）
- 截图：`iv-01-set-composition-held.png`（组合中，preedit 高亮、状态未提交）、`iv-02-set-goal-during-composition.png`、`iv-03-set-goal-after-commit.png`（目标 `买牛奶`、系统维护）、`iv-04-set-503.png`、`iv-05-set-409.png`、`iv-06-set-focus-after-save.png`、`iv-07/08-set-nav-during-composition.png`
- `hashes-after.txt` — 测试后散列（与测试前逐行相同）

---

## 9. 测试前后散列复核

```
$ sha256sum <6 个改动文件>   # 测试后
44c717e35c9ccc23ee802956338542f5ffa00ba2519bdc8d550d6f1f8c3e17c0  frontend/src/editor/RichTextEditor.css
10cd75def0d239c7ad93e3ad37788078c02be844691a33f50dfc83718cf144a2  frontend/src/editor/RichTextEditor.tsx
2eb6ef634eaf89541fe33360b52794e6363f1a79f9ecda495c0ca439f722a907  frontend/src/pages/RitualPage.tsx
ecab1074e075fea92cd4c0998627a595c9322987f44ad531baf1dee3de36284b  frontend/src/pages/WritingPage.tsx
2a5c4692387b8dbabb62a6dd7e3d08aaca56f7863dd1ae101b679ddf0fcff7b0  frontend/src/utils/ritualControlled.test.ts
8cec0e6b2ba8dc335e4af86e417cb9a2321c37993f5c227b4fe7fcb785c9d070  frontend/src/utils/ritualControlled.ts
```

与测试前完全一致；`git status` 仍为「6 个已修改文件 + 两个未跟踪证据目录（`s04-qa-web-paths/`、`s04-qa-independent/`）」。

**收尾**：未提交、未合并、未推送；Mock（8041）与本轮无头浏览器已停止，端口无残留监听；`frontend/dist` 已用默认基址重新构建（构建产物被 `.gitignore` 忽略）。
