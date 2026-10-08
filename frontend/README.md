# SeekJournal Frontend

当前交付为 Stage 2 / S2-T03：Journal 新契约 UI、基础导航、卡片、分页和统一离开确认。
产品/API/架构/任务分别以根目录 `docs/stage2*.md` 为准；Stage 1 历史验收见 `docs/stage1-acceptance.md`。
后续模块仍未开放；此处没有实现 Inbox、Insight、Search、Trash 或 Folder 业务页面。

## 已实现的流程

- Journal 新建、真实详情读取、按实际修改字段 PATCH，以及移入回收箱的软删除；204 不解析 JSON。
- 主列表与新建表单的当天已有记录都按固定 20 条分页；数量使用响应 `total`。
- 日期条件改变回第 1 页，删除导致当前页越界时按 `total` 重读最近有效页。
- 所有卡片直接显示服务器 `display_title`，不在当前页上重算 Journal 编号，不把生成标题写回 `title`。
- 整张卡片是原生按钮，支持点击、Enter、Space；打开时重新请求真实详情。
- 默认 Journal 日期按本机 04:00 换日，打开编辑器时确定，后续不自动重置。
- 新建与详情编辑只保留一个活动面板；模块、文件、列表、主分页、日期筛选、返回、取消、新建等离开出口统一经 App 的 Dirty 检查。
- 默认值不算改动，恢复初始字段值不再 Dirty；继续编辑保留输入，确认离开才丢弃。
- title ≤80、content ≤50,000 个 Unicode 码点；正文有非空白字符。原始 Markdown 空格、缩进与换行原样保存。
- PATCH 只验证实际提交字段，旧空白/超长正文可继续读取、只改其他字段；历史空串标题未编辑时保持空串。
- 写入期间阻止重复提交与导航；保存失败保留输入/Dirty；保存成功重置基线。后续列表刷新失败单独显示，不冒充保存失败。
- 日期/详情快速切换用 AbortController 和组件身份作废旧请求；404 清掉过期详情。
- 标题一行、摘要三行省略；详情保持完整正文。阅读仍是安全普通文本，Markdown 渲染属于后续 T12。

## 运行与配置

继续使用 React + TypeScript + Vite、组件 state 和原生 fetch，无新增依赖。
前端读取 `VITE_API_BASE_URL`，值为后端根地址，不含 `/api`；未配置时默认 `http://127.0.0.1:8000`。
`VITE_*` 进入浏览器产物，只能放非敏感地址，不能放数据库凭据。

普通开发端口由 `vite.config.ts` 设置为 `127.0.0.1:5173`，`strictPort` 防止端口占用时自动换端口。
后端 CORS 必须允许所用前端来源。当前轮的既有 `node_modules` 直接复用，不安装或升级包。

本轮 T03 自测在独立工作树运行，`frontend/.env.local` 指向：

```text
VITE_API_BASE_URL=http://127.0.0.1:8013
```

在本树 `frontend/` 执行：

```powershell
npm.cmd run dev -- --host 127.0.0.1 --port 5175
```

浏览器地址为 `http://127.0.0.1:5175`。后端 8013 必须使用 `seekjournal_t03_ui_test`，
并允许 `http://127.0.0.1:5175`；启动器会校验实际库名。
不得借用个人库进行写测试，不启动 Compose、不动 5173/8000/5432 服务。
本树禁止运行后端 pytest，因为现有 fixture 固定指向另一个并行任务的 `seekjournal_test`。

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
```

构建先运行 TypeScript 检查，再输出忽略的 `dist/`。
纯逻辑直接用 Node 类型剥离，不添加测试框架；实际结果以当次输出为准。
`journalTitles.ts` 和对应测试保留 Stage 1.5 完整日期编号的历史回归；
当前 Journal UI **不调用此函数**，跨页/软删编号来自 T02 的服务器投影。

真实浏览器自测必须先证明数据库隔离，记录每次自建的 `(type, id)`，
将真实链路、合成失败和延迟真实响应分开记录；收尾只清理本轮自建记录，不重置 sequence。
实施者自测结束后仍需 Lead 独立验收，不代表完整 Stage 2 已验收。

## 核心代码

- `src/App.tsx`：活动模块/文件、统一 Dirty 离开检查、主列表与写后刷新。
- `src/api/journals.ts` / `types/`：分页响应、只读显示标题与 fetch。
- `components/FileCard.tsx` / `Pagination.tsx`：真实被 Journal 使用的最小共享组件。
- `components/JournalEditor.tsx` / `JournalDetail.tsx`：输入基线、写入锁、失败保留、当天分页。
- `utils/dirtyState.ts` / `pagination.ts` / `journalDetail.ts`：可脱离 React 验证的比较和页码规则。

当前最值得理解的是：`total` 与当前页 `items.length` 不同；
`display_title` 是读取投影，原始 `title` 是可写字段；
Dirty 比较编辑基线，而写成功与后续读失败是两个独立结果。
