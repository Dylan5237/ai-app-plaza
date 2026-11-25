import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { createAppAccessService } from '../server/domain/app-access.js';
import { setAdministrator } from '../server/domain/platform-access.js';
import {
  DEFAULT_PUBLISH_MANAGED_NEW_TEMPLATE,
  DEFAULT_PUBLISH_MANAGED_UPDATE_TEMPLATE,
  DEFAULT_SHARE_AGENT_TEMPLATE,
  DEFAULT_SHARE_PLATFORM_TEMPLATE,
  renderShareTemplate,
  renderTemplate,
  setTextTemplate,
} from '../server/domain/text-templates.js';
import { manifest } from './helpers/gitlab-fixture.js';
import { startIdentityHarness } from './helpers/identity-fixture.js';
import { MANAGED_GITLAB_TOKEN, startManagedGitLabFixture } from './helpers/managed-gitlab-fixture.js';

async function setup(t: any) {
  const h = await startIdentityHarness('/plaza', { superAdminAccount: 'fixture.admin' });
  const gitlab = await startManagedGitLabFixture('main');
  const integrated = await createApp({
    ...h.config,
    gitlabUrl: gitlab.url,
    managedPublishing: { token: MANAGED_GITLAB_TOKEN, groupId: '63', groupPath: 'fixture/apps' },
  }, h.db);
  t.after(async () => {
    await integrated.app.close();
    await gitlab.close();
    await h.close();
  });

  const admin = await h.login('fixture-admin');
  const member = await h.login('fixture-member');
  const headers = (who: { cookie: string } | null, extra: Record<string, string> = {}) => h.headers({
    ...(who ? { cookie: who.cookie, 'x-plaza-portal-token': who === admin ? 'fixture-admin' : 'fixture-member' } : {}),
    ...extra,
  });

  // Register one managed app owned by admin so update publish-contract can be tested too.
  const publishKey = randomBytes(32).toString('base64url');
  const files = {
    'ai-app.json': JSON.stringify({ ...manifest(1), appKey: 'template-sample', projectVersion: '1.0.0' }),
    'docs/usage-1.md': '# 使用说明\n模板测试应用说明。',
    'docs/agent-1.md': '# 接入说明\n模板测试接入说明。',
  };
  const submitted = await integrated.managed!.submit({
    appKey: 'template-sample',
    manifestPath: 'ai-app.json',
    files: Object.entries(files).map(([path, text]) => ({ path, content: Buffer.from(text, 'utf8').toString('base64') })),
  }, publishKey, randomUUID());
  const raw = await integrated.service.publication(submitted.id, submitted.ticket, admin.user.id);
  const confirmed = await integrated.service.confirm(raw.id, submitted.ticket, { revision: raw.revision, digest: raw.digest! }, admin.user.id);
  const appId = confirmed.appId!;
  await createAppAccessService(h.db, h.config.audience).update(admin.user.id, appId, {
    revision: 1, requestId: randomUUID(), scope: 'all', memberIds: [], groupIds: [],
  });

  return { h, integrated, gitlab, admin, member, appId, headers };
}

test('default managed publish prompts omit redundant first paragraph and keep complete guidance', async t => {
  const { integrated, admin, appId, headers } = await setup(t);

  const newRes = await integrated.app.inject({ url: '/plaza/api/publish-contract', headers: headers(null) });
  assert.equal(newRes.statusCode, 200, newRes.body);
  const newPrompt: string = newRes.json().prompt;
  assert.equal(newPrompt.includes('首次收录默认仅自己；最终确认需要有效天宫身份'), false);
  assert.equal(newPrompt.includes('不要复制天宫 Token 或浏览器会话到 Host'), false);
  assert.ok(newPrompt.includes(`${integrated.managed ? 'fixture/apps' : ''}`));
  assert.ok(newPrompt.includes(newRes.json().managed.publisherSha256));
  assert.ok(newPrompt.includes(newRes.json().managed.validationUrl));
  assert.ok(newPrompt.includes(newRes.json().managed.receiptUrl));
  assert.ok(newPrompt.includes(newRes.json().submitUrl));
  assert.ok(newPrompt.includes('请在当前项目上下文中把我的 AI 应用发布到 AI应用广场'));

  const updateRes = await integrated.app.inject({
    url: `/plaza/api/apps/${appId}/publish-contract`,
    headers: headers(admin),
  });
  assert.equal(updateRes.statusCode, 200, updateRes.body);
  const updatePrompt: string = updateRes.json().prompt;
  assert.equal(updatePrompt.includes('首次收录默认仅自己；最终确认需要有效天宫身份'), false);
  assert.equal(updatePrompt.includes('不要复制天宫 Token 或浏览器会话到 Host'), false);
  assert.ok(updatePrompt.includes('本次更新目标'));
  assert.ok(updatePrompt.includes('--managed-app-id'));
  assert.ok(updatePrompt.includes('--expected-revision 1'));
  assert.ok(updatePrompt.includes(appId));
});

