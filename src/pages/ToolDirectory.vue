<script setup>
import { computed, nextTick, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import AppPublicContent from '../components/AppPublicContent.vue'
import { apiRequest } from '../lib/api.js'
import { renderMarkdown, repositoryDocumentBase } from '../lib/markdown.js'

const query = ref('')
const selectedTags = ref([])
const apps = ref([])
const authorTags = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(8)
const catalogLoading = ref(false)
const catalogError = ref('')
const catalogNotice = ref('')
let catalogRequestSequence = 0

const detailVisible = ref(false)
const detailLoading = ref(false)
const detailError = ref('')
const selectedApp = ref(null)
const instruction = ref(null)
const instructionLoading = ref(false)
const instructionError = ref('')
const instructionEntry = ref(null)
const instructionHtml = computed(() => {
  const source = selectedApp.value?.source || {}
  const instructionSource = instruction.value?.source
  const documentPath = typeof instructionSource === 'string'
    ? instructionSource
    : instructionSource?.path || instructionEntry.value?.instructionsPath || ''
  const baseUrl = repositoryDocumentBase(source.projectUrl, source.commitSha, documentPath)
  return renderMarkdown(instruction.value?.text, { baseUrl })
})

const shareVisible = ref(false)
const contractLoading = ref(false)
const contractError = ref('')
const publishContract = ref(null)
const copyFallbackVisible = ref(false)
const copyFallbackText = ref('')
const copyFallbackTextarea = ref(null)

const publicationId = ref('')
const publication = ref(null)
const publicationLoading = ref(false)
const publicationBusy = ref(false)
const publicationError = ref('')

const pages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
const selectedAppEntries = computed(() => {
  const manifest = selectedApp.value?.manifest || {}
  const entries = Array.isArray(manifest.entries) ? [...manifest.entries] : []
  const primaryId = manifest.primaryEntry
  return entries.sort((left, right) => Number(right.id === primaryId) - Number(left.id === primaryId))
})
const publicationStatusText = computed(() => ({
  checking: '正在检查发布内容',
  preview_ready: '等待作者确认收录',
  registered: '应用已收录',
  failed: '收录未完成',
  cancelled: '发布已取消',
}[publication.value?.status] || '正在读取发布状态'))

function errorText(error) {
  return error?.message || '操作未完成，请稍后重试。'
}

function appName(app) {
  return app?.manifest?.name || '未命名应用'
}

function appSummary(app) {
  return app?.manifest?.summary || '暂无应用简介。'
}

function appTags(app) {
  return Array.isArray(app?.manifest?.tags) ? app.manifest.tags : []
}

function maintainerName(value) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  return value.name || value.displayName || value.username || value.id || ''
}

function appMaintainers(app) {
  const maintainers = app?.manifest?.maintainers
  const values = Array.isArray(maintainers) ? maintainers : maintainers ? [maintainers] : []
  return values.map(maintainerName).filter(Boolean).join('、') || '作者未登记'
}

function formatDate(value) {
  if (!value) return '未登记'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return String(value)
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(parsed)
}

function safeHttpUrl(value) {
  if (typeof value !== 'string') return ''
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''
  } catch {
    return ''
  }
}

async function loadCatalog() {
  const requestSequence = ++catalogRequestSequence
  catalogLoading.value = true
  catalogError.value = ''
  catalogNotice.value = ''
  const params = new URLSearchParams()
  const trimmedQuery = query.value.trim()
  if (trimmedQuery) params.set('query', trimmedQuery)
  for (const tag of selectedTags.value) params.append('tags', tag)
  params.set('page', String(page.value))

  try {
    const result = await apiRequest(`/api/apps?${params.toString()}`)
    if (requestSequence !== catalogRequestSequence) return
    apps.value = Array.isArray(result.items) ? result.items : []
    authorTags.value = Array.isArray(result.tags) ? result.tags : []
    total.value = Number.isFinite(Number(result.total)) ? Number(result.total) : 0
    page.value = Number.isFinite(Number(result.page)) && Number(result.page) > 0 ? Number(result.page) : page.value
    pageSize.value = Number.isFinite(Number(result.pageSize)) && Number(result.pageSize) > 0 ? Number(result.pageSize) : 8
  } catch (error) {
    if (requestSequence !== catalogRequestSequence) return
    apps.value = []
    total.value = 0
    catalogError.value = errorText(error)
  } finally {
    if (requestSequence === catalogRequestSequence) catalogLoading.value = false
  }
}

function searchCatalog() {
  page.value = 1
  return loadCatalog()
}

function toggleTag(tag) {
  selectedTags.value = selectedTags.value.includes(tag)
    ? selectedTags.value.filter((item) => item !== tag)
    : [...selectedTags.value, tag]
  page.value = 1
  loadCatalog()
}

function changePage(nextPage) {
  page.value = nextPage
  loadCatalog()
}

function clearFilters() {
  query.value = ''
  selectedTags.value = []
  page.value = 1
  loadCatalog()
}

