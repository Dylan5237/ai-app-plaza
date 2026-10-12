<script setup>
import { computed } from 'vue'
import AppExamples from './AppExamples.vue'
import { renderMarkdown, repositoryDocumentBase } from '../lib/markdown.js'

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

const manifest = computed(() => props.app?.manifest || {})
const capabilities = computed(() => manifest.value.capabilities || {})
const source = computed(() => props.app?.source || {})
const tags = computed(() => Array.isArray(manifest.value.tags) ? manifest.value.tags : [])
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
const requirements = computed(() => toList(manifest.value.requirements))
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
const usageDocument = computed(() => documentContent('usage'))

function documentsMatch() {
  const readme = readmeDocument.value
  const usage = usageDocument.value
  if (readme.path && usage.path && normalizeDocumentPath(readme.path) === normalizeDocumentPath(usage.path)) return true
  return Boolean(readme.text.trim()) && readme.text.trim() === usage.text.trim()
}

function docHtml(doc) {
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
  <article class="public-app-content">
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
.public-app-dates { display: flex; min-width: 0; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 7px 16px; margin-top: 12px; color: #8993a2; font-size: 12px; }
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
.public-app-source dt { color: #8993a2; }
.public-app-source dd { min-width: 0; margin: 0; color: #536174; overflow-wrap: anywhere; }
.public-app-source a { color: #315fbd; text-decoration: none; }
.public-app-source a:hover { text-decoration: underline; }
.source-sha { font-family: Consolas, monospace; }
.public-app-entry-info li { display: flex; flex-wrap: wrap; gap: 10px; }
.public-app-entry-info li span { color: #8993a2; }
@media (max-width: 680px) {
  .public-app-title-row h2 { font-size: 19px; }
  .capability-grid { grid-template-columns: 1fr; }
  .capability-wide { grid-column: auto; }
  .public-app-dates, .public-app-date-values { justify-content: flex-start; }
}
</style>
