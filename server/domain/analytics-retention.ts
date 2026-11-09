import type { Config } from '../config.js';
import type { Database } from './database.js';

// Browser and server facts use the same period boundary; journal fields contain no credentials.
const facts = `
  SELECT event_name,effective_at AS at,app_id::text,attributes,visitor_id,session_id,heat_counted
    FROM analytics_events WHERE environment=$1 AND site_instance_id=$2
  UNION ALL
  SELECT j.value->>'eventName', (j.value->>'occurredAt')::timestamptz, j.value->>'appId',
    j.value, NULL::uuid, NULL::uuid, false
  FROM publications p CROSS JOIN LATERAL jsonb_array_elements(p.analytics_journal) j(value)
    WHERE j.value->>'environment'=$1 AND j.value->>'siteInstanceId'=$2
  UNION ALL
  SELECT j.value->>'eventName', (j.value->>'occurredAt')::timestamptz, j.value->>'appId',
    j.value, NULL::uuid, NULL::uuid, false
  FROM managed_publish_operations p CROSS JOIN LATERAL jsonb_array_elements(p.analytics_journal) j(value)
    WHERE j.value->>'environment'=$1 AND j.value->>'siteInstanceId'=$2
  UNION ALL
  SELECT j.value->>'eventName', (j.value->>'occurredAt')::timestamptz, j.value->>'appId',
    j.value, NULL::uuid, NULL::uuid, false
  FROM catalog_app_lifecycle p CROSS JOIN LATERAL jsonb_array_elements(p.analytics_journal) j(value)
    WHERE j.value->>'environment'=$1 AND j.value->>'siteInstanceId'=$2
  UNION ALL
  SELECT 'publication_expired', expires_at, NULL::text, '{}'::jsonb, NULL::uuid, NULL::uuid, false
  FROM analytics_publication_expirations WHERE environment=$1 AND site_instance_id=$2`;

