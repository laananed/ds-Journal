# 结题云端演示：部署与交接手册

状态：本地准备，模板未经服务端配置检查或部署。适用于用户明确授权的独立演示环境；上线还取决于 VPS 盘点、Android 真实 origin、客户端认证接线与权限。部署基线应为经用户批准并冻结的集成版本，而不是直接使用此分支的未提交文件。本轮不安排测试或真实付费调用。

## 1. 已查明的项目行为

- 数据流：APK 内置 Web 内容 → HTTPS 认证反向代理 → 127.0.0.1 上单进程 FastAPI → 独立 PostgreSQL；AI 由后端访问 DeepSeek，网络搜索另由后端访问。单进程避免破坏现有 AI 进程内并发/恢复假设。
- `backend/app/database.py` 加载 `backend/.env`，已有进程环境优先；Alembic 用同一 Engine。`backend/app/main.py` 启动时运行 `recover_pending(restart=True)`，可能修改 AI 请求及计量；绝不可在目标未核实或多个实例并存时启动。`/api/health` 不检查数据库。
- 前端各 API 模块读取 `VITE_API_BASE_URL`，未设置默认手机自身的 127.0.0.1:8000；这是构建时公开配置，不含 `/api`。当前后端无认证，CORS 仅本机 5173；无法直接供 APK 安全使用。
- 服务端读取 `DEEPSEEK_API_KEY`；可选联网搜索读取 `BRAVE_SEARCH_API_KEY`，默认以 `WEB_SEARCH_ENABLED=false` 禁用。密钥仅通过服务器受限权限环境文件提供，绝不上传或写入 APK、源码、命令参数及日志。真实 AI/搜索调用可能产生费用，须另获授权。

## 2. 三路接口交接（待对方确认，不等于已经约定）

1. Android 负责人给出内置资源实际来源、确切 origin（scheme/host/port）、构建版本、刷新与返回方案。推荐使用能给本地资源提供稳定 HTTPS origin 的 Android WebView 资源加载机制，具体以其实现为准；禁止预设同源、`file://`、`null` 或 `*`。限制外部导航和明文网络，外链不携带认证信息。
2. UI/API 负责人在获明确文件交接后，以构建时 `VITE_API_BASE_URL=https://<域名>` 接入。现有 API 文件分散，不能只改一个调用。候选为演示者运行时输入 HTTP Basic 凭据、仅会话内保存、每个目标 API 请求显式设置 `Authorization`；不在 URL、日志或构建物中保存。必须覆盖所有 API（含 AI、恢复、写入和 health），不向任何其他 origin 发送。当前未实现，需要和 Android/UI 接口所有者确认可行性。
3. 网关对业务请求全路径认证；预检只允许确定 origin、GET/POST/PATCH/DELETE 和 Authorization/Content-Type/If-Match，OPTIONS 不进入应用；错误响应也携带 CORS。CORS 不限制非浏览器客户端，必须使用认证。Basic 密码并非设备绑定、可能重放，使用独立高强度临时账号、最小分发、演示后撤销；公开前配置并审核针对认证尝试的速率限制和访问日志策略，确认不影响既有服务。模板不包含速率限制，未完成前不得公开。证书、用户态登录及 Android WebView 行为不能凭模板推断成功。
4. 401 重新输入凭据；403 拒绝访问；网络/TLS、5xx 显示可恢复状态，保留未保存内容；409/422/428 沿用业务冲突/校验语义。AI 超时或结果未知不要自动重发，沿用 request_id 恢复。应用内路由由内置前端处理，不依赖服务器 SPA fallback。以上为提出的交接契约，未代替对方确认。

## 3. VPS 只读盘点（SSH 授权与主机身份核实后）

使用用户现有 SSH 客户端和密钥代理，不要求聊天粘贴私钥或密码；先核对目标 IP/主机名与主机指纹。以下只读，不展示环境变量、容器 inspect、代理配置中的秘密、连接串或个人数据：

```sh
uname -a
cat /etc/os-release
uptime
free -h
df -h
ss -lntup
systemctl --type=service --state=running --no-pager
command -v docker && docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
command -v nginx && nginx -v
command -v psql && psql --version
command -v python3 && python3 --version
```

