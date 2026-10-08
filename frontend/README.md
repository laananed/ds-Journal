# SeekJournal Frontend

当前交付为 Stage 2 / S2-T05：在已验收的 S2-T03 Journal UI 之上，补齐 Inbox 使用流程
（普通 Inbox 与当日 Daily Inbox 的列表、详情、新建、编辑、硬删除）。
产品/API/架构/任务分别以根目录 `docs/stage2*.md` 为准；Stage 1 历史验收见 `docs/stage1-acceptance.md`。
仍**未开放**的模块：Insight、Search、Trash、Folder 管理、Inbox→Journal、AI 辅助。
Markdown 本期按**原始源码**编辑与展示，不渲染。

## 已实现的流程

### Journal（S2-T03，未改动）

- Journal 新建、真实详情读取、按实际修改字段 PATCH，以及移入回收箱的软删除；204 不解析 JSON。
- 主列表与新建表单的当天已有记录都按固定 20 条分页；数量使用响应 `total`。
- 日期条件改变回第 1 页，删除导致当前页越界时按 `total` 重读最近有效页。
- 所有卡片直接显示服务器 `display_title`，不在当前页上重算 Journal 编号，不把生成标题写回 `title`。
- 默认 Journal 日期按本机 04:00 换日，打开编辑器时确定，后续不自动重置。
- PATCH 只验证实际提交字段，旧空白/超长正文可继续读取、只改其他字段；历史空串标题未编辑时保持空串。
- 阅读仍是安全普通文本，Markdown 渲染属于后续 T12。

### Inbox / Daily Inbox（S2-T05）

- 普通 Inbox：列表、真实详情读取、新建、按实际修改字段 PATCH、**硬删除**（含 Daily，不进回收箱）。
- Daily 入口按业务日期查询当日身份：`GET /api/inboxes/daily?inbox_date=YYYY-MM-DD` 只返回
  `missing` / `active` 两态。`missing` 打开空编辑器（**不发 POST**），输入有效内容保存后才创建并绑定真实 id；
  `active` 直接打开已有记录的真实详情。再次进入同一天打开同一条记录；同一天仍可另建多条普通 Inbox。
- 默认 Inbox 日期复用 `defaultJournalDate()`（本机 04:00 换日），不使用 UTC 截取或减 24 小时；
  跨 04:00 不自动改写已打开编辑器的日期。
- 创建后 `inbox_date` 与 `is_daily` **不可修改**；更新时这两个字段永不进入请求体。
- 标题语义：POST 省略 `title` 时后端存默认 `inbox_date`；主动清空需显式发送 `null` 或空串；
  PATCH 省略即不修改；`display_title` 只是读取回退，绝不写回 `title`。已有 `title=null/""` 打开编辑器
  不会被回退成日期；非空标题不 trim；最多 80 个 Unicode 码点。
- 正文最多 50,000 个 Unicode 码点（按码点而非 UTF-16 长度），非空白判定沿用既有规则，
  Markdown 空格/缩进/换行原样保存；非法输入不改动也不发写请求。
- 失败与竞态：保存中阻止重复提交与导航；保存成功后的列表刷新失败单独显示，不冒充保存失败；
  保存失败保留日期/标题/正文与 Dirty 状态；Daily 并发 409 时重查同日状态并给出明确冲突提示与
  已有记录入口，不自动覆盖也不丢弃输入；过期响应不覆盖新视图。
- 删除：全类型硬删除，确认文案明确「永久删除、不可恢复」；成功消费 204 空响应，不调用 `response.json()`；
  删除后刷新列表与当日 Daily 状态，删除 Daily 后允许同日重建。

### 交互（S2-T03 + T05 共用）

- 新建与详情编辑只保留一个活动面板；模块、文件、列表、主分页、日期筛选、返回、取消、新建、
  Daily 入口等离开出口统一经 App 的 Dirty 检查。
- 默认值不算改动，恢复初始字段值不再 Dirty；继续编辑保留输入，确认离开才丢弃。
- 整张卡片是原生按钮，支持点击、Enter、Space；打开时重新请求真实详情。
- 写入期间阻止重复提交与导航；保存失败保留输入/Dirty；保存成功重置基线。
- 日期/详情快速切换用 AbortController 和组件身份作废旧请求；404 清掉过期详情。
- 列表标题一行、摘要三行省略；详情保持完整正文。

## 运行与配置

