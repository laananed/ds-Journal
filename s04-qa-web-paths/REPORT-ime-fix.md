# Set／End 输入法组合与保存期编辑器重建 —— 修复记录

- **目录**：`C:\Programme\demo\SeekJournal-Work-01`
- **分支 / 基线 HEAD**：`wb/writing` / `856d602`（改动**未提交**，工作区含 6 个已修改文件 + 未跟踪证据目录）
- **其他工作树**：`SeekJournal`（`codex/s4t12`）、`SeekJournal-Work-02`（`wb/sight`）、`SeekJournal-Work-03`（`wb/sight-check`）全程未切换、未写入、未清理
- **数据面**：仅自建内存 Mock（8039），未连 8000 / PostgreSQL，未调用任何模型
- **依据**：`s04-qa-web-paths/REPORT-ime-composition.md`（第二轮核查）、`AGENTS.md`、`agents/ds-developer.md`、`agents/multi-agent-workflow.md`

## 0. 结论

| 原缺陷 | 修复后实测 |
| --- | --- |
| D2 Set/End 组合期触发自动保存，拼音当正文落库（`…nihao` 永久留存） | 组合保持 1.5s **零写请求**；上屏后只提交已确认文本 |
| D1 每次保存重建编辑器、丢焦点、盲打落空 | 保存前后节点身份标记不变、`contenteditable` 全程 true、焦点采样 0 次丢失；保存完成后不点击即可继续输入 |
| D3 Set 清单预编辑拼音被自动固化为目标（`买ni`） | 组合期不落库、不转目标；上屏「牛奶」后目标为 `买牛奶`，刷新仍在 |

## 1. 根因（本轮重新验证，非照抄报告）

1. **守卫从未置位**：`state/editSessions.ts:496` 的 `planWrite` 本就有 `imeComposing → blocked('ime')`，`utils/ritualControlled.ts` 的自动转目标也依赖该标记；但 `RitualPage` 只**读** `session.imeComposing`，全文件没有 `setComposing` / `onCompositionStart`。
2. **保存即重建**：`RitualPage` 把 `disabled`（含本页 `inFlight`）当 `readOnly` 传给编辑器；`RichTextEditor` 的 `useEditor(..., [readOnly])` 在依赖变化时 `editor.destroy()` 后新建（`node_modules/@tiptap/react/src/useEditor.ts:254-280`），于是 DOM 节点被替换 → 丢焦点、组合被静默打断。
3. **回流竞态（本轮新发现）**：`disabled` 来自 App 的 `uiLocked`，比本页 `autoSaving` **晚一拍**。第一版修复只做「保存时不锁」，仍在保存结束的瞬间观察到一次短暂 `setEditable(false)` → `activeElement` 变 `BODY`（`diag-focus2` 首版：`dt≈992ms active:false`）。因此最终版本让编辑器锁定**完全脱离** `disabled`。

## 2. 改动（6 个文件，+147/−23）

| 文件 | 改动 |
| --- | --- |
| `frontend/src/editor/RichTextEditor.tsx` | 新增 `locked?: boolean`：只调 `editor.setEditable()`，**不进 `useEditor` 依赖**，不重建实例；工具栏按钮随 `locked` 禁用；`readOnly` 仍是视图级语义（扩展装配/隐藏工具栏），文档头补契约说明 |
| `frontend/src/editor/RichTextEditor.css` | `.s4-editor.is-locked .s4-editor-content { cursor: progress }`（只改光标，不刷底色，避免状态切换闪烁） |
| `frontend/src/pages/RitualPage.tsx` | ① `.ritual-main` 上接 `onCompositionStart/End` → `editSessionStore.setComposing`；② 自动保存 effect 依赖加入 `imeComposing`；③ 卸载时清组合标记（排在离开前 flush 之前）；④ `busy` 拆出 `autoSaving`，编辑器锁改为 `editorLocked = templateSaving \|\| goalBusy \|\| compareBusy`（不再看 `disabled`）；⑤ 主/对照编辑器改用 `locked`；⑥ 自动转目标闸门改用可测函数 |
| `frontend/src/pages/WritingPage.tsx` | 编辑器 `readOnly={disabled}` + `locked={busy}`（显式保存不再重建）；新增卸载清组合标记 |
| `frontend/src/utils/ritualControlled.ts` | 抽出 `goalConversionReady(gate)` 纯函数（disabled / busy / status / inFlight / imeComposing / dirty），作为目标固化的唯一防线 |
| `frontend/src/utils/ritualControlled.test.ts` | 新增 7 项闸门断言（组合中、脏、在途、saving、页面锁、显式动作） |

未改 `App.tsx`：导航在保存中仍按既有约定禁用（N1），本次不调整该交互，避免扩大范围。

## 3. 验证

### 3.1 不写库的构建与测试（本次实际运行）

| 项目 | 结果 |
| --- | --- |
| `npm run build` | 退出 0（含 tsc） |
| `npm run lint` | 退出 0，19 warning / 0 error（与修复前同量） |
| 纯逻辑测试 39 份（`node --experimental-strip-types`） | 全部通过（0 失败） |
| `ritualControlled.test.ts` | 24 项（新增 7 项闸门） |

### 3.2 浏览器（真实构建产物 + 隔离 Mock + 无头 Chrome CDP，`run15-fix-verify.mjs`）