登记各监听地址/端口与服务归属、已有代理及 80/443、DNS、证书、可用磁盘内存、swap、Docker/PostgreSQL/Python 版本及服务管理方式；不读取现有服务密码或配置全文。确认端口、域名及容量之前，不改防火墙、既有反代、服务或容器；端口已占用时需要所有者确认兼容接入方案。若内存/磁盘不足先报告，不承诺 1 GB 可运行。无域名或证书时先准备 DNS/证书方案，不自行购买。

## 4. 安装和初次部署（盘点后才执行）

以下为可执行顺序，具体路径、用户、组件复用及操作权限需依据盘点确定；不安装或升级现有软件，不改未知站点。候选最少组件：现有 PostgreSQL、现有 Nginx、Python 虚拟环境、systemd，均须确认存在或单独授权安装。服务器仅运行数据库、一个 API worker 和入口；前端及优先可能的 Linux 兼容依赖包在本地/兼容构建环境构建，Windows wheel 不能直接用于 Linux。锁定 Python/系统架构及 requirements 的实际可用性后再打包；不把 `.env`、个人数据、node_modules、私钥、日志纳入产物。

1. 固定经整合批准的代码版本和制品摘要；登记变更、恢复版本和仅本项目使用的用户、目录、端口、域名。确认演示域名解析及 80/443 的既有归属与证书签发方式。启用 HTTPS 前端口不能直接暴露应用。
2. 专用低权限用户和专用空演示库由获授权的数据库管理员创建；单独记录库名、角色、主机/端口和服务器标识。账号只拥有演示库所需权限。避免将数据库监听公网；存在共享数据库时先确认访问配置与归属。不要复制本地 `seekjournal` 的数据。
3. 服务端创建受限权限的环境文件（仅部署账号/服务账号可读），提供 `DATABASE_URL` 和经授权的 AI 环境变量；切勿输出文件内容。配套 `PGSERVICE` 使用受限权限的 libpq service/密码文件来连接**同一**演示库供备份工具使用。按运维安全渠道配置；不要在命令行明文传密码。任何 `.env` 文件都不应进入制品或 Git。
4. **在迁移和每次服务启动前**，以与服务相同的账号、工作目录和环境文件运行下方只读 Python 目标检查；由管理员比对预先登记的服务器标识、地址、端口、数据库名及角色，确认不是 `seekjournal` 或其他现有库。通过受保护服务文件用 `psql service=<已登记的服务名>` 同样执行 `SELECT current_database(), current_user, inet_server_addr(), inet_server_port();`，确认备份目标与应用目标一致。`inet_server_addr()` 对 Unix socket 可为 NULL，需用登记的 socket/实例身份补充确认；任何不符或无法证明即停止，不能依赖环境文件名称判断。

```sh
# 在发布版 backend 目录，以实际服务账号及其已加载的环境运行；不打印 URL
python - <<'PY'
from sqlalchemy import text
from app.database import engine
with engine.connect() as c:
    row = c.execute(text('SELECT current_database(), current_user, inet_server_addr(), inet_server_port()')).one()
    print('database, role, server address, port:', *row)
PY
```

5. 在同一环境中先 `python -m alembic heads`、`python -m alembic current`，人工确认唯一 head、当前 revision 与演示库目标，备份后才 `python -m alembic upgrade head`。新空库初次迁移前也须检查目标；不对个人库或不明库操作。记录版本但不输出连接串。出现多 head、未知版本或失败立即停止，不自动 stamp/降级/重建。
6. 将 `seekjournal.service.template` 和 `nginx-site.conf.template` 当作需填写及审阅的模板，按已核实目录、端口、证书、origin 和服务账户生成专用配置；该模板本身不能直接启用。环境文件不得包含前端资产。Nginx 认证文件由管理员交互式创建，使用已有安全工具生成密码哈希，不在命令行传明文；权限仅允许代理读取。禁止代理访问日志记录 Authorization、请求正文或查询字符串中的私密内容。
7. 获得对专用配置和服务的具体变更权限后，先检查配置并确保既有站点不受影响，再以单 worker 启动专用 API。模板禁用失败自动重启；不要启用开机自启，管理员每次重新核对实际数据库目标后手动启动，检查服务状态、入口和认证失败的边界；需要真机、CORS、端口暴露和安全审核证据，未测不得对外开放。不要以 health 200 当成数据库或业务验证。

