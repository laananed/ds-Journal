# S2-T04 实施与独立验收记录

日期：2026-10-08。结论：**T04 后端独立验收 PASS，可以整理并提交本任务 commit；本轮未提交、合并或集成。**
本记录是当前代码/测试环境快照，不代表 Inbox Web 或完整 Stage 2 完成，也不授权个人开发库升级。

## 1. 基线、角色与范围

- 工作树：`C:\Programme\demo\SeekJournal-T04`。
- 分支：`task/s02-t04-inbox-api`。
- 起始和最终HEAD：`01bf8a86a875332b590ef6e5c0f0d087ac44c50b`，标题 `feat: add journal pagination, display titles and soft deletion`。
- 实施前重新核对三个仓库tracked/untracked均干净；测试库四表0、M2 `a8d98342e603`。
- 实施Agent B / implement_t04；独立验收verify_t04；Lead负责共享规则、范围、最终数据及服务审计。
- 仅Inbox后端、相关测试与新M3；未做前端、Inbox→Journal、AI、日志、Trash/Restore/Search或后续业务。
- Journal/Insight软删除规则不变；Inbox普通/当日Daily/往日Daily全部硬删除。

## 2. 实施文件（12份，Agent B负责）

以下相对本工作树：

| 文件 | 原因 |
|---|---|
| backend/app/inbox/schemas.py（新增） | 创建/修改、80/50,000码点、完整响应和分页/Daily envelope |
| backend/app/inbox/service.py（新增） | CRUD、筛选分页、Daily身份、唯一冲突映射、事务与硬删除 |
| backend/app/inbox/router.py（新增） | HTTP接入，静态/daily优先，404/409/204 |
| backend/app/inbox/models.py | M3索引metadata；deleted_at保留未用，无列删除 |
| backend/app/main.py | 仅注册Inbox Router |
| backend/alembic/versions/18ecf7e09da6_add_daily_inbox_unique_index.py（新增） | 新线性M3，只新增Daily唯一索引 |
| backend/tests/test_inbox_schemas.py（新增） | 省略/null/空串、空白、Unicode与PATCH提交边界 |
| backend/tests/test_inbox_api.py（新增） | 输入/原样存储/分页排序/时间/Folder/硬删除 |
| backend/tests/test_daily_inbox_api.py（新增） | 零写GET、身份不依赖标题、并发唯一性与重建 |
| backend/tests/test_inbox_service.py（新增） | 写失败rollback、Session继续、其他完整性错误不误判409 |
| backend/tests/test_stage2_migrations.py | 隔离验证从临时数据库改为本库临时schema，旧值/旧迁移/public保护 |
| backend/README.md | API、M3、命令与本轮数据库边界 |

Lead独占的共同文件：AGENTS.md、README.md、三份agents、四份Stage2权威文档及本次两份验收记录。
同一版本同步三树；实施者没有维护另一版本。

## 3. 已确认契约的实现

POST省略title存入客户端inbox_date日期标题；显式null/空串原值保存，display_title回退日期而不写回title。
纯空白非空标题不trim、原样保存、最多80码点；正文统一空白集合校验、最多50,000码点，保存原始Markdown。
PATCH仅title/content/folder_id，省略不变，创建身份与系统字段按extra=ignore不可修改；空/相同PATCH时间不变。
Daily由inbox_date+is_daily识别，改名/清空/移动不变，读取missing/active零写入。
全部Inbox DELETE物理删除、204零字节；随后详情/PATCH/重复DELETE404；删除Daily释放唯一日期，可同日重建。
deleted_at列仍在M2模型与数据库，服务不赋值、不筛选、响应恒null。无Trash或恢复入口。
Folder校验与提交字段同事务，写失败rollback；只把指定Daily唯一冲突映射409，不吞其他数据库错误。

## 4. 实际测试命令与独立证据

在本树backend/，使用既有 .venv，各命令实际退出0：

```powershell
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_inbox_schemas.py tests/test_inbox_service.py tests/test_inbox_api.py tests/test_daily_inbox_api.py tests/test_stage2_migrations.py
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests
.\.venv\Scripts\python.exe -B -m alembic heads
.\.venv\Scripts\python.exe -B -m alembic current
.\.venv\Scripts\python.exe -B -m alembic check
```

