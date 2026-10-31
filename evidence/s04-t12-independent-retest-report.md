# S04-T12 恢复入口修复独立复测（2026-10-31）

结果：部分通过，复测未完成，不能宣布 Web 过渡交付通过。此对话未参与修复；开发对话 t12测试明确声明停止写入，复测前查询为 idle。模型多样性未核实。

基线：codex/s4t12，HEAD 856d602307215204b992fdd3ea954e6d0fb88241，暂存为空。开始和结束状态的既有修改、未跟踪文件清单一致；本轮新增本报告、independent-retest-server.py 和 independent-retest-requests.jsonl。交接四文件 SHA-256 均与交接一致，前后相同；交接文件本身 FD80A904F6822304FF5B34A249A0715AAFF815BEE3794C34C26B536DE4291EA0 前后相同。完整修改文件散列的临时快照因命令运行环境临时目录不跨调用保留而无法比较；不能声称全部文件散列前后一致。未改产品代码、未提交、合并或推送。

通过：前端 npm run build 退出 0（chunk 大小提示）；node --experimental-strip-types 运行 recoveryTypeIsolation.test.ts、aiRequestState.test.ts、reviewSelection.test.ts、state/aiRequests.test.ts 的组合命令退出 0，后续三个分别输出 150、74、50 断言通过；组合命令未逐个检查退出码，因此前面三个的独立退出码未记录。聚焦测试覆盖同源双类型增删、未知 kind、损坏 JSON、版本 2 保留；它不能替代 UI 测试。

隔离浏览器/Mock：仅 review（Inbox 91）时历史 Inbox 显示原文、陪伴写作未调用，复盘显示 review；仅 local 时复盘不显示 review。双类型时 Inbox 陪伴写作显示 local 的合成 unknown；清除 local 后 review 仍在，刷新后仍在。重新注入双类型，移除 review 后 Inbox 仍显示 local 的合成 unknown；该方向刷新未验证。清除的是合成浏览器 localStorage 入口，不是删除服务器请求。上述最初两个单索引场景的临时 Mock 日志未持久保存。

复盘异常类型：固定同一 review ID，Mock 第一次 GET 返回 review/pending，下一次轮询 GET 返回 local/applied；UI 显示状态未知、类型无法确认、入口保留、不自动重发。刷新后入口仍在；再次手动查询返回 local/applied，同样显示状态未知。持久日志 independent-retest-requests.jsonl 共 51 次 GET，local 请求 2 次，review 请求 3 次，无其他方法；模拟服务器非 GET 返回 405。此日志只覆盖第二个持久 Mock 实例。关闭测试页面时 mock 出现连接中止，属于测试环境日志。

未验证：Journal 的浏览器类型组合和双向清除、反向清除后的刷新；local 错误类型的查询与轮询；旧格式/未知条目在实际浏览器的写入前后原始索引；本轮搜索、Folder、内部链接以及 Journal/Insight 路径。此前独立测试报告对导航的历史证据不视为本轮复测。未记录每次浏览器操作的 localStorage 原始值。真实后端、数据库、模型与计费、数据收缩、迁移及专项风险审核均未测试；用户最终接受尚未完成。

自建 8039 Mock 已停止，测试标签页关闭。结论仅涉及所列模拟条件下的 T12 Web 过渡行为，不代表完整 T12、阶段验收或真实数据安全。建议补齐上述未验证矩阵，再由规定角色进行风险复核。
