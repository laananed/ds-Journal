# SeekJournal Frontend

SeekJournal 前端项目（Stage 1 / Task 8.1 列表 + Task 8.2 创建 + Task 8.3 详情 / 修改 / 删除 + Task 8.4 整体验收）。

## 技术栈

- React
- TypeScript
- Vite
- 浏览器原生 `fetch`（不引入 Axios / React Query 等）
- 组件本地 State（不引入 Redux / Zustand / React Router）
- Oxlint（代码检查）

## 安装

```bash
cd frontend
npm install
```

## 配置后端地址

前端通过 `VITE_API_BASE_URL` 读取后端根地址，**不包含 `/api`**：

```text
VITE_API_BASE_URL=http://127.0.0.1:8000
```

- 未设置时，代码内使用同一默认值 `http://127.0.0.1:8000`（见 `src/api/journals.ts`），
  因此本地开发可以不建 `.env`。
- 如需覆盖，复制 `frontend/.env.example` 为 `frontend/.env` 并修改。
- 注意：`VITE_*` 会被编译进浏览器产物，只能放非敏感配置，
  **不要**在其中写数据库凭据或其它秘密。

## 本地开发

需要同时运行后端（FastAPI，默认 `127.0.0.1:8000`）与前端（Vite）。
后端启动方式见 `backend/README.md`。

```bash
npm run dev
```

开发地址是固定的：

```text
http://127.0.0.1:5173
```

`vite.config.ts` 里显式写了 `host: '127.0.0.1'`、`port: 5173`、`strictPort: true`：

- 写死 `host` 是为了避免只监听 IPv6 的 `[::1]`，导致 `127.0.0.1` 打不开；
- `strictPort` 让端口被占用时**直接报错**，而不是悄悄换到 5174——
  后端 CORS 只放开了 5173 这两个来源，换端口会静默失效。

前端与后端是不同来源（端口不同），因此后端已配置 CORS 允许
`http://127.0.0.1:5173` 与 `http://localhost:5173` 的
**GET / POST / PATCH / DELETE** 请求，
详见 `backend/README.md` 的 CORS 说明。

## 构建

```bash
npm run build
```

构建前会先执行 TypeScript 类型检查（`tsc -b`），产物输出到 `dist/`。

## 代码检查

```bash
npm run lint
```

使用 Oxlint，配置在 `.oxlintrc.json`。

## 日期规则测试

默认业务日期规则（本机 04:00 换日）有一份最小测试，**不引入测试框架**，
直接用 Node 内置的类型剥离运行：

```bash
node --experimental-strip-types src/utils/journalDate.test.ts
```

成功时输出 `defaultJournalDate: 10 cases passed`。

## 详情 / 编辑纯逻辑测试

Task 8.3 里唯一值得单测的纯逻辑（PATCH 请求体构造 + 时间戳排版）放在
`src/utils/journalDetail.ts`，测试同样用 Node 类型剥离直接跑：

```bash
node --experimental-strip-types src/utils/journalDetail.test.ts
```

成功时输出 `journalDetail: 25 assertions passed`。

## 预览构建产物

```bash
npm run preview
```

## 当前范围

### Task 8.1：API 接入与列表（已实现）

- Journal 列表：通过真实 HTTP `GET /api/journals` 读取并展示；
- 按 `journal_date` 精确筛选：`GET /api/journals?journal_date=YYYY-MM-DD`，
  筛选在**后端**执行，前端不拿全量再过滤；
- 清除筛选后恢复全部列表；
- 状态处理：加载中、有记录、列表为空、指定日期无记录、请求失败与重试；
- 列表顺序完全沿用后端返回顺序（`journal_date DESC`、同日 `created_at DESC`），前端不再排序；
- `title` 为 `null` 时用 `journal_date` 作为显示标题（**仅 UI**，不写回数据库）；
- 正文用普通文本渲染（不使用 `dangerouslySetInnerHTML`）。

