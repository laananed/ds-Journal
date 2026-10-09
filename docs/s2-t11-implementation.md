# S2-T11 实施交付（待 WorkBuddy 独立测试）

2026-10-08，Codex Lead + Developer。本记录是实际实施与自测结果，不代替独立验收或 Stage 2 整体验收。

## 基线、权限和文件责任

- 唯一开发目录：`C:\Programme\demo\SeekJournal`。未新增 Worktree，没有并行写入本目录的子 Agent。
- 首轮检查在 `task/s02-t09` / `c5706a4b025cbd8df908978f43c8d6a99d021e28`，工作树干净；T10 提交树当时没有 TrashPage，因此暂停，没有从旧基线实施。
- 用户要求提交 T10 并重试后，复核发现 T10 已提交：`4fc9682669b3d57a060b032f897b7971ff437e99`，标题为 `feat: complete S2-T10 Trash UI with restore, permanent deletion and 404 refresh`，T10 工作树干净。无需重复提交。
- 实际核对已提交的 TrashPage：GET404 调用 handleGone → onTargetGone → refreshList；已提交 App 接通 Trash/Folder，Inbox/Insight 的 initialOpen 和统一 Dirty 导航存在。
- 主目录执行 `git switch -c codex/s02-t11-search task/s02-t10-trash-ui`，退出 0。
- **T11 起始/结束 HEAD 均为 `4fc9682669b3d57a060b032f897b7971ff437e99`**，分支 `codex/s02-t11-search`，T11 留为未提交 diff。没有 main 合并、reset、其他工作树切换或整目录覆盖。
- Codex 本轮独占实施；交付后停止修改主目录，WorkBuddy 后续在同一目录独立测试。

## 修改文件与最终行为

| 文件 | 责任 |
|---|---|
| backend/app/search/__init__.py、schemas.py、service.py、router.py | 原始 title/content 子串搜索、跨类型投影、排序/count/分页与 GET 参数验证 |
| backend/tests/test_search_api.py | 46 例真实 PostgreSQL 契约测试，复用固定测试库 fixture |
| backend/app/main.py | 仅新增 Search Router 导入及注册 |
| frontend/src/api/search.ts、types/search.ts、pages/SearchPage.tsx | 查询、最小筛选、分页、状态、旧请求取消、失效目标清理 |
| frontend/src/App.tsx | 小型搜索条件状态、Search 入口；Folder/Search 共用现有跨模块打开接口 |
| backend/README.md、frontend/README.md | 必要搜索运行说明 |
| docs/stage2-tasks.md、本文 | 本轮实际执行记录，历史验收不改写 |

没有 Model/Migration、依赖、API 契约、生产 CORS、真实 .env、测试库选择机制或架构层变更。没有 T12/T13、AI/FTS/索引/高级表达式/日期或 Folder 名搜索。

`GET /api/search?q=...&type=all|journal|inbox|insight&page=N`：

- q 省略/纯空白返回空分页，保留请求页码，不查全库。连续空白分词，每词 title/content OR、各词 AND；重复词可去重。
- 中文子串、英文 ILIKE 忽略大小写；先转义反斜杠，再转义 `%`/`_`，通过 SQLAlchemy 绑定参数执行。
- 搜索原始 title/content，自动 display_title、业务日期、Folder 名不参与匹配。
- Journal/Insight 仅有效行；Inbox 查询现存行，不用未启用 deleted_at，响应 deleted_at 为 null。
- UNION ALL 后在数据库统一 count、`updated_at DESC, Journal→Inbox→Insight, id DESC` 排序与固定 20 条分页。非空搜索两条查询，无逐项查库；空搜索零查询。
- Journal 调用现有完整日期编号子查询与 build_display_title，编号包含未匹配、其他 Folder 和软删除现存行。
- GET 不 flush/commit，no_autoflush 防止测试复用 Session 时带入 pending 写入。

前端：

