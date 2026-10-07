# SeekJournal — Stage 1.5 / Pre-Stage-2 Bug Fix Plan

> 2026-10-07。Goal：修复 Stage 1 实际体验问题，再进入 Stage 2。
> 本轮仅编写计划。以下任务均未执行；没有修改源码、依赖、测试或 Migration。
> Architecture：保留 React local State + fetch → FastAPI/Pydantic → Service → SQLAlchemy → PostgreSQL。
> 本文件是 Stage 1.5 的需求、契约修订与 Task 权威来源；覆盖 Stage 1 文档中的旧输入规则和编号实现要求。历史验收不重写。

## 1. 现状核对（本轮只读证据）

| 项 | 结果 |
|---|---|
| 分支 | `task/s02-t00-create-stage2-task` |
| HEAD | `de97e714b11d6fd5b217b1d39a2291a6a4a3bbb0` |
| 初始工作区 | 已跟踪文件无改动；未跟踪 `启动指令.md`，本轮保留 |
| Stage 1 | Journal CRUD、04:00 默认日期、同日多篇、日期筛选、PostgreSQL 持久化代码存在；普通删除仍硬删除 |
| Model | `journals` 六字段；title 为 Nullable Text，content 为 Not Null Text，journal_date 普通索引；时间由 Python default/onupdate 维护 |
| Schema/Router/Service | 已有 Create/Update/Response；完整 CRUD；空 PATCH 返回原值；相同值由 ORM 避免 UPDATE；写失败 rollback |
| Alembic | 仅初始 revision `3a70890ddb10`；本轮 heads/current 均为 head，check 无新操作；两库 revision 一致 |
| 前端 | App、JournalEditor/List/Detail；local State、fetch、AbortController；无分页/路由/状态框架/Markdown 渲染 |
| 历史验收 | `stage1-acceptance.md` 记录 232 个后端测试、71 条浏览器断言；本轮没有重跑该功能验收，不作为当前新结果 |
| 旧数据聚合 | 开发库 10 行：标题 >80 有 1 行、正文 >50,000 有 1 行、纯空白正文有 4 行；测试库 0 行。本轮只查聚合，不记录真实内容 |

文档与代码/新要求的差异：

- README/Agent 仍写当前 Stage 1；改为 Stage 1 已完成、Stage 1.5 待执行、Stage 2 规划中，不能写成已实现 Stage 2。
- `JournalList.tsx` 按倒序列表遍历计数，新记录成为编号 1，旧记录随之改号。
- Stage 1 Schema/前端确实允许空正文、不限长度，这是当时契约；本轮明确批准改为新规则，不将历史验收改写为失败。
- **正文 CSS 已有三行 clamp**（`App.css`），用户观察的“没有截断”需实际复现；标题未做一行省略。不能计划一个已经存在的全新正文截断功能。
- Stage 1 详情仅显示日期、没有编号，这是历史契约；Stage 2 所有入口需一致标题，见 S2-T02。
- 根 `AGENTS.md` 尚为 Stage 1 规则，本轮授权覆盖 docs/必要 agents 文件；进入开发前按下方检查清单同步根阶段导航，不能默默忽略其模型/API/Stage 2 批准限制。

## 2. 修订需求与 API 边界

### Bug 1：无标题编号方向

按同日无标题记录的 `created_at ASC, id ASC` 分配序号；列表继续倒序。手工 title 不计数。
既有 `NULL` 和空字符串均视作无标题；纯空白但非空字符串仍是手工标题，不新增自动 trim 规则。
主列表与“当天已有记录”同一条 id 的编号一致，新增第四条后原三条不变。
Stage 1.5 利用当前返回的完整日期数据计算；不得在 Stage 2 把该函数直接套在分页数组上。
Stage 2 后端提供统一显示标题元数据，完整日期范围计算，见 `stage2-architecture.md`。
删除/改日期/改标题后的稳定性没有获得确认，登记在 `stage2.md` P3，不新增永久编号字段。

