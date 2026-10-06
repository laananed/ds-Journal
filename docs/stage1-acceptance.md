# SeekJournal — Stage 1 整体验收记录

> 本文档记录 **Task 8.4（Stage 1 整体验收）** 的一次真实执行结果。
> 它是一次**带时间点的验收快照**，不是永久保证：
> 代码、依赖或环境变化后必须重新执行，不能把本文档当作持续有效的结论。

## 0. 验收对象与时间

| 项 | 值 |
|---|---|
| 验收日期 | 2026-10-06（本机时区 GMT+8） |
| 分支 | `task/s01-t08-journal-frontend` |
| HEAD | `8201533` feat: add journal detail editing and deletion UI |
| 未提交改动 | 无（验收开始时工作区干净） |
| 功能分支与 main 的差异 | `main`(`8c1a9b1`) 只到 Task 7.2；**8.1 / 8.2 / 8.3 三个前端提交只在任务分支上，尚未合入 main** |
| 角色 | DeepSeek Developer（未 commit、未 merge、未 push、未打 tag） |

验收涉及的 8.1 / 8.2 / 8.3 提交：

```text
8201533 feat: add journal detail editing and deletion UI        (8.3)
6980c1c feat: add journal creation UI with business date defaults (8.2)
1c1790e feat: connect journal list UI to backend API             (8.1)
```

## 1. 验收环境

| 组件 | 取值 | 说明 |
|---|---|---|
| 前端 | Vite dev server，固定 `http://127.0.0.1:5173`（`strictPort`） | 用户已有的开发服务，验收期间未重启、未改配置 |
| 后端（用户） | `http://127.0.0.1:8000`（uvicorn） | 连**开发库** `seekjournal`；验收期间只读，未写 |
| 后端（验收用临时） | `http://127.0.0.1:8010` | 由本次验收自己启动，`DATABASE_URL` 指向**测试库** `seekjournal_test`；验收后已停止 |
| 数据库 | Docker 容器 `seekjournal-postgres-1`，镜像 `postgres:17`，`127.0.0.1:5432`，named volume `postgres_data` | 共享容器，验收期间未重启、未删除 |
| Python | `backend\.venv`（3.12） | 只用 `.venv\Scripts\python.exe` |
| 浏览器 | 预装 Chromium（`ms-playwright/chromium-1228`）+ `playwright-core` 1.63.0 | 真实浏览器，非模拟 |
| Alembic revision | `3a70890ddb10`（两个库一致） | 未新增 Migration |

### 端口重映射方式（重要）

前端默认请求 `http://127.0.0.1:8000`。验收时**不改前端配置、不改 CORS**，
而是在 Playwright 里用 `page.route` 把请求 URL 的 **端口 8000 换成 8010**：

```js
page.route(/^http:\/\/127\.0\.0\.1:8000\/api\//, (route) =>
  route.continue({ url: route.request().url().replace('127.0.0.1:8000', '127.0.0.1:8010') }))
```

- 页面、React、`fetch`、CORS 预检、FastAPI、SQLAlchemy、psycopg、PostgreSQL **全部为真**；
- 只有 API 端口被改写，**没有任何写请求落到开发库**；
- 已核实：8010 返回 `[]`（空测试库），同时用户 8000 返回 2 条（开发库），
  两者不是同一个库。

## 2. 自动化检查（真实命令与结果）

