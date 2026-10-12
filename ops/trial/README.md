# 内网试用部署

本目录只处理首次、隔离的内网试用安装，范围见 [Phase #9](https://github.com/Dylan5237/ai-app-plaza/issues/9)。不会操作已有 Nginx、PM2、系统 Node 或业务数据库。已有安装再次运行会拒绝覆盖，恢复前须先检查实际状态。

## 组成

- `/opt/ai-app-plaza-trial/releases/<日期-SHA>`：已提交的应用源码、前端构建和独立依赖。
- `/opt/ai-app-plaza-trial/runtime/`：Node 22.22.1，通过官方 HTTPS 下载与 SHA-256 校验；不替换系统运行时。
- 依赖安装以非 root 身份运行，使用独立 HOME、缓存和最小环境；不继承管理员 npm 配置，安装结束后产物恢复为 root 所有。
- `/opt/ai-app-plaza-trial/config/`：服务密钥和数据库配置，部署时随机生成，目录 0700、文件 0600，不入 Git、不回显。
- `/opt/ai-app-plaza-trial/data/postgres/`：专属 PostgreSQL 数据。
- `ai-app-plaza-trial.service`：systemd 管理的应用，动态低权限身份，只读文件系统、私有临时目录，512 MiB 内存/1 CPU 上限。
- `ai-app-plaza-trial-db`：独立 Docker 数据库，512 MiB/1 CPU，上游缓存镜像的不可变 ID 由部署前检查指定；仅发布到 127.0.0.1。

本次选用 HTTP 私有 IP 试用入口；传输不加密，不用于公网发布。`ALLOW_INSECURE_PORTAL=1` 必须显式启用且只接受 RFC1918 数字 IPv4 地址；默认非本地环境仍要求 HTTPS。数据库仍为 PostgreSQL，不使用 `PLAZA_LOCAL` 绕过部署要求。

## 先检查，再安装

1. 核验 SSH host key 和当前授权；只读记录原服务的启动状态、监听端口、Nginx 配置哈希与页面/API 响应。应用端口和数据库端口必须空闲，目标目录、unit、容器名不能已存在。
2. 在独立 checkout 中执行 `npm ci`、`npm run typecheck`、`npm test`、`npm run build`，提交并推送固定源码。不要打包任何 `.env`、node_modules 或原始项目资料。
3. 执行 `python ops/trial/package.py --date YYYYMMDD --output artifacts/trial-release`。输出包含 release ID、完整源码 SHA、包 SHA-256 和文件级清单。
4. 将包和 `deploy.py` 传至已确认的唯一远端临时路径，再回读大小和 SHA-256。部署脚本需要 Python 3.12+、Docker、systemd，联网只下载独立 Node 运行时和锁定 npm 依赖。
5. `deploy.py` 参数为 `--archive <路径> --sha256 <包哈希> --release <release ID> --host <私网IP> --port <空闲端口> --db-port <本机空闲端口> --gitlab <GitLab根地址> --postgres-image <已核验sha256镜像ID>`。先附加 `--check` 做零写入预检，再用同组参数安装。
6. 回读 `/api/health`、`/api/apps`、首页和静态资源，检查复制发布提示词。重启本应用实例并核验数据库记录保留；再次核对原服务配置、启动时间和健康状态。

部署使用普通 HTTP API，不需要先配置 MCP。只部署空目录门户，既不会往 GitLab 写入应用资料，也不会默认把 17 项历史 Mock 放进目录。真实 GitLab 项目发布与具体 Agent Host 接入要另行验证。

## 状态与恢复

`deployment.json` 记录当前阶段、源码 SHA、包/运行时哈希和入口。命令中断时，先检查该文件、本应用的 systemd 状态和专属容器；不能把超时当作“未执行”再覆盖安装。

运行中只需通过 `systemctl status ai-app-plaza-trial.service` 和专属容器检查状态。日志禁止携带请求头、发布凭证或配置内容；不要输出 `docker inspect` 的完整环境，也不要读取/复制 `config/*.env` 到报告。

需要停止试用或恢复版本时，仅操作本应用的 unit/容器，保留目录、密钥和数据库；移除、清库、覆盖已有安装须先明确范围。不得执行全局 PM2 重启、Docker compose 全量停服、镜像清理或共享 Nginx 重载。
