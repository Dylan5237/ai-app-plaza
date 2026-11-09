import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';

const nonLocalRequirements = {
  GITLAB_URL: 'https://gitlab.example.invalid',
  DATABASE_URL: 'postgresql://unused',
  PLAZA_SECRET: 'test-only-production-config-with-long-secret',
};

test('disabling collection preserves the configured retention namespace', async () => {
  const base = { ...nonLocalRequirements, PUBLIC_ORIGIN:'https://plaza.example.invalid', PLAZA_ANALYTICS_SITE_ID:'main', PLAZA_ANALYTICS_ENVIRONMENT:'production' };
  const enabled = await loadConfig({ ...base, PLAZA_ANALYTICS_ENABLED:'1' });
  const disabled = await loadConfig(base);
  assert.deepEqual(enabled.analytics, { environment:'production', siteInstanceId:'main' });
  assert.equal(disabled.analytics, undefined);
  assert.deepEqual(disabled.analyticsRetention, enabled.analytics);
  await assert.rejects(loadConfig({ ...base, PLAZA_ANALYTICS_SITE_ID:'invalid/site' }), /埋点环境或站点标识/);
});

test('optional HTTPS ingress preserves the canonical HTTP origin and requires an exact same-host private IP', async () => {
  const base = { ...nonLocalRequirements, PUBLIC_ORIGIN: 'http://192.168.2.145:16090', ALLOW_INSECURE_PORTAL: '1' };
  const disabled = await loadConfig(base);
  assert.equal(disabled.httpsOrigin, undefined);
  const enabled = await loadConfig({ ...base, PLAZA_HTTPS_ORIGIN: 'https://192.168.2.145:16490' });
  assert.equal(enabled.publicOrigin, base.PUBLIC_ORIGIN);
  assert.equal(enabled.httpsOrigin, 'https://192.168.2.145:16490');
  for (const value of ['http://192.168.2.145:16490', 'https://192.168.2.146:16490',
    'https://192.168.2.145:16090', 'https://plaza.example.invalid:16490', 'https://192.168.2.145:16490/entry',
    'https://user:fixture@192.168.2.145:16490', 'https://192.168.2.145:16490?x=1',
    'https://192.168.2.145:16490#x', 'https://3232236181:16490', ' https://192.168.2.145:16490']) {
    await assert.rejects(loadConfig({ ...base, PLAZA_HTTPS_ORIGIN: value }), /PLAZA_HTTPS_ORIGIN/);
  }
  await assert.rejects(loadConfig({ ...nonLocalRequirements, PUBLIC_ORIGIN: 'https://192.168.2.145:16090', PLAZA_HTTPS_ORIGIN: 'https://192.168.2.145:16490' }), /PLAZA_HTTPS_ORIGIN/);
});

test('configuration never silently downgrades production or invents a GitLab source', async () => {
  await assert.rejects(loadConfig({ PLAZA_LOCAL: '1', NODE_ENV: 'production' }), /生产环境/);
  await assert.rejects(loadConfig({ PLAZA_LOCAL: '1', HOST: '0.0.0.0' }), /127.0.0.1/);
  await assert.rejects(loadConfig({ PLAZA_LOCAL: '1' }), /GITLAB_URL/);
  await assert.rejects(loadConfig({ PUBLIC_ORIGIN: 'https://plaza.example.invalid', GITLAB_URL: 'http://gitlab.example.invalid' }), /ALLOW_INSECURE_GITLAB/);
  await assert.rejects(loadConfig({ PUBLIC_ORIGIN: 'https://plaza.example.invalid', GITLAB_URL: 'https://gitlab.example.invalid' }), /DATABASE_URL/);
  await assert.rejects(loadConfig({ PUBLIC_ORIGIN: 'https://plaza.example.invalid', GITLAB_URL: 'https://gitlab.example.invalid', DATABASE_URL: 'postgresql://unused' }), /PLAZA_SECRET/);
  const configured = await loadConfig({ PUBLIC_ORIGIN: 'https://plaza.example.invalid', ...nonLocalRequirements });
  assert.equal(configured.local, false);
  assert.equal(configured.audience, '所有能访问本门户的人');
});

test('non-local HTTP portal origins require the explicit trial flag', async () => {
  await assert.rejects(loadConfig({ PUBLIC_ORIGIN: 'http://192.168.2.145', ...nonLocalRequirements }), /HTTPS PUBLIC_ORIGIN/);
  const configured = await loadConfig({ PUBLIC_ORIGIN: 'http://192.168.2.145', ALLOW_INSECURE_PORTAL: '1', ...nonLocalRequirements });
  assert.equal(configured.publicOrigin, 'http://192.168.2.145');
});

test('insecure portal trial accepts only RFC1918 IPv4 origins', async () => {
  for (const hostname of [
    '10.0.0.1', '10.255.255.254',
    '172.16.0.1', '172.31.255.254',
    '192.168.0.1', '192.168.255.254',
  ]) {
    const configured = await loadConfig({
      PUBLIC_ORIGIN: `http://${hostname}`,
      ALLOW_INSECURE_PORTAL: '1',
      ...nonLocalRequirements,
    });
    assert.equal(configured.publicOrigin, `http://${hostname}`);
  }

  for (const hostname of [
    '203.0.113.10', '172.15.255.255', '172.32.0.1', '192.167.1.1', '192.169.1.1',
    'localhost', 'plaza.localhost', '0.0.0.0', 'plaza.example.invalid', '[::1]',
    '3232235777', '0xc0a80101', '192.168.1',
  ]) {
    await assert.rejects(
      loadConfig({ PUBLIC_ORIGIN: `http://${hostname}`, ALLOW_INSECURE_PORTAL: '1', ...nonLocalRequirements }),
      /HTTPS PUBLIC_ORIGIN/,
      `${hostname} must not be allowed for insecure portal trial`,
    );
  }
});

