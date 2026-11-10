# 天宫同源接入与广场正式更新

本目录将同源 `/plaza/`、旧来源入口兼容和正式更新过程纳入版本管理。只更新既有广场实例，复用数据库、持久密钥、托管发布授权和 Node 22；首次安装仍见[试用安装](../trial/README.md)。本脚本不管理 SSH 凭据、不修改天宫服务器、不自动回滚或认领应用。

## 文件与两段 TLS

| 文件 | 用途 |
| --- | --- |
| [deployment.example.json](deployment.example.json) | 脱敏计划；所有地址是文档占位值，哈希必须实测填写 |
| [release.py](release.py) | 渲染、预检、暂存、备份切换、开放及独立回读 |
| [portal-location.conf.in](templates/portal-location.conf.in) | 天宫现有 HTTPS server 内的一次性 location 配置 |
| [gateway-canonical.conf.in](templates/gateway-canonical.conf.in) | 广场网关内的同源入口与代理对端校验 |
| [gateway-legacy.conf.in](templates/gateway-legacy.conf.in) | 两个旧入口的匿名来源 API 与网页跳转 |
| [identity.env.in](templates/identity.env.in) | 只覆盖身份和入口配置，不覆盖数据库及发布凭据 |

浏览器 → 天宫继续使用天宫现有公司证书。天宫 Nginx → 广场 HTTPS 网关需验证网关的真实证书链；可复用伏羲已验证且确实签发该上游证书的公开 CA，不能仅凭公司名称假设两段 CA 相同。`portal_gateway_ca` 是天宫服务器上的公开上游 CA 路径，`gateway_ca` 是广场主机进行旧 HTTPS 入口回读时使用的同一公开 CA。二者路径可以不同。

广场后端 → 天宫身份接口使用 `portal_ca` 对应的公司公开 CA，脚本只把它复制到本服务新建、可读的 `public-trust/` 文件。保留全部 TLS、主机名和有效期校验；不放宽既有证书目录权限，不复制私钥。

## 准备固定来源

1. 在独立、干净的 checkout 中同步并检出已批准发布的 `origin/main`，核对 GitHub 权威 URL 和完整 SHA。PR 候选测试通过不构成上线授权。
2. Node 22.16+ 执行 `npm ci` 和本次变更适用的检查，再打包：

   ```sh
   python ops/trial/package.py --date YYYYMMDD --main-ref origin/main --output artifacts/release
   ```

   打包器在本次调用内执行前端构建，之后再次检查源码未改变；运行源码读取 Git 原始 blob，避免 Windows CRLF 转换。输出 `release.json`、Git SHA/tree、逐文件摘要与归档 SHA-256；排除配置、凭据、证书、备份、`node_modules` 和本地历史。输出目录必须在忽略区域或 checkout 外。再次使用同一归档名会拒绝覆盖。
3. 通过已有、已核验主机指纹的传输方式上传归档、脚本及其 `templates/`、`deployment.example.json` 到所属主机的独立保护目录；回读文件大小和 SHA-256。脚本支持 Python 3.10+，运行主机须已有 systemd、Docker PostgreSQL、tar、Node 和带 realip/sub_filter 模块的 Nginx。脚本不会下载安装软件。

## 生成私有配置

将示例另存为 checkout 外的私有计划（例如 `/srv/plaza-incoming/deployment.local.json`），填写真实路径、端口、完整来源 SHA 和实测哈希。不要把实机计划提交到 Git。各阶段必须使用同一份计划及同一批输入。

```sh
python ops/tiangong/release.py render --plan /private/deployment.local.json --output artifacts/entry-bundle
```

该命令只在新建的 0700 目录生成 0600 文件，不连接主机或数据库。输出包括三个网关片段、一个天宫片段和身份环境模板。只允许固定 `/plaza/`；后端绑定 `127.0.0.1`，与网关同机。

- `portal_origin` 使用规范 HTTPS origin，保留实际非默认端口，默认 443 不显式写入。`portal_peer_ip` 填天宫与广场网关连接的实际 IPv4 对端，不能填任意浏览器 IP 或网络段。
- 维护人在天宫既有 HTTPS server 内一次插入 `portal-location.conf`，保留前缀与查询参数。门户菜单建议直接使用正式 HTTPS `/plaza/` URL；旧 HTTP 菜单在部分浏览器中可能被混合内容策略阻止，不能以一台浏览器的跳转成功推定全端可用。
- 广场维护人只在原广场 TLS server 内替换旧根路径代理为 `gateway-canonical.conf` 与 `gateway-legacy.conf`，保留既有 TLS 证书。已有等价 Host guard 应整理为模板中的单一 guard。另在同一 `http` 内追加 `gateway-legacy-server.conf`，它接续旧 HTTP 端口。不得替换完整天宫或伏羲配置。
- 完整广场网关候选由维护人在所属主机生成，文件与原 `nginx.conf` 位于同目录以保持相对 include 语义，使用 `.plaza-candidate` 等不被现有 include 通配符匹配的名称。只在私有计划记录候选与原配置的 SHA-256，完整配置不回传、不提交。
- 生成的 `identity.env` 作为私有 `identity_env` 输入，账号引导项默认留空。需要首次绑定超级管理员时，只在私有文件填写已确认的精确天宫账号；由真实服务端核验后绑定稳定 subject。已有角色不会因保留引导配置被重新授予。不要填写昵称、Token、Cookie 或其他平台数据库身份。
- 新环境覆盖由 systemd 加载在原 EnvironmentFiles 之后，文件内容只允许模板列出的键。原数据库、GitLab 授权、密钥和绝对 `PLAZA_DATA_DIR` 必须已经明确配置，脚本逐项比对进程中的配置摘要而不导出原值。清除旧免身份管理模式和双 origin 模式。
- 输入目录由 root 控制，身份环境文件 0600；归档、网关候选和公开 CA 不允许符号链接或组/其他用户写入。计划中的 `previous_release`、数据目录和 Nginx master 必须与实际相符；master 要使用明确的 `-p` 与 `-c` 参数。

