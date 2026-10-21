import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startManagementFixture } from '../tests/helpers/management-fixture.js';
import { seedManagementPagination } from '../tests/helpers/management-pagination.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseOptions() {
  let port = Number(process.env.PORT || 9442);
  let staticDir = resolve(repositoryRoot, 'dist');
  let pagination = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--pagination') {
      pagination = true;
    } else if (argument === '--port') {
      port = Number(args[++index]);
    } else if (argument?.startsWith('--port=')) {
      port = Number(argument.slice('--port='.length));
    } else if (argument === '--static-dir') {
      const value = args[++index];
      if (!value) throw new Error('--static-dir needs a path.');
      staticDir = resolve(value);
    } else if (argument?.startsWith('--static-dir=')) {
      staticDir = resolve(argument.slice('--static-dir='.length));
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  return { port, staticDir, pagination };
}

async function main() {
  const options = parseOptions();
  const fixture = await startManagementFixture(options);
  try {
    if (options.pagination) await seedManagementPagination(fixture);
  } catch (error) {
    await fixture.close();
    throw error;
  }
  console.log(`本地管理后台试用地址：${fixture.origin}/admin`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await fixture.close();
  };
  process.once('SIGINT', () => { void stop().catch(() => { process.exitCode = 1; }); });
  process.once('SIGTERM', () => { void stop().catch(() => { process.exitCode = 1; }); });
}

main().catch(error => {
  const value = error as NodeJS.ErrnoException;
  if (value.code === 'EADDRINUSE') {
    console.error('本地管理后台端口已被占用；未关闭或修改现有进程。');
  } else {
    console.error(`本地管理后台启动失败：${error instanceof Error ? error.message : '未知错误'}`);
  }
  process.exitCode = 1;
});