| 命令（工作目录） | 结果 | 退出码 |
|---|---|---|
| `npm run build`（frontend/） | `tsc -b && vite build` 通过，23 modules，产物到 `dist/` | 0 |
| `npm run lint`（frontend/） | Oxlint：`0 warnings and 0 errors`（12 files） | 0 |
| `node --experimental-strip-types src/utils/journalDate.test.ts` | `defaultJournalDate: 10 cases passed` | 0 |
| `node --experimental-strip-types src/utils/journalDetail.test.ts` | `journalDetail: 25 assertions passed` | 0 |
| `PYTHONDONTWRITEBYTECODE=1 .\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests`（backend/） | **232 passed**（3.32s） | 0 |
| `.\.venv\Scripts\python.exe -m pip check`（backend/） | `No broken requirements found.` | 0 |
| `alembic current` / `heads` / `check`（backend/，针对 `.env` 的 **开发库** `seekjournal`） | `3a70890ddb10 (head)` / 一致 / `No new upgrade operations detected.` | 0 |
| `alembic current`（进程内覆盖 `DATABASE_URL`，针对 **测试库** `seekjournal_test`） | `3a70890ddb10 (head)` | 0 |
| OpenAPI 路径枚举 | `/api/health`(GET)、`/api/journals`(GET/POST)、`/api/journals/{id}`(GET/PATCH/DELETE) —— **无新增路由** | 0 |

后端用例分布（`pytest --collect-only`，合计 232）：

| 文件 | 用例数 | 是否连库 |
|---|---|---|
| `test_journal_schemas.py` | 37 | 否（纯内存） |
| `test_journal_update_schemas.py` | 41 | 否（纯内存） |
| `test_journal_api.py` | 21 | 是（测试库） |
| `test_journal_read_api.py` | 18 | 是（测试库） |
| `test_journal_detail_api.py` | 21 | 是（测试库） |
| `test_journal_update_api.py` | 51 | 是（测试库） |
| `test_journal_delete_api.py` | 25 | 是（测试库） |
| `test_cors.py` | 17 | 否（只读 health / 预检） |
| `test_test_database.py` | 1 | 否（只读 Engine 元数据） |

测试隔离守卫已核对：

- `tests/conftest.py` 在**导入 `app` 之前**把 `DATABASE_URL` 换成测试库，
  并在导入后断言 `engine.url.database == "seekjournal_test"`（`test_test_database.py`）；
- 每个测试用「外层事务 + `join_transaction_mode="create_savepoint"`」+ `dependency_overrides[get_db]`，
  结束时 `clear → session.close → outer.rollback → connection.close`，并复查行数与测试前一致；
- 因此上表所有连库测试都不写开发库，跑完测试库也无日记残留。

## 3. 数据库结构核对（只读）

`journals` 表实际结构（开发库，`\d journals`）：

```text
 id           | integer                  | not null | nextval('journals_id_seq')
 title        | text                     |          |
 content      | text                     | not null |
 journal_date | date                     | not null |
 created_at   | timestamp with time zone | not null |
 updated_at   | timestamp with time zone | not null |
Indexes:
    "journals_pkey" PRIMARY KEY, btree (id)
    "ix_journals_journal_date" btree (journal_date)
```

- 六个字段与 `docs/stage1-architecture.md` §14 一致；
- `journal_date` 是**普通索引**（`ix_journals_journal_date` 上没有 `UNIQUE` 标记），
  同日可存在多篇，符合 `docs/stage1.md` §7 与 §14；
- 表由 Alembic Migration `3a70890ddb10` 建立，代码里没有 `create_all`。

## 4. 功能验收矩阵（映射 `docs/stage1.md` §17）

状态口径：**通过**＝有本次真实证据；**未验证**＝本次未取到证据；**待用户确认**＝需要用户主观判断。

