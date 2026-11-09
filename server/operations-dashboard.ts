import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from './domain/database.js';
import { DomainError } from './domain/errors.js';
import { getOperationsDashboard, type AnalyticsSettings, type DashboardPeriod, type PublicAppIds } from './domain/operations-dashboard.js';

export interface OperationsDashboardOptions {
  analytics?: AnalyticsSettings;
  authenticateAdministrator: (request: FastifyRequest) => Promise<unknown>;
  visibleAppIds?: PublicAppIds;
}

export function registerOperationsDashboard(app: FastifyInstance, db: Database, options: OperationsDashboardOptions) {
  app.get<{ Querystring: { period?: string } }>('/api/operations/dashboard', async (request, reply) => {
    await options.authenticateAdministrator(request);
    const period = request.query.period || '30d';
    if (!['7d', '30d', '90d'].includes(period)) throw new DomainError(400, 'INVALID_REQUEST', '请选择近 7、30 或 90 天。');
    reply.header('Cache-Control', 'no-store');
    return getOperationsDashboard(db, options.analytics, period as DashboardPeriod, options.visibleAppIds);
  });
}
