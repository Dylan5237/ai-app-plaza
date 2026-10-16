import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';

export const SHA = 'a'.repeat(40);
export const SHA2 = 'b'.repeat(40);
export const TOKEN = 'test-only-maintainer-token';
export const DEFAULT_TAG = 'v1.0.0';
export function manifest(index = 1) {
  return { schemaVersion: '2', appKey: `sample-${index}`, name: `DocPilot 文档助手 ${index}`, summary: '将 Word 转为 Markdown，保留表格并生成清晰的文档摘要。',
    projectVersion: '1.0.0', tags: index % 2 ? ['文档处理', '知识整理'] : ['代码审查'], maintainers: [{ name: '张明', nameEn: 'Ming Zhang' }],
    capabilities: { scenarios: ['转换 Word 文档并整理知识'], inputs: ['Word 文档'], outputs: ['Markdown 文档', '文档摘要'] },
    examples: [{ request: '将 Word 转为 Markdown 并保留表格', expectedResult: '输出 Markdown 与转换说明' }], requirements: ['测试工作区'], limitations: ['受控测试资料，不是可安装的正式应用'],
    docs: { readme: `docs/usage-${index}.md`, usage: `docs/usage-${index}.md` },
    entries: [{ id: 'web', kind: 'web', label: '打开平台', url: 'https://example.invalid/docpilot' }, { id: 'agent', kind: 'agent', label: '接入我的Agent', instructionsPath: `docs/agent-${index}.md`, compatibility: ['Codex', 'WorkBuddy'] }], primaryEntry: index % 2 ? 'agent' : 'web' };
}

/** Explicit, loopback-only GitLab protocol fixture. Never used by runtime configuration. */
export async function startGitLabFixture(count = 1) {
  const files = new Map<string, string>();
  for (let i = 1; i <= count; i++) {
    files.set(i === 1 ? 'ai-app.json' : `.ai-apps/sample-${i}/ai-app.json`, JSON.stringify(manifest(i)));
    files.set(`docs/usage-${i}.md`, `# 使用步骤与说明\n\n1. 准备 Word 文档。\n2. 在目标工具中转换。\n3. 核对表格与输出。\n\n## 示例\n将需求文档转换为 Markdown。\n\n<script>window.fixtureXss=true</script>\n![remote](https://example.invalid/track.png)`);
    files.set(`docs/agent-${i}.md`, '# 接入说明\n\n此为协议测试材料，不执行真实安装。\n1. 核对环境和授权。\n2. 取得固定版本。\n3. 执行最小验证，失败时保留原配置。');
  }
  const state = { offline: false, role: 40, tagName: DEFAULT_TAG, tagSha: SHA, releaseSha: SHA, releasePresent: true, userId: 10, files, modes: new Map<string, string>(), delayMs: 0, delayOverrides: new Map<string, number>(), active: 0, peak: 0, requests: [] as { method: string; path: string; query: string }[] };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    state.requests.push({ method: req.method!, path: url.pathname, query: url.search });
    state.active++; state.peak = Math.max(state.peak, state.active);
    let ended = false;
    const controller = new AbortController();
    const done = () => { if (!ended) { ended = true; state.active--; } };
    res.once('finish', done);
    res.once('close', () => { controller.abort(); done(); });
    const delay = state.delayOverrides.get(url.pathname) ?? state.delayMs;
    if (delay) try { await pause(delay, undefined, { signal: controller.signal }); } catch { return; }
    const send = (code: number, data: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: 'READ_ONLY_FIXTURE' });
    if (state.offline) return send(503, { error: 'fixture unavailable' });
    const auth = req.headers['private-token'] || req.headers.authorization?.replace(/^Bearer /, '');
    if (auth !== TOKEN) return send(401, { error: 'invalid fixture token' });
    if (url.pathname === '/api/v4/user') return send(200, { id: state.userId, username: 'fixture-author', name: '测试作者' });
    const match = url.pathname.match(/^\/api\/v4\/projects\/([^/]+)(.*)$/);
    if (!match || !['1', 'test/project'].includes(decodeURIComponent(match[1]))) return send(404, { error: 'not found' });
    const suffix = match[2];
    if (!suffix) return send(200, { id: 1, name: '协议测试项目', web_url: `http://${req.headers.host}/test/project`, created_at: '2026-01-02T03:04:05Z', default_branch: 'main', permissions: { project_access: { access_level: state.role }, group_access: null } });
    if (suffix.startsWith('/members/all/')) return send(200, { id: state.userId, access_level: state.role });
    if (suffix.startsWith('/repository/commits/')) {
      const sha = decodeURIComponent(suffix.split('/').at(-1)!);
      return [SHA, SHA2].includes(sha) ? send(200, { id: sha, short_id: sha.slice(0, 8), created_at: '2026-09-01T00:00:00Z' }) : send(404, { error: 'commit not found' });
    }
    if (suffix.startsWith('/repository/tags/')) {
      const tagName = decodeURIComponent(suffix.slice('/repository/tags/'.length));
      return tagName === state.tagName ? send(200, { name: tagName, commit: { id: state.tagSha } }) : send(404, { error: 'tag not found' });
    }
    if (suffix.startsWith('/releases/')) {
      const tagName = decodeURIComponent(suffix.slice('/releases/'.length));
      return state.releasePresent && tagName === state.tagName ? send(200, { tag_name: tagName, commit: { id: state.releaseSha } }) : send(404, { error: 'release not found' });
    }
    if (suffix === '/repository/tree') {
      const parent = url.searchParams.get('path') || '';
      const prefix = parent ? `${parent}/` : '';
      const recursive = url.searchParams.get('recursive') === 'true';
      const entries = [...files.keys()].filter(path => path.startsWith(prefix) && (recursive || !path.slice(prefix.length).includes('/'))).map(path => ({ id: createHash('sha1').update(files.get(path)!).digest('hex'), name: path.split('/').at(-1), path, type: 'blob', mode: state.modes.get(path) || '100644' }));
      if (!recursive) for (const name of new Set([...files.keys()].filter(path => path.startsWith(prefix) && path.slice(prefix.length).includes('/')).map(path => path.slice(prefix.length).split('/')[0]!))) {
        entries.push({ id: 'directory', name, path: prefix + name, type: 'tree', mode: '040000' });
      }
      return send(200, entries);
    }
    if (suffix.startsWith('/repository/files/')) {
      const raw = suffix.endsWith('/raw');
      const file = decodeURIComponent(suffix.slice('/repository/files/'.length, raw ? -4 : undefined));
      const text = files.get(file);
      if (text === undefined) return send(404, { error: 'file not found' });
      if (![SHA, SHA2].includes(url.searchParams.get('ref') || '')) return send(400, { error: 'immutable ref required' });
      const bytes = Buffer.from(text);
      if (raw) { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(bytes); }
      return send(200, { file_name: file.split('/').at(-1), file_path: file, size: bytes.length, encoding: 'base64', content: bytes.toString('base64'), content_sha256: createHash('sha256').update(bytes).digest('hex'), ref: url.searchParams.get('ref'), blob_id: createHash('sha1').update(bytes).digest('hex'), commit_id: url.searchParams.get('ref'), last_commit_id: SHA, execute_filemode: false });
    }
    return send(404, { error: 'not found' });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { state, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}