| 验收项（stage1.md §17） | 要求 | 验证方式 | 实际结果 | 证据 | 状态 |
|---|---|---|---|---|---|
| Web | 本地 Web 可正常打开 | 真实浏览器打开 `127.0.0.1:5173` | 页面渲染正常，标题可见 | 脚本 A `A1`；截图 `sj84-1-overview.png` | 通过 |
| Create | 可填写 Journal | UI 输入标题/正文/日期并提交 | 创建成功 | 脚本 A `B1/B7/B8` | 通过 |
| Create | title 可以留空 | 留空提交 | 数据库存 `NULL`（非空串） | 脚本 A `B1`；psql 核对 | 通过 |
| Create | journal_date 自动默认值 | 打开表单读取默认日期 | = 本机 04:00 换日规则结果 | 脚本 A `A3` + `journalDate.test.ts` 10 例 | 通过 |
| Create | 可手动修改 journal_date | 手动改日期后提交 | 提交值未被默认值覆盖 | 脚本 A `B3` | 通过 |
| Create | 可保存 Journal | POST 真实提交 | 201，记录真实入库 | 脚本 A `B1`；脚本 B `S1` | 通过 |
| Date | 04:00 前默认前一天 | 纯逻辑构造 03:59 / 00:00 | 用例通过（`journalDate.test.ts`） | 10 例断言 | 通过（纯逻辑） |
| Date | 04:00 后默认当天 | 纯逻辑构造 04:00 / 23:59 | 用例通过 | 同上 | 通过（纯逻辑） |
| Date | 边界在真实浏览器中的取值 | 页面默认日期 = 本机规则计算值 | 一致（验收时为 `2026-10-06`） | 脚本 A `A3` | 通过（浏览器，非改系统时间） |
| Date | 同一天允许多篇 | 同日创建两篇 | 两篇并存，id 不同 | 脚本 A `B4/B5` | 通过 |
| Date | 选日期时能看到当天已有 Journal | 切换日期观察提示 | 显示「该日期已有 2 篇记录」 | 脚本 A `B6` | 通过 |
| Display | title 不为空时显示 title | 主列表与详情 | 显示原始 title，不做 trim | 脚本 A `C4` | 通过 |
| Display | title 为空时显示日期 | 主列表与详情 | 显示 `journal_date` | 脚本 A `C3`、`E3` | 通过 |
| Display | 同日多篇无标题可用 (2)(3) 区分 | 主列表 | `2026-05-20` 与 `2026-05-20 (2)` | 脚本 A `C3` | 通过 |
| Display | `(n)` 与默认标题**不写入数据库** | 查数据库 `title` | 仍为 `NULL` | 脚本 A `C5` | 通过 |
| Read | 可查看 Journal 列表 | 真实 GET 列表 | 顺序 `journal_date DESC`、同日 `created_at DESC` | 脚本 A `C1/C2` | 通过 |
| Read | 可打开单篇 Journal | 列表与当天记录两处入口 → `GET /{id}` | 详情六字段命中该 id | 脚本 A `E1/E4/E5` | 通过 |
| Read | 按日期筛选 / 清除筛选 | 工具栏日期 | 只返回该日期；清除后恢复全部 | 脚本 A `D1/D2` | 通过 |
| Update | 可修改 title / content / journal_date | UI 编辑保存 | 单字段与多字段均生效 | 脚本 A `G1/G5/G8` | 通过 |
| Update | 省略字段不被改动 | 只改一个字段 | 其余字段保持原值 | 脚本 A `G1/G5` | 通过 |
| Update | 清空 title 为 NULL | 标题清空后保存 | 数据库 `title` 为 `NULL` | 脚本 A `G6` | 通过 |
| Update | updated_at 正确更新 | 真实修改后比较时间 | 后端更新时间（变新） | 脚本 A `G3/G4` | 通过 |
| Update | created_at 不改变 | 多次修改后比较 | 始终等于原值 | 脚本 A `G2/G6` | 通过 |
| Update | 无变化时 updated_at 不变 | 提交空更新 `{}` | 返回原记录，`updated_at` 不变 | 脚本 A `G7` | 通过 |
| Update | 改日期后列表 / 筛选同步 | 改到另一日期 | 原日期不再有、新日期有 | 脚本 A `G9/G10` | 通过 |
| Delete | 可删除 Journal（硬删除） | UI 确认删除 | 204 且响应体 0 字节 | 脚本 B `D3/D9` | 通过 |
| Delete | 删除后数据库中记录不存在 | 独立 API 查询 + 原生 SQL | `GET /{id}` → 404；psql 无该行 | 脚本 B `D5`；psql 核对 | 通过 |
| Delete | 只影响目标记录 | 同日兄弟 + 另一日期记录 | 六字段完全不变 | 脚本 B `D7/D8` | 通过 |
| Persistence | 关闭网页再打开仍存在 | 关闭浏览器上下文 → 新上下文 → `GET` 同 id | 六字段完全一致 | 脚本 B `F1/F2/F3` | 通过 |
| Persistence | 重启后端后仍存在（补强） | 停掉自建 8010 再启动 → `GET` 同 id | 六字段完全一致 | `GET /api/journals/2896` 前后对照 | 通过 |