## 5. 备份、更新与回退

- 更新前冻结部署版本、记录 Alembic revision，安排独占窗口；确认应用、迁移、备份连接的数据库均为上述演示库。备份目录仅限专用账号，访问权限 0700，文件 0600，记录时间和摘要；注意容量及备份包含敏感演示内容。下面仅在 `PGSERVICE` 已指向并核实专用演示库后运行，工具不会打印连接串：

```sh
umask 077
pg_dump --format=custom --no-owner --file=/专用备份目录/更新前.dump
```

- 文件存在不等于可恢复。恢复须在**新建、目标已确认的隔离恢复库**进行：用另一个经过核实的 libpq service 指向该库后执行 `pg_restore --exit-on-error --no-owner --dbname=service=恢复库服务名 /专用备份目录/更新前.dump`；先检查目标库为空且属于本次项目，不使用 `--clean` 覆盖现有数据库。恢复演练须获得相应资源和写权限；本轮未执行。
- 更新：备份 → 核对目标及唯一迁移 head → 关闭本项目旧 worker（确认归属）→ 升级专用演示库 → 以固定新制品启动单 worker → 做经授权的必要验证。不可同时运行新旧 worker；中断时按步骤停在安全状态。
- 回退：先确认仅影响专用服务并停止它。若数据库 schema 与旧程序兼容，可恢复旧制品并重新确认目标后启动；如迁移不可向后兼容，先在隔离恢复库验证备份，再由用户明确授权切换到经核实的恢复库或实施恢复，不盲目 `downgrade`、覆盖现有库或删除数据。更新后产生的演示数据可能丢失，操作前说明恢复点；保留现场。

## 6. 仍需用户提供 / 授权

一次性交接：目标 VPS 的非秘密标识（IP/域名、账号名、已配置密钥代理的连接别名及指纹核对方式）、可使用的权限及维护窗口；现有服务/端口与域名证书负责人；独立演示数据库创建、专用系统用户和目录、Nginx 独立站点及服务变更权限；若组件缺失，是否允许安装与来源；Android 实际 origin、APK/UI 对认证和 API 客户端的责任交接；演示人数、域名及证书是否已有；是否允许真实 AI 调用及费用上限。不要在聊天提供密码、私钥、完整连接串。需要购买资源、开通收费服务或产生 AI 费用时先取得单独批准。


## 7. 2026-11-03 用户补充与只读连接结果

- 目标由用户提供：`23.94.56.41`，普通账号 `alice`；期望在服务器使用独立 `seekjournal` 目录。`vps-cf` 是本机 SSH 别名，解析配置显示用户名 `alice`、主机 `ssh.freirenlikesleep.cyou`、端口 22。具体目录绝对路径和是否已存在尚未核实，不能覆盖。用户允许必要时使用 root 权限；实际 sudo 可用性及现有服务变更仍需核实和明确操作范围。
- 只读 SSH：现有别名因 `websocket: bad handshake` 无法建立连接；直接连接 IP（包括沿用别名认证配置）均返回 `Permission denied (publickey)`。因此尚未登录，VPS 服务、端口、容量和权限都未核实，目录未创建。需由用户恢复既有别名或配置其 SSH 客户端/密钥代理，勿传送私钥。
- DNS 公开 A 记录指向 Cloudflare；对 `freirenlikesleep.cyou` 的公开 TLS 握手成功，观察到 Let's Encrypt 证书，截止 2027-01-26 08:26:35 UTC。此结果只证明客户端到该域名当前 TLS 入口，不能证明 VPS 源站 TLS、DNS 路由或可安全复用 443；不能更改该域名已有站点。
- 用户允许 AI 调用费用，表示不限制次数、若需预算则以人民币 10 元为参考。实际价格、额度、单次 token 和调用次数未核实，此金额不能保证足够；现有系统未发现硬性人民币限额，不能承诺自动阻止超支。仍应在发起真实调用前说明其具体用途及预估，并避免自动重试。
- Android 实际 origin 与前端认证负责人用户尚不清楚；交付时由相应 WorkBuddy 提供实际实现与文件责任。候选方案未实现、未协商完成，不能提前放行或暴露公网 API。


