import { z } from 'zod';
import type { Database } from './database.js';
import type { Config } from '../config.js';
import { DomainError } from './errors.js';
import { catalogTags, EFFECTIVE_TAGS, TAG_OVERRIDE_JOIN } from './tags.js';
import { appAccessPredicate } from './app-access.js';
import { randomUUID } from 'node:crypto';

const id = z.string().uuid();
const attributes = z.object({
  pageContext: z.enum(['catalog', 'random', 'search', 'detail', 'publication', 'management']),
  entryMode: z.enum(['catalog', 'detail_link', 'publication_link', 'management']),
  trigger: z.enum(['initial', 'search', 'filter', 'pagination', 'manual_refresh', 'layout_refresh', 'random_refresh']).optional(),
  discoveryRequestId: id.optional(),
  resultCount: z.number().int().min(0).max(1_000_000).optional(),
  renderedCount: z.number().int().min(0).max(100).optional(),
  page: z.number().int().min(1).max(100_000).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  usageType: z.enum(['all', 'platform', 'agent']).optional(),
  selectedTags: z.array(z.string().min(1).max(64)).max(12).optional(),
  hasQuery: z.boolean().optional(),
  queryLengthBucket: z.enum(['0', '1-10', '11-50', '51-200']).optional(),
  position: z.number().int().min(1).max(100).optional(),
  section: z.enum(['catalog', 'random', 'search']).optional(),
  entryContext: z.enum(['card', 'search_result', 'deep_link', 'after_publication', 'management']).optional(),
  entryId: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/).optional(),
  entryKind: z.enum(['web', 'agent']).optional(),
  placement: z.enum(['card', 'detail', 'header']).optional(),
  promptPurpose: z.enum(['usage', 'publish', 'update', 'example']).optional(),
  result: z.enum(['success', 'failure']).optional(),
  operationKind: z.enum(['catalog', 'search', 'filter', 'detail', 'instructions', 'random']).optional(),
  safeErrorCode: z.enum(['NETWORK_ERROR', 'NOT_FOUND', 'RATE_LIMITED', 'INVALID_REQUEST', 'SERVICE_UNAVAILABLE', 'UNKNOWN_ERROR']).optional(),
  publishKind: z.enum(['new', 'update']).optional(),
  viewerContext: z.enum(['publication_link', 'management']).optional(),
  previewRevision: z.number().int().min(1).optional(),
}).strict();

export const browserEvent = z.object({
  eventId: id,
  eventName: z.enum(['portal_viewed', 'catalog_results_viewed', 'app_card_exposed', 'app_detail_viewed', 'app_entry_clicked', 'prompt_copy_result', 'portal_operation_failed', 'publish_panel_viewed', 'publication_preview_viewed']),
  occurredAt: z.iso.datetime({ offset: true }),
  identityScope: z.enum(['persistent', 'session_only']),
  visitorId: id.nullable(), sessionId: id, viewId: id,
  interactionId: id.optional(), resultSetId: id.optional(), flowId: id.optional(), publicationId: id.optional(), appId: id.optional(), snapshotId: id.optional(),
  attributes,
}).strict().superRefine((value, context) => {
  if ((value.identityScope === 'persistent') !== Boolean(value.visitorId)) context.addIssue({ code: 'custom', message: 'invalid identity scope' });
  const required: Record<string, string[]> = {
    portal_viewed: [],
    catalog_results_viewed: ['resultSetId', 'attributes.trigger', 'attributes.discoveryRequestId', 'attributes.resultCount', 'attributes.renderedCount', 'attributes.page', 'attributes.pageSize', 'attributes.usageType', 'attributes.hasQuery', 'attributes.queryLengthBucket'],
    app_card_exposed: ['appId', 'snapshotId', 'resultSetId', 'attributes.position', 'attributes.section'],
    app_detail_viewed: ['appId', 'snapshotId', 'attributes.entryContext'],
    app_entry_clicked: ['appId', 'snapshotId', 'interactionId', 'attributes.entryId', 'attributes.entryKind', 'attributes.placement'],
    prompt_copy_result: ['interactionId', 'attributes.promptPurpose', 'attributes.result'],
    portal_operation_failed: ['interactionId', 'attributes.operationKind', 'attributes.safeErrorCode'],
    publish_panel_viewed: ['flowId', 'attributes.publishKind'],
    publication_preview_viewed: ['publicationId', 'attributes.previewRevision', 'attributes.viewerContext'],
  };
  for (const path of required[value.eventName] || []) {
    const actual = path.split('.').reduce((item: any, key) => item?.[key], value as any);
    if (actual === undefined || actual === null) context.addIssue({ code: 'custom', message: `missing ${path}` });
  }
  if (value.eventName === 'prompt_copy_result' && ['usage', 'example'].includes(value.attributes.promptPurpose || '') && (!value.appId || !value.snapshotId)) context.addIssue({ code: 'custom', message: 'missing app' });
  if (value.eventName === 'prompt_copy_result' && ['publish', 'update'].includes(value.attributes.promptPurpose || '') && !value.flowId) context.addIssue({ code: 'custom', message: 'missing flow' });
});

