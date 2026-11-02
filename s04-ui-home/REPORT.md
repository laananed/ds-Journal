# SeekJournal UI 调整第一轮验收报告（全局导航 + 首页）

> 2026-11-02 · 开发者自测（WorkBuddy）。**不是**独立测试，也**不是**用户视觉验收结论。
> 证据目录：`C:\Programme\demo\SeekJournal\s04-ui-home\`
> 验证台源码：`C:\Programme\demo\SeekJournal\frontend\s04-ui-home\`（仅本地证据，不参与 `npm run build`）

## 1. 基线与边界

| 项 | 实际值 |
|---|---|
| 工作区 | `C:\Programme\demo\SeekJournal` |
| 分支 | `wb/ui` |
| 起始 / 结束时 HEAD | `2446435778f1a22963887b7abba18abc8ea19b20`（`fix: 修改启动指令`，等于本地 `main`，领先 `origin/main` 一次） |
| 开始前工作区 | 干净：`git status --short --branch` 无改动、无未跟踪文件 |
| 其他 worktree | `Work-01`=`wb/writing`@a9d6b00、`Work-02`=`wb/sight`@ac82665、`Work-03`=`worktree02`@47cdc44（本轮未进入、未修改） |
| 本轮 Git 权限 | 只读 + 本地改动。**未执行** commit / merge / push / tag / 切分支 / 建或清理 worktree |

本轮授权范围：首页与全局导航改版 + 本地自测；不改后端、不改 API/数据模型、不写数据库、不调用真实模型、不安装依赖。

## 2. 改动清单

修改（7）：

| 文件 | 主要变化 |
|---|---|
| `frontend/src/components/AppNav.tsx`（新增） | 图标导航栏 + 右下角快捷入口；内联 SVG 图标；`aria-label` / `data-tip` / `aria-current`；「更多」与「外观」浮层的 Esc/外部点击关闭与焦点归还 |
| `frontend/src/components/AppNav.css`（新增） | 图标栏、文字提示、浮层、快捷入口样式；≤860px 竖栏转顶部横栏 |
| `frontend/src/components/AppShell.tsx` | 新增可选 `shortcuts` 插槽；外观从常驻表单改为图标 + 弹出面板（选项与持久化行为不变） |
| `frontend/src/components/AppShell.css` | 左列 232px → 76px；侧栏不裁剪浮层；外观面板/快捷入口定位；响应式断点 1120 → 860 |
| `frontend/src/pages/DashboardPage.tsx` | 首页改为「速记入口 + 蓝色渐变主卡（左计划/右复盘）」；loading / empty / error 状态；复盘禁用与原因 |
| `frontend/src/pages/DashboardPage.css` | 居中留白布局、渐变卡片、白色药丸按钮、禁用浅白态、窄屏收敛 |
| `frontend/src/hooks/useTodayOverview.ts` | 网络层失败（`Failed to fetch` 等）转成中文可读原因；其余错误保持原样 |
| `frontend/src/App.tsx` | 导航数据改为「主入口 4 项 + 更多 4 项 + 快捷 3 项」；命名 速记/计划/复盘/AI 复盘；`新建记录` 从导航移入记录页工具条；移除概览「打开某篇速记」的死代码接线 |
| `frontend/src/App.css`（1 行） | 删除 `.app.app-embedded .home-new{width:100%}`（旧导航整行按钮专用，已随导航收窄失效，会把工具条按钮拉成整行） |

新增证据文件：`frontend/s04-ui-home/{home.html,home.tsx}`、`s04-ui-home/{drive.mjs,drive-report.json,17 张 PNG}`。

## 3. 参考图 3 的对照检查（逐项自查）

| 参考图要素 | 本轮实现 | 结论 |
|---|---|---|
| 极窄左栏、纯图标、顶部品牌 | 76px 图标栏；深色声波品牌块；概览/速记/记录/洞察 | 一致 |
| 大面积留白、内容居中、白底 | 首屏内容 620px 居中，垂直居中偏上；页面白底 | 一致 |
| 上方醒目「速记」入口 | 蓝色渐变横条，左标题右铅笔，悬停轻微上浮 | 一致（参考图的麦克风按钮**未实现**：本项目无语音功能，不伪造入口） |
| 下方蓝色渐变主卡 + 右下白色弧形高光 | 135° 蓝紫渐变 + 右下大圆高光 | 一致 |
| 卡内左「计划」右「复盘」白色按钮 | 等宽两列白色药丸按钮 | 一致（参考图为左对齐不等宽，本轮取等宽以平衡两入口权重） |
| 未完成前置时按钮浅色 | 复盘为浅白底 + 半透明蓝字，下方给出原因 | 一致 |
| 图标底部工具区（月亮） | 底部「更多」+「外观（月亮）」 | 一致（外观仍是浅色/深色/跟随系统三项） |
| 顶部右侧状态徽标（Day 3 of 7 等） | 未实现 | 刻意不做：本项目无该统计，不编造数据 |

字号/比例：卡片标题 30px/700，副文案 15px/1.62，卡片内边距 32px，圆角 22px，按钮高 46px 圆角 999px；窄屏（≤520px）标题 24px、按钮 44px。

## 4. 验证（本轮实测）

| 命令（工作目录 `frontend`） | 退出码 | 结果 |
|---|---|---|
| `npm run build` | 0 | `tsc -b` + `vite build` 通过；仅有既有的 chunk > 500 kB 提示（1,189 kB，非本轮引入） |
| `npm run lint` | 0 | 19 warnings / 0 errors；与本轮前一致，新增文件 0 告警，`App.tsx` 唯一告警是既有的搜索 effect |
| `node --experimental-strip-types src/utils/writingSession.test.ts` | 0 | 138 项通过 |
| `node --experimental-strip-types src/utils/theme.test.ts` | 0 | 40 项通过 |
| `node --experimental-strip-types src/utils/ritualView.test.ts` | 0 | 132 项断言通过 |
| 全部前端纯逻辑测试（42 个 `*.test.ts`，逐文件执行） | 0 | 42/42 通过，0 失败 |

### 4.1 首页状态（真实组件 + 只读 Mock）

验证台用真实 `AppShell` / `AppNav` / `PageShortcuts` / `DashboardPage` / `useTodayOverview`，只把 `window.fetch` 换成合成数据；`App.css` 一并引入，避免"验证台比真实页面干净"。

| 截图 | 场景 |
|---|---|
| `01-desktop-empty.png` | 今天无任何记录：复盘禁用 + 原因「今天还没有计划，完成计划后即可复盘。」 |
| `02-desktop-plan.png` | 今天已有计划：两个按钮均可用，提示「计划已记录，今晚可以回来复盘。」 |
| `03-desktop-end.png` | 今天已有复盘：提示「今天已经复盘过了，可以随时回来继续。」 |
| `04-desktop-error.png` | 读取失败（HTTP 503）：红色面板 + 重新读取，明确"不会创建任何文件" |
| `05-desktop-loading.png` | 加载中：骨架屏 |
| `06/07-narrow-*.png` | 500px 窄屏，空态 / 有计划 |
| `08-menu-more.png` | 「更多」：日程 / AI 复盘 / 历史收件箱 / 文件夹（首项获得焦点环） |
| `09-panel-theme.png` | 外观面板：浅色 / 深色 / 跟随系统 + 当前值 |
| `10-focus-tooltip.png` | 键盘聚焦「速记」：焦点环 + 文字提示 |
| `11-desktop-dark.png` | 深色主题 |
| `12-nav-records.png` | 「记录」选中态（浅色底 + 左侧短竖条 + 主色图标） |

请求日志（`harness-calls`）：打开首页 / 重新读取只发出 `GET /api/business-day`、`GET /api/journals`、`GET /api/rituals`，**无 POST/PATCH**。开发模式下 StrictMode 会把首个 `business-day` 读两次，属 React 开发期双调用，生产构建不会。

### 4.2 真实应用导航接线（CDP，未替换组件）

`node s04-ui-home/drive.mjs`（真实 `App.tsx`，无后端）结果见 `drive-report.json`：

- 左栏四项逐一点击：`速记 → 写作页`、`记录 → 记录列表（含新建记录）`、`洞察 → Insight`、`概览 → 首页`，`aria-current="page"` 始终只落在被点项。
- 「更多」展开 `aria-expanded=true`，四项分别进入：日程、完整复盘（AI 复盘）、历史 Inbox 列表、Folder。
- 右下角「搜索 / 设置 / 回收箱」全部切换成功并接管 `aria-current`。
- 「新建记录」在记录页工具条可用，点击后进入「写一篇日记」编辑器（"尚未创建 / 写下正文后自动创建"）。
- 全程 **32 次请求全部为 GET，0 次写请求**。
- Tab 顺序：跳到正文 → SeekJournal 品牌 → 概览 → 速记 → 记录 → 洞察 → 更多 → 外观 → （正文）→ 搜索 → 设置 → 回收箱。
- 截图：`13-app-records.png`、`14-app-more-menu.png`、`15-app-trash.png`、`16-app-home-no-backend.png`、`17-app-new-record.png`。

## 5. 未验证 / 已知差距（必须由后续轮次或他人完成）

1. **目标页文案仍是旧名**：`RitualPage`（经 `utils/ritualView.ts` 的 `KIND_LABEL`）仍显示「开始今天 / 结束今天」，`WritingPage` 页头仍是「写作」，`ReviewPage` 仍叫「复盘」。本轮只统一了导航与首页入口名；点击「计划」进入后标题不一致。改这些会动 T10/T06 的文件与其测试（`ritualView.test.ts:83-84` 断言旧字面量），不在本轮「导航 + 首页」范围。
2. **权威文档未同步**：`docs/stage4.md` §2 术语表仍写"前端显示 开始今天 / 结束今天 / 写作"，`docs/stage4-tasks.md` §1/§3.6/§3.11 也仍要求"全前端开始今天/结束今天"。本轮按用户 2026-11-02 的明确指令实现新命名，**未修改共享 docs/、agents/、AGENTS.md**，需 Codex 先同步。
3. **真实数据下的 Ritual 创建时机未实测**：本轮无后端与测试库写权限，未验证"点计划/复盘进入的是当天同一份记录"。依据是 `RitualPage` 先 `GET /api/rituals?journal_date=` 取得已有文件、缺失时才开会话且首次有效正文才落库（结构保证 + 读取路径核对），不是实测结论。
4. **真机/真实 IME 与 Tab 实按未测**：焦点环与提示用程序化聚焦截图，Tab 顺序用 DOM 只读枚举；未做人工逐键走查。
5. **「其他入口是否也应限制复盘」未决定**：本轮只限制首页入口，`RitualPage` 仍可经回收箱/历史链接进入，后端无任何新限制（按要求不改 API/模型）。需 Codex 明确。
6. **`AppShell` 接口新增可选 `shortcuts`**：属 T05 冻结接口的**加法**扩展（默认 null，不传即无变化），需 Codex 确认是否接受。
7. **概览不再列出今日速记标题**：为贴合参考图的极简留白，只保留一句状态（"今天 N 篇速记"）；多篇速记仍在「速记」页左侧列表可点开。原 `App.tsx` 中"从概览打开某篇速记"的一次性请求接线随之移除（死代码）。

## 6. 清理

- 自建服务已停止：`5173`（真实应用 dev）、`5188`（验证台 dev）均 `taskkill` 并确认无 LISTENING。
- 未启动后端、未连接数据库、未写任何库、未调用模型、未安装依赖。
- 临时截图裁切文件已删除；`chrome` 调试 profile 位于系统临时目录，未纳入仓库。

## 7. 关键文件散列（SHA256）

```
468a3e4e6043a50cd50c7d99cc236ee41d58d6dcee77f93cd0d74de355ddd9a9  frontend/src/App.tsx
50a15b07ea46744b840852252586af791fca11c1c9341825470bef15726401a1  frontend/src/App.css
effde93de42cbc13d3876776cde05f61117cf804ca2fb3605d10dfccf248c6a5  frontend/src/components/AppShell.tsx
50960dddb640be948623328d9deaa9e1f363be3d41d771181a77356775820ff7  frontend/src/components/AppShell.css
7545c7b0529cd543b029215240a1ce92bae06f7faa0427a6992cefb0e4b0ebff  frontend/src/components/AppNav.tsx
e4d44ca4c39c3dc0bb70932de3ab573697020d71049846c4b2480cc1b581eaa0  frontend/src/components/AppNav.css
f461c8004148809cd5425d13d82140ba7bfb91dc5af668dfcb3bd36dc6811767  frontend/src/pages/DashboardPage.tsx
0ea766a3debfbaa412887d9b40d463af4ca08d797758182eb06d4e8932d6e03c  frontend/src/pages/DashboardPage.css
0dfd781c1f6d4f668c7e621495600944acb29db667697e892261c43cdd471bcf  frontend/src/hooks/useTodayOverview.ts
```

工作区状态（停止写入时）：分支 `wb/ui`、HEAD `2446435` 未变；7 个已跟踪文件修改、2 个新增源码文件、2 个新增证据目录，无其他未跟踪文件；**未提交**。