### Task 8.2：创建 Journal（已实现）

- 创建表单：标题（可选）、正文、日期，调用已有 `POST /api/journals`；
- **默认业务日期**按本机 04:00 换日规则计算（`src/utils/journalDate.ts`）：
  00:00～03:59 默认前一天，04:00～23:59 默认当天；
  表单打开时计算一次，之后只由用户修改，不会被任何 effect 或列表筛选覆盖；
- 标题留空时按契约发送 `null`（不是空字符串）；其它字符串原样发送，不做 `trim`；
- 正文允许空字符串，不擅自增加非空限制；
- 所选日期变化时真实查询该日期已有记录，显示数量与摘要，**允许同日多篇**；
- 保存中禁用提交按钮并显示状态，避免重复提交；
- 保存失败保留输入、显示错误，由用户决定是否重试（不自动重试）；
- 保存成功后清空标题与正文（保留日期，方便同日继续写），
  并按**当前筛选语义**刷新列表（全部还是全部，某日期还是该日期），不偷偷改筛选；
- 新记录不在当前筛选范围内时给出明确提示（例如「当前列表筛选的是 2026-05-19，
  这篇不在当前列表中」），避免误以为没保存；
- **「保存成功」与「列表刷新失败」严格区分**：列表刷新失败只在列表区域提示，
  不会把已经成功的 POST 报成保存失败；
- 同一日期多篇无标题记录时，显示标题依次为 `2026-05-02`、`2026-05-02 (2)`、`2026-05-02 (3)`；
  编号只计无标题记录，有自定义标题的记录不消耗编号，且**只存在于 UI**，
  不写回数据库（数据库里的 `title` 仍是 `null`）。

### Task 8.3：详情、修改与删除（已实现）

新增 `src/components/JournalDetail.tsx`（详情面板，内含查看 / 编辑 / 删除确认三个状态）
与 `src/utils/journalDetail.ts`（纯逻辑，见上一节）。

**打开详情**

- 主列表和创建表单的「当天已有记录」每条都有「打开」入口，两处入口行为一致；
- 打开时真实调用 `GET /api/journals/{id}`，**不把列表里那条数据当详情用**——
  列表可能已经过期；
- 详情展示：显示标题（无标题时用 `journal_date`）、完整正文、`journal_date`、
  `created_at`、`updated_at`，另外显示 `id` 便于和数据库对照；
- 正文用普通文本渲染并保留换行，**不使用 `dangerouslySetInnerHTML`**；
- 状态齐全：加载中、读取失败（带「重新读取」重试）、记录不存在（明确说明）、返回列表；
- 详情 404 时会清掉过期内容，不会继续展示已经不存在的记录；
- **编号是列表上下文**：详情只用「标题，没有标题就用日期」这一条规则，
  不另造一套 `(2)`、`(3)` 的详情编号，也不会把编号写回 `title`；
- 切换记录时用 `key={journalId}` 让详情面板整体重新挂载，
  旧状态与在飞请求一起作废，因此**迟到的旧响应不会覆盖新记录**。

**修改**

- 编辑表单用真实详情初始化标题、正文、日期；原 `title` 为 `null` 时输入框显示空字符串；
- 只把**真正改过的字段**放进 `PATCH`（`buildJournalUpdate()`）：
  - 空标题按创建表单的同一约定发送 `null`，其它字符串原样发送、不做 `trim`；
  - 正文允许空字符串，不额外加非空或长度限制；
  - 日期必须提供合法值，**不套用新建时的 04:00 默认日期规则**；
  - `id` / `created_at` / `updated_at` 永远不放进请求体；
  - 一个字段都没改时发送 `{}`，沿用后端已确认的空更新语义
    （返回原记录、不改变 `updated_at`）；
