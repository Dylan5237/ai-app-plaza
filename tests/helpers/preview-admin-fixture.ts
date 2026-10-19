import { randomUUID } from 'node:crypto';
import { startHarness } from './harness.js';
import { SHA, TOKEN, DEFAULT_TAG, manifest } from './gitlab-fixture.js';

// Explicitly synthetic, loopback-only fixture. Not a deployment configuration.
export const ADMIN_FIXTURE_PASSWORD = 'fixture-only-preview-admin-password-53';
export async function startPreviewAdminFixture() {
  const h = await startHarness(2, 'memory://', { previewAdmin: { password: ADMIN_FIXTURE_PASSWORD } });
  try {
    const data = { ...manifest(), name: '本地验证：待确认应用 A', maintainers: [{ name: '验证作者甲', nameEn: 'Fixture A' }] };
    h.gitlab.state.files.set('ai-app.json', JSON.stringify(data));
    const pending = await h.service.submit({ projectId: 1, appKey: 'sample-1', manifestPath: 'ai-app.json', commitSha: SHA, tag: DEFAULT_TAG }, TOKEN, randomUUID());
    const publicApp = await h.service.submit({ projectId: 1, appKey: 'sample-2', manifestPath: '.ai-apps/sample-2/ai-app.json', commitSha: SHA, tag: DEFAULT_TAG }, TOKEN, randomUUID());
    await h.service.confirm(publicApp.id, publicApp.ticket, { revision: publicApp.revision, digest: publicApp.digest! });
    for (let index = 0; index < 24; index++) {
      const status = index === 0 ? 'failed' : index === 1 ? 'checking' : 'preview_ready';
      const expired = index === 2;
      const preview = status === 'checking' ? null : { ...pending.preview, manifest: { ...data, name: expired ? '本地验证：过期预览' : `本地验证：应用 ${index + 1}`, maintainers: [{ name: '验证作者乙', nameEn: 'Fixture B' }] } };
      await h.db.query(`INSERT INTO publications (id, actor_id, idempotency_digest, request_hash, submission, status,
        candidate_app_id, preview_jsonb, next_action, expires_at, created_at, updated_at, error_code, error_message)
        VALUES ($1, 'fixture-author-b', $2, 'fixture', $3::jsonb, $4, $5, $6::jsonb, 'confirm', $7, now(), now(), $8, $9)`,
      [randomUUID(), randomUUID(), JSON.stringify({ appKey: `fixture-preview-${index + 1}` }), status, randomUUID(), JSON.stringify(preview), new Date(Date.now() + (expired ? -3600000 : 3600000)), status === 'failed' ? 'SOURCE_UNAVAILABLE' : null, status === 'failed' ? '本地验证：来源暂不可用' : null]);
    }
    return h;
  } catch (error) { await h.close(); throw error; }
}