/** Retain event totals and per-dimension counts indefinitely; remove raw facts only after both rollups commit. */
export async function maintainAnalyticsRetention(db: Database, config: Config, now = new Date()) {
  const settings = config.analyticsRetention || config.analytics;
  if (!settings) return;
  const { environment, siteInstanceId } = settings;
  const params = [environment, siteInstanceId, now.toISOString()];
  await db.transaction(async tx => {
    const periods = await tx.query<{ period: 'day' | 'week'; start_at: Date; end_at: Date }>(`
      WITH facts AS (${facts}), expired AS (
        SELECT at FROM facts WHERE at < $3::timestamptz - interval '180 days'
        UNION
        SELECT effective_at FROM analytics_events WHERE environment=$1 AND site_instance_id=$2
          AND received_at < $3::timestamptz - interval '180 days'
      ), boundaries AS (
        SELECT DISTINCT p.period, date_trunc(p.period, at AT TIME ZONE 'Asia/Shanghai') AS local_start
        FROM expired CROSS JOIN (VALUES ('day'),('week')) p(period)
      )
      SELECT period,local_start AT TIME ZONE 'Asia/Shanghai' AS start_at,
        (local_start + CASE WHEN period='day' THEN interval '1 day' ELSE interval '1 week' END) AT TIME ZONE 'Asia/Shanghai' AS end_at
      FROM boundaries ORDER BY start_at,period`, params);
    for (const period of periods.rows) {
      const p = [environment, siteInstanceId, period.period, period.start_at, period.end_at];
      const inserted = await tx.query(`INSERT INTO analytics_rollup_periods(environment,site_instance_id,period,period_start,period_end)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING period_start`, p);
      if (!inserted.rowCount) continue;
      // Totals and dimensional rows are separate: distinct visitors/sessions cannot be summed across dimensions.
      await tx.query(`WITH facts AS (${facts}), in_period AS (
        SELECT *,jsonb_strip_nulls(jsonb_build_object(
          'appId',app_id,'appType',attributes->>'appType','appVersion',attributes->>'appVersion',
          'tagNames',attributes->'tagNames','selectedTags',attributes->'selectedTags',
          'pageContext',attributes->>'pageContext','entryContext',attributes->>'entryContext',
          'trigger',attributes->>'trigger','usageType',attributes->>'usageType','section',attributes->>'section',
          'position',attributes->'position','entryKind',attributes->>'entryKind','placement',attributes->>'placement',
          'promptPurpose',attributes->>'promptPurpose','result',attributes->>'result',
          'resultCount',attributes->'resultCount','hasQuery',attributes->'hasQuery',
          'operationKind',attributes->>'operationKind','safeErrorCode',attributes->>'safeErrorCode',
          'publishMode',attributes->>'publishMode','publishKind',attributes->>'publishKind',
          'attemptKind',attributes->>'attemptKind','retryKind',attributes->>'retryKind',
          'actorContext',attributes->>'actorContext','viewerContext',attributes->>'viewerContext',
          'durationMs',attributes->'durationMs','failureStage',attributes->>'failureStage',
          'fromState',attributes->>'fromState','toState',attributes->>'toState',
          'fromStage',attributes->>'fromStage','toStage',attributes->>'toStage',
          'registrationKind',attributes->>'registrationKind','action',attributes->>'action'
        )) AS dimension FROM facts WHERE at >= $4 AND at < $5
      ), grouped AS (
        SELECT event_name,dimension,count(*) AS events,count(DISTINCT visitor_id) AS visitors,
          count(DISTINCT session_id) AS sessions,count(*) FILTER (WHERE heat_counted) AS heat
        FROM in_period GROUP BY event_name,dimension
        UNION ALL
        SELECT event_name,'{"total":true}'::jsonb,count(*),count(DISTINCT visitor_id),
          count(DISTINCT session_id),count(*) FILTER (WHERE heat_counted)
        FROM in_period GROUP BY event_name
      ) INSERT INTO analytics_rollups(environment,site_instance_id,period,period_start,event_name,dimension,event_count,visitor_count,session_count,heat_count)
        SELECT $1,$2,$3,$4,event_name,dimension,events,visitors,sessions,heat FROM grouped`, p);
    }

    // All expired periods have now been aggregated in this transaction. Periods are stable because
    // incoming client timestamps older than five minutes are assigned the server receive time.
    await tx.query(`DELETE FROM analytics_events WHERE environment=$1 AND site_instance_id=$2
      AND received_at < $3::timestamptz - interval '180 days'`, params);
    for (const table of ['publications', 'managed_publish_operations', 'catalog_app_lifecycle'] as const) {
      await tx.query(`UPDATE ${table} SET analytics_journal = COALESCE((
        SELECT jsonb_agg(j.value ORDER BY j.ordinality) FROM jsonb_array_elements(analytics_journal) WITH ORDINALITY j(value,ordinality)
        WHERE NOT (j.value->>'environment'=$1 AND j.value->>'siteInstanceId'=$2
          AND (j.value->>'occurredAt')::timestamptz < $3::timestamptz - interval '180 days')
      ), '[]'::jsonb) WHERE EXISTS (
        SELECT 1 FROM jsonb_array_elements(analytics_journal) j(value)
        WHERE j.value->>'environment'=$1 AND j.value->>'siteInstanceId'=$2
          AND (j.value->>'occurredAt')::timestamptz < $3::timestamptz - interval '180 days'
      )`, params);
    }
    await tx.query(`DELETE FROM analytics_usage_windows WHERE environment=$1 AND site_instance_id=$2
      AND last_counted_at < $3::timestamptz - interval '180 days'`, params);
    await tx.query(`DELETE FROM analytics_publication_expirations WHERE environment=$1 AND site_instance_id=$2
      AND expires_at < $3::timestamptz - interval '180 days'`, params);
  });
}
