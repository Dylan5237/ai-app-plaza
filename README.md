# AI应用广场

一个无需登录的 AI 应用门户。使用者按任务和作者标签找到应用，查看说明后打开平台或将接入提示词交给自己的 Agent；作者由 Agent 整理 GitLab 资料，预览确认后收录。

启用统一托管后，负责人复制发布提示词到有当前项目文件和执行权限的 AI Harness，AI 自动整理源码与应用资料、上传并返回预览链接。负责人无需预建 GitLab 仓库或配置个人 GitLab 令牌。

当前开发范围为 **托管发布 → 发现 → 使用及更新**，见[首版边界](docs/product/mainflow-scope.md)与 [Phase #17](https://github.com/Dylan5237/ai-app-plaza/issues/17)。统一托管仅保存 GitLab 发布快照，不执行应用代码；没有登录、账号、收藏、审批或安装执行器。历史 17 项 Mock 原型仅在 `?prototype=1` 展示，不进入真实目录。实现、验证、部署和业务验收分别记录在 Phase 中。

## 本地运行

需要 Node.js 22.16+；历史原型生成和作者侧托管上传工具需要 Python 3.10+。

```powershell
npm ci
Copy-Item .env.example .env
# 由 Agent 将 .env 的 GITLAB_URL 设置为实际 GitLab 根地址
npm run build
npm start
```

默认地址 `http://127.0.0.1:4173`。`.env` 已忽略，不提交令牌或真实配置。第一次运行是空目录；没有自动注入的示例应用。本地模式使用文件持久化的 PGlite（PostgreSQL 引擎），数据与自动生成的加密密钥位于 `artifacts/plaza-local/`。保留该目录可跨重启恢复记录。

开发时使用 `npm run dev`，它启动同源 Vite 网页和 API。`npm run dev:prototype` 用于单独维护历史原型。访问地址须与 `PUBLIC_ORIGIN` 一致；不要同时占用同一端口。

非本地运行必须显式配置 `DATABASE_URL`（PostgreSQL）、`PLAZA_SECRET`（安全随机生成并持久保管）和 HTTPS `PUBLIC_ORIGIN`，并移除 `PLAZA_LOCAL=1`。仅可信内网试用可显式设置 `ALLOW_INSECURE_PORTAL=1`，使用 RFC1918 数字 IPv4 的 HTTP 入口；这不提供链路加密，不改变默认 HTTPS 要求。内部 HTTP GitLab 需要部署者明确设置 `ALLOW_INSECURE_GITLAB=1`；这仅允许访问已配置实例，不关闭来源/路径校验。启动不会部署到任何远端。独立试用部署方式见 [部署说明](ops/trial/README.md)。

## 发布与使用

Agent 首先阅读[上传、分享与更新接入规范](docs/integration/publishing.md)，再取得目标门户的在线契约。该规范统一说明 v2 资料、托管/直连发布、作者确认、版本更新、回执恢复及已知限制；旧资料契约页只保留索引。

配置统一托管时，“分享我的AI应用”默认提供免 GitLab 配置的发布提示词。AI 从项目中准备 `ai-app.json`、共享说明与必要源码，运行广场提供的 Python 辅助工具完成上传。服务端只在固定群组内创建私有独立仓库、commit、版本 tag 和 Release，随后仍使用原有来源核验及作者私有预览确认。新仓库关闭 CI，上传内容不在广场执行。

每个应用的专属发布凭证由辅助工具保存在用户私有目录，Windows 用 DPAPI 保护，POSIX 使用私有文件权限；它不能更新其他应用，也不是 GitLab 令牌。首次运行前保存恢复记录，网络不确定时沿用原操作和原内容；更新自动复用凭证并核对广场版本。姓名仍由负责人确认，是作者声明；GitLab 操作身份由统一托管服务提供，不宣称员工实名验证。

上传前先用官方工具 `--validate` 做本地及服务端无写入校验；诊断只提供安全的相对路径、规则和行/字段定位。预检不会建立发布身份、修改 receipt 或创建任何发布对象，通过也不表示已上传。工具返回校验、鉴权或发布错误时，按诊断处理，不能改用正式 POST 做小包探测或换身份重发。`--status` 查看本机已保存回执，`--recover` 只读取回服务器原操作的回执；两者不重传源码。缺少有效预览链接或保存失败时属于交接待恢复，须保留原 receipt、凭据、幂等键和原包。操作与诊断说明见 [发布校验与恢复](docs/ops/publishing-validation-recovery.md)。

统一托管要求服务器同时设置 `PLAZA_MANAGED_GROUP_ID`、`PLAZA_MANAGED_GROUP_PATH`、`PLAZA_MANAGED_GITLAB_TOKEN`。使用仅管理目标群组的授权，原始令牌不进入提示词、网页、作者客户端或日志。未启用时，以及更新原有直连 GitLab 的应用时，沿用下述直接 GitLab 发布流程；`GET /api/publish-contract?mode=gitlab` 可显式取得该规范。

在页面点“分享我的AI应用”并复制提示词。项目 Agent 取得 `/api/publish-contract` 中的 schemaVersion 2 规范，生成 `ai-app.json` 和明确可共享的 Markdown。每位作者都需提供中文姓名和英文全名或完整拼音；缺任一姓名时 Agent 会先询问，不从 GitLab 用户名、邮箱或 Git 配置推测。作者不用填写资料表格。

原有直连发布接口只读取 GitLab。作者 Agent 按现有 GitLab 授权和项目发布流程提交资料，并为目标 commit 创建版本 tag 与正式 GitLab Release；`projectVersion`、tag 和 Release 必须匹配，格式为 `1.2.3` / `v1.2.3`，也支持合法预发布号。不要移动已有 tag；新 commit 应使用新的匹配版本号、tag 和 Release。提交与作者确认时，门户都会复核 Release.commit.id、tag.commit.id 和请求中的完整 commit SHA 一致，并重新读取共享资料。广场不替作者执行 GitLab 写入。作者 Agent 将既有读取授权通过 `X-GitLab-Token` 请求头提供，门户核验当前项目 Maintainer/Owner 权限。授权应支持读取用户、项目、仓库和 Release API（例如个人令牌 `read_api`）；不要在对话中提供令牌，也不要将其写入提示词或命令行实参。

Agent 返回本次专属预览链接，作者检查内容后确认。**任何持有完整链接的人都能查看和确认本次发布**；链接 24 小时有效，应只交给本次作者。它不是门户账号，也不是 GitLab 令牌。网页会把临时凭证保存在本标签页的 sessionStorage 中并从地址栏移除；同标签页刷新可继续。

收录后，所有能访问门户的人都能查看已批准的介绍和使用资料。平台应用直接跳转；其他应用复制固定版本接入提示词，由用户自己的 Agent 完成授权、下载和安装。源码、软件包和目标系统仍使用它们本来的权限，广场不代理下载、不执行代码。

作者更新时，在管理后台的应用列表或详情点“发布新版本”，复制带应用上下文的更新提示词。Agent 保持原项目与 appKey，准备更高版本资料：托管模式由服务器创建匹配 tag 和 Release，直连模式由作者 Agent 按项目授权准备；随后生成预览。作者核对版本变化与变更项后确认，原应用链接不变。重复的相同内容不会重复收录；同版本改内容、版本倒退及旧预览覆盖会被拒绝，失败时保留当前版本。

使用者升级仍从“接入我的Agent”进入。提示词要求 Agent 先核对广场已确认版本及本地状态，按未安装、旧版或已是目标版本分别处理，保留配置与本地修改，并执行最小验证。广场不记录本地安装情况、不执行升级、不自动追踪未收录的 GitLab Release。

## 管理后台与本地集成

连续点击广场 Logo 三次进入 `/admin`；旧 `/private-previews` 自动跳转。应用管理、待收录与更新、上传占位集中在后台；应用详情、完整资料、来源、Agent 说明、更新提示词和发布预览确认继续使用原组件和服务。广场保留发现、使用和首次分享，详情不再开放作者更新入口。

本地候选可执行 `npm run build`，再运行 `npm run dev:management-local`，打开 `http://127.0.0.1:9442/admin`。该启动脚本只连接隔离 PGlite 和本地 GitLab 协议 fixture，包含可确认的首次上传、待确认更新和一个固定的合成上传占位；重启后重新准备测试数据，不读取真实 `.env` 或 GitLab。详见[本地集成说明](docs/ops/local-management-integration.md)。

管理写入口只有显式 `PLAZA_LOCAL_MANAGEMENT=1` 且 `PLAZA_LOCAL=1`、HOST/PUBLIC_ORIGIN 均为同端口的 `127.0.0.1` 时才启用。默认不提供 `/api/management/*`，非本地或生产环境不能启用此候选能力；生产管理员访问策略不属于本轮本地集成。原作者专属预览协议和只读 `/api/preview-admin/*` 保持兼容，不导出作者票据。后者的代理校验、限频和读取边界见[只读接口说明](docs/ops/private-preview-administration.md)。

## Agent 接口

HTTP 与 MCP 使用同一套服务逻辑。HTTP 是复制发布提示词后的直接入口，无须先安装 MCP。现有 MCP 的提交工具只提交 GitLab 固定来源，托管文件上传使用契约下发的官方 CLI；完整字段与状态见[统一接入规范](docs/integration/publishing.md#7-http-与-mcp-对照)。

| 操作 | 接口 |
| --- | --- |
| 规范与发布提示词 | `GET /api/publish-contract` |
| 托管上传工具 | `GET /api/publisher-cli.py`，需开启统一托管，规范包含工具 SHA-256 |
| 无写入托管资料校验 | `POST /api/managed-publications/validate`，与上传共享包规则，不创建发布身份或业务记录 |
| 上传应用发布快照 | `POST /api/managed-publications`，仅应用专属发布凭证，不接收作者 GitLab 令牌 |
| 读取原托管操作回执 | `GET /api/managed-publications/receipt`，原应用专属凭据和原 `Idempotency-Key`，不重传源码或推进发布 |
| 作者读取托管更新状态 | `GET /api/managed-apps/:id/status`，使用应用专属发布凭证核对当前目录修订 |
| 指定应用的更新提示词 | `GET /api/apps/:id/publish-contract`，包含当前版本与修订号 |
| 提交固定来源 | `POST /api/publications`，须包含 GitLab 版本 `tag`，并提供 `X-GitLab-Token` + `Idempotency-Key` |
| 查询私有预览/结果 | `GET /api/publications/:id`，Bearer 本次凭证 |
| 作者确认收录 | `POST /api/publications/:id/confirm`，本次凭证及预览 revision/digest |
| 恢复核验/已确认收录 | `POST /api/publications/:id/retry`，本次凭证 |
| 发现与作者标签 | `GET /api/apps?query=...&tags=...&page=1&pageSize=12`，多标签为交集；`pageSize` 可选，1–100，默认 8；网页按可用高度选择完整卡片行数 |
| 已有能力标签 | `GET /api/tags`，返回已有名称及单应用最多 3 个的上限；发布规范也返回 `tagPolicy` |
| 详情与接入说明 | `GET /api/apps/:id`、`GET /api/apps/:id/instructions/:entryId` |

单个应用最多 3 个核心能力标签，优先复用已有名称。目录与详情的 `tags` 是有效分类，`manifest.tags` 保留固定来源原文；两者在未整理时相同。存量整理与回滚操作见 [标签清洗说明](docs/ops/capability-tag-cleanup.md)。

可选 MCP 通过官方 TypeScript SDK 的 stdio 适配器连接同一 HTTP 服务；不另建后端。项目目录内运行 `npm run mcp`；Host 配置由 Agent 自动生成：Node 的参数使用本 checkout 中 `node_modules/tsx/dist/cli.mjs` 与 `server/mcp.ts` 的**绝对路径**，环境配置 `PLAZA_URL` 和本机安全提供的 `GITLAB_TOKEN`。后者只用于发布，可不配置以使用只读工具。

工具为 `get_publish_contract`（可传 `appId` 获取更新上下文）、`submit_candidate`、`get_publish_status`、`retry_registration`、`get_agent_instructions`（安装／升级提示词）；没有自动确认工具。MCP stdout 只用于协议消息。真实 Codex/WorkBuddy Host 配置仍须在各 Host 中验证，协议进程测试不代替 Host 验收。

## 验证

```powershell
npm run typecheck
npm run test:docs
npm test
npm run build
npm run test:e2e
npm run test:prototype
```

浏览器测试需要 Playwright Chromium，或设置 `PLAYWRIGHT_CHANNEL=chrome` / `PLAYWRIGHT_EXECUTABLE_PATH` 指向已安装浏览器。本地主流程测试使用受控 GitLab 协议服务与真实 PostgreSQL 引擎，不向公司仓库写入。测试代码区分这些替身与实际服务；结果和截图位于忽略的 `artifacts/`。

`npm run test:docs` 使用运行时资料校验器检查 v2 示例，解析旧 Schema 到服务端 Schema 的引用，并检查接入规范及相关文档的本地链接和 Markdown 标题。GitHub Actions 的 `Publishing documentation / publishing-docs` 在相关 PR 和 main 更新时执行同一检查，不访问真实广场或 GitLab，不证明业务运行或部署通过。

`npm test` 最多并发运行 4 个测试文件，为测试中的 PGlite/WASM 实例和服务启动子进程保留资源。测试仍并发执行；启动探活有 30 秒总截止，为 Windows 并发测试中的 PGlite 冷启动留出调度余量，不代表产品服务 SLA。每次探测都受剩余预算约束，且必须同时满足被测子进程的启动标记和完整健康响应；子进程提前退出会立即失败。失败时记录脱敏后的子进程状态和最后一次健康探测。排查资源争用时可用 `node --import tsx --test tests/*.test.ts` 对照 Node 默认并发，或用 `node --import tsx --test --test-concurrency=1 tests/*.test.ts` 作串行对比。

## 代码与项目约定

- `src/`：当前 Vue/Element Plus 门户；`server/`：API、GitLab 读取、SQL 数据与 MCP 适配器。
- `server/contracts/app-manifest.schema.json`：唯一完整可执行资料 Schema；`docs/integration/publishing.md`：统一接入规范；`docs/product/mainflow-scope.md`：本次最小范围。
- `prototype/`、`scripts/apply_compact_portal.py` 与 `build_fuxi_portal.cjs`：历史 Mock 原型。不要直接修改生成的 `public/portal.html`。
- `tests/`：领域、HTTP、MCP 进程和浏览器测试；`archive/`、`artifacts/`：本地历史和证据，不提交。
- 唯一写入权威为 [GitHub origin](https://github.com/Dylan5237/ai-app-plaza)，APO 约定见 `AGENTS.md`。主题分支提交后按既有授权推送；不自动合并、部署或宣布 Phase Accept。

技术依据：[GitLab 文件 API](https://docs.gitlab.com/api/repository_files/)、[PGlite 本地 PostgreSQL](https://pglite.dev/docs/)、[MCP 官方 SDK](https://modelcontextprotocol.io/docs/sdk)。本地嵌入式数据库用于开发和测试，生产配置使用外部 PostgreSQL；未声称已在公司环境完成上线。

## 文档与历史记录

[需求说明](docs/product/requirements.md)与[架构说明](docs/architecture/architecture.md)已按现行实现校正；Agent 接入统一从[上传、分享与更新规范](docs/integration/publishing.md)进入。[旧资料契约地址](docs/architecture/data-contract.md)保留迁移说明，旧 Schema 路径引用服务端 Schema，三个资料样例已更新为 v2。

[2026-10-10 设计决策](docs/architecture/decisions-2026-10-10.md)、[历史架构图](docs/architecture/plaza-architecture.html)与[原型说明](docs/product/capability-boundaries.md)保留当时语境，不能用其中的登录、可选 Release 等安排指导现行发布。阶段状态和验收仍以 GitHub 控制面为准。
