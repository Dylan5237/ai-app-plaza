import { spawn } from 'node:child_process';
try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const origin = new URL(process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:4173');
if (origin.hostname !== '127.0.0.1' || origin.protocol !== 'http:') throw new Error('开发模式使用 http://127.0.0.1:<端口>');
const frontPort = Number(origin.port || 80);
const apiPort = frontPort + 1;
if (apiPort > 65535) throw new Error('开发端口过大');
const env = { ...process.env, PUBLIC_ORIGIN: origin.origin, PORT: String(apiPort), HOST: '127.0.0.1', PLAZA_LOCAL: '1', PLAZA_API_TARGET: `http://127.0.0.1:${apiPort}` };
const api = spawn(process.execPath, ['--import', 'tsx', '--watch', 'server/index.ts'], { env, stdio: 'inherit', windowsHide: true });
const web = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(frontPort), '--strictPort'], { env, stdio: 'inherit', windowsHide: true });
let stopping = false;
function stop(code = 0) { if (stopping) return; stopping = true; api.kill(); web.kill(); process.exitCode = code; }
process.once('SIGINT', () => stop()); process.once('SIGTERM', () => stop());
for (const child of [api, web]) { child.on('error', () => stop(1)); child.on('exit', code => { if (!stopping) stop(code || 0); }); }