export async function recordBrowserEvent(db: Database, config: Config, input: unknown, viewerId?: string, anonymousFallback = false) {
  if (!config.analytics) throw new DomainError(404, 'NOT_FOUND', '未找到请求的资源');
  const settings = config.analytics;
  const event = browserEvent.parse(input);
  if (event.attributes.selectedTags?.length) {
    const allowed = new Map<string, string>((await catalogTags(db, config.audience, undefined, viewerId)).map(tag => [tag.toLowerCase(), tag]));
    const selected = event.attributes.selectedTags.map(tag => allowed.get(tag.toLowerCase()));
    if (!anonymousFallback && selected.some(tag => tag === undefined)) throw new DomainError(400, 'INVALID_REQUEST', '标签无效');
    event.attributes.selectedTags = selected.filter((tag): tag is string => tag !== undefined);
  }
  let snapshot: { version: string; tags: string[]; appType: 'platform' | 'agent' } | undefined;
  if (event.appId) {
    if (!event.snapshotId) throw new DomainError(400, 'INVALID_REQUEST', '应用事件缺少版本');
    const result = await db.query<{ version: string; manifest: any; effective_tags: unknown }>(`SELECT s.version,s.manifest,${EFFECTIVE_TAGS} AS effective_tags FROM catalog_apps a
      JOIN published_snapshots s ON s.id=$2 AND s.id=a.current_snapshot_id AND s.app_id=a.id
      LEFT JOIN catalog_app_lifecycle l ON l.app_id=a.id
      ${TAG_OVERRIDE_JOIN}
      WHERE a.id=$1 AND s.audience=$3 AND COALESCE(l.status,'published')='published'
        AND ${appAccessPredicate('$4::uuid')}`, [event.appId, event.snapshotId, config.audience, viewerId ?? null]);
    const row = result.rows[0];
    if (!row && !anonymousFallback) throw new DomainError(404, 'NOT_FOUND', '未找到请求的资源');
    if (!row) {
      // Preserve the anonymous event, without attributing private application metadata or heat.
      delete event.appId;
      delete event.snapshotId;
      delete event.attributes.entryId;
    } else {
      const manifest = typeof row.manifest === 'string' ? JSON.parse(row.manifest) : row.manifest;
      if (event.attributes.entryId) {
        const entry = manifest.entries?.find((item: any) => item.id === event.attributes.entryId && item.kind === event.attributes.entryKind);
        if (!entry) throw new DomainError(400, 'INVALID_REQUEST', '应用入口无效');
        if (entry.kind === 'web') {
          try { const url = new URL(entry.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(); }
          catch { throw new DomainError(400, 'INVALID_REQUEST', '应用入口无效'); }
        }
      }
      const tags = typeof row.effective_tags === 'string' ? JSON.parse(row.effective_tags) : row.effective_tags;
      snapshot = { version: row.version, tags: Array.isArray(tags) ? tags : [], appType: manifest.entries?.some((entry: any) => entry.kind === 'web') ? 'platform' : 'agent' };
    }
  }
  const received = new Date();
  const occurred = new Date(event.occurredAt);
  if (Number.isNaN(occurred.getTime())) throw new DomainError(400, 'INVALID_REQUEST', '事件时间无效');
  const adjusted = Math.abs(received.getTime() - occurred.getTime()) > 5 * 60_000;
  const details = { ...event.attributes, ...(snapshot ? { appType: snapshot.appType, appVersion: snapshot.version, tagNames: snapshot.tags } : {}), source: 'direct_or_unknown', trafficClass: 'unknown' };
  const effective = adjusted ? received.toISOString() : occurred.toISOString();
  const action = event.eventName === 'app_entry_clicked' && event.attributes.entryKind === 'web' ? 'web'
    : event.eventName === 'prompt_copy_result' && event.attributes.promptPurpose === 'usage' && event.attributes.result === 'success' ? 'agent' : undefined;
  return db.transaction(async tx => {
    const result = await tx.query(`INSERT INTO analytics_events(event_id,event_name,occurred_at,received_at,effective_at,clock_adjusted,environment,site_instance_id,identity_scope,visitor_id,session_id,view_id,interaction_id,result_set_id,flow_id,publication_id,app_id,snapshot_id,attributes)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb) ON CONFLICT DO NOTHING RETURNING event_id`,
  [event.eventId, event.eventName, occurred.toISOString(), received.toISOString(), effective, adjusted,
    settings.environment, settings.siteInstanceId, event.identityScope, event.visitorId, event.sessionId, event.viewId,
    event.interactionId || null, event.resultSetId || null, event.flowId || null, event.publicationId || null, event.appId || null, event.snapshotId || null, JSON.stringify(details)]);
    if (result.rowCount && action && event.appId) {
      const clientId = event.visitorId || event.sessionId;
      const window = await tx.query(`INSERT INTO analytics_usage_windows(environment,site_instance_id,client_id,app_id,action,last_counted_at) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(environment,site_instance_id,client_id,app_id,action) DO UPDATE SET last_counted_at=EXCLUDED.last_counted_at
        WHERE analytics_usage_windows.last_counted_at <= EXCLUDED.last_counted_at - interval '30 minutes' RETURNING app_id`,
      [settings.environment, settings.siteInstanceId, clientId, event.appId, action, effective]);
      if (window.rowCount) {
        await tx.query(`INSERT INTO analytics_usage_counts(environment,site_instance_id,app_id,action,total,first_counted_at) VALUES($1,$2,$3,$4,1,$5)
          ON CONFLICT(environment,site_instance_id,app_id,action) DO UPDATE SET total=analytics_usage_counts.total+1`, [settings.environment, settings.siteInstanceId, event.appId, action, effective]);
        await tx.query('UPDATE analytics_events SET heat_counted=true WHERE event_id=$1', [event.eventId]);
      }
    }
    return { accepted: true, duplicate: result.rowCount === 0 };
  });
}

/** One initial state snapshot, never represented as new historical registrations. */
export async function recordCatalogBaseline(db: Database, config: Config) {
  const settings = config.analytics;
  if (!settings) return;
  const baselineId = randomUUID();
  await db.transaction(async tx => {
    const inserted = await tx.query(`INSERT INTO analytics_baselines(environment,site_instance_id,baseline_id,effective_at)
      VALUES($1,$2,$3,now()) ON CONFLICT(environment,site_instance_id) DO NOTHING RETURNING baseline_id`,
    [settings.environment, settings.siteInstanceId, baselineId]);
    if (!inserted.rowCount) return;
    await tx.query(`INSERT INTO analytics_baseline_items(baseline_id,app_id,snapshot_id,status,lifecycle_revision,app_type,tag_names)
      SELECT $1,a.id,s.id,COALESCE(l.status,'published'),COALESCE(l.revision,1),
        CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.manifest->'entries')='array' THEN s.manifest->'entries' ELSE '[]'::jsonb END) e WHERE e->>'kind'='web') THEN 'platform' ELSE 'agent' END,
        ${EFFECTIVE_TAGS}
      FROM catalog_apps a JOIN published_snapshots s ON s.id=a.current_snapshot_id
      LEFT JOIN catalog_app_lifecycle l ON l.app_id=a.id ${TAG_OVERRIDE_JOIN}
      WHERE s.audience=$2`, [baselineId, config.audience]);
  });
}

export async function recordPublicationExpirations(db: Database, config: Config) {
  const settings = config.analytics;
  if (!settings) return;
  await db.query(`INSERT INTO analytics_publication_expirations(environment,site_instance_id,publication_id,expires_at,detected_at)
    SELECT $1,$2,p.id,p.expires_at,now() FROM publications p
    JOIN analytics_baselines b ON b.environment=$1 AND b.site_instance_id=$2
    WHERE p.expires_at >= b.effective_at AND p.expires_at <= now() AND p.expires_at >= now()-interval '180 days'
      AND p.status NOT IN ('registered','cancelled')
    ON CONFLICT(environment,site_instance_id,publication_id) DO NOTHING`, [settings.environment, settings.siteInstanceId]);
}
