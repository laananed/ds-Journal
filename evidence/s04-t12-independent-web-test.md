# S04-T12 Web 过渡交付独立测试（2026-10-31）

- 本对话未参与本次 T12 实现。开发对话明确声明已停写；执行独立性满足。开发者与本测试均为 Codex，具体模型差异未核实，不声称模型多样性交叉验证。
- 基线：`codex/s4t12`，HEAD `856d602307215204b992fdd3ea954e6d0fb88241`；暂存为空。测试前后状态相同，交接清单内 22 个文件 SHA-256 均一致，清单自身 SHA-256 `AE404C8FBCE8C6A9251D20C06F30803D16DB67BC3D45B0DE93D2BD5DA5300692`。部分已修改文件仅行尾差异，故 status 有而 diff stat 无。此报告为测试后新增文件。
- `npm run build`：退出码 0，Vite 提示大 chunk；`node --experimental-strip-types src/utils/legacyInboxPolicy.test.ts` 和 `node --experimental-strip-types src/api/retiredConsumers.test.ts`：各退出码 0；后端 `python -B -m unittest discover -s tests/unit -p 'test_s4_retirement*.py'`：9 项通过、退出码 0。以上不证明数据库或 UI 全链路。
- `python -B -m alembic heads`：唯一代码 head `c01a7e421b50`。只读连接实际 `seekjournal_test_03`，事务 read-only，数据库 revision 相同；其他连接 4，`ai_usage` 1 条，其余业务表 0 条。无独占窗口和既有记录归属，未写入、迁移或清理数据库。真实迁移和个人库数据未验证。
- 浏览器使用实际 Vite App、独立端口 5188 与 8038 上仅返回合成数据的内存模拟 HTTP 服务：从导航打开历史列表及详情，显示合成原文和保留提示；列表与详情未见新建、修改、删除、新 AI 按钮；复盘页只显示 Journal 来源。模拟未实现完整后端，不能作为 PostgreSQL 或完整正式端到端证据。
- 未验证：搜索、Folder、内部链接打开历史记录的浏览器闭环；已有 AI 请求查询与恢复；Journal、Insight 和普通搜索/链接的实际回归；旧数据访问前后内容、关联及数量比对。源码中后端旧写接口仍存在，故 Web 隐藏控件不证明数据安全或旧客户端只读。
- 未发现本轮实测产品失败；整体仅部分验证，Web 过渡交付不能判定通过，完整 T12 的转换、收缩、备份恢复和专项风险复核均未完成。未改产品代码，未提交、合并或推送；自建服务已停止，测试浏览器页已关闭。

## 续测：合成浏览器路径与恢复缺陷

- 再次核对：开发者前次明确停写；`codex/s4t12`、HEAD 与上次一致，暂存为空；测试前后交接清单 22 项及清单自身散列均一致。测试新增本报告、模拟服务和请求日志；无产品代码修改。
- 构建：设置模拟地址后 `npm run build` 退出码 0；测试以生产构建、8038 本机只读模拟 HTTP 服务和浏览器运行。模拟端点的合成对象为 Inbox 91、Journal 92、Insight 93、Folder 7。浏览器分别从搜索、Folder 和 Journal 内部链接打开 Inbox 91，均观察到 `Synthetic inbox original` 和历史保留说明，详情未见可见编辑、删除或新 AI 复盘按钮。
- 回归：Journal 列表及详情、Insight 列表及详情可读取；搜索结果打开 Journal；Insight 的内部链接可打开 Journal。此为模拟返回数据条件下的基本导航与呈现，不验证真实搜索算法或持久化。
- 局部请求：预置仅含 Inbox 91、kind=local 的合成恢复索引，打开详情后自动 GET 请求并显示模拟 `unknown`，手动“查询状态”可再次查询；复盘请求：预置 review 索引，在复盘页点击“查询并恢复”后显示模拟 `unknown`。模拟仅覆盖这一步，未覆盖 ready 预览、applied、实际服务保存或计费。
- **失败／产品缺陷**：仅预置 Inbox 91 的 `kind=review` 恢复索引，打开 Inbox 详情后，AI 陪伴写作组件把这条复盘请求当作局部请求自动查询并显示；点击该组件“清除恢复入口”后，复盘页对应恢复入口消失。请求本身未删除，但浏览器恢复入口丢失，影响既有复盘恢复。`AiWritingActions` 按源查索引而未过滤 kind；应交开发者修复后由独立测试者复测。合成请求的状态是 unknown；不推断其他状态的后果。
- 请求日志 `s04-t12-mock-requests.jsonl` 记录 99 次 GET、0 次 POST/PATCH/DELETE/PUT；模拟端也拒绝任何非 GET。该断言仅涵盖本轮已操作路径和该模拟服务；浏览器测试主动清除的只是本轮合成 localStorage 索引。
- `seekjournal_test_03` 重查：实际库名正确、只读事务、revision `c01a7e421b50`、其他连接 4、既有 `ai_usage` 1 行，其他列出的业务表 0 行。fixture 使用外层事务回滚、序列不回滚；无法证明独占及既有记录归属，未执行写库与正文/关联前后比对，也未停止其他连接。真实 PostgreSQL 数据安全、迁移和备份恢复仍未验证。
- 本轮浏览器完成后自建模拟服务已停止；浏览器页关闭。模拟服务器记录客户端取消请求时出现 ConnectionAbortedError，不影响上述已观察路径，属测试环境日志而非产品失败。结论：Web 过渡交付独立测试**未通过**，待修复恢复类型混用并复测；完整 T12 和用户最终接受仍未完成。

