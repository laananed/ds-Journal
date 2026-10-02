# SeekJournal Frontend

SeekJournal 前端项目（Stage 1 / Task 1 产物）。

## 技术栈

- React
- TypeScript
- Vite

## 安装

```bash
cd frontend
npm install
```

## 本地开发

```bash
npm run dev
```

终端会输出本地地址（默认 `http://localhost:5173`），用浏览器打开即可。

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

## 当前范围

本 Task 只初始化前端基础项目，页面仅显示初始化成功信息。

尚未实现：Journal 列表 / 编辑器 / CRUD、API 调用、路由、全局状态管理，以及与 FastAPI 后端和 PostgreSQL 的集成。
