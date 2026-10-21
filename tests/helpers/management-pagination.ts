import { createHash, randomUUID } from 'node:crypto';
import type { startManagementFixture } from './management-fixture.js';
import { seedTagCatalog } from './tag-catalog.js';

const AUDIENCE = '仅限本地管理试用';
const FIXTURE_INDEX = 70_000;

type ManagementFixture = Awaited<ReturnType<typeof startManagementFixture>>;

export interface ManagementPaginationSeedResult {
  apps: Array<{ id: string; appKey: string; name: string }>;
  trash: Array<{ id: string; appKey: string; name: string }>;
  publications: Array<{ id: string; appKey: string; name: string }>;
  uploads: Array<{ id: string; appKey: string }>;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function jsonObject(value: unknown): Record<string, any> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Management pagination fixture source must be a JSON object.');
  }
  return structuredClone(parsed) as Record<string, any>;
}

async function seedCatalogApp(fixture: ManagementFixture, kind: 'app' | 'trash', index: number) {
  const suffix = String(index + 1).padStart(4, '0');
  const appKey = `fixture-pagination-${kind}-${suffix}`;
  const name = `分页${kind === 'app' ? '应用' : '回收站'} ${suffix}`;
  const source = await seedTagCatalog(fixture.db, AUDIENCE, ['分页回归'], FIXTURE_INDEX + index);
  source.source.appKey = appKey;
  source.source.name = name;
  await fixture.db.query('UPDATE catalog_apps SET app_key = $2 WHERE id = $1', [source.appId, appKey]);
  await fixture.db.query(
    `UPDATE published_snapshots
        SET manifest = $2::jsonb, search_text = $3
      WHERE app_id = $1`,
    [source.appId, JSON.stringify(source.source), `${name} ${appKey}`.toLocaleLowerCase('zh-CN')],
  );
  return { id: source.appId, appKey, name };
}

async function seedPublication(fixture: ManagementFixture, index: number) {
  const suffix = String(index + 1).padStart(4, '0');
  const appKey = `fixture-pagination-publication-${suffix}`;
  const name = `分页发布 ${suffix}`;
  const publicationId = randomUUID();
  const candidateAppId = randomUUID();
  const source = (await fixture.db.query<{ submission: unknown; preview_jsonb: unknown }>(
    'SELECT submission, preview_jsonb FROM publications WHERE id = $1',
    [fixture.seeds.firstUpload.publicationId],
  )).rows[0];
  if (!source?.preview_jsonb) throw new Error('The management fixture has no preview-ready publication to clone.');

  const submission = jsonObject(source.submission);
  submission.appKey = appKey;
  const preview = jsonObject(source.preview_jsonb);
  const manifest = jsonObject(preview.manifest);
  manifest.appKey = appKey;
  manifest.name = name;
  preview.id = candidateAppId;
  preview.revision = 1;
  preview.manifest = manifest;
  const createdAt = new Date(Date.now() - index * 1_000).toISOString();
  preview.createdAt = createdAt;
  preview.updatedAt = createdAt;
  const unique = randomUUID();

  await fixture.db.query(
    `INSERT INTO publications
       (id, actor_id, idempotency_digest, request_hash, submission, status, revision, digest,
        candidate_app_id, expected_app_revision, app_id, preview_jsonb, next_action, expires_at,
        created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'preview_ready', 1, $6, $7, NULL, NULL, $8::jsonb,
        'confirm', $9, $10, $10)`,
    [
      publicationId,
      `pagination-fixture-${suffix}`,
      digest(`pagination-idempotency-${unique}`),
      digest(`pagination-request-${unique}`),
      JSON.stringify(submission),
      digest(`pagination-preview-${unique}`),
      candidateAppId,
      JSON.stringify(preview),
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
      createdAt,
    ],
  );
  return { id: publicationId, appKey, name };
}

async function seedUpload(fixture: ManagementFixture, index: number) {
  const suffix = String(index + 1).padStart(4, '0');
  const appKey = `fixture-pagination-upload-${suffix}`;
  const bindingId = randomUUID();
  const operationId = randomUUID();
  const unique = randomUUID();
  const createdAt = new Date(Date.now() - index * 1_000).toISOString();
  await fixture.db.query(
    `INSERT INTO managed_app_bindings (id, app_key, publish_key_digest, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4)`,
    [bindingId, appKey, digest(`pagination-publish-key-${unique}`), createdAt],
  );
  await fixture.db.query(
    `INSERT INTO managed_publish_operations
       (id, binding_id, idempotency_digest, request_digest, manifest_path, expected_app_revision,
        base_commit_sha, project_id, branch, commit_sha, tag, publication_id, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'ai-app.json', NULL, NULL, NULL, 'main', NULL, $5, NULL, 'prepared', $6, $6)`,
    [
      operationId,
      bindingId,
      digest(`pagination-upload-idempotency-${unique}`),
      digest(`pagination-upload-request-${unique}`),
      `v1.0.${index + 1}`,
      createdAt,
    ],
  );
  return { id: operationId, appKey };
}

/** Add more than one management page to each view in a running local fixture. */
export async function seedManagementPagination(fixture: ManagementFixture, count = 23): Promise<ManagementPaginationSeedResult> {
  if (!Number.isInteger(count) || count < 21) {
    throw new RangeError('Management pagination fixtures need at least 21 rows per view.');
  }

  const apps: ManagementPaginationSeedResult['apps'] = [];
  const trash: ManagementPaginationSeedResult['trash'] = [];
  const publications: ManagementPaginationSeedResult['publications'] = [];
  const uploads: ManagementPaginationSeedResult['uploads'] = [];

  for (let index = 0; index < count; index += 1) {
    const app = await seedCatalogApp(fixture, 'app', index);
    apps.push(app);
    if (index === 0) await fixture.service.changeLifecycle(app.id, 'offline', 1, 1);

    const trashed = await seedCatalogApp(fixture, 'trash', count + index);
    await fixture.service.changeLifecycle(trashed.id, 'delete', 1, 1);
    trash.push(trashed);

    publications.push(await seedPublication(fixture, index));
    uploads.push(await seedUpload(fixture, index));
  }

  return { apps, trash, publications, uploads };
}