### Bug 2 / Bug 4：标题与正文验证

POST 与 PATCH 实际提交字段使用同一规则：title 可空、最多 80；content 有非空白字符、最多 50,000。
长度按原始字符串 Unicode 码点数；正文只检查 trim，不将 trim 结果写入数据库。
前端创建/编辑均提示字段错误；后端请求 Schema 强制返回标准 422，无效请求不写库。
`content=null` 仍非法；PATCH 省略 content/title 不动该字段；`title=null` 仍可清空。
响应 Schema不收紧历史值；无变化、空 PATCH、系统字段忽略、合法日期解析边界沿用已有行为。

### Bug 3：列表预览

标题一行省略、正文三行省略；打开详情显示完整内容。
保留数据库 Text 完整存储；不用 substring 截短保存值。
先验证既有三行 CSS 在长行、多换行、窄屏的实际结果，再修改必要样式；不做整体 UI 重构。

### Bug 2 附带：详情标题显示（T2 补充规则）

Stage 1 验收记录指出：当 `title` 是**空字符串**（历史数据或直接 API 写入）时，
详情面板按旧规则 `title ?? journal_date` 会显示成一个空行。
Stage 1.5 明确这一显示行为：详情标题对 `null` **和**空字符串都回退显示 `journal_date`，
与列表的「无标题」判定保持一致。

- 只改**显示**，不改数据：数据库里的空字符串标题保持空字符串，不批量归一化成 `NULL`；
- 非空标题（含纯空白的手工标题）原样显示，不做 `trim`；
- 不增加详情编号（编号仍然只是列表上下文的产物）。

### 旧数据策略

不改旧记录、不删空正文、不截断超长字段、不为旧内容追加新数据库 CHECK。
读取保持完整。仅提交 Folder、标题或日期时，不因未提交的旧超长/空正文拒绝；用户实际重新提交非法正文时返回 422。
前端对照 PATCH 请求体校验待提交字段；展示旧非法值的提示可以存在，但不能强迫无关字段更新一起清洗。
用户之后如要批量整理旧数据，必须另开任务授权；本期没有数据清理功能。

## 3. 全局执行约束与 DoD

- 一次执行一个已授权 Task。先记录最小复现/边界测试，再实现，再检查实际输出；各 Task 可独立 Review、Commit。
- 禁止 Stage 2 功能、架构重构、新库、Model/表结构变更。本方案 **不需要 Migration**。
- 所有写测试用 `seekjournal_test`，开发库只读；不能清库让测试通过。服务只启停本任务自建实例。
- 不删除 Stage 1 测试。允许修改“空正文合法”等已被新规则替代的预期，并添加对应无写入反例。
- 每 Task 完成报告：文件、行为、测试命令/退出码/实际结果、真实/合成证据、剩余决策、1～3 个知识点。
- DoD：目标通过测试与人工验收、无范围扩张、旧数据不变、Lead Review 通过；最终用户验收与 Commit 按协作规则单独进行。

## 4. 执行前检查清单（并入 T1 开始前，不单独计 Task）

- 阅读本文件与 Stage 1 权威文档，确认只执行当前获授权的 Task；Stage 2 的 P1/P2/P3 不阻塞本阶段最低修复。
- 只读记录 branch、HEAD、工作区、两库 revision 与测试库基线；已有改动/数据先辨明来源，不覆盖、不清库。
- 在测试环境复现“旧三条→新增一条”编号变化，验证现有正文 clamp，记录浏览器与窗口尺寸。
- 明确开发库保护与测试写入隔离；本阶段不生成 Migration、不安装依赖、不清洗旧 Journal。
- 根 `AGENTS.md` 的阶段导航同步已由用户明确授权：T1 完成「Stage 1 已完成 / 当前 Stage 1.5 /
  Stage 1.5 必读入口」的最小同步，T2 把授权文字从 T1 更新为 T2。
  未获授权时，Developer 不能自行解除其中的模型 / API / Stage 2 批准限制。

