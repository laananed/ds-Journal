# C01 修复交叉测试报告（2026-10-30）

## 结论
- D1：部分通过，未完成全部故障注入，不能判整体通过。浏览器验证 409 后表单与标题保留且有冲突提示；创建网络失败重试复用键、新建换键。最新版本读取失败、三种选择、再次 409、404/其他错误未独立复测。
- D2：失败。3 条列表中删除首条成功后，注入 list 网络失败，剩余两条已有显示消失，页面仅显示读取失败；remove 恰好 1 次。详见 refresh-failure-first.log 和 browser/refresh-failure-first.png。删除成功通知有依据。21 条末页成功回第一页已观察；首页删空、更多页末页、删除失败等未独立复测。
- D3：部分通过，未完成全部浏览器验证。浏览器检查等于开始时间有中文提示；早于开始只检查了 rangeUnderflow 和零写，不能据此证明中文提示；晚于、修正后更新和关联等未独立复测。纯函数测试通过但不能替代交互。
- 修复后需冻结新基线，独立复测上述缺口及回归。C01 不视为完成，用户尚未接受。

## 缺陷复现
打开隔离夹具 seed=3，记录三条列表；设置 window.__failNextList=true；点击首条删除、确认。Mock remove 成功，随后 list 抛网络错误。实际：列表 0 行，先前另外两条不可见；错误提示“网络中断，改动未确认”；调用序列 list(1), remove(1), list(1)。截图及日志记录实际结果。源码读取失败时把 listState 替换为 error，属于疑似原因；应由开发者判断修复。

## 验证和命令
隔离副本 frontend，build、lint、四个 Node 命令退出码均 0：
- npm run build（构建有 chunk 大小警告）
- npm run lint（11 条其他文件 warning）
- node --experimental-strip-types src/utils/scheduleTime.test.ts（35）
- node --experimental-strip-types src/utils/scheduleForm.test.ts（80）
- node --experimental-strip-types src/utils/schedulePaging.test.ts（24）
- node --experimental-strip-types src/api/schedulesMock.test.ts（34）
- node run-browser.mjs：退出 0，53/53，原独立测试夹具移植至本轮隔离副本；每项原始范围见 browser-run.log，不扩大解释。首次浏览器运行受沙箱限制退出 1；第二次夹具路径错误超时退出 1，修正夹具后重跑。
- node refresh-failure.mjs 与 node refresh-failure-first.mjs：退出 0（日志记录观察，不代表断言通过）。

浏览器回归：Mock 标识、时区显示、创建/编辑冲突/完成/删除/分页、emoji 码点、建议查看取消零写、确认后提交、模型不可用时手动创建、375px 溢出和部分键盘检查通过。不能由此证明所有指定边界。截图和结果位于 browser/，服务 127.0.0.1:5197 已停止。

## 实际基线
开发报告声明停止写入；测试前后分支 wb/s4C01，HEAD e0afbccf88f5beb1ed2bbfa1bd036dd8c28f47b4，已跟踪暂存和未暂存 diff 均空；12 个未跟踪文件散列前后一致如下（SHA-256）：

3B13779ED9BF92FA688A9014956DF2F3C76804E80F1AC3D54CAF5B4EB3B5056F frontend/src/api/schedules.ts
83C0830D2BCD0AEABB5FF36320CFDA4F1DB6E79ED70F356C40DA7C916D22F5CB frontend/src/api/schedulesMock.test.ts
9D65564E9BBB9A06342932910516E04D7AB2E5F5200F7D24638AE80A0AC11AA0 frontend/src/api/schedulesMock.ts
575AACA3E710E0B4B07514206B4F12722541569B569C6BAAC533ADACC41CC836 frontend/src/pages/SchedulePage.css
B6362CA4C74D7EED195046C449FA9DB92919DF35F3C18B0840B594DDD1FB37D2 frontend/src/pages/SchedulePage.tsx
31437B3EC28A4033D455A93D96319A47AFA98F68B1B016616883D9F66A18551F frontend/src/types/schedule.ts
2B7DF9EE2EE3F126A303A722E889D9A4951AA855206EE55A009EC2F0E2A6A1C0 frontend/src/utils/scheduleForm.test.ts
1B3982A63035AAF0F11DE696DE483ECF7F842BC018E5A5B37166932E5F474727 frontend/src/utils/scheduleForm.ts
99EC9EDB469BCEDB252FB8F1FD5EB0DAFC40A424C7B53DBD7027B931841B6C55 frontend/src/utils/schedulePaging.test.ts
98456175DBC8C57DC54A75709D29E12FF0D82F2AE75DD5E3346413D1862A9985 frontend/src/utils/schedulePaging.ts
7B5FECEE46AB62EFEC6846E78ECC4C17C1D6BCD1A9D9B4A5B54E42DAA35861C2 frontend/src/utils/scheduleTime.test.ts
E62C39F8265D447966AFB0D4D9B8BFC77D50D4E251337082C1FDCA2EB86E6570 frontend/src/utils/scheduleTime.ts

## 边界
仅本地内存 Mock；真实 HTTP/PostgreSQL、重启持久化、正式 App 接线、真实模型、移动真机和读屏实测未验证；未访问个人数据库或调用付费模型。任务文档要求确认后保存情绪推测，但组件仅展示不保存，属于契约/后端待办。视觉接受留给用户。没有修改开发工作树产品代码或操作 Git 集成。
