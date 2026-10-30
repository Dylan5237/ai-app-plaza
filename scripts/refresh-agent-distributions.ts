import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { openDatabase } from '../server/domain/database.js';
import { DomainError } from '../server/domain/errors.js';
import { refreshLegacyDistributions } from '../server/domain/legacy-refresh.js';

export async function runRefresh(args: string[], env = process.env) {
  const { values } = parseArgs({ args, options: { apply: { type: 'boolean', default: false },
    'expect-plan': { type: 'string' }, 'database-path': { type: 'string' }, 'show-guides': { type: 'boolean', default: false } } });
  if (Boolean(values.apply) !== Boolean(values['expect-plan'])) {
    throw new DomainError(400, 'VALIDATION_FAILED', '默认只读预览；执行刷新须同时提供 --apply 和预览的 --expect-plan。');
  }
  if (Boolean(env.DATABASE_URL) === Boolean(values['database-path'])) {
    throw new DomainError(400, 'VALIDATION_FAILED', '仅指定 DATABASE_URL 环境变量或本地 --database-path。');
  }
  if (!env.GITLAB_URL || !env.PLAZA_MANAGED_GITLAB_TOKEN || !env.PLAZA_DATA_DIR) {
    throw new DomainError(400, 'VALIDATION_FAILED', '需要广场已配置的 GitLab 地址、服务授权与持久化目录。');
  }
  const db = await openDatabase({ ...(env.DATABASE_URL ? { url: env.DATABASE_URL } : { path: resolve(values['database-path']!) }), migrate: false });
  try {
    return await refreshLegacyDistributions({ db, gitlabUrl: env.GITLAB_URL, token: env.PLAZA_MANAGED_GITLAB_TOKEN,
      directory: resolve(env.PLAZA_DATA_DIR, 'distribution'), staticDir: resolve('dist'),
      apply: values.apply, expectedPlan: values['expect-plan'], includeGuides: values['show-guides'] });
  } finally { await db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runRefresh(process.argv.slice(2));
    console.log(JSON.stringify(result));
    if (result.status === 'blocked') process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', error: error instanceof DomainError
      ? { code: error.code, message: error.message }
      : { code: 'REFRESH_FAILED', message: '刷新未完成；请核对本地预览、服务授权与固定来源。' } }));
    process.exitCode = 2;
  }
}