## 分阶段执行

以下命令只在具体候选获准上线后，在广场所属 Linux 主机执行。它们不是本 PR 的自动部署任务；CI 只使用本地测试夹具。

```sh
sudo python3 /private/kit/release.py check --plan /private/deployment.local.json
sudo python3 /private/kit/release.py stage --plan /private/deployment.local.json
sudo python3 /private/kit/release.py switch --plan /private/deployment.local.json
sudo python3 /private/kit/release.py verify --plan /private/deployment.local.json
sudo python3 /private/kit/release.py activate --plan /private/deployment.local.json
sudo python3 /private/kit/release.py verify --plan /private/deployment.local.json
```

| 阶段 | 效果与条件 |
| --- | --- |
| `check` | 只读核对既有进程、归档、清单、公开 CA、配置、当前网关与独立 master，不改服务 |
| `stage` | 创建唯一 release 与 0700 操作/备份目录；备份既有 unit、drop-in、环境与完整网关；复制同锁定依赖和公开 CA；保留当前服务 |
| `switch` | 检查输入与进程未漂移；维护、停止旧进程，再做一致数据库与持久文件备份并验证归档；切换仅广场的网关与 unit，启动新版，核对授权与数据摘要；保持维护 |
| `verify` | 独立进程回读实际 release、源码、配置、健康、授权与维护状态；开放后另核对两个旧入口的跳转、CLI 字节/摘要和身份拒绝 |
| `activate` | 独立核验维护状态与数据后开放入口，仅重载已核对的 Nginx master；再次验证正式与旧入口 |

此版本专用于**依赖锁定内容不变**的更新；比较解析后的 lock JSON，允许 CRLF/LF 字节差异。依赖有变化时预检直接阻止复制，须另行准备并验证新的 Linux 依赖安装方案。本脚本不以 root 身份运行 npm 安装。

暂存目录为 `<root>/deployments/<release>/`。`state.json` 固定计划摘要、输入摘要、已完成阶段和备份摘要。phase 为 `FAILED`、`UNKNOWN` 或有遗留锁文件时禁止重放写入；超时不等于没有执行。先运行只读检查并核对真实服务，保留失败 release、备份和证据。不要手工改状态为成功或删除锁后直接重跑。

数据库使用容器内部已有环境完成 `pg_dump -Fc`，不在命令行传递凭据；`pg_restore --list` 只校验备份结构，不执行恢复。持久文件在广场停止后备份。备份目录 0700，文件受 0077 umask 保护，均留在原主机。备份清单验证通过不等同于做过恢复演练。

## 旧客户端与验收

旧来源 API 保持 HTTP/HTTPS 原 origin，JSON 中的固定广场 URL 适配回原 origin，维持 CLI 回执绑定；不重定向携带来源凭据的 API 请求。代理清除 Cookie、天宫 Token 头、压缩协商和 Set-Cookie，保留原来源授权、正文及幂等标识。身份、个人空间、权限、后台、看板和发布确认/重试必须进入正式同源网页；Python 和 ZIP 等非 JSON 内容不得改写。

脚本技术回读通过后，使用正常浏览器从天宫入口完成真实账号核验：登录、刷新、超级管理员稳定绑定、管理员看板、普通账号拒绝，以及切换/停用/撤销后的响应。不要通过复制 Token、读取浏览器存储或伪造 HTTP 身份完成验收；不使用业务应用做破坏性权限试验。未完成的真实多账号检查单独记为未验证。

存量应用的 ID、版本、公开范围和负责人保持原样；归属只能逐项核验，脚本不批量认领、不改分享、不授予数据读取特权。

## 故障处理

失败先检查实际维护状态、所属 unit、网关 master、`state.json` 和保护目录里的备份；不重启全局 Nginx、PM2、Docker，不清理历史目录。激活后的技术验证失败会保留原失败记录，并只尝试一次关闭入口和重载所属 master；无法确认维护生效则标为 `UNKNOWN`，不重放切换或启动。

若入口已开放或生产已产生身份/受限数据，保持识别权限表的版本：可在获准后将 `config/plaza-entry-state.conf` 设置为 `return 503;`，语法检查后仅重载所属 master，再向前修复。不能直接切回忽略权限表的旧程序。即使失败发生在开放前，也应先核对是否出现新的权限数据；数据库恢复、版本回退、删除和清理均须另定明确方案，本脚本不执行这些操作。

## 本地与 CI 检查

```sh
python -B -m unittest discover -s ops/tiangong/tests -p 'test_*.py' -v
npm run test:docs
```

Python 用例覆盖打包来源/构建绑定、归档攻击、计划注入、配置隔离、失败重放和发布阶段约束。Linux CI 使用一次性本地 Nginx、测试证书和合成上游验证 TLS、维护闸门、真实客户端头、来源隔离、JSON 回执改写及非 JSON 字节。没有本机 Nginx/OpenSSL 的开发环境会明确跳过该部分，CI 要求它实际执行。所有检查都不连接生产或真实天宫身份。