async function openApp(id) {
  if (!id) return
  detailVisible.value = true
  detailLoading.value = true
  detailError.value = ''
  selectedApp.value = null
  instruction.value = null
  instructionEntry.value = null
  instructionError.value = ''
  try {
    selectedApp.value = await apiRequest(`/api/apps/${encodeURIComponent(id)}`)
  } catch (error) {
    detailError.value = errorText(error)
  } finally {
    detailLoading.value = false
  }
}

function closeDetail() {
  detailVisible.value = false
  instruction.value = null
  instructionEntry.value = null
  instructionError.value = ''
}

async function loadAgentInstructions(entry) {
  if (!selectedApp.value?.id || !entry?.id) return
  instructionEntry.value = entry
  instruction.value = null
  instructionError.value = ''
  instructionLoading.value = true
  try {
    instruction.value = await apiRequest(
      `/api/apps/${encodeURIComponent(selectedApp.value.id)}/instructions/${encodeURIComponent(entry.id)}`,
    )
  } catch (error) {
    instructionError.value = errorText(error)
  } finally {
    instructionLoading.value = false
  }
}

async function copyText(text, successMessage) {
  if (!text) return
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable')
    await navigator.clipboard.writeText(text)
    ElMessage.success(successMessage)
    return
  } catch {
    // Continue to the legacy copy path for HTTP intranet pages without Clipboard API access.
  }

  let copied = false
  const temporary = document.createElement('textarea')
  temporary.value = String(text)
  temporary.readOnly = true
  temporary.setAttribute('aria-hidden', 'true')
  temporary.style.position = 'fixed'
  temporary.style.left = '-10000px'
  temporary.style.top = '0'
  document.body.appendChild(temporary)
  temporary.select()
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  } finally {
    temporary.remove()
  }

  if (copied) {
    ElMessage.success(successMessage)
  } else {
    copyFallbackText.value = String(text)
    copyFallbackVisible.value = true
    await nextTick()
    selectManualCopyText()
    ElMessage.warning('自动复制不可用，已选中文本，请按 Ctrl+C 复制。')
  }
}

function selectManualCopyText() {
  copyFallbackTextarea.value?.focus()
  copyFallbackTextarea.value?.select()
}

async function openShareDialog() {
  shareVisible.value = true
  contractLoading.value = true
  contractError.value = ''
  publishContract.value = null
  try {
    publishContract.value = await apiRequest('/api/publish-contract')
  } catch (error) {
    contractError.value = errorText(error)
  } finally {
    contractLoading.value = false
  }
}

function publicationToken(id) {
  try {
    return window.sessionStorage.getItem(`ai-app-plaza:publication:${id}`) || ''
  } catch {
    return ''
  }
}

function preparePublicationRoute() {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const id = fragment.get('publish')
  if (!id) return false

  publicationId.value = id
  const ticket = fragment.get('key')
  if (ticket) {
    try {
      window.sessionStorage.setItem(`ai-app-plaza:publication:${id}`, ticket)
    } catch {
      publicationError.value = '浏览器未能保存此私有预览链接的临时授权，请允许当前标签页使用会话存储后重新打开链接。'
    }
  }
  const visibleFragment = new URLSearchParams()
  visibleFragment.set('publish', id)
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#${visibleFragment.toString()}`)

  if (!/^[\w-]{1,128}$/.test(id)) {
    publicationError.value = '私有预览链接中的编号格式无效。'
    return true
  }
  void loadPublication(id)
  return true
}

async function loadPublication(id = publicationId.value) {
  if (!id) return
  publicationLoading.value = true
  publicationError.value = ''
  publication.value = null
  const token = publicationToken(id)
  if (!token) {
    publicationError.value = '未找到此私有预览链接的临时授权，请重新打开作者提供的完整链接。'
    publicationLoading.value = false
    return
  }
  try {
    publication.value = await apiRequest(`/api/publications/${encodeURIComponent(id)}`, { token })
  } catch (error) {
    publicationError.value = errorText(error)
  } finally {
    publicationLoading.value = false
  }
}

async function mutatePublication(action) {
  const current = publication.value
  if (!publicationId.value || !current) return
  const token = publicationToken(publicationId.value)
  if (!token) {
    publicationError.value = '此私有预览链接的临时授权已不可用，请重新打开作者提供的完整链接。'
    return
  }
  publicationBusy.value = true
  publicationError.value = ''
  try {
    if (action === 'confirm') {
      publication.value = await apiRequest(
        `/api/publications/${encodeURIComponent(publicationId.value)}/confirm`,
        {
          method: 'POST',
          token,
          body: { revision: current.revision, digest: current.digest },
        },
      )
    } else {
      publication.value = await apiRequest(
        `/api/publications/${encodeURIComponent(publicationId.value)}/retry`,
        { method: 'POST', token, body: {} },
      )
    }
  } catch (error) {
    publicationError.value = errorText(error)
    try {
      publication.value = await apiRequest(`/api/publications/${encodeURIComponent(publicationId.value)}`, { token })
      publicationError.value = errorText(error)
    } catch {
      // Keep the original action error visible if the status refresh also fails.
    }
  } finally {
    publicationBusy.value = false
  }
}

function applicationUrl(appId) {
  const url = new URL(window.location.pathname, window.location.origin)
  url.searchParams.set('app', appId)
  return url.href
}

