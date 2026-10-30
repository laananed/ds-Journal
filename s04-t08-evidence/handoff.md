# S04-T08 开发交接与验证（2026-10-30）

状态：本轮开发及自测；尚未完成独立测试、新 Codex 专项审核、T06/T09 接线和用户最终接受，不宣称 Task 或 Stage 验收通过。

工作区：codex/s4t8，HEAD c3891b4849f71d66144711344a16840bc0ebc598；本轮未提交、未整合。暂存与未暂存补丁及文件散列见本目录。未跟踪文件本体保留在工作树。

测试：backend/.venv/Scripts/python.exe -B 调用 pytest，先将进程 DEEPSEEK_API_KEY 和 BRAVE_SEARCH_API_KEY 设为空，再将 urllib.request.urlopen 替换为抛错函数禁止真实 HTTP；23 个指定模块（AI usage/incremental/settings/local/recovery/tool/review/privacy/deletion、T08 及受影响 Ritual/goal）共 338 passed、14 subtests passed，退出码 0。先前单独执行 43 个工具测试及 62 个 Review 测试也通过。新前端 API 的 Node 测试通过；单独对 frontend/src/api/ai.ts 与 frontend/src/types/ai.ts 的 tsc --ignoreConfig --noEmit 检查通过。整站 npm run build 退出码 1：本工作树缺失既有 Tiptap 包；未安装依赖。

数据：测试库 seekjournal_test_03、端口 5432、revision 4f8e1a3c9d02；本轮结束只读检查其他连接 0，临时测试 schema 0。业务表除 ai_usage 一条外均 0；该匿名记录是本轮误触发真实模型的已知用量，UUID 4f2a8d02-c841-44e0-b42a-27da0e5119b9，1313 输入、369 输出、1682 总 Token，详见 accidental-model-call.txt；不能删除或当作合成已知用量。

接线与限制：T02 当前 replace_placeholder 只能替换已经存在的本地节点；prepare 新增占位时，若响应到达前已有较新本地输入，该窄效果无法插入节点，会进入保留草稿的冲突。comment_marks 也尚未接入 T02。T06/T09 需协调安全插入、标记窄效果和真实浏览器→HTTP→PG 验证；不得覆盖较新草稿。自动 Minds 的 ranges 由 T09 根据真实用户输入和激活基线生成，后端只验证保存快照的范围/归属，不能证明输入事件来源。T07 先前缺 End 创建、目标 UI 接线和跨文件风险审核等遗留仍开放。

用户另行授权了 journal/service.py、ritual/service.py、ritual/goals.py 的串行修改与 app/main.py 评论路由注册；确认 T08 独占 frontend/src/api/ai.ts、frontend/src/types/ai.ts。docs/stage4-api.md、stage4-architecture.md、stage4-tasks.md 记录了用户批准的多节点范围。

安全事件：一次错误的互斥测试未预先封锁传输，在预期 409 没有发生时误调用真实模型；仅用合成正文。测试事务回滚了原始记录，已在分配的 _03 中单独保留准确匿名用量。后续测试增加模型/搜索 Mock 防线、清空相关 Key 环境变量并禁止 urllib 出站。该事件须在独立审核时明确复核。

必需后续：未参与实现的新对话独立测试；新 Codex 对 C、幂等、计量和事务做专项审核；检查 prepare/apply 在 T02 中的较新草稿合并，执行 T09 自动范围与系统事件零调用、Insight/Review 浏览器链路、T07 遗留风险及完整集成回归。未经授权不提交、不整合、不安装依赖、不运行真实供应商。
