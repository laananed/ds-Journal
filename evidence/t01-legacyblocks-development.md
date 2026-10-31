# T01 旧多块转换开发记录

基线 `codex/t01-check` / `2a454d5f8b61bb34c32d0cd0f675977717c0c011`；上轮单块改动保留。本轮新增 schema 1 的 `legacyBlocks`（format_version 1），内部按旧规则投影，严格验证块类型、字段、ID 和 AI request_id；普通 PATCH 按块保护身份、顺序及 AI reply。前端注册同一节点、投影、编辑器守卫与用户块编辑。尚无用户界面的转换入口；当前通过既有 PATCH 提交候选，服务端比对实际旧 blocks。

目前转换仅支持多个合法 user blocks、原旧 R/U 和候选 R/U 精确一致、文本仅含字母数字和空白、数据库无任何 AI 请求且本文件无评论的 writing Journal。该范围很窄；空数组、AI 块、未知结构、链接/标点、来源和评论未证明的记录仍拒绝。旧 blocks、C 和正文保留，真实事务、恢复和跨进程行为未验证；不能认定可批量转换。测试支持的 AI 投影和保护不等于 AI blocks 转换已支持。

纯逻辑测试：backend 运行 `.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/unit/test_s4_legacy_blocks_document.py tests/unit/test_s4_legacy_projection_boundaries.py tests/unit/test_s4_single_block_conversion.py tests/unit/test_s4_transition.py tests/unit/test_s4_document_foundation.py`，42 passed、14 subtests passed。frontend 运行 `node --experimental-strip-types src/editor/legacyBlocks.test.ts` 和 `node --experimental-strip-types src/editor/documentProjection.test.ts`，退出 0。`npm run lint` 退出 0，20 条既有警告；`npm run build` 退出 1，`src/api/aiWriting.test.ts` 的 `node:assert` 类型 TS2591，见 `docs/stage4-t09-followups.md`，完整构建不通过。未进行浏览器可访问性/可编辑性测试。

未确认隔离数据库和独占窗口，未连接任何数据库、执行迁移、备份或恢复；HTTP/PostgreSQL、C/引用数据、旧 AI 迟到、竞争与故障注入、隔离恢复、T01/T03/T11 集成回归均未验证。未启动服务、创建测试对象或 manifest；无需清理本轮数据。后续需核实测试库目标、current/head、基线、其他连接和独占窗口，再使用合成数据按 manifest 测试；个人库与真实模型未触碰。需要独立测试和新 Codex 专项风险审核，未达到 T12 收缩门禁。
