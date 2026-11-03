# 结题演示：APK / 移动 UI 与云端接口交接

状态截至 2026-11-03；这是跨工作区只读观察与当前对接要求，不代表代码已整合或验收。共同起点 64161dd9c50a08f2e75c083232a7a5a60afa09cb，各工作区实际 HEAD 和未提交 diff 在交接前重新冻结。不得覆盖或直接修改其他路线的文件。

- Android 方案有两套：云端只读核对的 WorkBuddy 外壳使用 AndroidX `WebViewAssetLoader`；用户另交接的 Codex 外壳使用原生 `WebViewClient` 映射包内资源。两者均计划采用 `https://appassets.androidplatform.net`，但最终 APK 尚未选定或冻结、真实 Origin 未验证，不能互相套用实现或证据。来源变更前交云端协调 CORS；此通用 origin 不代表唯一应用身份，不代替认证。
- 演示 API 根地址拟为 `https://api.freirenlikesleep.cyou:8443`，不带 `/api`；前端构建通过 `VITE_API_BASE_URL` 传入。该地址尚未开放公网，不能报告连接成功。API 名称和地址非密码，严禁放数据库密码或第三方 API 密钥。
- HTTPS 网关候选采用用户运行时输入的 HTTP Basic：用户名 `demo`，密码由用户自行输入，不写进 APK、源码、剪贴板交接、日志、持久化明文或聊天。前端共享 API 负责人需明确取得文件责任后，覆盖所有 API 调用，包括 AI、保存、搜索、恢复和直接 fetch；仅对精确 API origin/端口添加 Authorization，绝不发送给其他网站。不要依赖 WebView 初始页面与 API 同源、也不要在 URL 中携带凭据。WebView 外壳当前不注入认证。
- 代理只对 Android 确认的 origin 提供 CORS 预检、允许 `Authorization`、`Content-Type` 和 `If-Match`，OPTIONS 不转发业务；401/429/5xx 等错误也需可被前端识别。Basic 为可重放的共享演示凭据，不是用户系统；代理必须全路径认证和限速，用户应于演示后撤销/更换密码。真实有效性需用户授权的后续安全与设备验证。
- 401 提示重新输入凭据；403 显示无权限；网络/TLS/429/5xx 明确提示并保留未保存内容。409/422/428 沿用现有业务规则；AI 状态 unknown 时沿既有 request_id 机制恢复，不自动重发有费用/副作用请求。APK 内路由返回/刷新由本地资源处理，外链不得获得认证头。
- 用户本轮明确不安排测试、独立测试或完整回归；待用户批准后按实际 APK、冻结集成版本、真实 origin 和实际服务开展必要安全/真机/回归验证，届时分别报告执行结果。源码相符不等于实机行为、云端连接或用户接受。

请相关负责人交付：实际分支和 HEAD、允许接线的具体文件及单写者交接、运行时认证的实现状态、API 失败/未保存内容处理、Android 最终 origin 与 APK 构建基线、未验证项。云端负责人确认后才安排开放 8443。未授权 commit/merge/push、依赖变更及修改其他工作区。


## 用户交接：Codex Android 路线（待冻结核对）

- 工作区 `C:\Programme\demo\SeekJournal\.local-run\android-apk`，分支 `codex/android-apk`，用户报告 HEAD `f57b4e1778dd02dcccfe8be67f6f2d58f1edfcc3`；`android/` 全部未跟踪、未提交。该路线仅负责此目录，共享前端认证和后端/代理文件尚未交接单写者。
- 现有 debug APK 是占位页，不含业务前端或 API 基址；用户此前在手机查看的 APK 是另一套 WorkBuddy 外壳，不可混同。本路线 README 中对占位 `index.html`“受跟踪”的表述待该负责人更正。
- 本路线尚无 Basic 输入、Authorization 注入或业务 API 错误和草稿保护；实际来源、CORS、TLS、认证、返回/刷新、外链与云端连接均未验证。实际构建时须确定前端产物与 `VITE_API_BASE_URL`，交付前冻结完整 HEAD 与未跟踪 diff。