## 8. 2026-11-03 SSH 恢复与 VPS 初步盘点

经用户批准，用户通过 RackNerd 控制台创建普通用户 `Fern` 并追加专用公钥、设置账户密码；本机专用密钥 SSH 直连成功。服务器默认 SSH 禁止密码认证，不更改 SSH 配置；用户以 `root` 控制台执行设置。`Fern` 属于自身用户组，未见 sudo 组。已使用 Fern 创建 `/home/Fern/seekjournal`，权限 0700、所有者 Fern；未上传应用、连接数据库或启动服务。

只读 SSH 显示 Ubuntu / Python 3.12.3，约 961 MiB 内存、571 MiB 当时可用、1 GiB swap（已用 32 MiB）、磁盘约 15 GiB 可用；状态会随负载变化。TCP 443、2083、22 已监听，443/2083 具体归属尚需 root 只读核查；`x-ui.service` 活动。nginx、psql、pg_dump、docker 未在 PATH 中找到，对应 service 未活动，Python venv 可用。不得据此断言所有数据库和代理均未安装；不占用已用端口、不停止服务。安装缺失组件、启动 PostgreSQL 或更改现有域名/入口之前需明确相应权限与方案。

用户已授权实际 AI 使用、10 元为建议预算；无硬上限保证，尚无付费调用。APK origin、客户端认证接线以及可用域名/证书入口仍待确认，公网开放前不得将现有无认证 API 暴露。


## 9. 2026-11-03 安装进度

用户批准安装 PostgreSQL、客户端和既有 Python 后端依赖；用户在 root 控制台安装，实测 PostgreSQL 16.15、16/main online，TCP 5432 仅监听 127.0.0.1 和 ::1。观测时可用内存约 529 MiB，非负载保证。Python 3.12 venv 已创建，固定基线 `64161dd` 源码与 Linux wheel 离线包装入 `/home/Fern/seekjournal`，源码及 wheel 传输摘要均与本机一致；pip 离线安装退出码 0。未创建演示库、迁移、启动 FastAPI 或开放端口；目标版本仍需集成其他路线后冻结。

拟通过 PostgreSQL 本机 Unix socket 与操作系统 `Fern` 账户对应的专用数据库角色使用 peer 认证，避免在环境文件存放数据库密码；具体是否可行须核实实际 pg_hba 规则及实例身份，确认后才创建独立演示库。保留现有默认服务，不改 Xray 443/2083。


## 10. 2026-11-03 演示库迁移

用户在 VPS 控制台创建 PostgreSQL 非管理员角色 `Fern` 及其拥有的独立库 `seekjournal_demo`。从 OS 用户 Fern 通过 Unix socket 实际查询得到数据库 `seekjournal_demo`、数据库用户 `Fern`，服务器地址/端口为 NULL（Unix socket）。共同基线 Alembic 唯一 head 为 `c01a7e421b50`；空库起点执行 `alembic upgrade head` 退出码 0，`alembic current` 显示该 head。写入前再次验证目标名称与角色；未访问或上传本地个人库。

这是迁移状态，非应用或安全验证。后端未启动，认证、实际 APK origin、HTTPS 入口、备份恢复演练及真机验收均未完成；其他路线整合后的最终版本可能需要重新核验 head/目标与迁移。


## 11. 2026-11-03 HTTPS 与本机服务准备

`api.freirenlikesleep.cyou` 已由用户新增 DNS-only A 记录指向 VPS；Nginx/Certbot 已按用户授权安装，Nginx 被 mask，未启动。初次 HTTP-01 在 UFW 未放行 80 时超时；用户批准并新增 80/tcp 后证书签发成功，截图显示到期 2027-01-31。Certbot 安装了自动续期计划，实际续期及部署后 Nginx 重载未验证；须确保续期时 80 可用及证书更新后加载。Xray 继续占用 443/2083；8443 未开放。

