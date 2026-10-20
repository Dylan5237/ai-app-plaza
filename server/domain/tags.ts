import { DomainError } from './errors.js';
import type { Queryable } from './database.js';
import type { AppLifecycleStatus } from './app-lifecycle.js';

export const MAX_APP_TAGS = 3;
export const TAG_OVERRIDE_JOIN = 'LEFT JOIN catalog_tag_overrides o ON o.snapshot_id = s.id';
export const EFFECTIVE_TAGS = "COALESCE(o.tags, s.manifest->'tags', '[]'::jsonb)";

export function tagKey(tag: string): string {
  return tag.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-CN');
}

export function validateCapabilityTags(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > MAX_APP_TAGS) {
    throw new DomainError(400, 'VALIDATION_FAILED', '单个应用最多 3 个能力标签，请保留核心能力并优先复用已有标签。');
  }
  const seen = new Set<string>();
  for (const tag of value) {
    if (typeof tag !== 'string' || !tag.trim() || [...tag].length > 32) {
      throw new DomainError(400, 'VALIDATION_FAILED', '能力标签须为 1 至 32 个字符的非空文本。');
    }
    const key = tagKey(tag);
    if (seen.has(key)) throw new DomainError(400, 'VALIDATION_FAILED', '标签规范化后不能重复。');
    seen.add(key);
  }
}

export async function catalogTags(db: Queryable, audience: string, statuses: readonly AppLifecycleStatus[] = ['published']): Promise<string[]> {
  if (statuses.length === 0) return [];
  const placeholders = statuses.map((_, index) => `$${index + 2}`);
  const result = await db.query<{ tag: string }>(
    `SELECT DISTINCT tag.value AS tag
       FROM catalog_apps a JOIN published_snapshots s ON s.id = a.current_snapshot_id
       LEFT JOIN catalog_app_lifecycle l ON l.app_id = a.id
       ${TAG_OVERRIDE_JOIN}
       CROSS JOIN LATERAL jsonb_array_elements_text(${EFFECTIVE_TAGS}) AS tag(value)
      WHERE s.audience = $1 AND COALESCE(l.status, 'published') IN (${placeholders.join(', ')})
      ORDER BY tag.value`, [audience, ...statuses],
  );
  return result.rows.map(row => row.tag);
}

export function validateTagReuse(tags: string[], existingTags: string[]): void {
  const names = new Map<string, string>();
  for (const tag of existingTags) if (!names.has(tagKey(tag))) names.set(tagKey(tag), tag);
  for (const tag of tags) {
    const existing = names.get(tagKey(tag));
    if (existing !== undefined && existing !== tag) {
      throw new DomainError(400, 'VALIDATION_FAILED', `能力标签“${tag}”已有名称“${existing}”，请复用已有标签。`);
    }
  }
}