执行顺序：检查清单 → S1.5-T1 → S1.5-T2（包含阶段整体验收）。两项可分别 Review、Commit。

## 5. S1.5-T1 — Journal 编号与列表预览修复

1. **Goal**：新增只给新记录新号，并补齐标题一行/正文三行预览。
2. **Scope**：`frontend/src/components/JournalList.tsx`、`frontend/src/App.css`；抽出 `frontend/src/utils/journalTitles.ts` 及对应纯逻辑测试（拟新增）。
3. **Out of Scope**：后端/API/Model、永久编号、分页、整体 UI。
4. **依赖**：执行前检查清单完成。
5. **模块**：主列表与当天已有记录共用编号和预览；详情保留完整正文。
6. **DB/Migration**：无。
7. **后端**：不改 API、不改排序。
8. **前端**：复制数组计算创建升序编号映射，再按原倒序数组渲染；不改传入对象/title。标题单行省略；先复现再修必要正文 clamp 样式；详情不截断，窄屏不挤坏布局。
9. **测试**：乱序输入、同时间 id 打破并列、手工标题、两个日期、NULL/空字符串、新增后旧标题不变、输入不被原地排序；build/lint/既有纯逻辑回归。预览用真实浏览器验证，不写镜像 CSS 的单测。
10. **人工验收**：三篇无标题与一篇手工标题，主列表/当天记录编号一致；再新增，前三篇号与倒序不变，查库 title 未写默认值。短/长标题、连续长行/多段正文、桌面/窄屏均符合一行/三行，详情完整。
11. **步骤**：检查清单 → 最小编号回归 → 编号映射与必要 CSS 修正 → 纯逻辑/构建/lint → 浏览器演示。
12. **DoD**：编号与预览验收通过，原始数据未被截断；明确编号函数依赖完整数据，不能供 Stage 2 当前页计数。

## 6. S1.5-T2 — 前后端输入校验与 Stage 1.5 整体验收

1. **Goal**：创建和修改强制 title/content 新规则，保留 Markdown/旧数据，并完成四个 Bug 的整体验收。
2. **Scope**：`backend/app/journal/schemas.py`、相关 Schema/API tests；`JournalEditor.tsx`、`JournalDetail.tsx`、`journalDetail.ts`；拟新增 `frontend/src/utils/contentValidation.ts` 与纯逻辑测试。
3. **Out of Scope**：数据库 CHECK、VARCHAR 改造、数据清理、Daily/Insight/Markdown 渲染。
4. **依赖**：T1 验收通过。
5. **模块**：Create/Update 请求校验与表单字段错误；Response 保持可读旧值。
6. **DB/Migration**：无，继续 Text。
7. **后端**：POST/PATCH 非法值 422 且无写；省略与 null 区分；不把验证用 trim 值存回。
8. **前端**：新建校验全部字段，编辑校验实际待提交字段；空白正文和超长显示提示，失败保留输入；不能只依赖 HTML maxlength。
9. **测试**：title 0/80/81、content 空字符串/空格/Tab/换行/49,999/50,000/50,001、中文/emoji、Markdown 缩进/尾空格往返；POST/PATCH；旧非法字段未提交仍可改其他字段；空 PATCH/相同值/显式 null/只提交系统字段回归。随后运行全量后端回归、前端 build/lint、既有与新增纯逻辑测试。
10. **人工验收**：前端与直接 API 均拒绝纯空白/超长，合法边界可保存；详情完整。复验新增不改旧编号、标题一行/正文三行、50,000 正文、桌面/窄屏、持久化与两库隔离；浏览器写入仅测试库。
11. **步骤**：更新被新规则替代的测试并补边界反例 → Schema/表单实现 → 指定测试 → 全阶段回归 → 记录真实证据 → Lead Review → 用户验收。
12. **DoD**：前后端规则一致、内容原样保存、旧值可读、开发库无变化；四个 Bug 均有验收证据，Stage 1.5 完成后才放行 Stage 2。