- 关键词/类型改变回第 1 页；App 保留搜索条件，详情/编辑/Trash 操作后返回 Search 会重新查询，越界回最近有效页。
- 区分未输入、无结果、加载、请求失败；支持重试/重新搜索。AbortController 取消旧列表和目标读取，迟到响应不覆盖当前结果。
- 全卡片使用 type+id。点击时读取对应普通详情；404 清空过期结果并刷新，成功后由现有模块读取自己的真实详情。
- 上述方式对单次成功点击会做一次目标读取和一次模块详情读取，避免为预加载而改动已有模块；没有列表逐项读取。
- 共用 App.navigate 的 Dirty/busy 检查；保留 Daily、Folder、各模块分页和保存失败输入。

## 实际验证命令与结果

所有后端 pytest 同一时刻仅一个流程，fixture 实际固定连接 `seekjournal_test`。各命令独立执行。

| 目录/命令 | 退出码与实际结果 |
|---|---|
| backend：`.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_search_api.py --tb=short`（实现前） | 1；46 failed in 2.05s，缺失接口导致 404 |
| backend：`.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_search_api.py` | 0；46 passed in 2.76s |
| backend：`.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests` | 0；756 passed in 31.95s |
| frontend：`npm run build` | 0；TypeScript/Vite 构建成功，43 modules |
| frontend：`npm run lint`（正常本机权限） | 0；无告警 |
| frontend：`Get-ChildItem .\src\utils -Filter *.test.ts \| ForEach-Object { node --experimental-strip-types $_.FullName; if ($LASTEXITCODE -ne 0) { throw "测试失败：$($_.Name)" } }` | 0；10 份、235 项全部通过 |
| backend：`.\.venv\Scripts\python.exe -B ..\.workbuddy\s2-t11-codex\qa.py setup/start/seed`（逐条） | 均 0；只准备 UI 专属库、启动本轮进程并记录自建对象 |
| backend：`.\.venv\Scripts\python.exe -B ..\.workbuddy\s2-t11-codex\http_checks.py` | 0；42 条实际 HTTP/独立 DB 断言 |
| 主目录：`git diff --check` | 0；仅正常 LF→CRLF 提示，无空白错误 |

纯逻辑数量：contentValidation 63、dirtyState 11、folderSelect 11、inboxDraft 34、insightDraft 34、journalDate 10、journalDetail 36、journalTitles 20、pagination 11、trashFeedback 5。

46 例搜索测试覆盖空白/省略 q、中文/大小写/跨字段 AND/重复词、字面 `%/_/反斜杠`/SQL 文本、三类各 23 条（含同数字 id）统一排序分页、超范围、非法参数、完整日期编号、普通投影一致、软删/恢复/永删/Inbox 硬删、原始字段范围、GET 零写与常数查询数。

## 真实 UI/HTTP 与故障注入证据

- 真实浏览器链路：`127.0.0.1:5178 → 127.0.0.1:8018 → seekjournal_t11_ui_test`。实际 DB 名、M3 revision 和四表空白基线先确认。仅临时 QA 包装允许 5178 CORS。
- HTTP 创建 69 条混合样例、4 条特殊样例和一个 Folder，均逐条记录 typed IDs。额外 HTTP 生命周期对象也记录到 manifest。
- 浏览器 **31 条断言**：69 篇/20 条/4 页；类型/关键词回第一页；末页 3 条；三类型真实详情，Journal/Inbox 相同数字 id 不撞；Dirty 取消保留/确认离开；条件保留；真实 GET404 清理；500/重试；内容改动后旧匹配消失与新匹配出现；保存失败保留输入；软删隐藏/Trash 恢复重现/永删后重新查询消失；末页删除后回第 1 页；Daily 与 Folder 混合打开保持可用。实际画面已在本轮浏览器工具中查看。
- 临时包装将旧 T11SLOW 请求延迟 2 秒。日志中 FAST 200 在 `1791465907.912781` 完成，SLOW 200 在 `1791465909.9010525` 完成；两者完成后页面仍显示 FAST，没有 SLOW 卡片。
- 搜索 500 和详情 PATCH500 仅由 QA 包装注入；真实成功行为、真实软删导致的 GET404 和注入故障分开记录。
- HTTP/DB **42 条断言**用独立连接观察实际提交：Journal/Insight 软删与恢复时间/全部列/Folder 保持；恢复重新命中；永久删除 204 空体、物理行不存在；Inbox 硬删消失/恢复类型 422。69 条所有页拼接顺序与独立 SQL 结果一致。