继续使用 React + TypeScript + Vite、组件 state 和原生 fetch，无新增依赖。
前端读取 `VITE_API_BASE_URL`，值为后端根地址，不含 `/api`；未配置时默认 `http://127.0.0.1:8000`。
`VITE_*` 进入浏览器产物，只能放非敏感地址，不能放数据库凭据。

普通开发端口由 `vite.config.ts` 设置为 `127.0.0.1:5173`，`strictPort` 防止端口占用时自动换端口。
后端 CORS 必须允许所用前端来源。当前轮的既有 `node_modules` 直接复用，不安装或升级包。

本轮 T05 自测在**当前授权工作树**运行，复用已验收的 T04 后端工作树 `SeekJournal-Work-02`，
**不改 `.env`**，只对本轮进程临时设置 `VITE_API_BASE_URL`：

```powershell
# 后端（在 SeekJournal-Work-02/backend，连接到测试库 seekjournal_test）
.\backend\.venv\Scripts\python.exe -B .\backend\.venv\parallel_server.py --database seekjournal_test --port 8014 --origin http://127.0.0.1:5175
# 前端（在本树 frontend）
$env:VITE_API_BASE_URL = 'http://127.0.0.1:8014'
npm.cmd run dev -- --host 127.0.0.1 --port 5175
```

后端启动器必须打印 `WORKSPACE_DATABASE=seekjournal_test`，并在浏览器写入前用数据库查询
确认实际连接；浏览器地址为 `http://127.0.0.1:5175`。
**不得**借用个人库 `seekjournal` 进行写测试，**不得**操作 `seekjournal_t03_ui_test`，
不启动 Compose、不动 5173/8000/5432 服务，不运行默认可能连个人库的后端启动命令。
UI 验证期间不得与固定使用 `seekjournal_test` 的后端 pytest 并行。

## 可复现的前端检查

在 `frontend/` 分别执行：

```powershell
npm.cmd run build
npm.cmd run lint
node --experimental-strip-types src/utils/journalDate.test.ts
node --experimental-strip-types src/utils/journalDetail.test.ts
node --experimental-strip-types src/utils/journalTitles.test.ts
node --experimental-strip-types src/utils/contentValidation.test.ts
node --experimental-strip-types src/utils/dirtyState.test.ts
node --experimental-strip-types src/utils/pagination.test.ts
node --experimental-strip-types src/utils/inboxDraft.test.ts
```

构建先运行 TypeScript 检查，再输出忽略的 `dist/`。
纯逻辑直接用 Node 类型剥离，不添加测试框架；实际结果以当次输出为准。
`journalTitles.ts` 和对应测试保留 Stage 1.5 完整日期编号的历史回归；
当前 Journal UI **不调用此函数**，跨页/软删编号来自 T02 的服务器投影。

真实浏览器自测必须先证明数据库隔离，记录每次自建的 `(type, id)`，
将真实链路、合成失败和延迟真实响应分开记录；收尾只清理本轮自建记录，不重置 sequence。
实施者自测结束后仍需 Lead 独立验收，不代表完整 Stage 2 已验收。

## 核心代码

- `src/App.tsx`：活动模块/文件、统一 Dirty 离开检查、主列表与写后刷新；`journal` 与 `inbox` 两个模块分支。
- `src/api/journals.ts` / `src/api/inboxes.ts`：Journal 与 Inbox 的分页响应与 fetch；`deleteInbox` 不解析 204。
- `src/types/file.ts` / `src/types/inbox.ts`：共享契约与 Inbox 创建/更新/分页/Daily 状态类型。
- `components/FileCard.tsx` / `Pagination.tsx`：被 Journal 与 Inbox 共用的最小共享组件。
- `components/JournalEditor.tsx` / `JournalDetail.tsx`：Journal 的输入基线、写入锁、失败保留、当天分页。
- `pages/InboxPage.tsx`：Inbox 工具栏/列表/分页/筛选/Daily 状态 + 创建/详情/编辑面板。
- `utils/dirtyState.ts` / `pagination.ts` / `journalDetail.ts` / `inboxDraft.ts`：可脱离 React 验证的
  比较、页码与 Inbox 草稿建造规则。

当前最值得理解的是：`total` 与当前页 `items.length` 不同；
`display_title` 是读取投影，原始 `title` 是可写字段；
Dirty 比较编辑基线，而写成功与后续读失败是两个独立结果；
Daily 身份的创建与更新由「保存时是否携带真实 id」区分，入口本身只读、不写库。