新增 `seekjournal-demo.service` 与 `check-demo-db.sh`：固定版本、单 worker 仅 127.0.0.1:18090，Unix socket peer、数据库名/角色/迁移版本启动前严格核对，禁止失败自动重启及开机自启。服务文件在 Fern 目录供 root 审阅安装；校验脚本只读检查通过；systemd-analyze 在 Fern 下退出码 0，同时报告无权读取不相关系统 unit，不能据此声称服务已启动或验证业务。演示 API 身份认证、精确 CORS、限速、AI 供应商密钥、最终版本整合未就绪，不应开放公网。


## 12. 2026-11-03 后端服务及 Android 当前来源

用户安装并启动独立 `seekjournal-demo.service`，只读检查其 active 且监听 `127.0.0.1:18090`；PostgreSQL 5432 仅回环，Xray 仍活动。观察时可用内存约 458 MiB；这不是业务访问、负载或安全验证。当前单进程不配置 AI 密钥，重启和开机启动均需再次检查目标和资源。

已只读核对的 WorkBuddy Android 工作区使用 AndroidX `WebViewAssetLoader`，预期来源为 `https://appassets.androidplatform.net`。用户另行交接的 Codex Android 外壳使用原生 `WebViewClient` 映射包内资源，计划保留相同来源；两套外壳的实现和证据不可互相替代，最终 APK 尚未选定或冻结，真实 Origin 未验证。两套外壳当前均未实现认证注入；前端 API 的 Basic 接线、登录 UI 和 401 错误处理尚待负责方实现。预期 APK 构建时 API 根地址为 `https://api.freirenlikesleep.cyou:8443`；不向 APK 放供应商密钥。该通用 origin 不代表应用身份，不能把 CORS 当安全保护。


## 13. 2026-11-03 稍后状态及交接

用户启动专用 Nginx 代理后，约三小时后只读核对：`seekjournal-demo`、`seekjournal-proxy`、`postgresql`、`x-ui` 均 active；代理仅监听 127.0.0.1:8443，后端仅监听 127.0.0.1:18090；数据库仅回环。该观察不是对认证、防火墙、证书续期或业务访问的测试，也不是公网可用证明。服务未启用开机自启；启动前需重新验证演示库及服务状态。

移动路线交接见 `mobile-handoff.md`。已准备证书续期后的专用代理 reload hook，尚未安装或验证；Certbot 定时器存在不证明真实续期可用。用户原指示本轮不安排测试、独立测试或完整回归，因此不得将状态检查报告为访问或安全通过。


## 14. Android 交接更正（用户提供，尚待冻结核对）

用户报告 Codex Android 路线工作区 `C:\Programme\demo\SeekJournal\.local-run\android-apk`，分支 `codex/android-apk`，HEAD `f57b4e1778dd02dcccfe8be67f6f2d58f1edfcc3`，`android/` 全部未跟踪、未提交；其负责范围仅该目录。现有 debug APK 仅有占位页，无业务前端/API 地址；用户手机此前查看的是另一套 WorkBuddy APK。原生 `WebViewClient` 的预期 origin 与前述 WorkBuddy 方案相同，但最终 APK、真实请求头、TLS、CORS、认证、API 错误和草稿保护、路由/外链与云端连接均未验证。本路线 README 对占位 `index.html` 的“受跟踪”表述由该路线后续修正，云部署线不越界修改。

共享 `frontend/src/api/*`、登录界面及后端/代理需要明确单写者；此前云端转交材料中的 AndroidX 表述只适用于已观察的 WorkBuddy 外壳，不能视为 Codex 外壳的实现或验证证据。


## 15. 手机 UI 认证产物与服务器当前状态

手机 UI 线报告认证代码已接入并完成开发构建，尚未运行验证；交接见 `mobile-handoff.md`。云端线以 SHA-256 检查交接前端产物 4 文件与清单一致，未做运行测试。只读服务器状态：seekjournal-demo、seekjournal-proxy、postgresql、x-ui 均 active；后端 18090、代理 8443 和 PostgreSQL 5432 均仅回环监听。证书续期 hook 文件已安装，真实续期、重载行为未验证。未配置 AI 供应商密钥，8443 未公开、APK 尚未选定/冻结。


