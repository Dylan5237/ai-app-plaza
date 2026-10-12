import { readFile } from 'node:fs/promises';
import type { Config } from './config.js';

export async function publishContract(config: Pick<Config, 'publicOrigin' | 'gitlabUrl' | 'audience'>) {
  const schema = JSON.parse(await readFile(new URL('./contracts/app-manifest.schema.json', import.meta.url), 'utf8'));
  const submitUrl = `${config.publicOrigin}/api/publications`;
  const prompt = `请基于当前项目上下文，将我的 AI 应用分享到 AI应用广场。

广场地址：${config.publicOrigin}
GitLab 实例：${config.gitlabUrl}
分享范围：${config.audience}
规范与 JSON Schema：GET ${config.publicOrigin}/api/publish-contract

1. 先读取项目实际代码、README、运行说明与已有 GitLab remote。按 schemaVersion 2 规范生成 ai-app.json 和明确可共享的 Markdown；可以用一个 docs/plaza-usage.md 同时作为介绍和使用说明。项目名称、能力、作者自定义标签、示例、条件、限制与两类入口均须有项目依据。summary 用一句话说明价值，scenarios 提炼约 3 项主要用途，requirements 和 limitations 先列关键项并尽量一句一项；操作细节写入完整 Markdown，不删去必要限制。不确定的关键项只向我澄清，不要猜测，不要让我手填表单。不要自动改变已有 appKey。每位作者都必须提供中文姓名和英文全名或完整拼音；任一缺失时先向我询问，再继续准备资料。不得从 GitLab 用户名、邮箱或 Git 配置推测或补全姓名。
2. 平台应用登记真实 URL；其他应用准备 Agent 接入说明，写清固定版本的取得方式、环境要求、安装步骤、最小验证和失败处理。保留原有 SKILL.md；不要把提示词复制或收录当作安装成功。不得包含凭据、内部配置或未经允许分享的资料。
3. 先核对 ai-app.json 的 projectVersion，再使用当前 Host 已有且经我授权的 GitLab 工具，在已有目标项目中按原分支/MR 政策提交资料。版本使用 MAJOR.MINOR.PATCH 格式，可带 v 前缀和合法预发布号，例如 1.2.3、v1.2.3-rc.1。按项目现有授权和发布流程，为目标 commit 创建同版本 tag 和正式 GitLab Release；广场只接受 tag、Release、projectVersion 一致的来源。不要改写或移动已有 tag；新 commit 应准备新的匹配版本号、tag 和 Release。上传源码或文档会先向 GitLab 原有读者公开；不得把广场确认当作 GitLab 写入授权。不要创建仓库或代替我合并/部署。由你通过 GitLab 取得数字项目 ID、最终完整 commit SHA、版本 tag 和 Release 后再提交广场。若缺少姓名、写入授权或发布权限，说明缺口并停止对应步骤。
4. 使用现有 GitLab 授权，要求当前用户具有目标项目有效 Maintainer/Owner 权限与只读 API/仓库读取能力。令牌只在本机安全配置或进程环境中读取，通过 X-GitLab-Token 请求头发送；不要把令牌写入 JSON、提示词、命令行实参、仓库、日志或对话。没有可安全使用的授权时说明缺口，不要索要聊天中的密码或令牌。
5. POST ${submitUrl}，Content-Type: application/json，X-GitLab-Token 为上述授权，Idempotency-Key 为本次唯一 UUID。JSON 为 {"projectId":"GitLab 数字项目 ID","appKey":"稳定标识","manifestPath":"ai-app.json","commitSha":"完整 SHA","tag":"v1.2.3"}，更新时可附 expectedAppRevision。不要传源码或文档副本。门户会重新读取并核验 Release.commit.id、tag.commit.id 与请求 commitSha 完全一致，且 Release tag、tag、projectVersion 表示同一版本，并核验共享文件。若 Release 缺失、Release/tag 指向不同提交、tag 已移动或版本不一致，按返回说明为正确的新版本修复 GitLab 来源后重新提交；发生网络不确定时用同一个幂等键重试，不重新上传源码。
6. 将返回的 previewUrl 交给我打开，说明这条链接只用于本次预览确认，不要转发或公开。由我检查面向所有门户访问者的内容并确认收录；不要调用确认接口或替我点击确认。需要修改时更新 GitLab 内容并重新生成预览。
7. 用返回的 id/ticket 查询 GET /api/publications/{id}（Authorization: Bearer ticket）取得真实结果。失败按 nextAction 处理，必要时 POST /api/publications/{id}/retry；只恢复广场收录，不重复源码上传。若已经收录，提供条目链接，不声称安装或业务执行已经成功。

如果当前 Host 已配置本广场 MCP，可使用 get_publish_contract、submit_candidate、get_publish_status、retry_registration；这些工具不提供确认收录能力。`;
  return { prompt, schema, gitlabUrl: config.gitlabUrl, submitUrl, audience: config.audience };
}
