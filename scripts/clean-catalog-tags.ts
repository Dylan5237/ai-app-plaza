import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { openDatabase, type Database } from '../server/domain/database.js';
import { parseStrictJson } from '../server/domain/manifest.js';
import { DomainError } from '../server/domain/errors.js';
import { cleanCatalogTags, restoreCatalogTags, parseCleanupPlan, parseCleanupBackup, cleanupPlanHash, type TagCleanupBackup } from '../server/domain/tag-cleanup.js';

async function saveBackup(file: string, backup: TagCleanupBackup): Promise<void> {
  try { await writeFile(file, JSON.stringify(backup, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    const existing = parseCleanupBackup(parseStrictJson(await readFile(file, 'utf8')));
    if (!isDeepStrictEqual(existing, backup)) throw new DomainError(409, 'TAG_CLEANUP_CONFLICT', '已有备份与本次操作不一致，停止写入。');
  }
}

export async function runTagCleanup(args: string[], env = process.env) {
  const { values } = parseArgs({ args, options: { plan: { type: 'string' }, backup: { type: 'string' }, rollback: { type: 'string' }, apply: { type: 'boolean', default: false }, 'database-path': { type: 'string' } } });
  if (Boolean(values.plan) === Boolean(values.rollback) || (values.apply && values.plan && !values.backup) || (values.rollback && values.backup)) {
    throw new DomainError(400, 'VALIDATION_FAILED', '指定 --plan 或 --rollback；执行清洗还需 --apply --backup，默认仅预览。');
  }
  if (Boolean(env.DATABASE_URL) === Boolean(values['database-path'])) {
    throw new DomainError(400, 'VALIDATION_FAILED', '仅指定 DATABASE_URL 环境变量或本地 --database-path，不在命令参数中提供数据库凭据。');
  }
  const raw = parseStrictJson(await readFile(resolve(values.plan ?? values.rollback!), 'utf8'));
  const input = values.rollback ? parseCleanupBackup(raw) : parseCleanupPlan(raw);
  let originalBackup: TagCleanupBackup | undefined;
  if (values.plan && values.backup) {
    try { originalBackup = parseCleanupBackup(parseStrictJson(await readFile(resolve(values.backup), 'utf8'))); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  if (originalBackup && (originalBackup.operationId !== input.operationId || originalBackup.planHash !== cleanupPlanHash(input))) {
    throw new DomainError(409, 'TAG_CLEANUP_CONFLICT', '原备份与清洗计划不一致，停止操作。');
  }
  let db: Database | undefined;
  try {
    db = await openDatabase({ ...(env.DATABASE_URL ? { url: env.DATABASE_URL } : { path: resolve(values['database-path']!) }), migrate: false });
    return values.rollback ? await restoreCatalogTags(db, input, values.apply) : await cleanCatalogTags(db, input, {
      apply: values.apply,
      ...(originalBackup ? { originalBackup } : {}),
      ...(values.backup ? { saveBackup: (backup: TagCleanupBackup) => saveBackup(resolve(values.backup!), backup) } : {}),
    });
  } finally { await db?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runTagCleanup(process.argv.slice(2)))); }
  catch (error) {
    console.error(JSON.stringify({ status: 'failed', error: error instanceof DomainError ? { code: error.code, message: error.message } : { code: 'CLEANUP_FAILED', message: '标签操作未完成，请核对文件、数据库和原回执。' } }));
    process.exitCode = 2;
  }
}