**功能验收结论：以上 30 项全部取得本次真实证据，无失败项、无未验证项。**

## 5. 技术验收矩阵（映射 `docs/stage1.md` §18）

| 验收项 | 要求 | 验证方式 | 实际结果 | 证据 | 状态 |
|---|---|---|---|---|---|
| React | 可以正常运行 | 真实浏览器打开页面 | 正常渲染与交互 | 脚本 A/B 全流程；截图 | 通过 |
| TypeScript | 正常使用 | `tsc -b` | 通过（`npm run build` 退出码 0） | build 日志 | 通过 |
| Vite | 正常运行 | dev server + build | dev 正常；build 产物 233.86 kB | build 日志 | 通过 |
| React → FastAPI | React 能调用 FastAPI | 页面内 `fetch` 真实跨源 | GET/POST/PATCH/DELETE 全部成功 | 脚本 B `E5–E10` | 通过 |
| REST API | 可正常工作 | 7 条路由的契约行为 | 状态码与响应符合 `stage1-api.md` | pytest 232 + 浏览器 | 通过 |
| FastAPI `/docs` | 可查看 API | 应用已注册 OpenAPI | `/docs` 由 FastAPI 自动提供（路由枚举已确认） | OpenAPI 路径枚举 | 通过 |
| Pydantic | 完成请求验证 | 非法请求返回 422 | `content=null` / 非法日期 / 非整数 id / 缺必填 全部 422 | 脚本 B `E2` | 通过 |
| SQLAlchemy | 完成 ORM 操作 | Service 用 `Session` 读写 | CRUD 全链路生效 | pytest + 浏览器 | 通过 |
| psycopg | 正常连接 PostgreSQL | 驱动为 `postgresql+psycopg` | 连接可用（`SELECT current_database()` 与库名一致） | `app/database.py` + 验收查询 | 通过 |
| PostgreSQL | 正常持久化数据 | 关上下文 / 重启后端后仍可读 | 六字段一致 | 脚本 B `F*` + 重启对照 | 通过 |
| Alembic | Migration 可建 `journals` 表 | `alembic current/heads/check` | head 一致、无待生成迁移；表由该迁移建立 | 上述命令输出 | 通过 |
| pytest | 核心 API 测试通过 | 全量 pytest | 232 passed | pytest 输出 | 通过 |
| Docker Compose | 可通过 Compose 启动 PostgreSQL | `docker compose config` 只读检查 + 容器运行状态 | 单服务 `postgres`，`postgres:17`，仅绑 `127.0.0.1:5432`，named volume `postgres_data`，容器已运行 | `docker ps` + `compose config` | 通过（见下方限制） |
| `.env` | 不进入 Git | 检查 `.gitignore` 与 `git status` | `.gitignore` 忽略 `.env` / `.env.*`（保留 `!.env.example`）；工作区无 `.env` 被跟踪 | `.gitignore`、`git status` | 通过 |

**技术验收结论：以上 14 项全部取得本次真实证据，无失败项。**

**Compose 相关限制（必须如实说明）**：本次只做了**只读检查**与**当前容器状态**核对
（`docker compose config`、`docker ps`），**没有**为了验收去 `down`/`up` 共享的 PostgreSQL 容器。
也就是说：`compose.yaml` 的配置正确性已被检视，容器也确实在运行并持久化数据；
但「从零全新启动」这一步**本次未执行**，也没有在全新机器上验证过安装流程。

后续仅检查配置有效性时，应使用 `docker compose --env-file backend/.env config --quiet`。
上文记录的是本次验收实际执行的命令；未加 `--quiet` 的 `config` 会输出插值后的真实密码，
不要将其输出复制到聊天、Issue 或文档。