## 恢复类型补充验证

开发者交接对话仍 idle，末次明确停写；本轮开始 `codex/s4t12`、HEAD `856d602307215204b992fdd3ea954e6d0fb88241`、暂存为空，22 项交接散列与清单一致。使用已构建 Web 与本机 8038 模拟器；本轮 mock 日志独立保存。请求状态均为合成 `unknown`。记号 L = `11111111-1111-4111-8111-111111111111`（local），R = `22222222-2222-4222-8222-222222222222`（review）。

| 合成索引 | Inbox 91 详情 | 复盘页面 | 查询、清除及刷新 |
|---|---|---|---|
| 仅 R | 陪伴写作区错误自动 GET R，显示 review 的 unknown 消息和清除按钮（上轮、单索引已重现） | 显示 R，查询并恢复 GET R | 复盘页查询后刷新仍显示 R；移除后刷新不再显示。上轮在 Inbox 清除也使复盘入口消失。 |
| 仅 L | 自动 GET L，显示 local 的 unknown 消息，可手动查询 | 不显示复盘恢复入口 | 手动 GET L 后刷新重新打开仍恢复；清除后刷新重新打开显示未调用。 |
| 同源 `[L,R]` | 选最后一条 R 并 GET；清除 R 后刷新重新打开选 L | 清除 R 后不显示复盘入口 | 查询 GET R，清除仅移除 R，L 仍可恢复。 |
| 同源 `[R,L]` | 选最后一条 L 并 GET | 显示 R | 两者同时可见于各自页面；此顺序下未重复清除测试。 |

两条同源索引是人工构造的边界：本轮直接运行 `addRecoveryEntry`，同源依次加入 L→R 仅保留 R，R→L 仅保留 L（退出码 0）。因此不能宣称正常流程必然产生双条；也要注意目前按来源去重本身可能使较早请求失去本地入口，需开发者结合既定契约评估。

Journal 92：单独放入以该 Journal 为锚点的 R，打开旧版 Journal 详情并进入编辑、展开陪伴写作后，同样自动查询 R，显示 review 的 unknown 消息及“重新提问（新的付费调用）”；没有点击新付费调用。清除后复盘页面不再显示 R。单独 L 时该组件正常显示 L 的模拟消息。Journal 测试的 mock 请求响应 source 字段仍固定为 Inbox 91；本项证明按本地锚点错误选取并呈现请求，不证明后端源校验。Insight 93：模拟非法 Insight 恢复锚点时复盘页不显示恢复入口，Insight 详情无陪伴写作恢复组件；静态解析器只接受 journal/inbox，故这一机制不适用于该 Insight 页面，不能推断所有其他 AI 机制。

最小复现：在隔离浏览器写入唯一 `{kind:'review', source:{type:'inbox',id:91}, requestId:R}`；打开历史 Inbox 91，模拟 GET R 返回 review/unknown；陪伴写作区显示其状态并提供清除。点击清除，访问复盘页或刷新后，R 的恢复入口消失。建议开发者检查共享恢复索引的 kind/源匹配、同源去重与清除语义，覆盖 Inbox 和旧 Journal，确保各类型入口不会混用或覆盖；不在本轮实现修复。

本轮日志 `s04-t12-recovery-mock-requests.jsonl`：138 个 GET（L 查询 6、R 查询 5），无 POST/PATCH/DELETE/PUT；mock 非 GET 一律拒绝。清除操作改变的是本机合成 localStorage，mock 不提供任何服务端写路径，未连接真实后端或数据库，不能证明真实服务器数据状态。生产构建仅复用上轮结果；模拟器正常停用时因客户端取消请求记录 ConnectionAbortedError。保留已知限制：未测 ready/applied、真实计费、真实数据库或最终收缩。独立测试仍未通过。
