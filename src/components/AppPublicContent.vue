<script setup>
import { computed } from 'vue'
import AppExamples from './AppExamples.vue'
import { renderMarkdown, repositoryDocumentBase } from '../lib/markdown.js'
import { downloadPackage } from '../lib/api.js'
import { ElMessage } from 'element-plus'

const props = defineProps({
  app: { type: Object, required: true },
  showHeader: { type: Boolean, default: true },
  showCapabilities: { type: Boolean, default: true },
  showConditions: { type: Boolean, default: true },
  showExamples: { type: Boolean, default: true },
  showDocuments: { type: Boolean, default: true },
  showSource: { type: Boolean, default: true },
  showEntries: { type: Boolean, default: true },
})
const emit = defineEmits(['access-lost'])
async function savePackage(url) {
  try { await downloadPackage(url) }
  catch (error) { ElMessage.error(error.message); if ([401,403,404].includes(error.status)) emit('access-lost') }
}
function contentClick(event) {
  const anchor = event.target.closest?.('a[href]')
  if (!anchor) return
  const url = new URL(anchor.href, location.href)
  if (url.origin === location.origin && /\/api\/apps\/[a-f0-9-]+\/packages\/[a-f0-9-]+$/i.test(url.pathname)) {
    event.preventDefault(); savePackage(url.href)
  }
}

const manifest = computed(() => props.app?.manifest || {})
const capabilities = computed(() => manifest.value.capabilities || {})
const source = computed(() => props.app?.source || {})
const authorPreview = computed(() => props.app?.isAuthorPreview === true)
const distributions = computed(() => Array.isArray(props.app?.distributions) ? props.app.distributions : [])
function distributionFor(entry) { return distributions.value.find(item => item.entryId === entry.id) }
function disabledFor(entry) { return props.app?.entryAvailability?.[entry.id]?.status === 'disabled' ? props.app.entryAvailability[entry.id] : null }
function conflictsWithInstallSource(text) {
  if (typeof text !== 'string') return false
  let host = ''
  try { host = new URL(source.value.projectUrl).host.toLowerCase() } catch { /* source is optional */ }
  return /\bgit\s+(?:clone|checkout|switch|pull|fetch)\b/i.test(text) || /\bgit\+(?:ssh|https?):\/\//i.test(text)
    || /\bgit@[^\s:]+:/i.test(text)
    || /https?:\/\/[^\s"'<>]+\.(?:zip|tgz|tar(?:\.(?:gz|bz2|xz))?|whl|msi|exe|git)(?:[?#][^\s"'<>]*)?(?=[\s"'<>)]|$)/i.test(text)
    || /https?:\/\/[^\s"'<>]+\/(?:archive|releases\/download)\//i.test(text)
    || text.split(/\r?\n/).some(line => /https?:\/\//i.test(line) && (
      /\bwget\b/i.test(line) || (/\b(?:curl|iwr|invoke-webrequest)\b/i.test(line) && /(?:\s-(?:o|outfile|output)\b|--output\b|>|\|\s*(?:sh|bash|powershell)\b)/i.test(line))
      || /\b(?:pip|pip3|npm|npx)\s+(?:install|i)\s+https?:\/\//i.test(line)
    )) || Boolean(host && text.toLowerCase().includes(host))
}
const tags = computed(() => Array.isArray(props.app?.tags) ? props.app.tags : Array.isArray(manifest.value.tags) ? manifest.value.tags : [])
const maintainers = computed(() => {
  const values = manifest.value.maintainers
  if (!Array.isArray(values)) return values ? [values] : []
  return values
})
const maintainerNames = computed(() => maintainers.value.map((value) => {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  return typeof value.name === 'string' ? value.name : ''
}).filter(Boolean))
const maintainerLabel = computed(() => maintainerNames.value.join('、') || '未登记')
const scenarios = computed(() => toList(capabilities.value.scenarios))
const inputs = computed(() => toList(capabilities.value.inputs))
const outputs = computed(() => toList(capabilities.value.outputs))
const requirements = computed(() => toList(props.app?.displayRequirements ?? manifest.value.requirements))
const limitations = computed(() => toList(manifest.value.limitations))
const examples = computed(() => Array.isArray(manifest.value.examples) ? manifest.value.examples : [])
const entries = computed(() => Array.isArray(manifest.value.entries) ? manifest.value.entries : [])

function toList(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined && item !== '')
  if (typeof value === 'string' && value.trim()) return [value]
  return []
}

function labelOf(value) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return String(value ?? '')
  return value.name || value.displayName || value.username || value.id || ''
}

function normalizeDocumentPath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\//, '')
}

