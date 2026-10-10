const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const project = path.resolve(__dirname, '..')
const original = path.join(project, 'generated/portal-fragment.html')
const source = fs.readFileSync(original, 'utf8')
const publicDir = path.join(project, 'public')
const assetsDir = path.join(publicDir, 'assets')
fs.mkdirSync(assetsDir, { recursive: true })
fs.copyFileSync(path.join(project, 'node_modules/lucide/dist/umd/lucide.min.js'), path.join(assetsDir, 'lucide.js'))
const html = [
  '<!doctype html>',
  '<html lang="zh-CN" data-visualize-standalone>',
  '<head>',
  '  <meta charset="UTF-8">',
  '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
  '  <title>AI应用广场</title>',
  '  <style>html,body{width:100%;height:100%;margin:0;overflow:hidden}body{min-width:900px}#ai-tool-portal{height:100dvh}</style>',
  '  <script src="./assets/lucide.js"></script>',
  '</head>',
  '<body>',
  source,
  '<script>window.parent.postMessage({type:"portal-ready"}, window.location.origin)</script>',
  '</body>',
  '</html>',
  ''
].join('\n')
fs.writeFileSync(path.join(publicDir, 'portal.html'), html, 'utf8')
const manifest = {
  sourcePath: 'generated/portal-fragment.html',
  sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
  sourceBytes: Buffer.byteLength(source),
  packagedPortalSha256: crypto.createHash('sha256').update(html).digest('hex'),
  packagedPortalBytes: Buffer.byteLength(html),
  lucidePath: 'public/assets/lucide.js',
  lucideBytes: fs.statSync(path.join(assetsDir, 'lucide.js')).size,
  sourceCopiedWithoutEditing: true,
  externalResourceReferencesInSource: (source.match(/https?:\/\//g) || []).length
}
fs.writeFileSync(path.join(project, 'generated/build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
process.stdout.write(JSON.stringify(manifest, null, 2) + '\n')