## 6. 浏览器验收证据：真实与合成的区分

浏览器验收共 **71 项断言**（脚本 A 45 项 + 脚本 B 26 项），全部通过（退出码 0）。

**真实链路证据（默认即为真）**：

- 页面、React、`fetch`、CORS 预检、FastAPI、Pydantic、SQLAlchemy、psycopg、PostgreSQL；
- 所有创建 / 修改 / 删除都真正打到 PostgreSQL（`seekjournal_test`）；
- 真实浏览器跨源（`5173` → `8010`）的 `GET 200` / `POST 201` / `PATCH 200` /
  `DELETE 204 且 0 字节`，以及 CDP 观测到的 3 次 `OPTIONS` 预检；
- 反向用例：携带未允许请求头时 `fetch` 抛 `TypeError`（预检被拒）。

**合成（非真实）状态，单独列出 —— 仅用于制造 UI 错误 / 竞态分支，不替代任何正常链路证据**：

| 编号 | 合成方式 | 验证的 UI 分支 |
|---|---|---|
| 脚本 A `F1` | `route` 延迟详情 GET（2s / 100ms） | 快速切换记录时旧响应不覆盖新记录 |
| 脚本 A `G12` | `route.fulfill` PATCH → 500 | 保存失败保留输入、留在编辑态 |
| 脚本 A `H1` | `route` 延迟 POST 800ms | 保存中按钮禁用 + 再次触发提交不产生第二次 POST |
| 脚本 A `I1` | `route.fulfill` 列表 GET → 500 | 列表加载失败显示错误与「重试」 |
| 脚本 A `J1` | `route.fulfill` 列表 GET → 500（PATCH 放行） | 写入成功与随后刷新失败严格区分 |
| 脚本 B `E1` | `route.fulfill` 详情 GET → 404 | 读取 404 显示「不存在」并给出「重新读取」 |
| 脚本 B `E4` | `route.fulfill` PATCH → 422 | 422 显示保存失败并保留输入 |

**注**：真实的 404（`GET` 与 `DELETE`）与真实的 422 都已单独用**真后端**验证过：
`DELETE` 遇到 404（脚本 B `D10`，记录被外部删除后 UI 点删除）与
四种真实 422（脚本 B `E2`）都不是合成结果。
UI 结构上会挡住非法日期，所以「由 UI 自然产生 422」这条路径不可达，
真实的 422 由后端测试与 `E2` 覆盖。

**控制台**：非合成阶段无与真实路径相关的控制台错误（脚本 A `K1`、脚本 B `G1`）。

## 7. 持久化专项

必须用**真实 POST 已提交**的记录来证明，不能用事务内未提交的数据。

步骤（脚本 B）：

1. 用**真实 UI** 创建记录（`POST` 201），记下 id（本次为 `2896`）；
2. 记录六字段（id / title / content / journal_date / created_at / updated_at）；
3. **关闭整个浏览器上下文**（不是刷新页面）；
4. 打开**新的**浏览器上下文与页面（无 localStorage / 无前端 State 继承）；
5. 在列表 DOM 中确认该记录仍在（`inDom === 1`）；
6. 用新上下文独立 `GET /api/journals/{id}` 读回，**六字段完全一致**（脚本 B `F2`）；
7. 打开详情，DOM 中的 id 与 journal_date 与 API 一致（脚本 B `F3`）。

补强（本次额外执行）：

8. **停止自己启动的临时后端 8010 并重新启动**，再 `GET /api/journals/2896`，
   六字段仍完全一致；
9. **独立数据库查询**（`psql` 直连测试库，不经 API）确认该行存在且值一致：

```text
2896|P-027895|<content md5 f817a9be…>|18|2026-06-10|2026-10-06 10:53:48.640312+00|2026-10-06 10:53:48.640312+00
```

三方一致：**DOM = API = PostgreSQL**。
localStorage / 前端 State / 合成响应均未参与该结论。