function documentContent(key) {
  const value = manifest.value.docs?.[key]
  const reference = typeof value === 'string' ? value : value?.path
  const inline = typeof value === 'object' && value ? value.content : ''
  if (typeof reference !== 'string' || !reference.trim()) {
    return { text: typeof inline === 'string' ? inline : '', path: '' }
  }

  const documents = props.app?.documents || {}
  if (Object.hasOwn(documents, reference)) return { text: documents[reference], path: reference }
  const normalizedReference = normalizeDocumentPath(reference)
  const match = Object.entries(documents).find(([path]) => normalizeDocumentPath(path) === normalizedReference)
  if (match) return { text: match[1], path: match[0] }
  if (/\.(?:md|markdown|mdown)$/i.test(reference.trim()) && !/[\r\n]/.test(reference)) {
    return { text: typeof inline === 'string' ? inline : '', path: reference }
  }
  return { text: reference, path: '' }
}

const readmeDocument = computed(() => documentContent('readme'))
const usageDocument = computed(() => {
  const raw = documentContent('usage')
  if (authorPreview.value) return raw
  const guide = distributions.value.find(item => item.delivery !== 'remote' && typeof item.guide === 'string')?.guide
    || distributions.value.find(item => typeof item.guide === 'string')?.guide
  return guide ? { text: guide, path: raw.path } : raw
})

function documentsMatch() {
  const readme = readmeDocument.value
  const usage = usageDocument.value
  return Boolean(readme.text.trim()) && readme.text.trim() === usage.text.trim()
}

function docHtml(doc) {
  if (!authorPreview.value && conflictsWithInstallSource(doc.text)) {
    return '<p>原始资料包含旧的仓库获取步骤，暂不作为安装依据；请使用广场接入说明并联系广场维护者处理。</p>'
  }
  const baseUrl = repositoryDocumentBase(source.value.projectUrl, source.value.commitSha, doc.path)
  return renderMarkdown(doc.text, { baseUrl })
}

const readmeHtml = computed(() => docHtml(readmeDocument.value))
const usageHtml = computed(() => documentsMatch() ? '' : docHtml(usageDocument.value))

function safeHttpUrl(value) {
  if (typeof value !== 'string') return ''
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''
  } catch {
    return ''
  }
}

function formatDate(value) {
  if (!value) return '未登记'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return String(value)
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(parsed)
}

function formatVersion(value) {
  if (value === null || value === undefined || value === '') return ''
  const version = String(value)
  return /^\d/.test(version) ? `v${version}` : version
}
</script>

