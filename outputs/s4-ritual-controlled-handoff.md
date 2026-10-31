# S04 Ritual controlled commands — 开发交接

基线：codex/Ritual，df8c41ec85822b6422f81b5428e3d042daf9c9a5；无暂存。以下为本轮文件 SHA-256。

## 文件散列

- `backend/app/ritual/goals.py`: `c669666a22db4e3ffcbb4228e5255760585b85c6d2c4a67ef4ceb3cbe7380ddd`
- `backend/app/ritual/router.py`: `14476baad937eb84ef438cdbc1d3ddc654a277447b2a24bb38390e31e1edeccb`
- `backend/app/ritual/schemas.py`: `f6e47ac528943a05f673f7796a51ad1c2b7644a47eb0955e1c79b6ee10932b97`
- `backend/app/ritual/controlled.py`: `6f7ae95002002410361dd92938377ecfacd169fb1789ad60d448f414cabcdc0b`
- `backend/app/writing/documents.py`: `583755b1321b77345aa1cb877dd335bc84521f8ba091d60d8b303f416954dd91`
- `backend/tests/unit/test_s4_controlled_command.py`: `17908358688c3b2774c761602cf9fbe2b82f1ec0cb88b6da0ce78941457f04b3`
- `backend/tests/unit/test_s4_ritual_controlled_nodes.py`: `fee215b73d38787542e2ee21508a5561e5031b20ce477a89f4a9c89b2a6193aa`
- `docs/stage4-api.md`: `666bf6c3ebcd3aa9d9adb2dcfdc5b4de5e9eada67dcd0e455859fcce2bb11ce4`
- `docs/stage4-architecture.md`: `e23ca8ed4132c2c31924d918c098756fa6ce1e120105b821ae9d96ecfcb4c2a0`
- `docs/stage4-t10-followups.md`: `323dc4f722e846b95b981e661a5fcf4f7dbcec72fb76e03a185323d7142a3d6b`
- `frontend/src/pages/RitualPage.tsx`: `bfd318d1bc15920a6308f09da724250e62031e7f1ff0eb88291c8812eb61b952`
- `frontend/src/utils/ritualControlled.ts`: `d661f1a35111d6bf9fccaff189a765ae602c1275e4d93a1a06b246ae9b1111d5`
- `frontend/src/utils/ritualControlled.test.ts`: `9dbe9bb24f7918d78a22fb1b52b5dae91f26a3892fefa27cb567f5f035a328bb`

## 本轮验证

- backend: `.\.venv\Scripts\python.exe -m unittest tests.unit.test_s4_controlled_command tests.unit.test_s4_ritual_controlled_nodes tests.unit.test_s4_document_foundation`：退出 0，24 项；命令级测试为 mock，不证明数据库事务。
- frontend: `node --experimental-strip-types src/utils/ritualControlled.test.ts`、`src/utils/ritualView.test.ts`、`src/state/editSessions.test.ts`：退出 0；后两者分别 133 和 160 断言。
- `npm run build`：退出 1；当前工作树缺少 Tiptap 模块和部分 Node 类型，完整构建未验证。
- 未使用数据库、启动服务或执行迁移。没有经确认的隔离库独占窗口；未运行 PostgreSQL、HTTP、浏览器及并发测试。

## 未完成

- 正式 App 路由未接线；等待其他写入者停写后串行处理。
- Set 目前必须显式选择纯文字顶层清单条目转换；格式、评论、嵌套条目拒绝，尚不能证明满足原自动 Checklist 目标行为；首次无可保存正文时不能直接插入问题。
- 完整验证模板变更、重复操作、SQL 故障回滚、普通 Checklist 隔离、关联后同步及解除；独立测试、专项风险审核和用户接受均未完成。
- 无暂存或提交、合并、推送；其他工作树目录状态未能访问核实。