## 7. 精确验证命令

在 `backend/`，每个命令分别执行并记录退出码；下面是后续任务命令，本轮未执行 pytest：

```powershell
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_journal_schemas.py tests/test_journal_update_schemas.py tests/test_journal_api.py tests/test_journal_update_api.py
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests
.\.venv\Scripts\python.exe -B -m alembic current
.\.venv\Scripts\python.exe -B -m alembic check
```

在 `frontend/`：

```powershell
npm run build
npm run lint
node --experimental-strip-types src/utils/journalDate.test.ts
node --experimental-strip-types src/utils/journalDetail.test.ts
node --experimental-strip-types src/utils/journalTitles.test.ts
node --experimental-strip-types src/utils/contentValidation.test.ts
```

新测试文件到对应 Task 才创建。期望各命令退出 0；测试数量按实际结果记录，不要求沿用 232。浏览器验收指向连接 `seekjournal_test` 的临时后端，不覆盖真实 `.env`。

## 8. 执行记录（Stage 1.5 实际结果）

> 本节是**执行之后**补记的实际结果，供 Review / 验收对照，不是事前计划。
> 历史验收记录（`docs/stage1-acceptance.md`）不重写。

### S1.5-T1（已完成并提交）

- 交付：抽出 `frontend/src/utils/journalTitles.ts`（编号纯函数）与对应纯逻辑测试；
  `JournalList.tsx` 改为查表渲染；`App.css` 标题单行省略。
- 结果：编号按同日无标题记录的 `created_at ASC`、`created_at` 真正相同时 `id ASC`；
  新增较晚记录不改动旧编号（浏览器按记录逐条核对，旧记录 `changed` 全为 `false`）。
  正文三行 clamp 复现为**本就生效**，则未改 CSS。
- 测试：`npm run build` / `npm run lint` / 三个既有纯逻辑测试全部退出 0。
- 提交：`c08db51 fix: stabilize journal numbering and clamp list previews`。

### S1.5-T2（已实现，待独立验收）

- 交付：
  - 后端 `backend/app/journal/schemas.py`：`JournalCreate` / `JournalUpdate` 增加
    `title` ≤80 码点、`content` 非空白且 ≤50,000 码点校验；
    校验只作用于**实际提交**的字段（省略字段不参与），`JournalResponse` **不加**校验，
    保证数据库里的历史超长 / 空白记录仍能正常读取。
  - 后端测试：`test_journal_schemas.py`、`test_journal_update_schemas.py`、
    `test_journal_api.py`、`test_journal_update_api.py` 补边界、无写入与旧数据用例
    （旧数据一律用 ORM 直接在测试库里合成，不修改开发库）。
  - 前端新增 `frontend/src/utils/contentValidation.ts` 与测试；`JournalEditor` 提交前校验
    全部待创建字段、`JournalDetail` 只校验本次 PATCH 实际提交的字段；
    `journalDetail.ts` 增加详情标题显示修复（`null` 或空字符串 → `journal_date`）与测试。
- 关键结论：前后端空白判定与码点计数使用**同一份字符集合、同一套口径**；
  PATCH 只校验本次提交字段，因此旧超长 / 空白记录仍能改其它字段，
  只有真的重新提交非法值才返回 422。
- 无 Migration、无 Model 变更、无 API 路由或六字段响应变更；未安装依赖、未引入测试框架。

> 仍未验证 / 未授权（留给独立验收与后续）：删除、改日期、改标题后的编号**永久**稳定性
> 仍未获得确认（登记在 `stage2.md` P3），本阶段不新增永久编号字段；
> `journalTitles.buildDisplayTitles()` 依赖完整数据，**不能**直接用于 Stage 2 的当前页计数。