## 8. 数据保护与服务收尾

**开发库 `seekjournal`（个人操作库）**：

- 验收前后逐行快照（id / title / content 摘要 / journal_date / created_at / updated_at）**diff 为空**；
- `count = 2`，ids `[629, 1639]`；`journals_id_seq` 保持 `1639`；
- `alembic_version = 3a70890ddb10`；
- 验收期间对开发库**只读**，没有任何创建 / 修改 / 删除。

**测试库 `seekjournal_test`**：

- 验收前 `count = 0`；验收后按 id 白名单逐个清理本轮自建记录，恢复 `count = 0`；
- `alembic_version = 3a70890ddb10`；
- `journals_id_seq` 由 `2746` 前进到 `2902`：**这是 PostgreSQL sequence 不随回滚/删除回退的正常现象，不代表数据残留**；
- 未清空整库，未删除任何来源不明的数据。

**服务状态**：

- 验收自己启动的临时后端 `8010` 已停止；
- **用户既有服务未受影响**：`8000`（uvicorn）、`5173`（Vite）、
  `5432`（Docker PostgreSQL 容器 `seekjournal-postgres-1`）均仍在运行，未重启、未删除；
- 未修改真实 `.env`、未新增依赖、未生成 Migration。

## 9. 未验证项与已知限制

1. **「全新机器安装」未验证**：本次只在本机（Windows / Git Bash，Python 3.12，
   已有 `.venv` 与已预装 Chromium）执行，**没有**在干净环境重跑安装流程。
2. **Docker Compose「从零启动」未执行**：只做只读配置检查 + 当前容器状态核对，
   未 `down`/`up` 共享容器（避免影响用户数据）。
3. **前端没有自动化回归测试框架**：`npm run build` / `lint` +
   两个纯逻辑测试（`journalDate` 10 例、`journalDetail` 25 断言）是全部自动检查；
   其余前端行为靠本次浏览器人工 / 脚本验收。这符合 `docs/stage1-architecture.md` §20
   （Stage 1 前端主要人工验收）。
4. **`title=''` 的两种表示**：经由 UI 创建只会产生 `NULL`；但直接用 API `POST {"title": ""}`
   仍可写入空字符串。此时用编辑表单保存会把它归一化成 `NULL`（按「空输入框＝`null`」的既有约定）。
   这是数据层的既有自由度，不是本次验收引入的问题。
5. **`journal_date` 的解析边界**：Pydantic v2 内置 `date` 解析会接受
   `"2026-10-02T00:00:00"` 并截断为 `2026-10-02`。前端始终发送 `YYYY-MM-DD`，
   契约未要求更严格，因此未收紧。
6. **合成状态覆盖的边界**：见第 6 节的合成清单。它们只用于制造错误 / 竞态分支；
   真实 404、真实 422、真实 204 均已用真后端单独验证。

## 10. 学习验收（`docs/stage1.md` §19）—— 待用户自述与最终确认

以下**不能由本次验收代替用户回答**，标记为「待用户自述与最终确认」。
验收方只能提供数据流与自检问题作为辅助。

### 一篇 Journal 从 React 到 PostgreSQL 的数据流

**创建（POST）**

```text
[React] JournalEditor 的 useState 保存 title / content / journal_date
   ↓ 提交时 createJournal() → 原生 fetch(POST /api/journals, Content-Type: application/json)
   ↓ 浏览器先发 OPTIONS 预检 → CORSMiddleware 应答 200（Allow-Origin、Allow-Methods）
[HTTP / REST / JSON]
   ↓
[FastAPI] router.create_journal()：路径 / 请求体由 FastAPI 解析
   ↓
[Pydantic] JournalCreate 校验：content / journal_date 必填；title 可空；额外字段忽略
   ↓
[Service] create_journal()：Journal(...) → db.add() → db.commit()，失败 rollback
   ↓
[SQLAlchemy] 生成 INSERT，使用 Model 上的 default 生成 created_at / updated_at
   ↓
[psycopg] 以 postgresql+psycopg 驱动把 SQL 发给 PostgreSQL
   ↓
[PostgreSQL] journals 表写入一行，id 来自 sequence，返回生成值
   ↓ 逐层回传：Service db.refresh() → Router → JournalResponse（六字段 JSON）
[React] 用**后端返回值**更新列表 / 详情（前端不自己造 id 与时间）
```

