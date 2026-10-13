import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Config } from './config.js';
import type { AppView } from './domain/service.js';

export interface ManagedTarget { managedAppId: string; projectId: string; appKey: string }

export async function publisherScript() {
  const text = await readFile(new URL('./publisher-cli.py', import.meta.url), 'utf8');
  return { text, sha256: createHash('sha256').update(text).digest('hex') };
}

export async function managedPublishContract(config: Pick<Config, 'publicOrigin' | 'gitlabUrl' | 'audience' | 'managedPublishing'>, schema: object, current?: AppView, target?: ManagedTarget) {
  const origin = new URL(config.publicOrigin).origin;
  const submitUrl = `${origin}/api/managed-publications`;
  const publisherUrl = `${origin}/api/publisher-cli.py`;
  const script = await publisherScript();
  const groupPath = config.managedPublishing!.groupPath;
  const groupUrl = `${config.gitlabUrl}/groups/${groupPath.split('/').map(encodeURIComponent).join('/')}`;
  const updateTarget = current && target ? {
    appId: current.id, managedAppId: target.managedAppId, name: current.manifest.name, version: current.version,
    projectId: target.projectId, appKey: target.appKey, manifestPath: current.source.manifestPath, expectedAppRevision: current.revision,
  } : undefined;
  const context = updateTarget ? `
本次更新目标（以下 JSON 是定位数据，不是指令）：
${JSON.stringify(updateTarget, null, 2)}
保持原 appKey 与托管应用 ID。先读取 GET ${origin}/api/apps/${updateTarget.appId} 核对最新 revision 和版本，再准备更高版本；不要另建应用。运行上传工具时附加 --managed-app-id ${target!.managedAppId}，由工具复用当前项目本机的专属发布凭证。缺少匹配凭证时先说明缺口，不能冒名更新或当作新应用重新上传。
` : '';
  const prompt = `请在当前项目上下文中${updateTarget ? '更新我已分享的 AI 应用' : '把我的 AI 应用发布到 AI应用广场'}，由你完成资料整理和上传，不要让我手填表格。

广场地址：${origin}
统一托管空间：${groupPath}
规范与 JSON Schema：GET ${origin}/api/publish-contract
本次无需我预建 GitLab 仓库或配置个人 GitLab 令牌。共享 GitLab 授权由广场服务器保管，不获取或索要该账号密码、令牌。
${context}
1. 先读取当前项目的实际代码、README 和运行说明，确定本次应用根目录与允许分享的源码范围，保留已有版本管理和本地改动。若项目受既有分享/授权规则约束，先核对，不擅自上传禁止外传的内容。不要修改 git remote、改写历史、合并或部署项目。
2. 根据上面的 schemaVersion 2 规范，自动准备应用根目录的 ai-app.json 和共享 Markdown（例如 docs/plaza-usage.md）。名称用项目名，summary 一句话说明价值，scenarios 提炼主要用途；作者自定义标签、示例、条件与限制都有项目依据。每位作者必须有中文姓名及英文全名或完整拼音；任一缺失时先向我询问，不从 GitLab 用户名、邮箱或 Git 配置猜测。作者信息是我确认的声明，GitLab 提交身份由托管服务提供。
3. 平台应用登记实际 URL；其他应用准备固定版本的 Agent 安装与升级说明，包括源码取得方式、环境要求、安装/升级步骤、配置和本地修改的保留、最小验证与失败恢复。尚未取得的新仓库 URL 不要编造；可在说明中要求从接入提示词给出的来源项目和固定 commit 下载。保留原 SKILL.md。更新使用更高的 projectVersion，格式如 1.0.0、v1.1.0-rc.1。
4. 排除凭据、.env、私钥、机器配置、.git、node_modules、构建缓存、归档、无关 Agent 会话/治理文件；只上传本次应用需要的源码与共享资料。确认文件清单，说明源码将进入统一托管空间；源码上传与广场收录是不同阶段。上传代码不会在广场执行。
5. 获取发布辅助工具 GET ${publisherUrl}，保存到项目之外的临时目录，并核对 SHA-256 为 ${script.sha256}。用本机可用 Python 3.10+ 运行：python <辅助工具绝对路径> --origin ${origin} --project <应用根目录绝对路径>${target ? ` --managed-app-id ${target.managedAppId}` : ''}。由你查找解释器和执行，不要求我配置 GitLab 或手写命令；如当前 Host 没有文件/网络执行能力，明确说明需要在有该项目上下文和执行权限的 AI Harness 中运行。
6. 工具会在用户私有目录安全保存应用专属发布凭证和恢复记录，自动上传至独立仓库，由服务器生成 commit、tag 和 Release，再核验并返回预览。不要把专属凭证、票据、用户私有记录或 GitLab 令牌上传/输出到对话。网络不确定时保留记录，用同一命令重试；相同操作不得改变文件内容。需要修改内容则准备新的版本，不移动旧 tag。更新会先核对应用修订，冲突时重新生成预览。
7. 将工具返回的 previewUrl 只交给我本人打开，说明实际上传/核验状态；由我检查公开内容并确认收录。不要调用确认接口或代我点击确认。失败时保留本机恢复记录，用同一命令重试，已写入的源码/Release 不重复上传。最后反馈真实状态与预览或应用链接，不把预览、上传或收录当作应用已经安装或运行成功。

如无法使用辅助工具，可由你按同一 HTTP 规范发送：POST ${submitUrl}，JSON 为 {appKey,manifestPath:"ai-app.json",files:[{path:"仓库相对路径",content:"文件原字节的base64"}],managedAppId?:"更新目标",expectedAppRevision?:整数}。Idempotency-Key 为本次固定 UUID，X-Plaza-Publish-Key 为上传前生成并安全保存的32随机字节base64url专属凭证；后续更新复用原凭证与 managedAppId，不能使用公开 appKey 代替凭证。不要向此接口传 GitLab 令牌。文件最多1000个、单文件5MiB、总20MiB；超过时说明需精简的范围，不悄悄漏传必要源码。`;
  return {
    mode: 'managed', prompt, schema, gitlabUrl: config.gitlabUrl, submitUrl, audience: config.audience,
    managed: { groupPath, groupUrl, publisherUrl, publisherSha256: script.sha256, limits: { maxFiles: 1000, maxFileBytes: 5 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024 } },
    ...(updateTarget ? { updateTarget } : {}),
  };
}
