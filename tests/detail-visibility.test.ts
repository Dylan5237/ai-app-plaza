import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createAppAccessService } from '../server/domain/app-access.js';
import { DEFAULT_TAG, manifest, SHA, TOKEN } from './helpers/gitlab-fixture.js';
import { startIdentityHarness } from './helpers/identity-fixture.js';

test('detail visibility is returned only to owner/maintainers, reflects sharing updates, and restricted apps stay 404 for unauthorized callers', async t => {
  const h = await startIdentityHarness('/plaza', { superAdminAccount: 'fixture.admin' });
  t.after(h.close);

  const owner = await h.login('fixture-member');
  const other = await h.login('fixture-admin');
  const headers = (who: { cookie: string } | null) => h.headers(
    who ? { cookie: who.cookie, 'x-plaza-portal-token': who === owner ? 'fixture-member' : 'fixture-admin' } : {},
  );

  // Give the test app an explicit distribution file so package endpoint can be tested too.
  const srcManifest = manifest(1);
  srcManifest.entries = [
    {
      id: 'agent', kind: 'agent', label: '接入我的Agent', instructionsPath: 'docs/agent-1.md',
      compatibility: ['Codex'], distribution: { type: 'source', files: ['docs/agent-1.md'] },
    } as any,
  ];
  srcManifest.primaryEntry = 'agent';
  h.gitlab.state.files.set('ai-app.json', JSON.stringify(srcManifest));

  const pub = await h.service.submit({
    projectId: 1, appKey: 'sample-1', manifestPath: 'ai-app.json', commitSha: SHA, tag: DEFAULT_TAG,
  }, TOKEN, randomUUID());
  const reg = await h.service.confirm(pub.id, pub.ticket, { revision: pub.revision, digest: pub.digest! }, owner.user.id);
  const appId = reg.appId!;

  // 1. Default scope is 'self'. Owner sees visibility with canShare=true; unauthorized users get 404 everywhere.
  const ownerSelfRes = await h.app.inject({ url: `/plaza/api/apps/${appId}`, headers: headers(owner) });
  assert.equal(ownerSelfRes.statusCode, 200);
  assert.deepEqual(ownerSelfRes.json().visibility, { scope: 'self', canShare: true, memberCount: 0, groupCount: 0 });
  const assetId = ownerSelfRes.json().distributions[0].assetId;

  for (const caller of [null, other]) {
    for (const path of [`/plaza/api/apps/${appId}`, `/plaza/api/apps/${appId}/instructions/agent`, `/plaza/api/apps/${appId}/packages/${assetId}`]) {
      const denied = await h.app.inject({ url: path, headers: headers(caller) });
      assert.equal(denied.statusCode, 404);
      assert.equal(denied.body.includes(srcManifest.name), false, '404 response must not leak app name');
    }
  }

  // 2. Delegate maintainer to `other`: other gets visibility with canShare=false even if scope='self' or 'members'.
  const access = createAppAccessService(h.db, h.config.audience);
  await access.update(owner.user.id, appId, { revision: 1, requestId: randomUUID(), scope: 'members', memberIds: [other.user.id], groupIds: [] });
  const ownerMembersRes = await h.app.inject({ url: `/plaza/api/apps/${appId}`, headers: headers(owner) });
  assert.deepEqual(ownerMembersRes.json().visibility, { scope: 'members', canShare: true, memberCount: 1, groupCount: 0 });

  const sharedMemberRes = await h.app.inject({ url: `/plaza/api/apps/${appId}`, headers: headers(other) });
  assert.equal(sharedMemberRes.statusCode, 200);
  assert.equal('visibility' in sharedMemberRes.json(), false, 'plain shared viewers do not receive visibility configuration');

  await access.update(owner.user.id, appId, { revision: 2, requestId: randomUUID(), maintainerIds: [other.user.id] });
  const maintainerRes = await h.app.inject({ url: `/plaza/api/apps/${appId}`, headers: headers(other) });
  assert.equal(maintainerRes.statusCode, 200);
  assert.deepEqual(maintainerRes.json().visibility, { scope: 'members', canShare: false, memberCount: 1, groupCount: 0 });

  // 3. Switch to groups, then all -> owner visibility updates immediately and anonymous visitor still never sees visibility.
  const groupId = randomUUID();
  await h.db.query('INSERT INTO plaza_groups(id, name) VALUES($1, $2)', [groupId, '测试可见性小组']);
  await access.update(owner.user.id, appId, { revision: 3, requestId: randomUUID(), scope: 'groups', memberIds: [], groupIds: [groupId] });
  const ownerGroupsRes = await h.app.inject({ url: `/plaza/api/apps/${appId}`, headers: headers(owner) });
  assert.deepEqual(ownerGroupsRes.json().visibility, { scope: 'groups', canShare: true, memberCount: 0, groupCount: 1, activeGroupCount: 1 });

  await h.db.query('UPDATE plaza_groups SET enabled = false WHERE id = $1', [groupId]);
  const ownerDisabledGroupRes = await h.app.inject({ url: `/plaza/api/apps/${appId}`, headers: headers(owner) });
  assert.deepEqual(ownerDisabledGroupRes.json().visibility, { scope: 'groups', canShare: true, memberCount: 0, groupCount: 1, activeGroupCount: 0 });

  await h.db.query('UPDATE plaza_groups SET enabled = true WHERE id = $1', [groupId]);
  const ownerReenabledGroupRes = await h.app.inject({ url: `/plaza/api/apps/${appId}`, headers: headers(owner) });
  assert.deepEqual(ownerReenabledGroupRes.json().visibility, { scope: 'groups', canShare: true, memberCount: 0, groupCount: 1, activeGroupCount: 1 });

  await access.update(owner.user.id, appId, { revision: 4, requestId: randomUUID(), scope: 'all', memberIds: [], groupIds: [] });
  const ownerAllRes = await h.app.inject({ url: `/plaza/api/apps/${appId}`, headers: headers(owner) });
  assert.deepEqual(ownerAllRes.json().visibility, { scope: 'all', canShare: true, memberCount: 0, groupCount: 0 });

  const anonAllRes = await h.app.inject({ url: `/plaza/api/apps/${appId}`, headers: headers(null) });
  assert.equal(anonAllRes.statusCode, 200);
  assert.equal('visibility' in anonAllRes.json(), false, 'anonymous viewers never receive visibility metadata');
});