test('text templates endpoint is restricted to super administrators and supports validation, idempotency, audit, and reset', async t => {
  const { h, integrated, admin, member, appId, headers } = await setup(t);

  assert.equal((await integrated.app.inject({ url: '/plaza/api/access/text-templates', headers: headers(null) })).statusCode, 401);
  assert.equal((await integrated.app.inject({ url: '/plaza/api/access/text-templates', headers: headers(member) })).statusCode, 403);

  await setAdministrator(h.db, admin.user.id, { userId: member.user.id, role: 'administrator', revision: 0, requestId: randomUUID() });
  assert.equal((await integrated.app.inject({ url: '/plaza/api/access/text-templates', headers: headers(member) })).statusCode, 403);

  const adminGet = await integrated.app.inject({ url: '/plaza/api/access/text-templates', headers: headers(admin) });
  assert.equal(adminGet.statusCode, 200, adminGet.body);
  const items = adminGet.json().items;
  assert.equal(items.publish_managed_new.template, null);
  assert.equal(items.publish_managed_new.defaultTemplate, DEFAULT_PUBLISH_MANAGED_NEW_TEMPLATE);
  assert.equal(items.publish_managed_update.defaultTemplate, DEFAULT_PUBLISH_MANAGED_UPDATE_TEMPLATE);
  assert.equal(items.share_agent.defaultTemplate, DEFAULT_SHARE_AGENT_TEMPLATE);
  assert.equal(items.share_platform.defaultTemplate, DEFAULT_SHARE_PLATFORM_TEMPLATE);

  // Validation and control character cleaning.
  const emptyPut = await integrated.app.inject({
    method: 'PUT', url: '/plaza/api/access/text-templates', headers: headers(admin),
    payload: { confirmed: true, requestId: randomUUID(), purpose: 'publish_managed_new', template: '   ' },
  });
  assert.equal(emptyPut.statusCode, 400);

  const tooLongShare = await integrated.app.inject({
    method: 'PUT', url: '/plaza/api/access/text-templates', headers: headers(admin),
    payload: { confirmed: true, requestId: randomUUID(), purpose: 'share_agent', template: `{{url}} ${'a'.repeat(2001)}` },
  });
  assert.equal(tooLongShare.statusCode, 400);

  const missingUrlShare = await integrated.app.inject({
    method: 'PUT', url: '/plaza/api/access/text-templates', headers: headers(admin),
    payload: { confirmed: true, requestId: randomUUID(), purpose: 'share_agent', template: '自定义但漏掉链接占位符：{{name}}' },
  });
  assert.equal(missingUrlShare.statusCode, 400);
  assert.equal(missingUrlShare.json().error.code, 'TEMPLATE_INVALID');

  // 6,500 Chinese characters (~19.5 KiB UTF-8 JSON) exceeds default 16 KiB bodyLimit but succeeds under 128 KiB route limit.
  const longChinesePublish = `长中文发布模板 {{origin}} ${'中'.repeat(6500)}`;
  const longChineseSave = await integrated.app.inject({
    method: 'PUT', url: '/plaza/api/access/text-templates', headers: headers(admin),
    payload: { confirmed: true, requestId: randomUUID(), purpose: 'publish_managed_new', template: longChinesePublish },
  });
  assert.equal(longChineseSave.statusCode, 200, longChineseSave.body);
  assert.equal((await integrated.app.inject({ url: '/plaza/api/publish-contract', headers: headers(null) })).json().prompt.length > 6500, true);
  await integrated.app.inject({
    method: 'PUT', url: '/plaza/api/access/text-templates', headers: headers(admin),
    payload: { confirmed: true, requestId: randomUUID(), purpose: 'publish_managed_new', template: null },
  });

  const newReqId = randomUUID();
  const customNewTemplate = '新发布指引：门户={{origin}} 空间={{groupPath}} 工具={{publisherUrl}} SHA={{publisherSha256}} 校验={{validationUrl}} 回执={{receiptUrl}} 提交={{submitUrl}} 清理\u0001控制';
  const saveNew = (reqId = newReqId, tpl: string | null = customNewTemplate) => integrated.app.inject({
    method: 'PUT', url: '/plaza/api/access/text-templates', headers: headers(admin),
    payload: { confirmed: true, requestId: reqId, purpose: 'publish_managed_new', template: tpl },
  });
  assert.equal((await saveNew()).statusCode, 200);
  assert.deepEqual((await saveNew()).json(), { recovered: true });
  assert.equal((await saveNew(newReqId, '不同模板')).statusCode, 409);

  // New publish contract uses updated template, update contract stays default.
  const newContract = (await integrated.app.inject({ url: '/plaza/api/publish-contract', headers: headers(null) })).json();
  assert.ok(newContract.prompt.startsWith('新发布指引：门户='));
  assert.ok(newContract.prompt.includes('清理控制'));
  assert.ok(newContract.prompt.includes(newContract.managed.publisherSha256));
  const unchangedUpdate = (await integrated.app.inject({ url: `/plaza/api/apps/${appId}/publish-contract`, headers: headers(admin) })).json();
  assert.ok(unchangedUpdate.prompt.includes('请在当前项目上下文中更新我已分享的 AI 应用'));

  // Update publish template affects update contract immediately.
  const customUpdateTemplate = '更新指引：{{origin}}\n{{updateContext}}\n参数={{updateArgs}}\n提交={{submitUrl}}';
  const saveUpdate = await integrated.app.inject({
    method: 'PUT', url: '/plaza/api/access/text-templates', headers: headers(admin),
    payload: { confirmed: true, requestId: randomUUID(), purpose: 'publish_managed_update', template: customUpdateTemplate },
  });
  assert.equal(saveUpdate.statusCode, 200);
  const updatedContract = (await integrated.app.inject({ url: `/plaza/api/apps/${appId}/publish-contract`, headers: headers(admin) })).json();
  assert.ok(updatedContract.prompt.startsWith('更新指引：'));
  assert.ok(updatedContract.prompt.includes(appId));
  assert.ok(updatedContract.prompt.includes('--managed-app-id'));

  // Reset new publish template restores default.
  const resetNew = await saveNew(randomUUID(), null);
  assert.equal(resetNew.statusCode, 200);
  const restoredContract = (await integrated.app.inject({ url: '/plaza/api/publish-contract', headers: headers(null) })).json();
  assert.ok(restoredContract.prompt.includes('请在当前项目上下文中把我的 AI 应用发布到 AI应用广场'));

  const auditCount = (await h.db.query("SELECT count(*) AS n FROM plaza_access_operations WHERE action = 'text_template_changed'")).rows[0].n;
  assert.equal(Number(auditCount), 5);
});