<template>
  <article class="public-app-content" @click="contentClick">
    <header v-if="props.showHeader" class="public-app-header">
      <div class="public-app-title-row">
        <h2>{{ manifest.name || '未命名应用' }}</h2>
        <span v-if="app.version" class="public-app-version">{{ formatVersion(app.version) }}</span>
      </div>
      <p class="public-app-summary">{{ manifest.summary || '暂无应用简介。' }}</p>
      <div v-if="tags.length" class="public-app-meta">
        <span v-for="tag in tags" :key="tag" class="public-app-tag">{{ tag }}</span>
      </div>
      <div class="public-app-dates">
        <span class="public-app-author">作者：{{ maintainerLabel }}</span>
        <span class="public-app-date-values">
          <time :datetime="app.createdAt || undefined">创建于 {{ formatDate(app.createdAt) }}</time>
          <time :datetime="app.updatedAt || undefined">更新于 {{ formatDate(app.updatedAt) }}</time>
        </span>
      </div>
    </header>

    <section v-if="props.showCapabilities && (scenarios.length || inputs.length || outputs.length)" class="public-app-section">
      <h3>应用能力</h3>
      <div class="capability-grid">
        <div v-if="scenarios.length" class="capability-block capability-wide">
          <h4>适用场景</h4>
          <ul><li v-for="(item, index) in scenarios" :key="index">{{ labelOf(item) }}</li></ul>
        </div>
        <div v-if="inputs.length" class="capability-block">
          <h4>输入材料</h4>
          <ul><li v-for="(item, index) in inputs" :key="index">{{ labelOf(item) }}</li></ul>
        </div>
        <div v-if="outputs.length" class="capability-block">
          <h4>预期产出</h4>
          <ul><li v-for="(item, index) in outputs" :key="index">{{ labelOf(item) }}</li></ul>
        </div>
      </div>
    </section>

    <section v-if="props.showConditions && (requirements.length || limitations.length)" class="public-app-section">
      <h3>使用条件与边界</h3>
      <div class="capability-grid">
        <div v-if="requirements.length" class="capability-block">
          <h4>使用要求</h4>
          <ul><li v-for="(item, index) in requirements" :key="index">{{ labelOf(item) }}</li></ul>
        </div>
        <div v-if="limitations.length" class="capability-block">
          <h4>使用边界</h4>
          <ul><li v-for="(item, index) in limitations" :key="index">{{ labelOf(item) }}</li></ul>
        </div>
      </div>
    </section>

    <AppExamples v-if="props.showExamples" :examples="examples" presentation="full" />

    <section v-if="props.showDocuments && (readmeHtml || usageHtml)" class="public-app-section public-app-docs">
      <h3>应用文档</h3>
      <section v-if="readmeHtml" class="doc-section">
        <h4>项目说明</h4>
        <div class="markdown-body" v-html="readmeHtml" />
      </section>
      <section v-if="usageHtml" class="doc-section">
        <h4>使用说明</h4>
        <div class="markdown-body" v-html="usageHtml" />
      </section>
    </section>

    <section v-if="props.showSource" class="public-app-section public-app-source">
      <h3>来源与版本</h3>
      <dl>
        <div v-if="app.version"><dt>应用版本</dt><dd>{{ formatVersion(app.version) }}</dd></div>
        <div v-if="source.projectId"><dt>项目</dt><dd>{{ source.projectId }}</dd></div>
        <div v-if="source.projectUrl"><dt>项目仓库</dt><dd>
          <a v-if="safeHttpUrl(source.projectUrl)" :href="safeHttpUrl(source.projectUrl)" target="_blank" rel="noopener noreferrer">{{ source.projectUrl }}</a>
          <span v-else>{{ source.projectUrl }}</span>
        </dd></div>
        <div v-if="source.commitSha"><dt>源码提交</dt><dd class="source-sha">{{ source.commitSha }}</dd></div>
        <div v-if="source.manifestPath"><dt>应用清单</dt><dd>{{ source.manifestPath }}</dd></div>
        <div v-if="source.tag"><dt>来源标签</dt><dd>{{ source.tag }}</dd></div>
        <div v-if="app.revision"><dt>目录记录</dt><dd>{{ app.revision }}</dd></div>
      </dl>
    </section>

    <section v-if="props.showEntries && entries.length" class="public-app-section public-app-entry-info">
      <h3>登记的使用入口</h3>
      <ul>
        <li v-for="entry in entries" :key="entry.id">
          <strong>{{ entry.label || '使用入口' }}</strong>
          <span>{{ entry.kind === 'web' ? '平台入口' : 'Agent 接入' }}</span>
          <span v-if="entry.kind === 'agent' && entry.compatibility">{{ entry.compatibility }}</span>
          <div v-if="entry.kind === 'web'" class="entry-details">
            <span>访问地址：</span>
            <a v-if="safeHttpUrl(entry.url)" :href="safeHttpUrl(entry.url)" target="_blank" rel="noopener noreferrer">{{ entry.url }}</a>
            <span v-else>{{ entry.url }}</span>
          </div>
          <div v-if="entry.kind === 'agent'" class="entry-details">
            <p>接入说明：<code>{{ entry.instructionsPath }}</code></p>
            <p v-if="disabledFor(entry)">安装入口暂不可用：{{ disabledFor(entry).reason }}</p>
            <p v-else-if="!distributionFor(entry) && !authorPreview">广场分发包尚未准备，暂不可安装。</p>
            <div v-if="distributionFor(entry)" class="entry-artifact">
              <p v-if="distributionFor(entry).delivery === 'remote'">远程连接入口：无需在本机安装服务端，远程版本另行核验。</p>
              <p v-if="distributionFor(entry).delivery !== 'remote'">广场分发包：{{ distributionFor(entry).type === 'artifact' ? '发布物' : '源码与脚本' }}，{{ distributionFor(entry).size }} 字节</p>
              <p v-if="distributionFor(entry).delivery !== 'remote'">SHA-256：<code>{{ distributionFor(entry).sha256 }}</code></p>
              <el-button v-if="!authorPreview && distributionFor(entry).delivery !== 'remote' && distributionFor(entry).url" type="primary" @click="savePackage(distributionFor(entry).url)">下载安装包</el-button>
              <details v-if="authorPreview && distributionFor(entry).delivery !== 'remote'"><summary>查看确认的分享文件（{{ distributionFor(entry).files.length }} 项）</summary>
                <ul><li v-for="file in distributionFor(entry).files" :key="file.path"><code>{{ file.path }}</code> · {{ file.size }} 字节</li></ul>
              </details>
            </div>
            <details v-if="app.documents?.[entry.instructionsPath] && (authorPreview || distributionFor(entry))">
              <summary>查看广场接入说明全文</summary>
              <div class="markdown-body" v-html="docHtml({ text: (!authorPreview && distributionFor(entry)?.guide) || app.documents[entry.instructionsPath], path: entry.instructionsPath })" />
            </details>
            <div v-for="artifact in authorPreview ? (entry.artifacts || []) : []" :key="artifact.url" class="entry-artifact">
              <span>作者原始产物声明（不是广场下载地址）：</span>
              <a v-if="safeHttpUrl(artifact.url)" :href="safeHttpUrl(artifact.url)" target="_blank" rel="noopener noreferrer">{{ artifact.url }}</a>
              <span v-else>{{ artifact.url }}</span>
              <p>SHA-256：<code>{{ artifact.sha256 }}</code></p>
            </div>
          </div>
        </li>
      </ul>
    </section>
  </article>