test('insecure portal trial still requires an external database and persistent secret', async () => {
  const trialConfig = {
    PUBLIC_ORIGIN: 'http://192.168.2.145',
    ALLOW_INSECURE_PORTAL: '1',
    ...nonLocalRequirements,
  };
  await assert.rejects(loadConfig({ ...trialConfig, DATABASE_URL: undefined }), /DATABASE_URL/);
  await assert.rejects(loadConfig({ ...trialConfig, PLAZA_SECRET: undefined }), /PLAZA_SECRET/);
});

test('intranet management is explicit, private-origin-only, and compatible with production configuration', async () => {
  const privateHttp = {
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    PORT: '16090',
    PUBLIC_ORIGIN: 'http://192.168.2.145:16090',
    ALLOW_INSECURE_PORTAL: '1',
    ...nonLocalRequirements,
  };
  const disabled = await loadConfig(privateHttp);
  assert.equal(disabled.local, false);
  assert.equal(disabled.intranetManagement, undefined);
  assert.equal(disabled.localManagement, undefined);

  const configured = await loadConfig({ ...privateHttp, PLAZA_INTRANET_MANAGEMENT: '1' });
  assert.equal(configured.intranetManagement, true);
  assert.equal(configured.local, false);
  assert.equal(configured.port, 16090);

  const privateHttps = await loadConfig({
    ...privateHttp,
    PORT: '443',
    PUBLIC_ORIGIN: 'https://192.168.2.145',
    ALLOW_INSECURE_PORTAL: undefined,
    PLAZA_INTRANET_MANAGEMENT: '1',
  });
  assert.equal(privateHttps.publicOrigin, 'https://192.168.2.145');
  assert.equal(privateHttps.intranetManagement, true);

  await assert.rejects(loadConfig({ ...privateHttp, PORT: '16091', PLAZA_INTRANET_MANAGEMENT: '1' }), /端口与 PORT 一致/);
  await assert.rejects(loadConfig({ ...privateHttp, PUBLIC_ORIGIN: 'https://plaza.example.invalid', PLAZA_INTRANET_MANAGEMENT: '1' }), /RFC1918/);
  await assert.rejects(loadConfig({ ...privateHttp, PUBLIC_ORIGIN: 'https://203.0.113.10:16090', PLAZA_INTRANET_MANAGEMENT: '1' }), /RFC1918/);
  await assert.rejects(loadConfig({ ...privateHttp, NODE_ENV: 'test', PLAZA_LOCAL: '1', HOST: '127.0.0.1', PUBLIC_ORIGIN: 'http://127.0.0.1:16090', PLAZA_INTRANET_MANAGEMENT: '1' }), /非本地模式/);
  await assert.rejects(loadConfig({
    ...privateHttp,
    NODE_ENV: 'test',
    PLAZA_LOCAL: '1',
    HOST: '127.0.0.1',
    PUBLIC_ORIGIN: 'http://127.0.0.1:16090',
    PLAZA_LOCAL_MANAGEMENT: '1',
    PLAZA_INTRANET_MANAGEMENT: '1',
  }), /不能同时启用/);
  await assert.rejects(loadConfig({ ...privateHttp, PLAZA_INTRANET_MANAGEMENT: 'true' }), /PLAZA_INTRANET_MANAGEMENT/);
});

test('managed publication requires an explicit complete fixed namespace and server-only authorization', async () => {
  const base = { PUBLIC_ORIGIN: 'https://plaza.example.invalid', ...nonLocalRequirements };
  for (const partial of [
    { PLAZA_MANAGED_GROUP_ID: '63' },
    { PLAZA_MANAGED_GROUP_PATH: 'team/ai-apps' },
    { PLAZA_MANAGED_GITLAB_TOKEN: 'fixture-only-service-token' },
  ]) await assert.rejects(loadConfig({ ...base, ...partial }), /同时配置/);
  const complete = { PLAZA_MANAGED_GROUP_ID: '63', PLAZA_MANAGED_GROUP_PATH: 'team/ai-apps', PLAZA_MANAGED_GITLAB_TOKEN: 'fixture-only-service-token' };
  const configured = await loadConfig({ ...base, ...complete });
  assert.equal(configured.managedPublishing?.groupId, '63');
  await assert.rejects(loadConfig({ ...base, ...complete, PLAZA_MANAGED_GROUP_ID: 'other-project' }), /群组 ID/);
  await assert.rejects(loadConfig({ ...base, ...complete, PLAZA_MANAGED_GROUP_PATH: '../other' }), /固定群组路径/);
  await assert.rejects(loadConfig({ ...base, ...complete, PLAZA_MANAGED_GITLAB_TOKEN: 'fixture\ninjected' }), /授权格式/);
});
