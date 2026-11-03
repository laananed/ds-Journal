# Android 外壳（Android APK shell）

把现有 Web 前端构建产物打包进 APK，用系统 WebView 加载 APK 内的页面，页面再通过 HTTPS 访问云端后端。

- 本目录只负责 **Android 外壳与打包**；不包含前端源码、不包含后端。
- 不修改 `frontend/`、`backend/`、`deploy/` 或共享权威文档。
- **当前产物是开发包（dev build）**：`seekjournal.apiBaseUrl` 仍是占位地址 `https://api.seekjournal.invalid`（`.invalid` 为保留顶级域，永远不可解析）。它不连接任何真实后端，因此**不是最终可用包**。

## 0. 交接速览（给前端 / 后端 / 云端负责人）

| 项 | 实际值 |
|---|---|
| WebView 资源加载方式 | AndroidX `WebViewAssetLoader`（webkit 1.12.1）：`shouldInterceptRequest` 拦截请求，`assets/www` 经 `AssetsPathHandler` 以官方 MIME 推断返回。**不是 `file://`**，未开启任何文件/内容访问 |
| 实际页面 origin | **scheme `https`，host `appassets.androidplatform.net`，端口 443（默认，不体现在 URL）**。入口 URL `https://appassets.androidplatform.net/index.html`。浏览器发出的 CORS `Origin` 头就是 `https://appassets.androidplatform.net`（注意：没有端口后缀） |
| 内部路由 | 前端当前**没有路由库**（无 react-router、无 `history.pushState`），单页 + 状态切换；URL 始终是 `/index.html`，无深链接、无服务端路由需求 |
| 系统返回键 | `WebView.canGoBack()` 为真则 `goBack()`，否则交给系统（退出应用）。由于无前端路由，页内返回目前全部由前端 UI 按钮承担；**前端将来引入路由时需回改本外壳的返回逻辑** |
| 前端产物更新 | `android\scripts\build-web.ps1`（默认现场 `vite build` 到 `assets/www`；`-DistDir` 可装入已有 dist，但 API 基址必须由那次前端构建决定） |
| 认证 | 外壳**不注入** `Authorization`、不存凭据、无 JS 桥。HTTP Basic（若定案）由前端共享 API 层接线；后端 CORS `allow_headers` 需加 `Authorization` |

## 1. 目录结构

```
android/
├── apk.properties            # 单一构建配置：versionCode / versionName / 云端 API 基址
├── settings.gradle           # 单模块工程，仓库只用 google()/mavenCentral()
├── build.gradle              # AGP 8.7.3
├── gradle.properties         # Gradle 参数、useAndroidX
├── local.properties          # 本机 SDK 路径（机器相关，不入库）
├── gradlew / gradlew.bat     # Gradle Wrapper（8.10.2）
├── scripts/build-web.ps1     # 构建前端并写入 assets/www
└── app/
    ├── build.gradle          # 读 apk.properties；唯一依赖 androidx.webkit
    └── src/main/
        ├── AndroidManifest.xml
        ├── java/net/seekjournal/app/MainActivity.java
        ├── res/{layout,values,xml}/
        └── assets/www/       # 前端产物（由脚本生成，不入库）
```

## 2. 架构与数据流

```
APK
└─ assets/www/index.html + assets/*.js|css      ← vite build 产物
        ▲
        │ WebViewAssetLoader（虚拟域名 https://appassets.androidplatform.net，映射 assets/www）
        │
   WebView ──fetch──► https://<云端后端>/api/...  （计划同步、AI 等）
```

- **本地资源加载**：使用 AndroidX `WebViewAssetLoader`，把 `assets/www` 以 `https://appassets.androidplatform.net/` 提供。页面是真实 https 来源，`/assets/index-xxx.js` 这类绝对路径可直接工作，**不使用 `file://`**。
- **安全边界**（`MainActivity#configureWebView`）：
  - `setAllowFileAccess(false)`、`setAllowContentAccess(false)`，不设置 `AllowFileAccessFromFileURLs` / `AllowUniversalAccessFromFileURLs`；
  - `MIXED_CONTENT_NEVER_ALLOW`；`network_security_config.xml` 全局 `cleartextTrafficPermitted="false"`，`usesCleartextTraffic="false"`；
  - 不忽略证书错误（未实现 `onReceivedSslError` 放行逻辑）；系统默认 SSL 校验生效；
  - **没有 JavaScript 桥**（无 `addJavascriptInterface`），原生层不读写业务数据、不接触凭据；
  - 只开启前端确实需要的 WebView 能力：JavaScript（Vite/React 必需）、DOM Storage（前端用 `localStorage` 记住面板与草稿状态），其余保持默认或显式关闭（多窗口、自动开窗、缩放、媒体自动播放）。