async function returnToCatalog() {
  const appId = publication.value?.appId
  publicationId.value = ''
  publication.value = null
  publicationError.value = ''
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`)
  query.value = ''
  selectedTags.value = []
  page.value = 1
  await loadCatalog()
  if (appId) {
    catalogNotice.value = '目录已刷新，以下为已收录应用的最新详情。'
    await openApp(appId)
  }
}

onMounted(async () => {
  if (preparePublicationRoute()) return

  const appId = new URLSearchParams(window.location.search).get('app')
  await loadCatalog()
  if (appId) await openApp(appId)
})
</script>

<template>
  <div v-if="publicationId" class="publication-shell">
    <header class="publication-topbar">
      <a class="publication-brand" href="/">AI应用广场</a>
      <span class="publication-private-label">私有预览</span>
    </header>
    <main class="publication-main">
      <section class="publication-status-card" data-testid="publication-status" aria-live="polite">
        <div class="publication-status-heading">
          <div>
            <p class="eyebrow">作者发布确认</p>
            <h1>{{ publicationStatusText }}</h1>
          </div>
          <span class="publication-status-value" :class="`status-${publication?.status || 'loading'}`">
            {{ publication?.status || (publicationLoading ? '读取中' : '待读取') }}
          </span>
        </div>
        <p class="publication-audience">确认收录后，应用目录对所有能访问本门户的人开放。</p>
        <p v-if="publication?.expiresAt" class="publication-expiry">预览有效期至 {{ formatDate(publication.expiresAt) }}</p>
        <div v-if="publicationLoading" class="publication-message" role="status">正在读取服务端发布状态…</div>
        <div v-else-if="publicationError && !publication" class="publication-message is-error" role="alert">{{ publicationError }}</div>
        <div v-else-if="publication?.status === 'checking'" class="publication-message" role="status">
          服务正在检查提交内容，状态更新后请重新加载此页面。
        </div>
        <div v-else-if="publication?.status === 'failed'" class="publication-message is-error" role="alert">
          {{ publication.error?.message || '服务未能完成收录。' }} 需要修改应用资料时，请让 Agent 更新后重新提交。
        </div>
        <div v-else-if="publication?.status === 'cancelled'" class="publication-message">此发布已取消，无法继续确认。</div>
        <div v-else-if="publication?.status === 'registered'" class="publication-message is-success" role="status">
          应用已进入目录。应用编号：<strong>{{ publication.appId }}</strong>
        </div>
        <div v-else-if="publication?.status === 'preview_ready'" class="publication-message">
          请核对下方公开内容与源码提交，确认后应用将进入目录。
        </div>
        <div v-if="publication?.status === 'preview_ready' && !publication.digest" class="publication-action-error" role="alert">
          服务未提供内容摘要校验值，暂时无法确认收录；请重新读取发布状态。
        </div>
        <div v-if="publicationError && publication" class="publication-action-error" role="alert">{{ publicationError }}</div>
        <div class="publication-actions">
          <button
            v-if="publication?.status === 'preview_ready'"
            class="primary-button"
            data-testid="confirm-publication"
            :disabled="publicationBusy || !publication.digest"
            @click="mutatePublication('confirm')"
          >
            {{ publicationBusy ? '正在确认…' : '确认收录' }}
          </button>
          <button
            v-if="publication?.status === 'failed'"
            class="primary-button"
            data-testid="retry-publication"
            :disabled="publicationBusy"
            @click="mutatePublication('retry')"
          >
            {{ publicationBusy ? '正在重试…' : '重试收录' }}
          </button>
          <button
            v-if="publication?.status === 'registered'"
            class="primary-button"
            data-testid="refresh-catalog"
            :disabled="catalogLoading"
            @click="returnToCatalog"
          >
            {{ catalogLoading ? '正在刷新目录…' : '刷新目录并查看应用' }}
          </button>
          <a
            v-if="publication?.status === 'registered' && publication.appId"
            class="secondary-button"
            :href="applicationUrl(publication.appId)"
          >
            在广场中打开
          </a>
          <button
            v-if="publication?.status === 'checking' || publicationError"
            class="secondary-button"
            :disabled="publicationLoading"
            @click="loadPublication()"
          >
            重新读取状态
          </button>
        </div>
      </section>

      <section v-if="publication?.preview" class="publication-preview" aria-labelledby="publication-preview-title">
        <div class="preview-section-heading">
          <div>
            <p class="eyebrow">公开内容预览</p>
            <h2 id="publication-preview-title">提交版本</h2>
          </div>
          <span v-if="publication.preview.version" class="public-app-version">v{{ publication.preview.version }}</span>
        </div>
        <p class="publication-source-commit">
          源码提交
          <code>{{ publication.preview.source?.commitSha || '未提供提交标识' }}</code>
        </p>
        <AppPublicContent :app="publication.preview" />
      </section>
    </main>
  </div>

  <div v-else class="directory-shell">
    <main class="directory-main">
      <header class="directory-header">
        <div class="brand-block">
          <div class="brand-mark" aria-hidden="true">AI</div>
          <div>
            <h1>AI应用广场</h1>
            <p>发现适合当前任务的 AI 应用</p>
          </div>
        </div>
        <button class="share-button" data-testid="share-button" @click="openShareDialog">分享我的AI应用</button>
      </header>

      <section class="search-section" aria-label="搜索 AI 应用">
        <div class="search-row">
          <el-input
            v-model="query"
            class="search-input"
            data-testid="search-input"
            size="large"
            clearable
            placeholder="搜索应用名称、用途或能力"
            aria-label="搜索应用名称、用途或能力"
            @keyup.enter="searchCatalog"
          >
            <template #prefix><span class="search-symbol" aria-hidden="true">⌕</span></template>
          </el-input>
          <el-button class="search-submit" type="primary" size="large" data-testid="search-button" @click="searchCatalog">搜索</el-button>
        </div>
        <div v-if="authorTags.length" class="tag-filter-row" aria-label="按作者标签筛选">
          <span class="tag-filter-label">能力标签</span>
          <button
            v-for="tag in authorTags"
            :key="tag"
            class="filter-chip"
            :class="{ active: selectedTags.includes(tag) }"
            data-testid="tag-chip"
            :aria-pressed="selectedTags.includes(tag)"
            @click="toggleTag(tag)"
          >{{ tag }}</button>
        </div>
      </section>

      <section class="catalog-section" aria-labelledby="catalog-heading">
        <div class="catalog-heading-row">
          <div>
            <h2 id="catalog-heading">应用目录</h2>
            <span class="catalog-total">{{ total }} 项应用</span>
          </div>
          <button v-if="query || selectedTags.length" class="clear-filters" @click="clearFilters">清除筛选</button>
        </div>

        <div v-if="catalogError" class="catalog-state is-error" role="alert">
          <strong>目录暂时无法加载</strong>
          <p>{{ catalogError }}</p>
          <button class="secondary-button" :disabled="catalogLoading" @click="loadCatalog">重试</button>
        </div>
        <div v-else-if="catalogLoading && !apps.length" class="catalog-state" role="status">正在读取应用目录…</div>
        <div v-else-if="!apps.length" class="catalog-state empty-state">
          <div class="empty-mark" aria-hidden="true">⌕</div>
          <strong>{{ query || selectedTags.length ? '没有找到匹配的应用' : '目录中还没有应用' }}</strong>
          <p>{{ query || selectedTags.length ? '试试其他关键词或清除筛选条件。' : '应用收录后会显示在这里。' }}</p>
          <button v-if="query || selectedTags.length" class="secondary-button" @click="clearFilters">清除筛选</button>
        </div>
        <div v-else class="catalog-results" :aria-busy="catalogLoading">
          <div v-if="catalogNotice" class="catalog-notice" role="status">{{ catalogNotice }}</div>
          <div class="app-grid">
            <article v-for="app in apps" :key="app.id" class="app-card" data-testid="app-card">
              <div class="app-card-top">
                <button class="app-title" :aria-label="`查看 ${appName(app)} 详情`" @click="openApp(app.id)">{{ appName(app) }}</button>
                <span v-if="app.version" class="app-version">v{{ app.version }}</span>
              </div>
              <p class="app-summary">{{ appSummary(app) }}</p>
              <div v-if="appTags(app).length" class="app-tags" aria-label="应用作者标签">
                <button
                  v-for="tag in appTags(app).slice(0, 3)"
                  :key="tag"
                  class="app-tag"
                  :class="{ active: selectedTags.includes(tag) }"
                  :aria-label="`按标签 ${tag} 筛选`"
                  @click="toggleTag(tag)"
                >{{ tag }}</button>
                <span v-if="appTags(app).length > 3" class="app-tag-more">+{{ appTags(app).length - 3 }}</span>
              </div>
              <div class="app-card-footer">
                <span class="app-author">{{ appMaintainers(app) }}</span>
                <div class="app-dates">
                  <time :datetime="app.createdAt || undefined">创建 {{ formatDate(app.createdAt) }}</time>
                  <time :datetime="app.updatedAt || undefined">更新 {{ formatDate(app.updatedAt) }}</time>
                </div>
              </div>
            </article>
          </div>
          <div v-if="apps.length" class="pagination-row" :class="{ 'pagination-empty': pages <= 1 }" data-testid="pagination">
            <el-pagination
              v-if="pages > 1"
              :current-page="page"
              :page-size="pageSize"
              :total="total"
              layout="prev, pager, next"
              background
              @current-change="changePage"
            />
          </div>
        </div>
      </section>
    </main>

    <el-dialog
      v-model="detailVisible"
      class="app-detail-dialog"
      width="min(1080px, 94vw)"
      top="4vh"
      destroy-on-close
      @closed="closeDetail"
    >
      <template #header>
        <div class="detail-dialog-heading">
          <span>应用详情</span>
          <span v-if="selectedApp?.revision" class="detail-revision">记录 {{ selectedApp.revision }}</span>
        </div>
      </template>
      <div v-if="detailLoading" class="dialog-state" role="status">正在读取应用详情…</div>
      <div v-else-if="detailError" class="dialog-state is-error" role="alert">
        <strong>应用详情暂时无法加载</strong>
        <p>{{ detailError }}</p>
      </div>
      <div v-else-if="selectedApp" class="detail-layout" data-testid="app-detail">
        <div class="detail-content-scroll">
          <AppPublicContent :app="selectedApp" />
        </div>
        <aside class="detail-actions" aria-label="应用使用入口">
          <div class="detail-action-heading">
            <h2>开始使用</h2>
            <p>选择作者登记的入口</p>
          </div>
          <div v-if="!selectedAppEntries.length" class="entry-empty">作者尚未登记使用入口。</div>
          <div v-for="entry in selectedAppEntries" :key="entry.id" class="entry-action">
            <template v-if="entry.kind === 'web'">
              <a
                v-if="safeHttpUrl(entry.url)"
                class="primary-button entry-button"
                data-testid="use-web"
                :href="safeHttpUrl(entry.url)"
                target="_blank"
                rel="noopener noreferrer"
              >{{ entry.label || '打开平台应用' }}</a>
              <button v-else class="primary-button entry-button" disabled>{{ entry.label || '平台入口不可用' }}</button>
            </template>
            <template v-else-if="entry.kind === 'agent'">
              <button class="primary-button entry-button" data-testid="use-agent" @click="loadAgentInstructions(entry)">
                {{ entry.label || '接入我的Agent' }}
              </button>
            </template>
          </div>

          <section v-if="instructionEntry" class="instruction-result" aria-live="polite">
            <h3>{{ instructionEntry.label || 'Agent 接入说明' }}</h3>
            <p v-if="instructionEntry.compatibility" class="instruction-compatibility">兼容信息：{{ instructionEntry.compatibility }}</p>
            <p v-if="instructionLoading" class="instruction-state" role="status">正在读取作者接入说明…</p>
            <p v-else-if="instructionError" class="instruction-state is-error" role="alert">{{ instructionError }}</p>
            <template v-else-if="instruction">
              <p v-if="instruction.compatibility && instruction.compatibility !== instructionEntry.compatibility" class="instruction-compatibility">
                兼容信息：{{ typeof instruction.compatibility === 'string' ? instruction.compatibility : JSON.stringify(instruction.compatibility) }}
              </p>
              <p v-if="instruction.source" class="instruction-source">说明来源：{{ typeof instruction.source === 'string' ? instruction.source : JSON.stringify(instruction.source) }}</p>
              <div class="instruction-markdown markdown-body" v-html="instructionHtml" />
              <el-button
                class="copy-instruction-button"
                data-testid="copy-agent-prompt"
                @click="copyText(instruction.text, '接入说明已复制')"
              >复制接入说明</el-button>
            </template>
          </section>
          <p class="detail-no-install-claim">入口信息来自作者提交的应用资料。</p>
        </aside>
      </div>
    </el-dialog>

    <el-dialog v-model="shareVisible" title="分享我的AI应用" width="min(720px, 92vw)" top="8vh">
      <div v-if="contractLoading" class="dialog-state" role="status">正在读取发布说明…</div>
      <div v-else-if="contractError" class="dialog-state is-error" role="alert">
        <strong>发布说明暂时无法加载</strong>
        <p>{{ contractError }}</p>
        <button class="secondary-button" @click="openShareDialog">重试</button>
      </div>
      <div v-else-if="publishContract" class="share-flow">
        <p class="share-intro">把服务提供的任务说明交给你自己的 Agent，由 Agent 提交应用资料；完成后，作者会收到可确认的私有预览链接。</p>
        <ol class="share-steps">
          <li><strong>复制发布任务</strong><span>内容由发布服务提供，包含所需资料和提交约定。</span></li>
          <li><strong>交给你的 Agent 执行</strong><span>Agent 按任务说明准备资料并提交到发布入口。</span></li>
          <li><strong>打开私有预览并确认</strong><span>核对公开内容和源码提交，再确认是否收录。</span></li>
        </ol>
        <div class="publish-prompt-wrap">
          <div class="prompt-heading"><strong>发布任务</strong><span>完整内容</span></div>
          <pre class="publish-prompt">{{ publishContract.prompt }}</pre>
          <el-button
            type="primary"
            data-testid="copy-publish-prompt"
            :disabled="!publishContract.prompt"
            @click="copyText(publishContract.prompt, '发布任务已复制')"
          >复制发布任务</el-button>
        </div>
        <div class="share-links">
          <span v-if="publishContract.audience"><strong>目录可见范围</strong>{{ publishContract.audience }}</span>
          <a v-if="safeHttpUrl(publishContract.submitUrl)" :href="safeHttpUrl(publishContract.submitUrl)" target="_blank" rel="noopener noreferrer">查看提交入口</a>
          <a v-if="safeHttpUrl(publishContract.gitlabUrl)" :href="safeHttpUrl(publishContract.gitlabUrl)" target="_blank" rel="noopener noreferrer">项目托管平台</a>
        </div>
      </div>
    </el-dialog>

    <el-dialog v-model="copyFallbackVisible" title="手动复制文本" width="min(640px, 92vw)" @opened="selectManualCopyText">
      <p class="manual-copy-help">自动复制不可用。文本已选中，请按 Ctrl+C 复制。</p>
      <textarea
        ref="copyFallbackTextarea"
        class="manual-copy-textarea"
        :value="copyFallbackText"
        readonly
        aria-label="待复制文本"
        @focus="selectManualCopyText"
      />
    </el-dialog>
  </div>
</template>

<style scoped>
:global(*) { box-sizing: border-box; }
:global(html), :global(body), :global(#app) { width: 100%; height: 100%; margin: 0; }
:global(body) { background: #f4f6f9; color: #273449; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
.directory-shell { width: 100%; height: 100%; overflow-y: auto; background: #f4f6f9; }
.directory-main { width: min(1480px, calc(100% - 64px)); min-height: 100%; margin: 0 auto; padding: 28px 0 46px; }
.directory-header { display: flex; align-items: center; justify-content: space-between; gap: 22px; }
.brand-block { display: flex; align-items: center; gap: 12px; }
.brand-mark { display: grid; width: 42px; height: 42px; place-items: center; border: 1px solid #d9e2ef; border-radius: 10px; background: #fff; color: #5273a6; font-size: 13px; font-weight: 700; letter-spacing: .3px; }
.brand-block h1 { margin: 0; color: #1e2b3c; font-size: 21px; font-weight: 650; line-height: 1.35; }
.brand-block p { margin: 3px 0 0; color: #8993a2; font-size: 12px; }
.share-button, .primary-button, .secondary-button { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 0 14px; border: 1px solid #315fbd; border-radius: 6px; background: #315fbd; color: #fff; font: inherit; font-size: 13px; font-weight: 550; text-decoration: none; cursor: pointer; transition: background .15s ease, border-color .15s ease; }
.share-button:hover, .primary-button:hover { border-color: #244f9f; background: #244f9f; }
.share-button:focus-visible, .primary-button:focus-visible, .secondary-button:focus-visible, .app-title:focus-visible, .filter-chip:focus-visible { outline: 3px solid #bfd3f5; outline-offset: 2px; }
.primary-button:disabled, .secondary-button:disabled, .share-button:disabled { opacity: .55; cursor: not-allowed; }
.secondary-button { border-color: #d6dde7; background: #fff; color: #46566d; }
.secondary-button:hover { border-color: #bac8db; background: #f8fafc; }
.search-section { margin: 29px 0 31px; padding: 19px 20px 15px; border: 1px solid #e8ebf0; border-radius: 9px; background: #fff; }
.search-row { display: flex; gap: 10px; max-width: 820px; }
.search-input { max-width: 690px; }
.search-input :deep(.el-input__wrapper) { box-shadow: 0 0 0 1px #dfe4ec inset; }
.search-input :deep(.el-input__wrapper.is-focus) { box-shadow: 0 0 0 1px #7ea1df inset; }
.search-symbol { color: #8a95a5; font-size: 22px; line-height: 1; }
.search-submit { min-width: 84px; }
.tag-filter-row { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-top: 15px; }
.tag-filter-label { margin-right: 3px; color: #8590a0; font-size: 12px; }
.filter-chip { min-height: 26px; padding: 3px 9px; border: 1px solid #e2e7ed; border-radius: 5px; background: #fafbfc; color: #677487; font: inherit; font-size: 12px; cursor: pointer; }
.filter-chip:hover { border-color: #c4d0e0; color: #425a7b; }
.filter-chip.active { border-color: #9cb4dc; background: #edf3fc; color: #315fbd; }
.catalog-heading-row { display: flex; align-items: end; justify-content: space-between; margin-bottom: 14px; }
.catalog-heading-row > div { display: flex; align-items: baseline; gap: 10px; }
.catalog-heading-row h2 { margin: 0; color: #253347; font-size: 17px; font-weight: 650; }
.catalog-total { color: #8a94a3; font-size: 12px; }
.clear-filters { border: 0; background: transparent; color: #5273a6; font: inherit; font-size: 12px; cursor: pointer; }
.clear-filters:hover { text-decoration: underline; }
.app-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.app-card { display: flex; min-width: 0; min-height: 218px; flex-direction: column; padding: 16px 16px 13px; border: 1px solid #e5e9ef; border-radius: 8px; background: #fff; box-shadow: 0 1px 2px rgb(25 43 67 / 2%); transition: border-color .15s ease, box-shadow .15s ease, transform .15s ease; }
.app-card:hover { transform: translateY(-1px); border-color: #ccd6e4; box-shadow: 0 5px 15px rgb(25 43 67 / 5%); }
.app-card-top { display: flex; min-height: 28px; align-items: flex-start; justify-content: space-between; gap: 10px; }
.app-title { min-width: 0; padding: 0; overflow: hidden; border: 0; background: transparent; color: #25364e; font: inherit; font-size: 15px; font-weight: 650; line-height: 1.5; text-align: left; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.app-title:hover { color: #315fbd; }
.app-version, .public-app-version { flex: none; padding: 3px 7px; border: 1px solid #dce3ed; border-radius: 5px; background: #f7f9fc; color: #61748f; font-size: 11px; line-height: 1.3; white-space: nowrap; }
.app-summary { display: -webkit-box; min-height: 44px; margin: 9px 0 11px; overflow: hidden; color: #657184; font-size: 13px; line-height: 1.7; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.app-tags { display: flex; min-height: 25px; flex-wrap: wrap; align-items: flex-start; gap: 5px; }
.app-tag, .app-tag-more { padding: 3px 7px; border: 1px solid #e5e9ef; border-radius: 4px; background: #fafbfc; color: #778395; font: inherit; font-size: 11px; line-height: 1.25; }
.app-tag { cursor: pointer; }
.app-tag:hover, .app-tag.active { border-color: #c2d1e7; background: #f1f5fb; color: #4a6792; }
.app-tag-more { border-color: transparent; background: transparent; color: #8993a2; }
.app-card-footer { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 8px; margin-top: auto; padding-top: 12px; border-top: 1px solid #edf0f3; }
.app-author { overflow: hidden; color: #53647a; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.app-dates { display: grid; gap: 4px; color: #8993a2; font-size: 10px; text-align: right; white-space: nowrap; }
.catalog-state { display: flex; min-height: 220px; flex-direction: column; align-items: center; justify-content: center; gap: 9px; padding: 28px; border: 1px solid #e5e9ef; border-radius: 8px; background: #fff; color: #748094; font-size: 13px; text-align: center; }
.catalog-state strong { color: #34445b; font-size: 15px; }
.catalog-state p { margin: 0 0 4px; }
.catalog-state.is-error { color: #7f4d4d; }
.catalog-state.is-error strong { color: #9c4545; }
.empty-mark { display: grid; width: 40px; height: 40px; place-items: center; border-radius: 50%; background: #f2f5f8; color: #8a96a6; font-size: 27px; }
.catalog-notice { margin-bottom: 12px; padding: 9px 12px; border: 1px solid #dce8dc; border-radius: 6px; background: #f8fcf7; color: #4d7250; font-size: 12px; }
.pagination-row { display: flex; justify-content: center; padding: 22px 0 4px; }
.pagination-row.pagination-empty { min-height: 1px; padding: 0; }
.detail-dialog-heading { display: flex; align-items: center; justify-content: space-between; padding-right: 18px; color: #26354a; font-size: 15px; font-weight: 650; }
.detail-revision { color: #98a1af; font-size: 11px; font-weight: 400; }
.detail-layout { display: grid; grid-template-columns: minmax(0, 7fr) minmax(250px, 3fr); gap: 20px; max-height: 72vh; min-height: 260px; }
.detail-content-scroll { min-width: 0; overflow-y: auto; padding: 0 16px 12px 2px; }
.detail-actions { align-self: start; max-height: 72vh; overflow-y: auto; padding: 15px; border: 1px solid #e8ebf0; border-radius: 8px; background: #fafbfd; }
.detail-action-heading { padding-bottom: 12px; border-bottom: 1px solid #e8ebf0; }
.detail-action-heading h2 { margin: 0; color: #2d3b50; font-size: 15px; }
.detail-action-heading p { margin: 5px 0 0; color: #8791a1; font-size: 12px; }
.entry-action { margin-top: 11px; }
.entry-button { width: 100%; min-height: 38px; }
.entry-empty { padding: 15px 0; color: #8590a0; font-size: 12px; line-height: 1.6; }
.detail-no-install-claim { margin: 17px 0 0; color: #9aa3b0; font-size: 11px; line-height: 1.55; }
.instruction-result { margin-top: 18px; padding-top: 13px; border-top: 1px solid #e4e8ee; }
.instruction-result h3 { margin: 0 0 8px; color: #3d4d63; font-size: 13px; }
.instruction-compatibility, .instruction-source, .instruction-state { color: #738094; font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
.instruction-state.is-error { color: #a44d4d; }
.instruction-markdown { max-height: 280px; overflow-y: auto; padding: 9px 10px; border: 1px solid #e7ebf0; border-radius: 6px; background: #fff; color: #526177; font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; }
.instruction-markdown :deep(p) { margin: 6px 0; }
.instruction-markdown :deep(ul), .instruction-markdown :deep(ol) { padding-left: 18px; }
.instruction-markdown :deep(a) { color: #315fbd; }
.instruction-markdown :deep(pre) { overflow-x: auto; padding: 8px; background: #f4f6f9; }
.copy-instruction-button { width: 100%; margin-top: 9px; }
.dialog-state { display: flex; min-height: 160px; flex-direction: column; align-items: center; justify-content: center; gap: 9px; color: #788598; font-size: 13px; text-align: center; }
.dialog-state strong { color: #38495f; font-size: 15px; }
.dialog-state p { max-width: 560px; margin: 0; line-height: 1.6; }
.dialog-state.is-error { color: #8e5454; }
.dialog-state.is-error strong { color: #a14343; }
.share-flow { color: #526177; }
.share-intro { margin: 0 0 15px; font-size: 13px; line-height: 1.7; }
.share-steps { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; counter-reset: share-step; }
.share-steps li { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 1px 10px; align-items: baseline; counter-increment: share-step; }
.share-steps li::before { grid-row: span 2; display: grid; width: 24px; height: 24px; place-items: center; border-radius: 50%; background: #edf3fc; color: #42649b; content: counter(share-step); font-size: 12px; font-weight: 650; }
.share-steps strong { color: #3d4e65; font-size: 13px; }
.share-steps span { color: #8792a2; font-size: 12px; line-height: 1.5; }
.publish-prompt-wrap { margin-top: 19px; padding: 13px; border: 1px solid #e5e9ef; border-radius: 7px; background: #fbfcfd; }
.prompt-heading { display: flex; justify-content: space-between; margin-bottom: 9px; color: #43536a; font-size: 12px; }
.prompt-heading span { color: #9aa3b0; font-weight: 400; }
.publish-prompt { max-height: 245px; overflow: auto; margin: 0 0 12px; padding: 11px; border: 1px solid #e8ebf0; border-radius: 5px; background: #fff; color: #4c5c71; font: 12px/1.65 Consolas, "Microsoft YaHei", sans-serif; white-space: pre-wrap; overflow-wrap: anywhere; }
.share-links { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 18px; margin-top: 14px; color: #778395; font-size: 12px; }
.share-links span { display: flex; flex-basis: 100%; gap: 8px; }
.share-links span strong { color: #57677d; font-weight: 550; }
.share-links a { color: #315fbd; text-decoration: none; }
.share-links a:hover { text-decoration: underline; }
.manual-copy-help { margin: 0 0 10px; color: #69788d; font-size: 13px; }
.manual-copy-textarea { width: 100%; min-height: 220px; resize: vertical; padding: 10px; border: 1px solid #dce2ea; border-radius: 6px; color: #4c5c71; font: 12px/1.65 Consolas, "Microsoft YaHei", sans-serif; }
.publication-shell { width: 100%; height: 100%; overflow-y: auto; background: #f4f6f9; }
.publication-topbar { display: flex; height: 58px; align-items: center; justify-content: space-between; padding: 0 max(24px, calc((100% - 1080px) / 2)); border-bottom: 1px solid #e6eaf0; background: #fff; }
.publication-brand { color: #25364e; font-size: 15px; font-weight: 650; text-decoration: none; }
.publication-private-label { padding: 4px 8px; border: 1px solid #e4e9f0; border-radius: 5px; background: #fafbfd; color: #6e7a8c; font-size: 11px; }
.publication-main { width: min(1080px, calc(100% - 48px)); margin: 24px auto 50px; }
.publication-status-card, .publication-preview { padding: 22px 24px; border: 1px solid #e5e9ef; border-radius: 9px; background: #fff; }
.publication-status-heading { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.eyebrow { margin: 0 0 5px; color: #8b95a4; font-size: 11px; letter-spacing: .02em; }
.publication-status-heading h1, .preview-section-heading h2 { margin: 0; color: #26364b; font-size: 19px; font-weight: 650; }
.publication-status-value { padding: 5px 9px; border: 1px solid #e1e6ed; border-radius: 5px; background: #f8fafc; color: #69788d; font-size: 11px; }
.status-preview_ready { border-color: #d9e4f3; background: #f3f7fc; color: #48668e; }
.status-registered { border-color: #d8e8dc; background: #f5faf6; color: #4b7955; }
.status-failed { border-color: #efdddd; background: #fff8f8; color: #9b5151; }
.publication-audience { margin: 13px 0 0; color: #58677b; font-size: 13px; line-height: 1.6; }
.publication-expiry { margin: 7px 0 0; color: #8993a2; font-size: 11px; }
.publication-message { margin-top: 12px; color: #68768a; font-size: 13px; line-height: 1.65; }
.publication-message.is-error, .publication-action-error { color: #9b4d4d; }
.publication-message.is-success { color: #4c7253; }
.publication-actions { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 17px; }
.publication-preview { margin-top: 16px; }
.preview-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 14px; border-bottom: 1px solid #e8ebf0; }
.publication-source-commit { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin: 13px 0; color: #8a94a3; font-size: 11px; }
.publication-source-commit code { color: #55667d; font-family: Consolas, monospace; overflow-wrap: anywhere; }
@media (max-width: 1180px) {
  .app-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 900px) {
  .directory-main { width: min(100% - 36px, 760px); padding-top: 20px; }
  .app-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .detail-layout { grid-template-columns: minmax(0, 1fr); max-height: 75vh; }
  .detail-content-scroll { max-height: 47vh; padding-right: 3px; }
  .detail-actions { max-height: 25vh; }
}
@media (max-width: 620px) {
  .directory-main { width: calc(100% - 28px); padding-top: 16px; }
  .directory-header { align-items: flex-start; }
  .brand-mark { width: 36px; height: 36px; }
  .brand-block h1 { font-size: 18px; }
  .brand-block p { font-size: 11px; }
  .share-button { min-height: 34px; padding: 0 9px; font-size: 11px; }
  .search-section { margin: 20px 0 23px; padding: 14px; }
  .search-row { gap: 7px; }
  .search-submit { min-width: 62px; padding: 0 10px; }
  .app-grid { grid-template-columns: 1fr; gap: 10px; }
  .app-card { min-height: 200px; }
  .publication-main { width: calc(100% - 24px); margin-top: 12px; }
  .publication-status-card, .publication-preview { padding: 17px 15px; }
  .publication-status-heading h1, .preview-section-heading h2 { font-size: 17px; }
}
</style>