## 16. Work-02 Android APK 开发交付

用户转交 Work-02 报告：`wb/android-apk` / `64161dd9c50a08f2e75c083232a7a5a60afa09cb`，接收 `codex/mobile-ui` / `f57b4e1` 加未提交 UI 和认证差异的前端产物；构建记录称 `assembleDebug` 通过。云端线只读核对 APK `C:\Programme\demo\SeekJournal-Work-02\android\app\build\outputs\apk\debug\app-debug.apk`：大小 1644119 字节，SHA-256 `dad6c39cdab5f8fb315b4d55fa6b036877ce9c2c558a54784286750b45d6c4e4`；zip 中交接清单的四个前端文件散列全部一致。没有安装或运行 APK，也未做测试。签名和产物来源等为开发者报告，未以构建成功声称设备或安全通过。

APK 的 `build-info.json` 中 `gitHead` 与 `frontendDirty` 反映打包所在 Work-02 工作区，不可代替前端源 Work-03 的基线和未提交更改；前端来源以 `FRONTEND-HANDOFF.md` 和源码/产物散列清单为准。页面源依 Work-02 代码预期为 `https://appassets.androidplatform.net`，真实 Origin 未验证。

本机代理仍只监听 127.0.0.1:8443，`seekjournal-nginx-public.conf` 为仅供审阅的 IPv4 公网候选配置，尚未部署；开放还涉及 UFW 8443 新规则，暴露后所有互联网客户端可到达认证入口。认证、CORS、限速和设备行为尚未运行验证；不得将 APK 构建或配置检查说成真实云端访问通过。AI 供应商密钥未配置。


## 17. 2026-11-03 用户授权开放 8443 后状态

用户明确批准公网 8443，用户在 root 控制台备份原本机监听代理配置、检查并加载候选配置，随后添加 UFW 8443/tcp IPv4/IPv6 规则。截图和 Fern 只读状态显示 seekjournal-proxy 与 seekjournal-demo、PostgreSQL、x-ui 活动；Nginx 仅在 127.0.0.1:8443 与 23.94.56.41:8443 监听，后端仅 127.0.0.1:18090，PostgreSQL 仅回环，Xray 443/2083 未调整。当前仅配置 IPv4 公网监听，UFW 的 IPv6 允许规则不代表已有 IPv6 服务。用户在根目录保留 `/etc/seekjournal/nginx.conf.loopback-backup`，回退须经确认只操作专用代理/本轮新增规则。

该入口已配置 Basic、限速和预期 origin CORS，但按本轮用户要求未发送公网请求、未进行认证/CORS/安全/设备测试；不能宣称公网访问通过或所有接口被实际验证。公网暴露期间应使用用户自行设定的强密码。AI 密钥尚未配置，禁止上传至前端或聊天；后端仍是共同基线而非最终集成代码，真实 APK 与云端连接尚未验证。


## 18. 2026-11-03 AI 环境文件接入与当前状态

用户在 root 控制台自行输入 AI Key 到仅 root 可读的服务端环境文件，未向云端对话提供其内容；安装专用 systemd drop-in 并重启 seekjournal-demo。重启前演示库身份/版本 guard 通过，观察到 pending AI 请求 0；用户命令与随后只读检查显示服务 active。仅凭服务启动无法判定 Key 是否有效或供应商是否可达；未读取密钥、未发起 AI 调用，也未产生本轮模型调用证据。此前各节“未配置 AI 密钥”和“8443 仅回环”是当时记录，以本节和 §17 的后续事实为准。

只读状态：Nginx 23.94.56.41:8443 与回环 8443 监听，FastAPI 127.0.0.1:18090、PostgreSQL 仅回环；Xray、PostgreSQL 和两项专用服务均 active，guard 再次匹配。用户开启 UFW 8443 规则；域名/证书、Basic/限速/CORS 已配置，但公网握手、认证、业务、AI 调用、设备和安全均未验证。约 446 MiB 可用内存是当时快照，不是容量证明。专用服务未启用开机自启，重启后需确认数据库目标、服务和端口再手动启动；系统提示的待重启内核尚未处理。