| 独立执行 | 实际结果 |
|---|---|
| 指定测试 | 105 passed in 10.01s，退出0 |
| 全量后端 | 481 passed in 19.29s，退出0 |
| heads/current | 单head 18ecf7e09da6，两者一致 |
| check | No new upgrade operations detected，退出0 |
| 新独立HTTP stdout脚本 | 39检查通过，created_ids=34，退出0 |
| git diff --check | 退出0，只有正常LF/CRLF提示 |

实施者105/481与82次HTTP另作自测记录，不替代上表独立执行。
真实HTTP涵盖省略/null/空串/纯空白标题、80emoji与50,000正文、非法输入、原样往返、Daily改名清空、
并发201/409、PATCH时间、非法Folder原子回滚、三类硬删除/404/同日重建、20条分页排序/total。
故障注入测试明确属于合成异常，真实HTTP与两个独立Session并发另外取得证据。

独立摘要：`C:\Users\Free\AppData\Local\Temp\seekjournal_t04_independent_acceptance_summary_20261008.md`。
有效HTTP输出：`C:\Users\Free\AppData\Local\Temp\seekjournal_t04_verifier_http_stdout_20261008.log`，逐条event=PASS与SUMMARY，SHELL_EXIT=0。
该摘要的105/481/heads/current/check是独立验收已执行工具结果，不引用实施者日志。
实施日志另为TEMP中的seekjournal-t04-pytest-full.log、seekjournal-t04-pytest-targeted.log、seekjournal-t04-http-evidence.py/.log。

QA纠错：并发fixture的generator断言位置改为finally后重新通过；HTTP临时脚本转义/参数错误、误创建id1004后精确删除；
Start-Transcript没有记录Python stdout，因此仅补跑真实HTTP并显式保存stdout/真正断言，不重复105/481。
旧transcript只作脚本命令记录，不声称包含实际PASS输出。有效结论采用新stdout证据。
未发现需产品代码修复的独立验收缺陷。

## 5. Migration与数据库保护

- M3 `18ecf7e09da6`，down_revision=`a8d98342e603`；旧初始/M1/M2三份Migration与HEAD一致。
- 唯一索引 `uq_inboxes_daily_date`，inbox_date，谓词`is_daily = true`；没有deleted_at条件。
- 本轮仅seekjournal_test的public升级M3；个人库与T03库未升级。
- 迁移验证仅在seekjournal_test内本轮独占s2t04_migcheck_<pid>_<uuid> schema；URL search_path与每次探针确认库/schema。
- 从base→Stage1→M1→M2→M3，8条合成旧Journal六字段逐步保持；不新建其他数据库、不改配置层、不清public表。
- fixture结束只清自己schema，public摘要/revision保持。Lead最终核对临时schema0、四表0。
- HTTP只按自己创建的typed IDs逐条清理，不清不明数据或reset sequence；Inbox无非空deleted_at记录。
- Lead个人库起止全行摘要/revision相同：13篇Journal，M2，sequence1651；无私人正文输出。
- 11份env/helper/依赖清单指纹未变，没有安装或升级、没有Compose操作。

## 6. 服务、Git及可提交性

8014所有本轮服务已停止、端口释放。原5173/8000/5432服务仍为2680/35520/14640，未停止或重启。
最终本任务4个backend已跟踪修改 + 8个新增，另有Lead共同说明/验收记录；全部未提交，HEAD不变。
前端、Journal业务与旧Migration未改；未commit/merge/push/tag、删分支或清理工作树。

**可以整理T04 commit，但不因此升级个人库。**共享规则/验收记录由Lead单独管理，避免双重维护。
本轮不自动提交。合并后需同一组合重新跑后端回归、前端检查和Journal浏览器冒烟，核对M3/元数据/CORS/数据库隔离。
个人库Migration仍等待独立审阅及明确授权；本结论只覆盖Inbox后端，Inbox UI留给T05。

学习重点：省略与显式null用model_fields_set区分；唯一索引是并发Daily的最终仲裁；物理删除会释放该唯一键。