## 数据、环境和服务收尾

- `seekjournal_test`：M3 `18ecf7e09da6`，本轮前后四业务表均 0。
- `seekjournal_t11_ui_test`：本轮获授权建立并应用已有初始→M1→M2→M3；前后四表均 0。清理只按 manifest 自建 typed IDs，先文件后 Folder；未清空不明数据，未删库。
- 个人库 `seekjournal`：M2 `a8d98342e603`；Journal 13、其余 0；摘要 `7e27c560595b1e7a83b96bd8439fd06a` 和 sequence `[1651,true]` 前后一致，全轮只读。
- `.env`（前/后端存在状态及内容）、requirements、venv 配置、package.json/lockfile 前后指纹一致；未安装/升级依赖，未启动 Compose。
- 本轮服务原 PID53172/36936、包装修正重启后 PID49356/52676 都已停止。5178/8018 无监听。
- 原 5173 PID40152、8000 PID39412、5432 PID28156 保持不变。
- T11 未 commit/merge/push/tag；没有删分支或清理工作树。报告保存后停止修改主目录，等待 WorkBuddy 接手。

实施期间的环境/QA 问题均未掩盖：默认沙箱下 lint 异常扫描 node_modules、退出 1，正常本机权限下原命令退出 0，未改规则；QA500 包装最初位于 CORS 外层导致网络错误，调整临时包装后复核 HTTP500；清理首轮比较因 JSON 列表与内存元组类型差异退出 1，逐字段只读证明真实值一致后统一序列化，再次 cleanup 退出 0。均不是产品代码测试失败。

## 复跑与 WorkBuddy 交接

明确绝对目录：`C:\Programme\demo\SeekJournal\.workbuddy\s2-t11-codex`（忽略的 QA 产物，不提交凭据/helper）。

- `run-checks.ps1`：用户指定后端局部/全量、前端 build/lint/utils 命令，串行保存各自日志及退出码；正常本机权限运行。
- `qa.py`：backend 目录用 venv Python 逐条执行 setup、start、seed、status、cleanup。已完成上一轮时 setup 自动归档旧 manifest/HTTP/browser 证据，拒绝未收尾或非空基线。
- `t11_backend.py`：临时 CORS/延迟/500 包装，生产不导入。修改 `faults.json` 可设置 `delay`、`fail_queries`、`fail_paths`。
- `http_checks.py`：seed 后可重复运行真实 HTTP/DB 验证；每次新增 ID 均进入 manifest 供精准清理。
- `browser-smoke.js`：使用 cua_repl 的可复跑核心浏览器步骤；详细附加手工流程见本文，不能把示例脚本数量当作完整 31 条实际验证。
- `stop.ps1`：主目录执行，仅停止 manifest PID 且实际命令行匹配本轮服务；再运行 cleanup。
- `manifest.json`、`http-checks.json`、`browser-checks.json`、`http.jsonl`：本轮实际数据库/环境指纹、typed IDs、进程、42/31 条证据和 HTTP 时序。
- `handoff.md`：供用户直接转交 WorkBuddy 的独立测试要求。

WorkBuddy 需先比对实际 HEAD 与上列起始 hash，审查未提交 diff；不切分支、不改变基线、不自动提交/整合，不在 Codex 实施期间并发写入。若发现产品缺陷先报告，不顺手扩大 Task。

## 风险、未验证项和学习点

- 本报告是实施者验证，WorkBuddy 独立审核尚未执行；用户最终验收与 T11 提交/整合未完成，不宣布 Stage 2 完成。
- P3 动态显示编号沿用：永久删除后可能重编号；type+id 才是对象身份。
- 搜索不做快照分页，数据变动后重新查询；契约接受此行为。T12/T13 未实施。
- 学习点：每词两个字段 OR、各词 AND 的 SQL 条件；LIKE 用户通配符必须先转义再参数化；UNION ALL 后全局分页与完整编号投影；取消过期请求防止旧结果覆盖当前条件。
