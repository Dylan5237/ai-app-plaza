import { randomUUID } from 'node:crypto';
import type { Database } from '../../server/domain/database.js';
import { manifest, SHA } from './gitlab-fixture.js';

export async function seedTagCatalog(db: Database, audience: string, tags: string[], index = 1) {
  const appId = randomUUID(), snapshotId = randomUUID();
  const source = manifest(index);
  source.tags = tags;
  const docs = { [source.docs.usage]: '# 使用说明', [`docs/agent-${index}.md`]: 'SOURCE-INSTRUCTIONS-UNCHANGED' };
  await db.transaction(async tx => {
    await tx.query(`INSERT INTO catalog_apps (id, instance_id, project_id, app_key, revision, created_at, updated_at)
      VALUES ($1, 'fixture-instance', $2, $3, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, [appId, String(index), source.appKey]);
    await tx.query(`INSERT INTO published_snapshots (id, app_id, commit_sha, manifest_path, tag, digest, audience, version, manifest, documents, search_text, project_url, source_created_at, created_at)
      VALUES ($1, $2, $3, 'ai-app.json', 'v1.0.0', $4, $5, '1.0.0', $6::jsonb, $7::jsonb, 'fixture application', 'https://example.invalid/source', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      [snapshotId, appId, SHA, 'd'.repeat(64), audience, JSON.stringify(source), JSON.stringify(docs)]);
    await tx.query('UPDATE catalog_apps SET current_snapshot_id = $2 WHERE id = $1', [appId, snapshotId]);
  });
  return { appId, snapshotId, source, entry: { appId, appKey: source.appKey, expectedRevision: 1, expectedCommitSha: SHA, expectedTags: tags, tags: ['MCP', '知识整理'], reason: '测试核心能力分类' } };
}