- **系统返回**：`WebView.canGoBack()` 为真则回退，否则交由系统（退出到桌面）。前端是单页状态驱动，页内返回由前端 UI 自己处理。
- **加载失败**：主框架加载失败时显示原生错误面板（失败描述 + 重试按钮），重试重新加载入口地址；不加载自制的“错误网页”。
- **软件键盘**：`windowSoftInputMode="adjustResize"`，键盘弹出时 WebView 视口收缩，前端编辑器按可视区域布局。`targetSdk` 保持 34，不改动 edge-to-edge 默认行为，避免 insets 处理引入额外复杂度。
- **外部链接**：非 `appassets.androidplatform.net` 的 `http/https/mailto/tel` 链接交给系统浏览器/对应应用打开；其他 scheme 提示“不支持打开该链接”，不在 WebView 内加载外部页面。

## 3. 前提（本机已满足，新机器需自行准备）

| 项 | 本机实际值 | 说明 |
|---|---|---|
| JDK | `C:\Programme\Java\jkd17`（`java 17`） | AGP 8.7 要求 JDK 17；系统默认 `java` 是 25，构建时需指定 `JAVA_HOME` |
| Android SDK | `C:\Users\Free\AppData\Local\Android\Sdk` | 已装 platform-35、build-tools 35.0.0 |
| Gradle | Wrapper 8.10.2（本机已缓存发行版） | 无系统级 Gradle，全部通过 wrapper |
| Node / npm | `v22.22.2` / `10.9.7`，`frontend/node_modules` 已存在 | 仅用于构建前端 |
| 签名 | `~/.android/debug.keystore`（自动生成/复用） | 本轮为 debug 签名 |

`local.properties` 为本机 SDK 路径，不入库；新机器请照下面格式新建，或设置 `ANDROID_HOME`：

```properties
sdk.dir=C\:\\Users\\<you>\\AppData\\Local\\Android\\Sdk
```

## 4. 首次打包

在 PowerShell 中，于仓库根目录执行：

```powershell
# 1) 构建前端并写入 app/src/main/assets/www（同时读取 apk.properties 的 API 基址）
powershell -NoProfile -ExecutionPolicy Bypass -File android\scripts\build-web.ps1

# 2) 生成 APK
$env:JAVA_HOME = 'C:\Programme\Java\jkd17'
android\gradlew.bat -p android assembleDebug --console=plain
```

产物：`android\app\build\outputs\apk\debug\app-debug.apk`

> `build-web.ps1` 用 `vite build --outDir .../assets/www` 直接把产物写进 android/，**不写入 `frontend/dist`、不修改 `frontend/` 源码**。
> 它会同时写出 `assets/www/build-info.json`（api 基址、git HEAD、frontend 是否脏、文件数、index.html SHA-256），便于核对“这个 APK 用的是哪个前端基线”。

## 5. 前端更新后重新打包

```powershell
# 仓库根目录，确认分支/HEAD 已是想要的前端基线（例如把 main 合进来或切到 UI 分支）
git -C . rev-parse HEAD

powershell -NoProfile -ExecutionPolicy Bypass -File android\scripts\build-web.ps1
$env:JAVA_HOME = 'C:\Programme\Java\jkd17'
android\gradlew.bat -p android assembleDebug --console=plain
```