</template>

<style scoped>
.public-app-content { color: #273449; }
.public-app-header { padding: 2px 0 18px; border-bottom: 1px solid #e8ebf0; }
.public-app-title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.public-app-title-row h2 { min-width: 0; margin: 0; color: #1f2c3d; font-size: 22px; font-weight: 650; line-height: 1.4; overflow-wrap: anywhere; }
.public-app-version { flex: none; margin-top: 3px; padding: 3px 8px; border: 1px solid #d9e1ee; border-radius: 5px; background: #f5f8fc; color: #526c91; font-size: 12px; line-height: 1.4; }
.public-app-summary { margin: 9px 0 11px; color: #536174; font-size: 14px; line-height: 1.7; white-space: pre-wrap; }
.public-app-meta { display: flex; min-width: 0; flex-wrap: wrap; gap: 6px; }
.public-app-author { min-width: 0; color: #667386; overflow-wrap: anywhere; }
.public-app-tag { padding: 3px 8px; border: 1px solid #e4e8ee; border-radius: 4px; background: #fafbfc; color: #667386; font-size: 12px; }
.public-app-tag { max-width: 100%; overflow-wrap: anywhere; }
.public-app-dates { display: flex; min-width: 0; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 7px 16px; margin-top: 12px; color: var(--plaza-muted); font-size: 12px; }
.public-app-date-values { display: flex; min-width: 0; flex-wrap: wrap; justify-content: flex-end; gap: 4px 16px; }
.public-app-section { min-width: 0; margin-top: 19px; }
.public-app-section h3 { margin: 0 0 11px; color: #2b394c; font-size: 15px; font-weight: 650; }
.capability-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.capability-block { min-width: 0; padding: 12px 14px; border: 1px solid #edf0f4; border-radius: 7px; background: #fbfcfd; overflow-wrap: anywhere; }
.capability-wide { grid-column: 1 / -1; }
.capability-block h4, .doc-section h4 { margin: 0 0 8px; color: #47566a; font-size: 13px; font-weight: 600; }
.capability-block ul, .public-app-entry-info ul { margin: 0; padding-left: 18px; color: #536174; font-size: 13px; line-height: 1.7; }
.doc-section { padding: 12px 14px; border: 1px solid #edf0f4; border-radius: 7px; background: #fff; }
.doc-section + .doc-section { margin-top: 9px; }
.markdown-body { min-width: 0; color: #536174; font-size: 13px; line-height: 1.75; overflow-wrap: anywhere; }
.markdown-body :deep(p) { margin: 7px 0; }
.markdown-body :deep(h1), .markdown-body :deep(h2), .markdown-body :deep(h3) { margin: 14px 0 7px; color: #35445a; font-size: 14px; }
.markdown-body :deep(ul), .markdown-body :deep(ol) { padding-left: 20px; }
.markdown-body :deep(pre) { overflow-x: auto; padding: 10px; border-radius: 5px; background: #f4f6f9; }
.markdown-body :deep(table) { display: block; max-width: 100%; overflow-x: auto; }
.markdown-body :deep(code) { font-family: Consolas, monospace; }
.markdown-body :deep(a) { color: #315fbd; text-decoration: underline; text-underline-offset: 2px; }
.public-app-source dl { display: grid; gap: 8px; margin: 0; }
.public-app-source dl > div { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 10px; font-size: 12px; line-height: 1.6; }
.public-app-source dt { color: var(--plaza-muted); }
.public-app-source dd { min-width: 0; margin: 0; color: #536174; overflow-wrap: anywhere; }
.public-app-source a { color: #315fbd; text-decoration: none; }
.public-app-source a:hover { text-decoration: underline; }
.source-sha { font-family: Consolas, monospace; }
.public-app-entry-info li { display: flex; flex-wrap: wrap; gap: 10px; }
.public-app-entry-info li span { color: var(--plaza-muted); }
.public-app-entry-info li + li { margin-top: 14px; }
.entry-details { width: 100%; min-width: 0; overflow-wrap: anywhere; }
.entry-details p { margin: 0; }
.entry-details a { color: #315fbd; }
.entry-details details { margin: 6px 0; }
.entry-details summary { width: fit-content; cursor: pointer; color: #315fbd; }
.entry-artifact { margin-top: 8px; }
@media (max-width: 680px) {
  .public-app-title-row h2 { font-size: 19px; }
  .capability-grid { grid-template-columns: 1fr; }
  .capability-wide { grid-column: auto; }
  .public-app-dates, .public-app-date-values { justify-content: flex-start; }
}
</style>
