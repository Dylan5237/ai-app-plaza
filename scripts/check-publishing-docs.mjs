import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import MarkdownIt from 'markdown-it';
import { manifestJson } from '../server/domain/manifest.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const markdown = new MarkdownIt();
const documents = [
  'README.md',
  'docs/integration/publishing.md',
  'docs/architecture/architecture.md',
  'docs/architecture/data-contract.md',
  'docs/architecture/decisions-2026-10-10.md',
  'docs/product/requirements.md',
  'docs/product/mainflow-scope.md',
  'docs/product/capability-boundaries.md',
  'docs/ops/github-command-center.md',
  'docs/ops/github-phase-1.md',
  'docs/ops/publishing-validation-recovery.md',
  'docs/ops/private-preview-administration.md',
];

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function headingIds(tokens) {
  const counts = new Map();
  const ids = new Set();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'heading_open') continue;
    const inline = tokens[i + 1];
    const text = (inline?.children ?? []).map(token => token.content).join('');
    const base = text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '').replace(/ /g, '-');
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    ids.add(count ? base + '-' + count : base);
  }
  return ids;
}

async function main() {
  const schemaPath = resolve(root, 'server/contracts/app-manifest.schema.json');
  const wrapperPath = resolve(root, 'docs/architecture/app-manifest.schema.json');
  const schema = await readJson(schemaPath);
  const wrapper = await readJson(wrapperPath);
  const schemaUrl = pathToFileURL(schemaPath);
  const wrapperUrl = pathToFileURL(wrapperPath);
  assert.equal(new URL(wrapper.$ref, wrapperUrl).href, schemaUrl.href, '旧 Schema 必须引用服务端 Schema');
  assert.equal(schema.properties.schemaVersion.const, '2', '协议版本变化时须复核接入文档');
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(schema, schemaUrl.href);
  const validateReference = ajv.compile({ ...wrapper, $id: wrapperUrl.href });
  const exampleDir = resolve(root, 'docs/architecture/examples');
  const examples = (await readdir(exampleDir)).filter(name => name.endsWith('.json')).sort();
  assert.ok(examples.length >= 3, '应保留平台、Agent 和本地工具样例');
  for (const name of examples) {
    const raw = await readFile(resolve(exampleDir, name), 'utf8');
    const sample = manifestJson(raw, JSON.parse(raw).appKey);
    assert.ok(validateReference(sample), name + ' 不符合旧路径引用的运行时 Schema');
    console.log('PASS v2 example: ' + name);
  }

  const cache = new Map();
  async function parseDocument(path) {
    if (!cache.has(path)) cache.set(path, markdown.parse(await readFile(path, 'utf8'), {}));
    return cache.get(path);
  }
  let linkCount = 0;
  for (const name of documents) {
    const path = resolve(root, name);
    const tokens = await parseDocument(path);
    for (const block of tokens) {
      for (const token of block.children ?? []) {
        if (token.type !== 'link_open' && token.type !== 'image') continue;
        const href = token.attrGet(token.type === 'image' ? 'src' : 'href');
        if (!href || /^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) continue;
        const url = new URL(href, pathToFileURL(path));
        assert.equal(url.protocol, 'file:', name + ': unexpected local link protocol');
        const destination = fileURLToPath(url);
        const fromRoot = relative(root, destination);
        assert.ok(!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith('../') && !fromRoot.startsWith('..\\'), name + ': link leaves repository: ' + href);
        assert.ok((await stat(destination)).isFile(), name + ': link is not a file: ' + href);
        if (url.hash && extname(destination) === '.md') {
          const anchor = decodeURIComponent(url.hash.slice(1));
          assert.ok(headingIds(await parseDocument(destination)).has(anchor), name + ': missing heading: ' + href);
        }
        linkCount++;
      }
    }
  }
  console.log('PASS runtime Schema reference and ' + linkCount + ' local links in ' + documents.length + ' documents');
}

main().catch(error => {
  console.error('Publishing documentation check failed: ' + error.message);
  process.exitCode = 1;
});
