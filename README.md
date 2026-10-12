# AI应用广场

一个无需登录的 AI 应用门户。使用者按任务和作者标签找到应用，查看说明后打开平台或将接入提示词交给自己的 Agent；作者由 Agent 整理 GitLab 资料，预览确认后收录。

当前开发范围为 **发布收录 → 发现 → 使用**，并补齐作者发布新版本与使用者本地升级，见[首版边界](docs/product/mainflow-scope.md)与 [Phase #14](https://github.com/Dylan5237/ai-app-plaza/issues/14)。没有登录、账号、收藏、审批、应用托管或安装执行器。历史 17 项 Mock 原型仅在 `?prototype=1` 展示，不进入真实目录。实现、验证、部署和业务验收分别记录在 Phase 中。

## 本地运行

需要 Node.js 22.16+、Python 3.10+（仅历史原型生成使用）。

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

在页面点“分享我的AI应用”并复制提示词。项目 Agent 取得 `/api/publish-contract` 中的 schemaVersion 2 规范，生成 `ai-app.json` 和明确可共享的 Markdown。每位作者都需提供中文姓名和英文全名或完整拼音；缺任一姓名时 Agent 会先询问，不从 GitLab 用户名、邮箱或 Git 配置推测。作者不用填写资料表格。

广场发布接口只读取 GitLab。作者 Agent 按现有 GitLab 授权和项目发布流程提交资料，并为目标 commit 创建版本 tag 与正式 GitLab Release；`projectVersion`、tag 和 Release 必须匹配，格式为 `1.2.3` / `v1.2.3`，也支持合法预发布号。不要移动已有 tag；新 commit 应使用新的匹配版本号、tag 和 Release。提交与作者确认时，门户都会复核 Release.commit.id、tag.commit.id 和请求中的完整 commit SHA 一致，并重新读取共享资料。广场不替作者执行 GitLab 写入。作者 Agent 将既有读取授权通过 `X-GitLab-Token` 请求头提供，门户核验当前项目 Maintainer/Owner 权限。授权应支持读取用户、项目、仓库和 Release API（例如个人令牌 `read_api`）；不要在对话中提供令牌，也不要将其写入提示词或命令行实参。

Agent 返回本次专属预览链接，作者检查内容后确认。**任何持有完整链接的人都能查看和确认本次发布**；链接 24 小时有效，应只交给本次作者。它不是门户账号，也不是 GitLab 令牌。网页会把临时凭证保存在本标签页的 sessionStorage 中并从地址栏移除；同标签页刷新可继续。

收录后，所有能访问门户的人都能查看已批准的介绍和使用资料。平台应用直接跳转；其他应用复制固定版本接入提示词，由用户自己的 Agent 完成授权、下载和安装。源码、软件包和目标系统仍使用它们本来的权限，广场不代理下载、不执行代码。

作者更新时，在应用详情点“发布新版本”，复制带应用上下文的更新提示词。Agent 保持原项目与 appKey，准备更高版本的 Release 并提交预览；作者核对版本变化与变更项后确认，原应用链接不变。重复的相同内容不会重复收录；同版本改内容、版本倒退及旧预览覆盖会被拒绝，失败时保留当前版本。

使用者升级仍从“接入我的Agent”进入。提示词要求 Agent 先核对广场已确认版本及本地状态，按未安装、旧版或已是目标版本分别处理，保留配置与本地修改，并执行最小验证。广场不记录本地安装情况、不执行升级、不自动追踪未收录的 GitLab Release。

## Agent 接口

HTTP 与 MCP 使用同一套服务逻辑。HTTP 是复制发布提示词后的直接入口，无须先安装 MCP。

| 操作 | 接口 |
| --- | --- |
| 规范与发布提示词 | `GET /api/publish-contract` |
| 指定应用的更新提示词 | `GET /api/apps/:id/publish-contract`，包含当前版本与修订号 |
| 提交固定来源 | `POST /api/publications`，须包含 GitLab 版本 `tag`，并提供 `X-GitLab-Token` + `Idempotency-Key` |
| 查询私有预览/结果 | `GET /api/publications/:id`，Bearer 本次凭证 |
| 作者确认收录 | `POST /api/publications/:id/confirm`，本次凭证及预览 revision/digest |
| 恢复核验/已确认收录 | `POST /api/publications/:id/retry`，本次凭证 |
| 发现与作者标签 | `GET /api/apps?query=...&tags=...&page=1`，多标签为交集，每页 8 项 |
| 详情与接入说明 | `GET /api/apps/:id`、`GET /api/apps/:id/instructions/:entryId` |

可选 MCP 通过官方 TypeScript SDK 的 stdio 适配器连接同一 HTTP 服务；不另建后端。项目目录内运行 `npm run mcp`；Host 配置由 Agent 自动生成：Node 的参数使用本 checkout 中 `node_modules/tsx/dist/cli.mjs` 与 `server/mcp.ts` 的**绝对路径**，环境配置 `PLAZA_URL` 和本机安全提供的 `GITLAB_TOKEN`。后者只用于发布，可不配置以使用只读工具。

工具为 `get_publish_contract`（可传 `appId` 获取更新上下文）、`submit_candidate`、`get_publish_status`、`retry_registration`、`get_agent_instructions`（安装／升级提示词）；没有自动确认工具。MCP stdout 只用于协议消息。真实 Codex/WorkBuddy Host 配置仍须在各 Host 中验证，协议进程测试不代替 Host 验收。

## 验证

```powershell
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:prototype
```

浏览器测试需要 Playwright Chromium，或设置 `PLAYWRIGHT_CHANNEL=chrome` / `PLAYWRIGHT_EXECUTABLE_PATH` 指向已安装浏览器。本地主流程测试使用受控 GitLab 协议服务与真实 PostgreSQL 引擎，不向公司仓库写入。测试代码区分这些替身与实际服务；结果和截图位于忽略的 `artifacts/`。

## 代码与项目约定

- `src/`：当前 Vue/Element Plus 门户；`server/`：API、GitLab 读取、SQL 数据与 MCP 适配器。
- `server/contracts/app-manifest.schema.json`：可执行资料规范；`docs/product/mainflow-scope.md`：本次最小范围。
- `prototype/`、`scripts/apply_compact_portal.py` 与 `build_fuxi_portal.cjs`：历史 Mock 原型。不要直接修改生成的 `public/portal.html`。
- `tests/`：领域、HTTP、MCP 进程和浏览器测试；`archive/`、`artifacts/`：本地历史和证据，不提交。
- 唯一写入权威为 [GitHub origin](https://github.com/Dylan5237/ai-app-plaza)，APO 约定见 `AGENTS.md`。主题分支提交后按既有授权推送；不自动合并、部署或宣布 Phase Accept。

技术依据：[GitLab 文件 API](https://docs.gitlab.com/api/repository_files/)、[PGlite 本地 PostgreSQL](https://pglite.dev/docs/)、[MCP 官方 SDK](https://modelcontextprotocol.io/docs/sdk)。本地嵌入式数据库用于开发和测试，生产配置使用外部 PostgreSQL；未声称已在公司环境完成上线。
