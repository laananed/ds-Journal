# SeekJournal Frontend

SeekJournal 前端项目（Stage 1 / Task 8.1 产物）。

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

需要同时运行后端（FastAPI，默认 `127.0.0.1:8000`）与前端（Vite，默认 `5173`）。
后端启动方式见 `backend/README.md`。

```bash
npm run dev
```

终端会输出本地地址（默认 `http://localhost:5173`），用浏览器打开即可。

前端与后端是不同来源（端口不同），因此后端已配置 CORS 允许
`http://127.0.0.1:5173` 与 `http://localhost:5173` 的读取请求，
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

## 预览构建产物

```bash
npm run preview
```

## 当前范围（Task 8.1）

已实现：

- Journal 列表：通过真实 HTTP `GET /api/journals` 读取并展示；
- 按 `journal_date` 精确筛选：`GET /api/journals?journal_date=YYYY-MM-DD`，
  筛选在**后端**执行，前端不拿全量再过滤；
- 清除筛选后恢复全部列表；
- 状态处理：加载中、有记录、列表为空、指定日期无记录、请求失败与重试；
- 列表顺序完全沿用后端返回顺序（`journal_date DESC`、同日 `created_at DESC`），前端不再排序；
- `title` 为 `null` 时用 `journal_date` 作为显示标题（**仅 UI**，不写回数据库）；
- 正文用普通文本渲染（不使用 `dangerouslySetInnerHTML`）。

工程细节：

- 只用组件本地 `useState` / `useEffect`，保留 `StrictMode`；
- 用 `AbortController` 取消过期请求，避免旧日期的迟到响应覆盖新结果，
  取消不会被显示成错误；
- 请求失败时不保留过期列表，避免把旧结果伪装成当前筛选结果；
- 日期与时间字段在前端保持**字符串**，不做 `Date` 转换，避免时区导致的日期偏移。

尚未实现（后续阶段）：

- 创建 Journal、详情、修改、删除 UI；
- 04:00 换日规则、创建时当天记录提示；
- 分页、搜索、路由、全局状态管理、前端测试框架。