- 保存中禁用提交与「取消」，也禁用打开其它记录的入口，避免写入过程中换目标；
- 保存失败保留输入、留在编辑模式，由用户决定是否重试（不自动重试）；
- 取消编辑**不发任何请求**；有未保存改动时先弹一句明确提示（放弃修改 / 继续编辑），
  不引入草稿持久化或自动保存；
- 保存成功后用**后端返回值**作为当前详情（`updated_at` 由后端生成，前端不自己造）。

**删除**

- 删除前必须经过确认，确认框明确写出「删除后无法恢复」；
- 取消确认**不发 `DELETE`**，详情保持原样；
- 成功后是 `204 No Content`：`deleteJournal()` **不调用 `response.json()`**
  （否则会因解析空响应体而把成功误报为失败）；
- 成功后清掉详情与编辑状态、关闭面板，并按当前筛选刷新列表与当天记录提示；
- 失败时**不从 UI 假装删掉记录**：详情保持原样，只提示删除失败；
- `404` 只说明「记录本来就不存在（可能已被删除）」，**不冒充「本次删除成功」**，
  同时清掉过期内容并刷新读取视图；
- 不实现回收箱、批量删除或撤销删除，也不从 UI 直接连数据库。

**同步与错误**

- 修改 / 删除成功后按**当前筛选语义**刷新列表，不偷偷改筛选；
- 修改日期后，原日期的筛选不再显示该记录，新日期能看到它；
- 详情写成功后通过一个自增的「数据版本」`dataRevision` 让创建表单重读当天已有记录，
  但**不触碰用户正在填写的创建表单内容**；没有全局事件总线或共享状态；
- **「写入成功」与「随后读取刷新失败」严格区分**：`PATCH` / `DELETE` 已成功时，
  列表刷新失败只在列表区域提示，不会被当成写入失败，也不会诱导用户重复提交；
- API 错误携带 HTTP 状态（`JournalApiError`），UI 据此区分 `404` 与普通请求失败；
  本文件内只加这一个 `Error` 子类，不引入通用错误框架。

工程细节：

- 只用组件本地 `useState` / `useEffect`，保留 `StrictMode`；
- 用 `AbortController` 取消过期请求，避免旧日期的迟到响应覆盖新结果，
  取消不会被显示成错误；
- 请求失败时不保留过期列表，避免把旧结果伪装成当前筛选结果；
- 日期与时间字段在前端保持**字符串**，不做 `Date` 转换，避免时区导致的日期偏移；
  详情里的 `created_at` / `updated_at` 只做字符串层面的排版
  （`2026-10-06T09:33:15.123456+00:00` → `2026-10-06 09:33:15+00:00`），
  换算时区会让「刚刚保存过」显示成别的时间；
- 列表与表单的「当天已有记录」复用同一个 `JournalList` 组件，
  因此两处的标题、编号与打开行为天然一致；
- `src/utils/` 下的纯逻辑都用 `node --experimental-strip-types` 直接测试，
  不引入测试框架。

尚未实现（后续阶段）：

- 分页、搜索、路由、全局状态管理、前端测试框架。

## Stage 1 整体验收（Task 8.4）

Stage 1 的整体验收记录在
[`docs/stage1-acceptance.md`](../docs/stage1-acceptance.md)，包含验收时 HEAD / 日期 / 环境、
逐项证据、真实与合成证据的区分、持久化专项、数据保护与未验证项。

前端侧的可复现检查（本目录执行）：

```bash
npm run build
npm run lint
node --experimental-strip-types src/utils/journalDate.test.ts
node --experimental-strip-types src/utils/journalDetail.test.ts
```

浏览器验收的做法：在 5173 上运行真实前端，用 Playwright 把 API 的 **端口 8000 换成指向
测试库的临时后端**（`page.route` 改写 URL），页面 / React / `fetch` / CORS /
FastAPI / PostgreSQL 全真，只有端口不同；且**所有写请求都不落到开发库**。
完整命令与证据见上述验收文档。