如果前端负责人已经给出构建产物（`dist` 目录），可以跳过打包机上的前端构建，直接装进 APK：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File android\scripts\build-web.ps1 -DistDir <dist 的绝对路径>
```

注意：`-DistDir` 模式不会重写 bundle 里的 API 基址——该地址在前端构建时就已固化，必须由前端构建时的 `VITE_API_BASE_URL` 决定。

## 6. 云端 API 地址配置方式

**单一配置来源：`android/apk.properties`**

```properties
seekjournal.apiBaseUrl=https://api.seekjournal.invalid
seekjournal.apiBaseUrlStatus=placeholder
```

- 该值由 `build-web.ps1` 作为 `VITE_API_BASE_URL` 传给 `vite build`，**在构建时固化进前端 bundle**（前端各 `src/api/*.ts` 都读取 `import.meta.env.VITE_API_BASE_URL`，未配置时回退到 `http://127.0.0.1:8000`）。
- 临时覆盖（不改文件）：`build-web.ps1 -ApiBaseUrl https://api.example.com`。
- 脚本拒绝非 `https://` 的基址——APK 禁止明文 HTTP。
- APK 内不放任何 API Key、数据库密码、站点密码。若后端将来需要鉴权，凭据必须由用户在运行时输入或走标准登录流程，不得打进包里。

### 当前暂定约定（2026-11-03，用户给定；细节仍待 Codex 落地）

1. **云端基址**：`https://<演示域名>`，**不含 `/api` 后缀**——前端 `src/api/*.ts` 的请求路径自带 `/api/...`（如 `` `${base}/api/journals` ``），基址带 `/api` 会拼成 `/api/api/`。域名未定，`apk.properties` 仍为占位值；域名确定后改一行并重跑 `build-web.ps1` + `assembleDebug`。
2. **现有默认地址不可用于云端**：前端未配置 `VITE_API_BASE_URL` 时回退 `http://127.0.0.1:8000`，只对本机开发有效，**手机连 VPS 必须靠构建时注入的 https 基址**。
3. **CORS**：按实际 origin 配置，即后端 `allow_origins` 需加入 **`https://appassets.androidplatform.net`**（精确值，无端口后缀；不能改用 `*`）。这是 WebViewAssetLoader 虚拟域名的固定值，与演示域名无关。
4. **认证候选：运行时输入的 HTTP Basic（尚未实现、未定案）**：
   - 接线位置：**前端共享 API 层 `frontend/src/api/*`**（所有请求都从这些文件发出，失败提示也在各文件的 `readError`/错误类里）。外壳不参与：不注入请求头、不拦截请求、不原生存凭据。
   - 若定案，后端需要：CORS `allow_headers` 增加 `Authorization`（当前只有 `Content-Type`、`If-Match`），并按 401 返回约定让前端能提示“账号或密码错误”。
   - 凭据只在运行时由用户输入；**密码、AI 密钥、任何 secret 一律不得写进 `apk.properties`、bundle 或 APK**。
   - 共享 API 文件与后端入口的修改涉及多条路线，**实施前须先与 Bug 修复路线（codex/backend-bugfix）交接排队**，不并行改。
5. **HTTPS 证书**：必须是系统信任链可验证的证书；外壳不提供任何证书例外开关。

## 7. 版本与签名

| 项 | 值 |
|---|---|
| 包名 / applicationId | `net.seekjournal.app` |
| versionCode / versionName | 由 `apk.properties` 决定，当前 `1` / `0.1.0-dev` |
| 签名类型 | **debug 签名**（`~/.android/debug.keystore`，`androiddebugkey`）；`release` 构建类型暂时复用 debug 签名，仅用于内部验证，**不是可发布包** |
| minSdk / targetSdk / compileSdk | 24 / 34 / 35 |
| 依赖 | 仅 `androidx.webkit:webkit:1.12.1`（WebViewAssetLoader） |

正式发布需要另行生成 release keystore 并把口令放在本机（不入库、不写进 Gradle 文件明文），这属于新授权范围。

## 8. 本轮未验证 / 已知限制

- **未安装到真机、未做任何运行验证**（按用户要求不做测试与安装验证）；构建成功不等于安装或业务功能通过。
- **内嵌前端落后新基线一个提交**：共同基线已改为 main 的 `f57b4e1`（writing IME 自动恢复修复，触及 `WritingAiPanel.tsx` / `WritingPage.tsx`），而 APK 里的产物构建自 `64161dd`。等基线更新获准（把 main 合入 `wb/android-apk`）后需重跑 `build-web.ps1` + `assembleDebug`。
- 占位 API 地址下，前端所有请求都会失败（域名不可解析），因此“断网提示/网络错误提示”的实际表现取决于前端，而不是外壳。
- 前端当前没有 `history`/`pushState` 使用，页内返回由前端 UI 按钮承担；如果前端将来引入前端路由，需要复核系统返回键与深链接行为。
- 未处理 `onRenderProcessGone`（WebView 进程崩溃）后的自动恢复，崩溃时表现为页面空白，需要手动重启应用。
- 未做 APK 体积优化（未开启 minify/shrinkResources、未对 assets 做压缩策略调整）。
- 未配置应用图标与启动页，使用系统默认图标。
