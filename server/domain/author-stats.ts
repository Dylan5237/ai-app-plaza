import type { Database } from './database.js';
import type { Config } from '../config.js';

/** Per-app discovery and usage counts for apps the viewer owns or maintains.
 *  Offline (下架) apps keep their history so authors do not lose the last 30 days;
 *  deleted apps are excluded. Usages follow the shared heat_counted 30-minute
 *  dedup window marked at ingest — the same basis as the operations dashboard. */
export async function authorAppStats(db: Database, settings: Config['analytics'], viewerId: string) {
  if (!settings) return { status: 'unavailable' as const, reason: '统计采集未启用' };
  const apps = (await db.query(`SELECT a.id, s.manifest->>'name' AS name
    FROM catalog_apps a
    JOIN published_snapshots s ON s.id = a.current_snapshot_id
    LEFT JOIN catalog_app_lifecycle l ON l.app_id = a.id
    LEFT JOIN plaza_app_access p ON p.app_id = a.id
    WHERE (p.owner_id=$1 OR $1=ANY(p.maintainer_ids)) AND COALESCE(l.status,'published') <> 'deleted'
    ORDER BY s.manifest->>'name', a.id`, [viewerId])).rows;
  if (!apps.length) return { status: 'available' as const, rangeDays: 30, items: [] };
  const stats = new Map(apps.map(app => [app.id, { exposed: 0, detailSessions: new Set<string>(), usages: 0, shares: 0 }]));
  const rows = (await db.query(`SELECT app_id, event_name, session_id, heat_counted, attributes FROM analytics_events
    WHERE environment=$1 AND site_instance_id=$2 AND effective_at >= now() - interval '30 days'
      AND app_id=ANY($3::uuid[]) AND attributes->>'pageContext' IN ('catalog','random','search','detail')
      AND COALESCE(attributes->>'entryContext','') NOT IN ('management','after_publication')`,
    [settings.environment, settings.siteInstanceId, apps.map(app => app.id)])).rows;
  for (const row of rows) {
    const stat = stats.get(row.app_id);
    if (!stat) continue;
    const attributes = row.attributes ?? {};
    if (row.event_name === 'app_card_exposed') stat.exposed++;
    else if (row.event_name === 'app_detail_viewed') stat.detailSessions.add(row.session_id);
    else if (row.event_name === 'app_share_link_copied') stat.shares++;
    else if (row.heat_counted && ((row.event_name === 'app_entry_clicked' && attributes.entryKind === 'web')
      || (row.event_name === 'prompt_copy_result' && attributes.promptPurpose === 'usage' && attributes.result === 'success'))) stat.usages++;
  }
  return {
    status: 'available' as const,
    rangeDays: 30,
    items: apps.map(app => ({ id: app.id, name: app.name, exposed: stats.get(app.id)!.exposed, detailSessions: stats.get(app.id)!.detailSessions.size, usages: stats.get(app.id)!.usages, shares: stats.get(app.id)!.shares })),
  };
}
