# T01 多块兼容映射：合成证据与待决方案

基线 `codex/t01-check` / `2a454d5f8b61bb34c32d0cd0f675977717c0c011`；本轮仅新增纯逻辑样例，不代表已支持多块转换。旧记录仍保留 legacy；数据库、备份与恢复均未实测。

## 已确认的映射障碍

1. 两个 user 块“甲”“乙”：旧 R/U 均为“甲乙”；两个保留原 ID 的 `legacyText` 新 R/U 均为“甲\n乙”。C 为“甲”时旧增量是“乙”，新增量是“\n乙”。把两块合成一个节点会丢失一个身份和边界。
2. user“甲”、AI reply“答”、user“乙”：使用带原 ID/request_id 的 `aiReply` 可以表达 AI 身份，但新 R 与旧 R 分隔不同、U 为“甲\n乙”而非“甲乙”。直接改 C 或丢失用户块边界不能证明原语义安全。AI summary 的可编辑属性与 reply 的只读属性也须分别保留。
3. 空数组与 NULL、未知字段/类型、重复或无效 ID、正文和 blocks 不一致，都不能据此自动确定作者或原文。未知结构需拒绝并保留。
4. 评论、内部链接与旧 review 来源快照涉及锚点、引用和格式身份；前端 `legacyText` 的显示及跳转不能仅凭文本相等证明，老快照仍须可安全查询。未证明时拒绝。

## 最小候选方案（未获架构/API 修改批准）

定义明确版本化的旧 blocks 兼容表示：保留每块原 ID、顺序、作者、原文及 AI request_id，并为其投影明确旧块拼接规则；服务端构造和严格验证，普通 PATCH 不得伪造或修改受控来源。同步 Python/TypeScript schema、投影、编辑与复制规则及共享黄金样例。仅当旧 content 等于按严格白名单计算的旧 R、新 R 精确等于旧 R、新 U 精确等于旧 U，且 C、引用与所有相关请求状态经验证时才提交转换。候选不意味着现有 `legacyText` 属性可以擅自扩充；具体节点形态、编辑行为和数据格式版本须先确认并同步 API/架构。

逐类扩展：先验证多个 user 块（含空段、Unicode、重复内容、部分 C）；再验证 reply/summary 交错及 request_id、受控编辑、复制和恢复；最后处理评论、内部链接、旧快照和迟到请求。仍无法证明的记录保留原字段并返回明确拒绝。

备份方案：取得一致性全库备份（含 schema、数据、序列），覆盖 Journal 的 content/blocks/doc、身份、版本和时间、AI 来源与结果快照、评论、C、Folder 和关联数据；不输出正文或凭据。只在已明确分配并核验的隔离库恢复，以脱敏摘要对比全部受影响字段、序列和计量，演练转换失败回滚及恢复后的读取。真实升级需单独授权和写入冻结；保留 blocks 不等于备份。

本轮纯逻辑测试命令：在 backend 目录运行 `.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/unit/test_s4_legacy_projection_boundaries.py tests/unit/test_s4_single_block_conversion.py tests/unit/test_s4_transition.py tests/unit/test_s4_document_foundation.py`，结果 37 passed、14 subtests passed，退出 0；测试中设置的数据库 URL 是明确的无效测试占位，不连接数据库。此证据不覆盖 HTTP、PostgreSQL、备份恢复、并发或独立测试。