test('share templates endpoint and renderer support agent/platform split, empty summary, and single-pass substitution', async t => {
  const { h, integrated, admin, member, appId, headers } = await setup(t);

  const pubInitial = await integrated.app.inject({ url: '/plaza/api/share-templates', headers: headers(null) });
  assert.equal(pubInitial.statusCode, 200);
  assert.equal(pubInitial.json().agent, DEFAULT_SHARE_AGENT_TEMPLATE);
  assert.equal(pubInitial.json().platform, DEFAULT_SHARE_PLATFORM_TEMPLATE);

  assert.equal(
    renderShareTemplate(DEFAULT_SHARE_AGENT_TEMPLATE, {
      name: 'WorkBuddy企微机器人权限主动续期',
      summary: '自动提醒企微连接器权限续期。',
      url: 'https://plaza.example/?app=123',
    }),
    '[AI应用分享]【WorkBuddy企微机器人权限主动续期】\n自动提醒企微连接器权限续期。\n在应用广场查看并一键安装：https://plaza.example/?app=123',
  );

  assert.equal(
    renderShareTemplate(DEFAULT_SHARE_PLATFORM_TEMPLATE, {
      name: 'AI周报平台',
      summary: '一键汇总项目周报。',
      url: 'https://plaza.example/?app=456',
    }),
    '[AI应用分享]【AI周报平台】\n一键汇总项目周报。\n在应用广场查看并立即使用：https://plaza.example/?app=456',
  );

  // Blank summary omits blank line.
  assert.equal(
    renderShareTemplate(DEFAULT_SHARE_AGENT_TEMPLATE, {
      name: '无简介应用',
      summary: '   ',
      url: 'https://plaza.example/?app=789',
    }),
    '[AI应用分享]【无简介应用】\n在应用广场查看并一键安装：https://plaza.example/?app=789',
  );

  // Single-pass substitution prevents literal {{url}} inside name or summary from expanding.
  assert.equal(
    renderShareTemplate(DEFAULT_SHARE_AGENT_TEMPLATE, {
      name: '模板{{url}}测试',
      summary: '包含{{name}}占位符的简介',
      url: 'https://plaza.example/?app=safe',
    }),
    '[AI应用分享]【模板{{url}}测试】\n包含{{name}}占位符的简介\n在应用广场查看并一键安装：https://plaza.example/?app=safe',
  );
  assert.equal(
    renderTemplate('A={{a}} B={{b}}', { a: '{{b}}', b: 'final' }),
    'A={{b}} B=final',
  );
  assert.equal(
    renderShareTemplate('仅有名称：{{name}}', { name: '兜底应用', summary: '', url: 'https://plaza.example/?app=fallback' }),
    '仅有名称：兜底应用\nhttps://plaza.example/?app=fallback',
  );

  // Admin updates share_agent & share_platform -> public endpoint reflects immediately.
  assert.equal((await integrated.app.inject({
    method: 'PUT', url: '/plaza/api/access/text-templates', headers: headers(admin),
    payload: { confirmed: true, requestId: randomUUID(), purpose: 'share_agent', template: 'Agent自定义：{{name}} -> {{url}}' },
  })).statusCode, 200);
  assert.equal((await integrated.app.inject({
    method: 'PUT', url: '/plaza/api/access/text-templates', headers: headers(admin),
    payload: { confirmed: true, requestId: randomUUID(), purpose: 'share_platform', template: '平台自定义：{{name}} -> {{url}}' },
  })).statusCode, 200);

  const pubUpdated = (await integrated.app.inject({ url: '/plaza/api/share-templates', headers: headers(null) })).json();
  assert.equal(pubUpdated.agent, 'Agent自定义：{{name}} -> {{url}}');
  assert.equal(pubUpdated.platform, '平台自定义：{{name}} -> {{url}}');

  // Reset restores defaults.
  assert.equal((await integrated.app.inject({
    method: 'PUT', url: '/plaza/api/access/text-templates', headers: headers(admin),
    payload: { confirmed: true, requestId: randomUUID(), purpose: 'share_agent', template: null },
  })).statusCode, 200);
  const pubReset = (await integrated.app.inject({ url: '/plaza/api/share-templates', headers: headers(null) })).json();
  assert.equal(pubReset.agent, DEFAULT_SHARE_AGENT_TEMPLATE);
  assert.equal(pubReset.platform, '平台自定义：{{name}} -> {{url}}');

  // Concurrent updates on same template serialize cleanly for both same-requestId replay and distinct changes.
  const dupReqId = randomUUID();
  const [dupA, dupB] = await Promise.all([
    integrated.app.inject({
      method: 'PUT', url: '/plaza/api/access/text-templates', headers: headers(admin),
      payload: { confirmed: true, requestId: dupReqId, purpose: 'share_agent', template: '并发幂等A {{url}}' },
    }),
    integrated.app.inject({
      method: 'PUT', url: '/plaza/api/access/text-templates', headers: headers(admin),
      payload: { confirmed: true, requestId: dupReqId, purpose: 'share_agent', template: '并发幂等A {{url}}' },
    }),
  ]);
  assert.equal(dupA.statusCode, 200);
  assert.equal(dupB.statusCode, 200);
  assert.equal([dupA.json(), dupB.json()].filter(x => x.saved).length, 1);
  assert.equal([dupA.json(), dupB.json()].filter(x => x.recovered).length, 1);

  const [diffA, diffB] = await Promise.all([
    integrated.app.inject({
      method: 'PUT', url: '/plaza/api/access/text-templates', headers: headers(admin),
      payload: { confirmed: true, requestId: randomUUID(), purpose: 'share_agent', template: '并发一 {{url}}' },
    }),
    integrated.app.inject({
      method: 'PUT', url: '/plaza/api/access/text-templates', headers: headers(admin),
      payload: { confirmed: true, requestId: randomUUID(), purpose: 'share_agent', template: '并发二 {{url}}' },
    }),
  ]);
  assert.equal(diffA.statusCode, 200);
  assert.equal(diffB.statusCode, 200);
  type TemplateAuditRow = { before_value: { template: string } | null; after_value: { template: string } | null };
  const auditRows = (await h.db.query<TemplateAuditRow>(
    `SELECT before_value, after_value FROM plaza_access_operations
      WHERE action = 'text_template_changed' AND resource_id = 'share_agent'`,
  )).rows;
  const fromConcurrentDup = auditRows.find((r: TemplateAuditRow) => r.before_value === null && r.after_value?.template === '并发幂等A {{url}}');
  assert.ok(fromConcurrentDup);
  const step2 = auditRows.find((r: TemplateAuditRow) => r.before_value?.template === fromConcurrentDup.after_value?.template);
  const step3 = step2 && auditRows.find((r: TemplateAuditRow) => r.before_value?.template === step2.after_value?.template);
  assert.ok(step2 && step3, 'concurrent template updates form an unbroken before/after audit chain');

  // publish_managed_update must retain {{updateContext}} and {{updateArgs}}, and contract still guards legacy rows.
  for (const invalidUpdate of ['缺少上下文与参数', '只有上下文 {{updateContext}}', '只有参数 {{updateArgs}}']) {
    const invalidRes = await integrated.app.inject({
      method: 'PUT', url: '/plaza/api/access/text-templates', headers: headers(admin),
      payload: { confirmed: true, requestId: randomUUID(), purpose: 'publish_managed_update', template: invalidUpdate },
    });
    assert.equal(invalidRes.statusCode, 400);
    assert.equal(invalidRes.json().error.code, 'TEMPLATE_INVALID');
  }
  const validUpdateRes = await integrated.app.inject({
    method: 'PUT', url: '/plaza/api/access/text-templates', headers: headers(admin),
    payload: { confirmed: true, requestId: randomUUID(), purpose: 'publish_managed_update', template: '自定义更新\n{{updateContext}}\n{{updateArgs}}' },
  });
  assert.equal(validUpdateRes.statusCode, 200);
  await h.db.query("UPDATE plaza_text_templates SET template = '历史极简更新提示词' WHERE purpose = 'publish_managed_update'");
  const fallbackContract = (await integrated.app.inject({ url: `/plaza/api/apps/${appId}/publish-contract`, headers: headers(admin) })).json();
  assert.ok(fallbackContract.prompt.includes('历史极简更新提示词'));
  assert.ok(fallbackContract.prompt.includes(appId));
  assert.ok(fallbackContract.prompt.includes('--managed-app-id'));
  assert.ok(fallbackContract.prompt.includes('--expected-revision 1'));

  // Demoting a super-administrator revokes template write access under transaction ordering.
  await setAdministrator(h.db, admin.user.id, { userId: member.user.id, role: 'super_administrator', revision: 0, requestId: randomUUID() });
  await setTextTemplate(h.db, member.user.id, { requestId: randomUUID(), purpose: 'share_agent', template: '临时超管模板 {{url}}' });
  await setAdministrator(h.db, admin.user.id, { userId: member.user.id, role: 'member', revision: 1, requestId: randomUUID() });
  await assert.rejects(
    setTextTemplate(h.db, member.user.id, { requestId: randomUUID(), purpose: 'share_agent', template: '降级后禁止写入 {{url}}' }),
    (err: any) => err?.code === 'ADMINISTRATOR_REQUIRED' && err?.statusCode === 403,
  );
  const currentShareTemplates = (await integrated.app.inject({ url: '/plaza/api/share-templates', headers: headers(null) })).json();
  assert.equal(currentShareTemplates.agent, '临时超管模板 {{url}}');
});
