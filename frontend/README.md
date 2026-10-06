# SeekJournal Frontend

SeekJournal 前端项目（Stage 1 / Task 8.1 列表 + Task 8.2 创建）。

## 技术栈

- React
- TypeScript
- Vite
- 浏览器原生 `fetch`（不引入 Axios / React Query 等）
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
`http://127.0.0.1:5173` 与 `http://localhost:5173` 的 **GET 与 POST** 请求，
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

工程细节：

- 只用组件本地 `useState` / `useEffect`，保留 `StrictMode`；
- 用 `AbortController` 取消过期请求，避免旧日期的迟到响应覆盖新结果，
  取消不会被显示成错误；
- 请求失败时不保留过期列表，避免把旧结果伪装成当前筛选结果；
- 日期与时间字段在前端保持**字符串**，不做 `Date` 转换，避免时区导致的日期偏移；
- 列表与表单的「当天已有记录」复用同一个 `JournalList` 组件，
  因此两处的标题与编号规则天然一致。

尚未实现（后续阶段）：

- 详情、修改、删除 UI（Task 8.3）；`PATCH` / `DELETE` 的浏览器 CORS 也留到该阶段；
- 分页、搜索、路由、全局状态管理、前端测试框架。
