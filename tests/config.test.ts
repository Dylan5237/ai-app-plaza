import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';

test('configuration never silently downgrades production or invents a GitLab source', async () => {
  await assert.rejects(loadConfig({ PLAZA_LOCAL: '1', NODE_ENV: 'production' }), /生产环境/);
  await assert.rejects(loadConfig({ PLAZA_LOCAL: '1', HOST: '0.0.0.0' }), /127.0.0.1/);
  await assert.rejects(loadConfig({ PLAZA_LOCAL: '1' }), /GITLAB_URL/);
  await assert.rejects(loadConfig({ PUBLIC_ORIGIN: 'https://plaza.example.invalid', GITLAB_URL: 'http://gitlab.example.invalid' }), /ALLOW_INSECURE_GITLAB/);
  await assert.rejects(loadConfig({ PUBLIC_ORIGIN: 'https://plaza.example.invalid', GITLAB_URL: 'https://gitlab.example.invalid' }), /DATABASE_URL/);
  await assert.rejects(loadConfig({ PUBLIC_ORIGIN: 'https://plaza.example.invalid', GITLAB_URL: 'https://gitlab.example.invalid', DATABASE_URL: 'postgresql://unused' }), /PLAZA_SECRET/);
  const configured = await loadConfig({ PUBLIC_ORIGIN: 'https://plaza.example.invalid', GITLAB_URL: 'https://gitlab.example.invalid', DATABASE_URL: 'postgresql://unused', PLAZA_SECRET: 'test-only-production-config-with-long-secret' });
  assert.equal(configured.local, false);
  assert.equal(configured.audience, '所有能访问本门户的人');
});