**读取 / 修改 / 删除**

- 列表与筛选：`GET /api/journals(?journal_date=...)` → `list_journals()` 在 **SQL 里**排序
  （`journal_date DESC`、`created_at DESC`）与等值筛选，不在 Python 侧过滤；
- 详情：`GET /api/journals/{id}` → `get_journal()` 按主键取，未命中 → Router 转 404；
- 修改：`PATCH /api/journals/{id}` → `JournalUpdate.model_dump(exclude_unset=True)`
  只取出**本次真正提交**的字段 → 赋值 → commit；SQLAlchemy 的 `onupdate` 刷新 `updated_at`；
  空更新直接返回、不写库；
- 删除：`DELETE /api/journals/{id}` → `delete_journal()` 按主键硬删除，未命中返回 False → 404，
  成功返回 204 与**空响应体**。

### Alembic 与测试库的作用

- **Alembic / Migration**：数据库表结构**只**通过 Migration 建立（本项目是
  `3a70890ddb10_create_journals_table.py`），代码里没有 `create_all`。
  `alembic/env.py` 复用 `app/database.py` 的 Engine 与 `Base.metadata`，
  所以「Model 声明的结构」与「数据库实际结构」用 `alembic check` 就能比对。
- **独立测试库 `seekjournal_test`**：API 测试写的是**另一个数据库**，
  开发库 `seekjournal` 里的真实日记不会参与测试；`conftest.py` 在导入应用前切换库名，
  测试结束后回滚外层事务，测试库里不留日记数据（sequence 会前进，属正常）。

### 建议的自检问题（请用自己的语言回答）

1. 什么是 React Component？`App.tsx` 里的 `useState` 保存了什么？它和数据库里的数据有什么区别？
2. 点「保存」以后，数据依次经过了哪些环节？哪一层负责「字段是否合法」，哪一层负责「写入事务」？
3. 为什么「无标题显示日期」和「同日 (2) 编号」放在前端而不是数据库？
4. 为什么要有 Alembic Migration，而不是在代码里直接 `create_all`？
5. 为什么测试要用另一个数据库、还要用「外层事务 + savepoint」？
6. `GET` 与 `PATCH` 在「找不到记录」时分别返回什么？为什么空 JSON `{}` 的 PATCH 不报错？

> 上述问题的答案需要**用户自己给出**。本次验收不替用户回答，也不因为代码通过就宣布学习验收通过。

## 11. 用户最终验收事项

需要用户确认的内容（本次验收不做判断）：

1. 是否接受 Stage 1 的**功能**与**技术**验收结论（本文档第 4、5 节）；
2. 是否接受 `title=''` 与「`journal_date` 接受带时间后缀字符串」这两条**已知数据自由度**
   （第 9 节第 4、5 条），还是希望后续收紧；
3. 详情里额外显示的 `id` 行是保留还是移除；
4. 学习验收：由用户自述第 10 节的自检问题；
5. 是否批准把 `task/s01-t08-journal-frontend` 上的 8.1 / 8.2 / 8.3 合入 `main`。

## 12. 结论

- **功能验收**：30 项，全部通过（有本次真实证据）。
- **技术验收**：14 项，全部通过（Compose「从零启动」与「全新机器安装」为已知未验证项）。
- **浏览器验收**：71 项断言通过，真实 / 合成证据已分别标注。
- **持久化专项**：关闭上下文重开、重启后端、独立 `psql` 三方一致，通过。
- **数据保护**：开发库完全未变；测试库恢复空白基线。
- **学习验收**：**未完成**，待用户自述。

> **Stage 1 是否「已获用户最终验收」——由用户决定，本文档不作宣布。**