| 场景 | 关键证据 | 判定 |
| --- | --- | --- |
| V1 Set 组合保持 1.5s | 期间 `writes=0`、`mark=A` 不变、`editable=true`、61 次采样焦点丢失 0；上屏后仅 1 次 PATCH `V1 已保存句。你好` | 通过 |
| V2 End 同场景 | 同上（`mark=B`，PATCH `…你好`） | 通过 |
| V3 组合 1.4s 后取消 | `writes=0`，正文与刷新后均为原文 | 通过 |
| V4 普通保存往返 | 120 次采样：`marks=["C"]`、`rebuilt=false`、`editable=["true"]`、`lostFocus=0`；保存完成后不点击继续打字并落库 | 通过 |
| V5 清单「买」+ 组合 `ni` 1.9s | 期间 `writes=0`、无 Set 记录、`mark=G` 不变；上屏「牛奶」后 POST `买牛奶` + 转目标，`goals=["买牛奶"]`，刷新仍在 | 通过 |
| V6 清单无组合 | 921ms 保存、928ms 自动转目标（回归未破） | 通过 |
| V7 上屏后 503 | 组合期 0 请求；PATCH 503、服务器原文未动、编辑器文本保留；点「重试保存」→ 200、版本 2 | 通过 |
| V8 上屏后 409 | 组合期 0 请求；PATCH 409、服务器原文未动、编辑器文本保留、冲突提示正确 | 通过 |
| V9 Writing 对照 | 组合期 0 请求、`mark=D` 不变、上屏后 PATCH `…你好` | 通过 |
| V10 Writing「立即保存」 | `mark=E` 跨保存不变、`rebuilt=false`；保存后继续输入并二次落库 | 通过 |
| V11 组合中真实点击切页 | 真实鼠标 mousedown → 失焦提交 → 442ms 落库 → 切到概览，无确认框；返回后继续输入并落库（版本 3） | 通过 |
| 控制台异常 | `Runtime.exceptionThrown`：0 | 通过 |

`diag-focus2.mjs`（15ms 采样，Set vs Writing 对照）：修复后两者均为 **1 次状态变化**（初始聚焦），全程 `mark` 不变、`contenteditable=true`、焦点未丢、打字可续。

## 4. 未验证 / 残余边界（必须保留）

1. **真实中文 IME 未验证。** 全部组合由 CDP `Input.imeSetComposition` / `Input.insertText` 驱动，事件种类与真实输入法一致（`compositionstart/update/end`、`insertCompositionText`），但**没有候选窗、没有输入法进程、没有按键到拼音的转换**。真实输入法下的观感、Esc 取消、连续输入的窗口命中需人工复核（步骤见 `REPORT-ime-composition.md` §5）。
2. **切页/失焦时预编辑串会被浏览器提交**（V11：`…qiehuan` 落库）。这是浏览器既定行为，Writing 同样如此，本次未改，属产品未做防护的选择。
3. **组合期目标面板会显示未保存候选**「买ni」（仅列表展示，不可固化：该转换按服务器文档的 taskItem 文本生成，拼音未落库则条目在服务端不存在）。属显示层瑕疵，未处理。
4. **真实后端 + PostgreSQL** 未复跑；Mock 的 `convert_ritual_task_item` 按后端同构实现。
5. 未覆盖：`content_blocks` 旧文档、多标签并发、移动端/软键盘、读屏与视觉回归。

## 5. 顺带记录（既有问题，非本次改动引入）

空白「写作」页**零输入**切到「开始今天」也会弹「最新改动还没保存成功，确定离开？」（`diag-writing-nav.mjs`：`writing-idle` → 点击导航 → `dialog` 打开、`journals=[]`）。原因是 `WritingPage` 的 flush 把 `blocked('invalid')` 直接映射为 `blocked`，而 RitualPage 对 `invalid` 视为可离开。该行为在改动前即存在（本次未触碰 flush 路径），已按超范围处理，仅记录。

## 6. 散列与收尾

```
44c717e35c9ccc23ee802956338542f5ffa00ba2519bdc8d550d6f1f8c3e17c0  frontend/src/editor/RichTextEditor.css
10cd75def0d239c7ad93e3ad37788078c02be844691a33f50dfc83718cf144a2  frontend/src/editor/RichTextEditor.tsx
2eb6ef634eaf89541fe33360b52794e6363f1a79f9ecda495c0ca439f722a907  frontend/src/pages/RitualPage.tsx
ecab1074e075fea92cd4c0998627a595c9322987f44ad531baf1dee3de36284b  frontend/src/pages/WritingPage.tsx
2a5c4692387b8dbabb62a6dd7e3d08aaca56f7863dd1ae101b679ddf0fcff7b0  frontend/src/utils/ritualControlled.test.ts
8cec0e6b2ba8dc335e4af86e417cb9a2321c37993f5c227b4fe7fcb785c9d070  frontend/src/utils/ritualControlled.ts
```

证据文件（均在本目录）：`run15-results.json`、`run15.log`、`diag-focus2.json`、`diag-v11.mjs`、`diag-writing-nav.mjs`、`build-final.log`、`lint-final.log`、`r15-01..07-*.png`。

**状态**：已停止写入；未提交、未合并、未推送。修复代码已在工作区，待用户确认后由 Codex 协调提交与独立测试。