## 用户指定的单写者和交接方式（2026-11-03）

用户指定手机 UI 对话独占共享前端 API 和认证界面，Android 对话仅负责外壳/打包，云端对话负责网关；不得跨工作树代写。已注册 `codex/mobile-ui` 工作区 `C:\Programme\demo\SeekJournal-Work-03`，工作树元数据记录 HEAD `f57b4e1778dd02dcccfe8be67f6f2d58f1edfcc3`，未确认工作区是否有未提交更改或实际对话写入状态。手机 UI 对话应确认其实际工作区、自己为唯一写入者，在原工作区记录 HEAD、完整状态、暂存/未暂存 diff 与未跟踪任务文件清单/摘要，以当前 UI 改动为接线基线；不清理/重置/切分支，不把提交 hash 当成完整冻结结果。若与实际持有人或路径不符，先协调。完成后冻结完整源码与构建产物及公开 API 基址交 Android 负责人；不自动提交、合并或启动测试。


## 用户的 Android 工作区选择意向（2026-11-03）

用户表示打算以 `C:\Programme\demo\SeekJournal-Work-02`、`wb/android-apk` 为 Android 开发路线；当前工作树元数据登记 HEAD `64161dd9c50a08f2e75c083232a7a5a60afa09cb`，未确认其未提交内容或负责人停写交接，也不代表最终 APK 已冻结。保留 `codex/android-apk` 的现有文件与工作树。手机 UI 独占共享前端认证及错误处理，Work-03 实际写入者先核对基线并保留变更，再将冻结的前端产物和接口信息交给 Work-02 的实际 Android 负责人。


## 2026-11-03 手机 UI 产物已交付，待 Work-02 接收

手机 UI 对话报告 `codex/mobile-ui` / `f57b4e1778dd02dcccfe8be67f6f2d58f1edfcc3` 与未提交 UI/认证差异构建前端开发产物：`C:\Programme\demo\SeekJournal\.local-run\android-apk\handoff-baseline\frontend-dist`，完整交接为同目录 `FRONTEND-HANDOFF.md`，API 根地址为 `https://api.freirenlikesleep.cyou:8443`。该报告中的构建退出码 0 与未测试状态为开发者提供，云端对话未重建。

云端线只读校验产物清单与目录：4 个文件，全部 SHA-256 一致，无额外文件；静态核对 Work-03 十二个现有 API 模块引用共享请求函数，未判定运行时覆盖或安全通过。工作区代码仍可能变化；产物、源码散列、HEAD 和未跟踪差异应由 Android 负责人交接时复核。此产物尚未确认由 Work-02 Android 负责人接收，不能与另一套 Android 外壳或旧 APK 混同。运行时认证、TLS、CORS、错误与草稿保护、AI 恢复、真实云端均未验证，8443 仍仅监听 VPS 回环。


## 2026-11-03 IPv4 公网入口配置状态

用户已批准并在 VPS 配置公网 IPv4 8443 监听及 UFW 入站规则；APK 的拟定 HTTPS 根地址不变。代理已配置访问认证、限速、预期 origin CORS，但这些行为及实际公网访问均未运行验证，不能把网络入口已配置当作连通或验收通过。实际 API 结果、最终 APK 和真实 Origin 均待获授权后验证；AI 服务端密钥尚未配置。


## 2026-11-03 最新 AI 配置

用户已在 VPS 控制台自行保存服务端 AI Key 并安装 drop-in，专用后端重启后 active。不得把 Key 添加到前端、APK 或交接材料；服务状态不能证明 Key 有效。未进行 AI 调用、云端联网、认证、CORS 或设备验证；本条更新此前 AI 密钥尚未配置的历史状态。
