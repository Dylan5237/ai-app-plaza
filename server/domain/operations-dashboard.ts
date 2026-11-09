import type { Database } from './database.js';
import type { Config } from '../config.js';

export type DashboardPeriod = '7d' | '30d' | '90d';
export type AnalyticsSettings = NonNullable<Config['analytics']>;

// Only the integration's server-side visibility policy may provide this list.
// Without it, all app-specific results are unavailable rather than unrestricted.
export type PublicAppIds = () => Promise<readonly string[]>;

// Catalog result events do not carry an authoritative visibility scope. They
// may include restricted results, so do not mix them into public statistics.
const discovery = `(event_name='app_detail_viewed' AND attributes->>'entryContext' IN ('card','search_result','deep_link'))
  OR (event_name='app_entry_clicked' AND attributes->>'entryKind'='web')
  OR (event_name='prompt_copy_result' AND attributes->>'promptPurpose'='usage' AND attributes->>'result'='success')`;
const usage = `(event_name='app_entry_clicked' AND attributes->>'entryKind'='web')
  OR (event_name='prompt_copy_result' AND attributes->>'promptPurpose'='usage' AND attributes->>'result'='success')`;

export async function getOperationsDashboard(db: Database, settings: AnalyticsSettings | undefined,
  period: DashboardPeriod, publicAppIds?: PublicAppIds, now = new Date()) {
  const end = now.toISOString();
  const requestedStart = new Date(now.getTime() - Number.parseInt(period, 10) * 86400_000).toISOString();
  if (!settings) return { status:'unavailable' as const, reason:'统计采集未启用', period, requestedStart, end };
  const baseline = (await db.query<{ effective_at: Date }>(
    'SELECT effective_at FROM analytics_baselines WHERE environment=$1 AND site_instance_id=$2',
    [settings.environment, settings.siteInstanceId])).rows[0];
  if (!baseline) return { status:'unavailable' as const, reason:'统计基线尚未建立', period, requestedStart, end };
  const collectionStart = new Date(baseline.effective_at).toISOString();
  const start = collectionStart > requestedStart ? collectionStart : requestedStart;
  const appScopeAvailable = Boolean(publicAppIds);
  const ids = publicAppIds ? await publicAppIds() : [];
  const params = [settings.environment, settings.siteInstanceId, start, end, ids];
  const from = `FROM analytics_events WHERE environment=$1 AND site_instance_id=$2
    AND effective_at >= $3::timestamptz AND effective_at < $4::timestamptz
    AND app_id=ANY($5::uuid[])
    AND attributes->>'pageContext' IN ('catalog','random','detail')
    AND COALESCE(attributes->>'entryContext','') NOT IN ('management','after_publication')`;
  const summary = (await db.query<any>(`SELECT
    COUNT(DISTINCT session_id) FILTER (WHERE ${discovery}) AS discovery_sessions,
    COUNT(DISTINCT session_id) FILTER (WHERE ${usage}) AS usage_sessions,
    COUNT(DISTINCT visitor_id) FILTER (WHERE ${discovery}) AS discovery_visitors,
    COUNT(DISTINCT session_id) FILTER (WHERE (${discovery}) AND identity_scope='session_only') AS session_only,
    COUNT(*) FILTER (WHERE event_name='app_entry_clicked' AND attributes->>'entryKind'='web' AND heat_counted) AS web_actions,
    COUNT(*) FILTER (WHERE event_name='prompt_copy_result' AND attributes->>'promptPurpose'='usage' AND attributes->>'result'='success' AND heat_counted) AS agent_actions
    ${from}`, params)).rows[0];
  const days = (await db.query<any>(`SELECT to_char(effective_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day,
    COUNT(DISTINCT session_id) FILTER (WHERE ${discovery}) AS discovery_sessions,
    COUNT(DISTINCT session_id) FILTER (WHERE ${usage}) AS usage_sessions
    ${from} GROUP BY day ORDER BY day`, params)).rows.map(row => ({ day:row.day,
      discoverySessions:Number(row.discovery_sessions), usageSessions:Number(row.usage_sessions) }));
  const apps = appScopeAvailable ? (await db.query<any>(`SELECT a.id, s.manifest->>'name' AS name,
    COUNT(*) FILTER (WHERE e.event_name='app_card_exposed') AS exposure,
    COUNT(DISTINCT e.session_id) FILTER (WHERE e.event_name='app_detail_viewed' AND e.attributes->>'entryContext' IN ('card','search_result','deep_link')) AS details,
    COUNT(DISTINCT e.session_id) FILTER (WHERE e.event_name='app_entry_clicked' AND e.attributes->>'entryKind'='web') AS web_sessions,
    COUNT(DISTINCT e.session_id) FILTER (WHERE e.event_name='prompt_copy_result' AND e.attributes->>'promptPurpose'='usage' AND e.attributes->>'result'='success') AS agent_sessions
    FROM catalog_apps a JOIN published_snapshots s ON s.id=a.current_snapshot_id
    LEFT JOIN catalog_app_lifecycle l ON l.app_id=a.id
    JOIN analytics_events e ON e.app_id=a.id AND e.environment=$1 AND e.site_instance_id=$2
      AND e.effective_at >= $3::timestamptz AND e.effective_at < $4::timestamptz
      AND e.attributes->>'pageContext' IN ('catalog','random','detail')
      AND COALESCE(e.attributes->>'entryContext','') NOT IN ('management','after_publication')
    WHERE a.id=ANY($5::uuid[]) AND COALESCE(l.status,'published')='published'
    GROUP BY a.id,s.manifest ORDER BY exposure DESC, a.id LIMIT 50`, params)).rows.map(row => ({
      id:row.id, name:row.name, exposure:Number(row.exposure), details:Number(row.details),
      webSessions:Number(row.web_sessions), agentSessions:Number(row.agent_sessions) })) : null;
  const supply = appScopeAvailable ? (await db.query<any>(`SELECT
    (SELECT COUNT(*) FROM catalog_apps a JOIN published_snapshots s ON s.id=a.current_snapshot_id
      LEFT JOIN catalog_app_lifecycle l ON l.app_id=a.id WHERE a.id=ANY($5::uuid[]) AND COALESCE(l.status,'published')='published') AS available,
    COUNT(DISTINCT j.value->>'appId') FILTER (WHERE j.value->>'registrationKind'='new') AS new_apps,
    COUNT(DISTINCT j.value->>'appId') FILTER (WHERE j.value->>'registrationKind'='version_update') AS updates
    FROM publications p CROSS JOIN LATERAL jsonb_array_elements(p.analytics_journal) j(value)
    WHERE j.value->>'environment'=$1 AND j.value->>'siteInstanceId'=$2
      AND (j.value->>'occurredAt')::timestamptz >= $3::timestamptz AND (j.value->>'occurredAt')::timestamptz < $4::timestamptz
      AND j.value->>'eventName'='publication_state_changed' AND j.value->>'toState'='registered'
      AND j.value->>'appId'=ANY($5::text[])`, params)).rows[0] : null;
  return { status:'available' as const, period, requestedStart, start, end, collectionStart,
    partial:start!==requestedStart, appScopeAvailable,
    summary:{ discoverySessions:appScopeAvailable?Number(summary.discovery_sessions):null, usageSessions:appScopeAvailable?Number(summary.usage_sessions):null,
      discoveryVisitors:appScopeAvailable?Number(summary.discovery_visitors):null, sessionOnly:appScopeAvailable?Number(summary.session_only):null,
      searches:null, emptySearches:null,
      webActions:appScopeAvailable?Number(summary.web_actions):null, agentActions:appScopeAvailable?Number(summary.agent_actions):null },
    days:appScopeAvailable?days:null, apps,
    supply:supply ? { available:Number(supply.available), newApps:Number(supply.new_apps), updates:Number(supply.updates) } : null,
    retention:null };
}