`wb/android-apk` debug APK 产物及 4 个交接文件哈希核对见 §16；后端是基线 64161dd，前端为 f57b4e1 加未提交变更。最终集成版本、Worktree 差异的合并/提交、真机与用户接受尚未完成，既有 Stage 验收不改写。


## 19. 用户授权后的必要验证（2026-11-03）

用户撤销本轮不测试的限制，授权必要测试。Windows Python 通过系统证书验证直连公网 HTTPS 8443：未认证 GET `/api/health`、`/api/ai/settings`、`/openapi.json` 均 401；Android 预期来源的 OPTIONS `/api/ai/settings` 为 204，并含对应 Allow-Origin、Authorization/Content-Type/If-Match 及方法头；其他来源响应的 Allow-Origin 仍是固定 Android 来源，不匹配该其他来源。该结果不证明最终 APK 真实 Origin、所有端点、限速或带凭据业务路径。

通过 SSH 在服务器确认演示库/角色/迁移目标，再从后端回环接口用唯一合成标识创建并读取日程，删除该自建日程成功（204，随后 GET 404）；日程表计数测试前后均为 0，退出码 0。该测试绕过 HTTPS 网关，不能作为公网认证或 APK 验证。GET AI settings 200、model_configured=true 只说明进程有非空配置，不证明 Key 有效或供应商可达；未发起付费调用。验证脚本 `verify-private-backend.py`。

现时仍未完成带认证的公网业务、真实 Android origin/CORS、手机安装与操作、供应商 AI 请求、证书续期演练与安全复核。


## 20. 2026-11-03 公网带认证及单次真实 AI 调用

用户自行在 Windows PowerShell 输入演示访问密码后报告公网 HTTPS `/api/health` 返回 HTTP 200；该结果来自用户提供的终端输出，代理认证、TLS 和后端 health 的单路径证据，非所有业务或 Android 的证明。云端线未读取或输出访问密码。

依用户授权的必要测试及真实 AI 费用范围，检查演示库/角色/迁移目标后，使用后端本机接口创建唯一合成测试日记、发起一次 `/api/ai/local`，服务端关闭联网搜索（effective_web_enabled=false），结果 applied；usage 记录 prompt 284、completion 77、合计 361 tokens、unknown 0、search_requests 0。通过应用接口删除并彻底清理该自建合成日记后，按 ID 只读检查其不存在，匿名 usage 计量保留。未读取或输出 API Key、日记正文或供应商原始结果；不以 token 数推断实际人民币费用。本次 AI 调用经服务器回环绕过 HTTPS 网关，不能作为 APK 到公网 AI 的完整链路证据。脚本 `verify-ai-once.py`，请求 ID `b9b296d6-8c05-48e5-b02e-a05db4f339aa`；不自动重试。

仍待实际手机安装/Origin、认证/CORS/TLS、保存与恢复、手机到云端 AI 的整链、证书续期、风险复核和用户接受。


## 21. 用户手机使用反馈及仓库提交范围

用户反馈目前手机可正常查看，先前反馈可调用 API；这是用户的实际使用反馈，不代替逐项真机测试记录、完整回归、独立安全审核或 Stage 验收。业务问题继续按实际归属分发给前端 UI 或后端修复路线；前端内置于 APK，变更后需重新构建 APK。云端后端仍是 64161dd 的演示部署，不因本地 main 后续更新而自动更新。

仓库保留部署文档、无凭据的网关配置与通用服务模板；依赖 wheel、压缩包、一次性验证脚本和含完整数据库连接值的实际机器专用 service 保留本地并由 `deploy/.gitignore` 排除。原服务端文件不因此改变；`seekjournal.service.template` 是待适配模板，不声称与线上实际 unit 逐字一致。后续更新应先核对被排除文件及真实线上 unit、演示库目标、备份和迁移链，避免将仓库模板直接覆盖已运行配置。
