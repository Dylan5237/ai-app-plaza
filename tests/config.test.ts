import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';

const nonLocalRequirements = {
  GITLAB_URL: 'https://gitlab.example.invalid',
  DATABASE_URL: 'postgresql://unused',
  PLAZA_SECRET: 'test-only-production-config-with-long-secret',
};

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
