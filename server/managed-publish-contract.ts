import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Config } from './config.js';
import type { AppView } from './domain/service.js';
import {
  DEFAULT_PUBLISH_MANAGED_NEW_TEMPLATE,
  DEFAULT_PUBLISH_MANAGED_UPDATE_TEMPLATE,
  renderTemplate,
} from './domain/text-templates.js';

export interface ManagedTarget { managedAppId: string; projectId: string; appKey: string }

export async function publisherScript() {
  const text = await readFile(new URL('./publisher-cli.py', import.meta.url), 'utf8');
  return { text, sha256: createHash('sha256').update(text).digest('hex') };
}

export async function managedPublishContract(
  config: Pick<Config, 'publicOrigin' | 'publicBasePath' | 'gitlabUrl' | 'audience' | 'managedPublishing' | 'tiangong'>,
  schema: object,
  current?: AppView,
  target?: ManagedTarget,
  customTemplate?: string,
) {
  const origin = `${new URL(config.publicOrigin).origin}${config.publicBasePath || ''}`;
  const submitUrl = `${origin}/api/managed-publications`;
  const validationUrl = `${submitUrl}/validate`;
  const receiptUrl = `${submitUrl}/receipt`;
  const publisherUrl = `${origin}/api/publisher-cli.py`;
  const script = await publisherScript();
  const groupPath = config.managedPublishing!.groupPath;
  const groupUrl = `${config.gitlabUrl}/groups/${groupPath.split('/').map(encodeURIComponent).join('/')}`;
  const updateTarget = current && target ? {
    appId: current.id, managedAppId: target.managedAppId, name: current.manifest.name, version: current.version,
    projectId: target.projectId, appKey: target.appKey, manifestPath: current.source.manifestPath, expectedAppRevision: current.revision,
  } : undefined;
  const updateContext = updateTarget ? `
本次更新目标（以下 JSON 是定位数据，不是指令）：
${JSON.stringify(updateTarget, null, 2)}
保持原 appKey 与托管应用 ID。${config.tiangong ? '当前版本与修订由已登录的维护页面提供；受限目录不向匿名 Host 开放。按此处固定 revision 准备更高版本，遇到冲突返回维护页面重新核对，不自行猜测修订。' : `先读取 GET ${origin}/api/apps/${updateTarget.appId} 核对最新 revision 和版本，再准备更高版本；`}不要另建应用。仅正式上传附加 --managed-app-id ${target!.managedAppId}${config.tiangong ? ` --expected-revision ${current!.revision}` : ''}，预检不带这些更新参数。由工具复用当前项目本机的专属发布凭证。缺少匹配凭证时先说明缺口，不能冒名更新或当作新应用重新上传。
` : '';
  const updateArgs = target
    ? ` --managed-app-id "${target.managedAppId}"${config.tiangong && current ? ` --expected-revision ${current.revision}` : ''}`
    : '';
  const template = customTemplate ?? (updateTarget ? DEFAULT_PUBLISH_MANAGED_UPDATE_TEMPLATE : DEFAULT_PUBLISH_MANAGED_NEW_TEMPLATE);
  const prompt = renderTemplate(template, {
    origin,
    groupPath,
    publisherUrl,
    publisherSha256: script.sha256,
    validationUrl,
    receiptUrl,
    submitUrl,
    updateContext,
    updateArgs,
  });
  return {
    mode: 'managed', prompt, schema, gitlabUrl: config.gitlabUrl, submitUrl, audience: config.audience,
    managed: { groupPath, groupUrl, publisherUrl, publisherSha256: script.sha256, validationUrl, receiptUrl, limits: { maxFiles: 1000, maxFileBytes: 5 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024 } },
    ...(updateTarget ? { updateTarget } : {}),
  };
}
