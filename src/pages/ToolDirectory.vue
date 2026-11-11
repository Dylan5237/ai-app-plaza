<script setup>
import { formatDate } from '../lib/date.ts'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElDialog, ElMessage, ElPopover } from 'element-plus'
import PlazaIcon from '../components/PlazaIcon.vue'
import '../styles/design-tokens.css'
import AppDetailOverview from '../components/AppDetailOverview.vue'
import AppPublicContent from '../components/AppPublicContent.vue'
import { identity } from '../lib/identity.js'
import AppExamples from '../components/AppExamples.vue'
import ListPagination from '../components/ListPagination.vue'
import CatalogCard from '../components/CatalogCard.vue'
import CatalogWheel from '../components/CatalogWheel.vue'
import FavoriteButton from '../components/FavoriteButton.vue'
import { apiRequest } from '../lib/api.js'
import { publicPath } from '../lib/public-path.js'
import { renderMarkdown, repositoryDocumentBase } from '../lib/markdown.js'
import { catalogPageCapacity, primaryAction, safeHttpUrl } from '../lib/catalog.ts'
import { enableAnalytics, track, uuid } from '../lib/analytics.js'

const props = defineProps({ management: { type: Boolean, default: false }, managementEnabled: { type: Boolean, default: false }, personalReturn: { type: Boolean, default: false } })
const emit = defineEmits(['return'])
let disposed = false
defineExpose({ openApp, usePrimary, filterByTag: filterFromWheel })

const discoveryTab = ref('catalog')
const randomItems = ref([])
const randomIndex = ref(0)
const randomLoading = ref(false)
const randomRevalidating = ref(false)
const randomError = ref('')
const randomAllShown = ref(false)
let randomLoaded = false
let randomRequestSequence = 0
const scrollPositions = { catalog: 0, random: 0 }
let measurementEnabled = false
let portalViewed = false
let publicationFlowId = null
let resultSetId = null
let randomResultSetId = null
let discoveryRequestId = uuid()
let exposureObserver
let exposureGeneration = 0
const exposureTimers = new Map()
const exposed = new Set()
function pageContext() { return detailVisible.value ? 'detail' : discoveryTab.value === 'random' ? 'random' : 'catalog' }
function entryMode() { return detailOriginUrl ? 'catalog' : new URLSearchParams(location.search).has('app') ? 'detail_link' : 'catalog' }
function eventAttributes(extra = {}) { return { pageContext: pageContext(), entryMode: entryMode(), ...extra } }
function appEvent(app) { return app?.id && app?.snapshotId ? { appId: app.id, snapshotId: app.snapshotId } : null }
function resultContext() { const id = discoveryTab.value === 'random' ? randomResultSetId : resultSetId; return id ? { resultSetId: id } : {} }
function recordFailure(operationKind, error) {
  const allowed = ['NOT_FOUND', 'RATE_LIMITED', 'INVALID_REQUEST', 'SERVICE_UNAVAILABLE']
  const safeErrorCode = allowed.includes(error?.code) ? error.code : error?.status ? 'UNKNOWN_ERROR' : 'NETWORK_ERROR'
  const interactionId = uuid()
  if (interactionId) track('portal_operation_failed', eventAttributes({ operationKind, safeErrorCode }), { interactionId, ...resultContext() })
}
function recordEntry(app, entry, placement) {
  const appContext = appEvent(app), interactionId = uuid()
  if (!props.management && appContext && interactionId && entry?.id && ['web', 'agent'].includes(entry.kind)) {
    track('app_entry_clicked', eventAttributes({ entryId: entry.id, entryKind: entry.kind, placement }), { ...appContext, interactionId, ...resultContext() })
  }
}
function clearExposureObserver() {
  exposureGeneration++
  exposureObserver?.disconnect()
  exposureObserver = undefined
  for (const timer of exposureTimers.values()) clearTimeout(timer)
  exposureTimers.clear()
}
async function observeCards() {
  clearExposureObserver()
  const generation = exposureGeneration
  if (!measurementEnabled || props.management || detailVisible.value || document.hidden || typeof IntersectionObserver === 'undefined') return
  await nextTick()
  if (generation !== exposureGeneration || document.hidden || detailVisible.value) return
  const random = discoveryTab.value === 'random'
  const resultId = random ? randomResultSetId : resultSetId
  const list = random ? randomItems.value : apps.value
  if (!resultId || !directoryMain.value) return
  const selector = random ? '[data-testid="wheel-current"] [data-testid="app-card"]' : '.catalog-results [data-testid="app-card"]'
  const cards = [...directoryMain.value.querySelectorAll(selector)]
  exposureObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const card = entry.target
      const key = `${resultId}:${card.dataset.appId}`
      clearTimeout(exposureTimers.get(card)); exposureTimers.delete(card)
      if (!entry.isIntersecting || entry.intersectionRatio < .5 || exposed.has(key)) continue
      const app = list.find(item => item.id === card.dataset.appId)
      const context = appEvent(app)
      if (!context) continue
      const position = Math.max(1, list.findIndex(item => item.id === app.id) + 1)
      exposureTimers.set(card, setTimeout(() => {
        exposureTimers.delete(card)
        if (document.hidden || detailVisible.value || !card.isConnected || exposed.has(key)) return
        exposed.add(key)
        track('app_card_exposed', eventAttributes({ position, section: random ? 'random' : 'catalog' }), { ...context, resultSetId: resultId })
      }, 1000))
    }
  }, { threshold: [.5] })
  cards.forEach(card => exposureObserver.observe(card))
}
function onVisibilityChange() { void observeCards() }
watch(randomIndex, () => { if (discoveryTab.value === 'random') void observeCards() }, { flush: 'post' })
const detailHeading = ref(null)
let detailOriginFocus = null
let detailOriginUrl = ''
let refreshOnReturn = false
let primaryRequestSequence = 0

function shell() { return directoryMain.value?.closest('.directory-shell') }

async function selectDiscovery(tab) {
  scrollPositions[discoveryTab.value] = shell()?.scrollTop || 0
  discoveryTab.value = tab
  await nextTick()
  if (shell()) shell().scrollTop = scrollPositions[tab]
  if (tab === 'random' && !randomLoaded) await loadRandom()
  void observeCards()
}

async function loadRandom({ revalidating = false } = {}) {
  if (revalidating && !randomItems.value.length) return
  const sequence = ++randomRequestSequence
  randomLoading.value = true
  randomRevalidating.value = revalidating
  randomError.value = ''
  const params = new URLSearchParams(randomItems.value.map(app => ['exclude', app.id]))
  try {
    const batch = randomItems.value
    let result
    if (revalidating) {
      const checked = await Promise.allSettled(batch.map(app => apiRequest(appPath(app.id))))
      const failure = checked.find(item => item.status === 'rejected' && [401, 403].includes(item.reason.status))
        || checked.find(item => item.status === 'rejected' && item.reason.status !== 404)
      if (failure) throw failure.reason
      result = { items: checked.flatMap((item, index) => item.status === 'fulfilled' ? [{ ...batch[index], ...item.value, documents: {} }] : []), allShown: randomAllShown.value }
    } else result = await apiRequest(`/api/apps/random?${params}`)
    if (sequence !== randomRequestSequence) return
    const currentId = randomItems.value[randomIndex.value]?.id
    const previousIndex = randomIndex.value
    randomItems.value = result.items
    if (!revalidating) randomResultSetId = uuid()
    randomAllShown.value = result.allShown
    const keptIndex = result.items.findIndex(app => app.id === currentId)
    randomIndex.value = revalidating ? Math.max(0, keptIndex >= 0 ? keptIndex : Math.min(previousIndex, result.items.length - 1)) : 0
    randomLoaded = true
    void observeCards()
  } catch (error) {
    if (sequence === randomRequestSequence) {
      if ([401, 403].includes(error.status)) { randomItems.value = []; randomLoaded = false; randomAllShown.value = false; randomIndex.value = 0 }
      randomError.value = errorText(error); recordFailure('random', error)
    }
  } finally {
    if (sequence === randomRequestSequence) { randomLoading.value = false; randomRevalidating.value = false }
  }
}

async function filterFromWheel(tag) {
  await selectDiscovery('catalog')
  toggleTag(tag)
}

async function usePrimary(app) {
  const action = primaryAction(app)
  if (action.reason) return
  const sequence = ++primaryRequestSequence
  // Reserve the tab during the user gesture; never navigate to an unchecked stale URL.
  const tab = action.entry.kind === 'web' ? window.open('about:blank', '_blank') : null
  if (tab) tab.opener = null
  try {
    const current = await apiRequest(appPath(app.id))
    if (sequence !== primaryRequestSequence) { tab?.close(); return }
    const latest = primaryAction(current)
    if (latest.reason) throw new Error(latest.reason)
    if (latest.entry.id !== action.entry.id || latest.entry.kind !== action.entry.kind) throw new Error('作者主入口已变更，请查看最新详情。')
    if (latest.entry.kind === 'web') {
      if (!tab) throw new Error('浏览器阻止了新标签页，请允许弹出窗口后重试。')
      // A noreferrer link also prevents the portal URL being sent to the target.
      const link = tab.document.createElement('a')
      link.href = safeHttpUrl(latest.entry.url)
      link.rel = 'noreferrer'
      tab.document.body.appendChild(link)
      recordEntry(current, latest.entry, 'card')
      link.click()
    } else {
      recordEntry(current, latest.entry, 'card')
      selectedApp.value = current
      await loadAgentInstructions(latest.entry)
    }
  } catch (error) {
    tab?.close()
    if (disposed || sequence !== primaryRequestSequence) return
    ElMessage.error(errorText(error))
    if (error?.status === 404) await openApp(app.id)
  }
}

const query = ref('')
const selectedTags = ref([])
const selectedUsage = ref('all')
const usageCounts = ref({ platform: 0, agent: 0 })
const usageOptions = [
  { value: 'all', label: '全部' },
  { value: 'platform', label: '平台类应用' },
  { value: 'agent', label: 'Agent能力' },
]
const apps = ref([])
const authorTags = ref([])
const tagRow = ref(null)
const tagMeasure = ref(null)
const visibleTagCount = ref(0)
const visibleTags = computed(() => authorTags.value.slice(0, visibleTagCount.value))
const overflowTags = computed(() => authorTags.value.slice(visibleTagCount.value))
let tagObserver
let tagFrame = 0
function measureTags() {
  cancelAnimationFrame(tagFrame)
  tagFrame = requestAnimationFrame(() => {
    const row = tagRow.value, measure = tagMeasure.value
    if (!row || !measure || !row.clientWidth) return
    const chips = [...measure.querySelectorAll('.filter-chip')]
    const gap = parseFloat(getComputedStyle(row).gap) || 0
    const fixed = [...row.querySelectorAll(':scope > .tag-filter-label, :scope > .tag-all, :scope > .clear-filters')]
    const available = row.clientWidth - fixed.reduce((sum, item) => sum + item.offsetWidth + gap, 0) - 8
    const allWidth = chips.reduce((sum, chip) => sum + chip.offsetWidth + gap, 0)
    let remaining = available - (allWidth > available ? measure.querySelector('.tag-more').offsetWidth + gap : 0)
    let count = 0
    for (const chip of chips) {
      if (chip.offsetWidth + gap > remaining) break
      remaining -= chip.offsetWidth + gap
      count++
    }
    visibleTagCount.value = count
  })
}
watch(tagRow, row => {
  tagObserver?.disconnect()
  if (row) { tagObserver = new ResizeObserver(measureTags); tagObserver.observe(row); measureTags() }
}, { flush: 'post' })
watch([authorTags, query, selectedTags, selectedUsage], async () => { await nextTick(); measureTags() }, { flush: 'post' })
const total = ref(0)
const page = ref(1)
const pageSize = ref(8)
const directoryMain = ref(null)
const catalogHeading = ref(null)
const paginationRow = ref(null)
let layoutObserver
let layoutFrame = 0
let catalogReady = false
const catalogLoading = ref(false)
const catalogError = ref('')
const catalogNotice = ref('')
let catalogRequestSequence = 0

const detailVisible = ref(false)
let detailRequestSequence = 0
const detailLoading = ref(false)
const detailError = ref('')
const selectedApp = ref(null)
const detailDocumentsVisible = ref(false)
const detailSourceVisible = ref(false)
const instructionDialogVisible = ref(false)
const instruction = ref(null)
const instructionLoading = ref(false)
const instructionError = ref('')
const instructionEntry = ref(null)
let instructionRequestSequence = 0
const instructionHtml = computed(() => {
  const source = instruction.value?.source || selectedApp.value?.source || {}
  const instructionSource = instruction.value?.source
  const documentPath = typeof instructionSource === 'string'
    ? instructionSource
    : instruction.value?.instructionsPath || instructionSource?.path || instructionEntry.value?.instructionsPath || ''
  const baseUrl = repositoryDocumentBase(source.projectUrl, source.commitSha, documentPath)
  return renderMarkdown(instruction.value?.text, { baseUrl })
})

const shareVisible = ref(false)
const shareAppId = ref('')
let contractRequestSequence = 0
const contractLoading = ref(false)
const contractError = ref('')
const publishContract = ref(null)
const copyFallbackVisible = ref(false)
const copyFallbackText = ref('')
const copyFallbackTextarea = ref(null)

const publicationId = ref('')
let publicationRequestSequence = 0
const publication = ref(null)
const publicationLoading = ref(false)
const publicationBusy = ref(false)
const publicationError = ref('')

const catalogGroups = computed(() => [{ value: selectedUsage.value, label: '应用目录', apps: apps.value }])
const selectedAppEntries = computed(() => {
  const manifest = selectedApp.value?.manifest || {}
  const entries = Array.isArray(manifest.entries) ? [...manifest.entries] : []
  const primaryId = manifest.primaryEntry
  return entries.sort((left, right) => Number(right.id === primaryId) - Number(left.id === primaryId))
})
const publicationExpired = computed(() => Boolean(publication.value?.expiresAt) && new Date(publication.value.expiresAt).getTime() <= Date.now())
const isUpdate = computed(() => publication.value?.change?.kind === 'update')
const isUnchanged = computed(() => publication.value?.change?.kind === 'unchanged')
const publicationStatusText = computed(() => ({
  checking: '正在检查发布内容',
  preview_ready: isUpdate.value ? '等待作者确认更新' : '等待作者确认收录',
  registered: isUnchanged.value ? '已是当前收录版本' : isUpdate.value ? '应用已更新' : '应用已收录',
  failed: isUpdate.value ? '本次更新未完成' : '收录未完成',
  cancelled: '发布已取消',
}[publication.value?.status] || '正在读取发布状态'))

function errorText(error) {
  return error?.message || '操作未完成，请稍后重试。'
}

function formatVersion(value) {
  if (value === null || value === undefined || value === '') return ''
  const version = String(value)
  return /^\d/.test(version) ? `v${version}` : version
}


async function loadCatalog({ preserveNotice = false, trigger = 'manual_refresh' } = {}) {
  const requestSequence = ++catalogRequestSequence
  catalogLoading.value = true
  catalogError.value = ''
  if (!preserveNotice) catalogNotice.value = ''
  const params = new URLSearchParams()
  const trimmedQuery = query.value.trim()
  if (trimmedQuery) params.set('query', trimmedQuery)
  for (const tag of selectedTags.value) params.append('tags', tag)
  params.set('page', String(page.value))
  params.set('pageSize', String(pageSize.value))
  params.set('usage', selectedUsage.value)
  params.set('sort', 'updated')

  try {
    const result = await apiRequest(`/api/apps?${params.toString()}`)
    if (requestSequence !== catalogRequestSequence) return
    apps.value = Array.isArray(result.items) ? result.items : []
    authorTags.value = Array.isArray(result.tags) ? result.tags : []
    total.value = Number.isFinite(Number(result.total)) ? Number(result.total) : 0
    usageCounts.value = result.usageCounts || { platform: 0, agent: 0 }
    page.value = Number.isFinite(Number(result.page)) && Number(result.page) > 0 ? Number(result.page) : page.value
    if (!props.management) {
      measurementEnabled = result.analyticsEnabled === true
      enableAnalytics(measurementEnabled)
      resultSetId = uuid()
      if (measurementEnabled && !portalViewed) { track('portal_viewed', eventAttributes()); portalViewed = true }
      await nextTick()
      if (requestSequence !== catalogRequestSequence) return
      const length = [...trimmedQuery].length
      if (resultSetId && discoveryRequestId) track('catalog_results_viewed', eventAttributes({ trigger, discoveryRequestId, resultCount: total.value, renderedCount: apps.value.length, page: page.value, pageSize: pageSize.value, usageType: selectedUsage.value, selectedTags: [...selectedTags.value], hasQuery: length > 0, queryLengthBucket: length === 0 ? '0' : length <= 10 ? '1-10' : length <= 50 ? '11-50' : '51-200' }), { resultSetId })
      void observeCards()
    }
  } catch (error) {
    if (requestSequence !== catalogRequestSequence) return
    if ([401, 403].includes(error.status)) { apps.value = []; authorTags.value = []; total.value = 0; usageCounts.value = { platform: 0, agent: 0 } }
    catalogError.value = errorText(error)
    if (!props.management) recordFailure(trigger === 'search' ? 'search' : trigger === 'filter' ? 'filter' : 'catalog', error)
  } finally {
    if (requestSequence === catalogRequestSequence) catalogLoading.value = false
  }
}

function updateCatalogPageSize(reload = true) {
  const main = directoryMain.value
  const heading = catalogHeading.value
  const footer = paginationRow.value
  if (!main || !heading || !footer || detailVisible.value || discoveryTab.value !== 'catalog') return
  const style = getComputedStyle(main)
  const columns = Number(style.getPropertyValue('--catalog-columns'))
  const cardHeight = parseFloat(style.getPropertyValue('--catalog-card-height'))
  const gap = parseFloat(style.getPropertyValue('--catalog-gap'))
  const notice = main.querySelector('.catalog-notice')
  const noticeHeight = notice ? notice.offsetHeight + parseFloat(getComputedStyle(notice).marginBottom) : 0
  // Size from the viewport, not the last page's content height (mobile main is auto-height).
  const viewport = shell()
  const availableHeight = viewport.clientHeight - (heading.getBoundingClientRect().bottom - viewport.getBoundingClientRect().top + viewport.scrollTop)
    - parseFloat(getComputedStyle(heading).marginBottom) - parseFloat(style.paddingBottom) - footer.offsetHeight - noticeHeight
  const capacity = catalogPageCapacity({
    availableHeight, columns, cardHeight, gap,
    headingHeight: 0,
    usage: selectedUsage.value,
  })
  if (capacity === pageSize.value) return
  pageSize.value = capacity
  page.value = 1
  if (reload && catalogReady) loadCatalog({ preserveNotice: true, trigger: 'layout_refresh' })
}

function scheduleCatalogLayout() {
  cancelAnimationFrame(layoutFrame)
  layoutFrame = requestAnimationFrame(() => updateCatalogPageSize())
}

watch(directoryMain, (main) => {
  layoutObserver?.disconnect()
  tagObserver?.disconnect()
  cancelAnimationFrame(tagFrame)
  if (!main) return
  layoutObserver = new ResizeObserver(scheduleCatalogLayout)
  layoutObserver.observe(main)
  layoutObserver.observe(main.querySelector('.catalog-section'))
  scheduleCatalogLayout()
}, { flush: 'post' })
watch([catalogNotice, usageCounts], async () => {
  await nextTick()
  scheduleCatalogLayout()
})

function searchCatalog() {
  page.value = 1
  discoveryRequestId = uuid()
  return loadCatalog({ trigger: 'search' })
}

function selectUsage(usage) {
  if (selectedUsage.value === usage) return
  selectedUsage.value = usage
  page.value = 1
  updateCatalogPageSize(false)
  discoveryRequestId = uuid()
  loadCatalog({ trigger: 'filter' })
}

function toggleTag(tag) {
  selectedTags.value = selectedTags.value.includes(tag)
    ? selectedTags.value.filter((item) => item !== tag)
    : [...selectedTags.value, tag]
  page.value = 1
  discoveryRequestId = uuid()
  loadCatalog({ trigger: 'filter' })
}

function changePage(nextPage) {
  page.value = nextPage
  loadCatalog({ trigger: 'pagination' })
}

function clearTags() {
  if (!selectedTags.value.length) return
  selectedTags.value = []
  page.value = 1
  discoveryRequestId = uuid()
  loadCatalog({ trigger: 'filter' })
}
function clearFilters() {
  query.value = ''
  selectedTags.value = []
  selectedUsage.value = 'all'
  page.value = 1
  updateCatalogPageSize(false)
  discoveryRequestId = uuid()
  loadCatalog({ trigger: 'filter' })
}

function appPath(id) { return `${props.management && props.managementEnabled ? '/api/management' : '/api'}/apps/${encodeURIComponent(id)}` }

async function openApp(id, { fromHistory = false, entryContext = null, revalidating = false } = {}) {
  if (!id) return
  if (!revalidating) primaryRequestSequence += 1
  if (!props.management) {
    if (!detailVisible.value) {
      scrollPositions[discoveryTab.value] = shell()?.scrollTop || 0
      detailOriginFocus = document.activeElement
    }
    if (!fromHistory && new URLSearchParams(location.search).get('app') !== id) {
      detailOriginUrl = location.href
      const url = new URL(location.href)
      url.searchParams.set('app', id)
      history.pushState({ ...history.state, plazaDiscoveryDetail: true }, '', url)
    }
  }
  const requestSequence = ++detailRequestSequence
  if (!revalidating) detailVisible.value = true
  clearExposureObserver()
  detailLoading.value = true
  detailError.value = ''
  if (!revalidating) {
    instructionRequestSequence += 1
    detailDocumentsVisible.value = false
    detailSourceVisible.value = false
    instructionDialogVisible.value = false
    selectedApp.value = null
    instruction.value = null
    instructionLoading.value = false
    instructionEntry.value = null
    instructionError.value = ''
  }
  await nextTick()
  if (!props.management && !revalidating) { if (shell()) shell().scrollTop = 0; detailHeading.value?.focus() }
  try {
    const result = await apiRequest(appPath(id))
    if (requestSequence !== detailRequestSequence) return
    const snapshotChanged = selectedApp.value?.snapshotId !== result.snapshotId
    selectedApp.value = result
    if (revalidating && snapshotChanged && instructionDialogVisible.value && instructionEntry.value) {
      const entry = result.manifest.entries.find(item => item.id === instructionEntry.value.id && item.kind === 'agent')
      if (entry) void loadAgentInstructions(entry, { revalidating: true })
      else closeAgentInstructions()
    }
    await nextTick()
    if (!props.management && !revalidating && requestSequence === detailRequestSequence && detailVisible.value) {
      const context = appEvent(result)
      if (context) track('app_detail_viewed', eventAttributes({ entryContext: entryContext || (detailOriginUrl ? (query.value.trim() ? 'search_result' : 'card') : 'deep_link') }), { ...context, ...resultContext() })
    }
  } catch (error) {
    if (requestSequence === detailRequestSequence) {
      if ([401, 403, 404].includes(error.status)) {
        selectedApp.value = null; detailDocumentsVisible.value = false; detailSourceVisible.value = false
        closeAgentInstructions(); copyFallbackVisible.value = false; copyFallbackText.value = ''
        if (shareAppId.value === id) { shareVisible.value = false; closeShareDialog() }
      }
      detailError.value = errorText(error)
      if (!props.management) recordFailure('detail', error)
    }
  } finally {
    if (requestSequence === detailRequestSequence) detailLoading.value = false
  }
}

async function restoreDiscovery() {
  const refresh = refreshOnReturn || Boolean(detailError.value)
  refreshOnReturn = false
  closeDetail()
  await nextTick()
  if (refresh) {
    await loadCatalog()
    if (randomLoaded) await loadRandom()
  }
  if (shell()) shell().scrollTop = scrollPositions[discoveryTab.value]
  detailOriginFocus?.focus({ preventScroll: true })
  void observeCards()
  emit('return')
}

function returnFromDetail() {
  if (history.state?.plazaDiscoveryDetail && detailOriginUrl) history.back()
  else {
    const url = new URL(location.href)
    url.searchParams.delete('app')
    history.replaceState(history.state, '', url)
    void restoreDiscovery()
  }
}

function handlePopState() {
  if (props.management || publicationId.value) return
  const id = new URLSearchParams(location.search).get('app')
  if (id) void openApp(id, { fromHistory: true })
  else if (detailVisible.value) void restoreDiscovery()
}

function handleDetailKey(event) {
  if (event.key !== 'Escape' || props.management || !detailVisible.value || instructionDialogVisible.value || detailDocumentsVisible.value || detailSourceVisible.value || shareVisible.value || copyFallbackVisible.value) return
  returnFromDetail()
}

function closeDetail() {
  detailRequestSequence += 1
  instructionRequestSequence += 1
  detailVisible.value = false
  detailDocumentsVisible.value = false
  detailSourceVisible.value = false
  instructionDialogVisible.value = false
  instruction.value = null
  instructionLoading.value = false
  instructionEntry.value = null
  instructionError.value = ''
  selectedApp.value = null
}

function closeAgentInstructions() {
  instructionRequestSequence += 1
  instructionDialogVisible.value = false
  instruction.value = null
  instructionLoading.value = false
  instructionError.value = ''
}

function refreshVisibleAccess() {
  if (!identity.user || !identity.enabled) return
  if (shareVisible.value && shareAppId.value) void openShareDialog(shareAppId.value, { revalidating: true })
  if (publicationId.value) { if (!publicationBusy.value) void loadPublication(publicationId.value, { revalidating: true }); return }
  const appId = selectedApp.value?.id
  if ((detailVisible.value || instructionDialogVisible.value) && appId) void openApp(appId, { fromHistory: true, revalidating: true })
  if (props.management) return
  void loadCatalog()
  if (discoveryTab.value === 'random') void loadRandom({ revalidating: true })
}

async function loadAgentInstructions(entry, { revalidating = false } = {}) {
  if (!selectedApp.value?.id || !entry?.id) return
  const requestSequence = ++instructionRequestSequence
  const appId = selectedApp.value.id
  const entryId = entry.id
  instructionEntry.value = entry
  instructionDialogVisible.value = true
  if (!revalidating) instruction.value = null
  instructionError.value = ''
  instructionLoading.value = true
  try {
    const result = await apiRequest(
      `${appPath(appId)}/instructions/${encodeURIComponent(entryId)}`,
    )
    if (requestSequence !== instructionRequestSequence || selectedApp.value?.id !== appId || instructionEntry.value?.id !== entryId) return
    instruction.value = result
  } catch (error) {
    if (requestSequence !== instructionRequestSequence || selectedApp.value?.id !== appId || instructionEntry.value?.id !== entryId) return
    instructionError.value = errorText(error)
    if ([401, 403, 404].includes(error?.status)) refreshVisibleAccess()
    if (!props.management) recordFailure('instructions', error)
    if (!props.management && error?.status === 404) refreshOnReturn = true
  } finally {
    if (requestSequence === instructionRequestSequence) instructionLoading.value = false
  }
}

async function copyAgentInstructions() {
  const entry = instructionEntry.value
  if (!entry || instructionLoading.value) return
  if (!props.management) await loadAgentInstructions(entry)
  if (disposed) return
  if (instruction.value && instruction.value.distribution?.status !== 'disabled') {
    const app = selectedApp.value
    const copied = await copyText(instruction.value.text, '接入说明已复制')
    if (disposed) return
    const context = appEvent(app), interactionId = uuid()
    if (!props.management && context && interactionId) track('prompt_copy_result', eventAttributes({ promptPurpose: 'usage', result: copied ? 'success' : 'failure' }), { ...context, interactionId, ...resultContext() })
  }
}

async function copyText(text, successMessage) {
  if (!text || disposed) return false
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable')
    await navigator.clipboard.writeText(text)
    if (disposed) return false
    ElMessage.success(successMessage)
    return true
  } catch {
    // Continue to the legacy copy path for HTTP intranet pages without Clipboard API access.
  }
  if (disposed) return false

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

  if (disposed) return false
  if (copied) {
    ElMessage.success(successMessage)
    return true
  } else {
    copyFallbackText.value = String(text)
    copyFallbackVisible.value = true
    await nextTick()
    if (disposed) return false
    selectManualCopyText()
    ElMessage.warning('自动复制不可用，已选中文本，请按 Ctrl+C 复制。')
    return false
  }
}

function selectManualCopyText() {
  copyFallbackTextarea.value?.focus()
  copyFallbackTextarea.value?.select()
}

function closeShareDialog() {
  contractRequestSequence += 1
  contractLoading.value = false
  publishContract.value = null
  publicationFlowId = null
}

async function openShareDialog(appId = '', { revalidating = false } = {}) {
  const sequence = ++contractRequestSequence
  shareAppId.value = appId
  if (!revalidating) publicationFlowId = uuid()
  shareVisible.value = true
  contractLoading.value = true
  contractError.value = ''
  if (!revalidating) publishContract.value = null
  try {
    const result = await apiRequest(appId ? `${appPath(appId)}/publish-contract` : '/api/publish-contract')
    if (sequence === contractRequestSequence) {
      publishContract.value = result
      await nextTick()
      const context = appId ? appEvent(selectedApp.value) : null
      if (!revalidating && !props.management && publicationFlowId && (!appId || context)) track('publish_panel_viewed', eventAttributes({ publishKind: appId ? 'update' : 'new', placement: appId ? 'detail' : 'header' }), { flowId: publicationFlowId, ...(context || {}) })
    }
  } catch (error) {
    if (sequence === contractRequestSequence) {
      contractError.value = errorText(error)
      if (revalidating && [401, 403, 404].includes(error.status)) { shareVisible.value = false; closeShareDialog(); copyFallbackVisible.value = false; copyFallbackText.value = '' }
    }
  } finally {
    if (sequence === contractRequestSequence) contractLoading.value = false
  }
}

async function copyPublishPrompt() {
  if (!publishContract.value?.prompt) return
  const copied = await copyText(publishContract.value.prompt, shareAppId.value ? '更新任务已复制' : '发布任务已复制')
  if (disposed) return
  const interactionId = uuid()
  if (!props.management && publicationFlowId && interactionId) track('prompt_copy_result', eventAttributes({ promptPurpose: shareAppId.value ? 'update' : 'publish', result: copied ? 'success' : 'failure' }), { flowId: publicationFlowId, interactionId })
}
async function copyExample(text) {
  const app = selectedApp.value
  const copied = await copyText(text, '示例任务已复制')
  if (disposed) return
  const context = appEvent(app), interactionId = uuid()
  if (!props.management && context && interactionId) track('prompt_copy_result', eventAttributes({ promptPurpose: 'example', result: copied ? 'success' : 'failure' }), { ...context, interactionId, ...resultContext() })
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
  publicationBusy.value = false
  detailVisible.value = false
  shareVisible.value = false
  const ticket = props.management ? '' : fragment.get('key')
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

async function handleHashChange() {
  if (preparePublicationRoute()) return
  if (!publicationId.value) return
  publicationRequestSequence += 1
  publicationId.value = ''
  publication.value = null
  publicationError.value = ''
  publicationLoading.value = false
  if (props.management) return
  await nextTick()
  updateCatalogPageSize(false)
  catalogReady = true
  await loadCatalog()
}

function publicationPath(id) {
  return `${props.management ? '/api/management' : '/api'}/publications/${encodeURIComponent(id)}`
}

function openPublication(id) {
  if (!id) return
  window.location.hash = new URLSearchParams({ publish: id }).toString()
  window.history.replaceState({ ...window.history.state, plazaManagementPreview: true }, '', window.location.href)
}

async function loadPublication(id = publicationId.value, { revalidating = publication.value?.id === id } = {}) {
  if (!id) return
  const sequence = ++publicationRequestSequence
  const current = () => sequence === publicationRequestSequence && publicationId.value === id
  publicationLoading.value = true
  publicationError.value = ''
  if (!revalidating) publication.value = null
  const token = props.management ? '' : publicationToken(id)
  if (!props.management && !token) {
    publication.value = null
    publicationError.value = '未找到此私有预览链接的临时授权，请重新打开作者提供的完整链接。'
    publicationLoading.value = false
    return
  }
  try {
    const result = await apiRequest(publicationPath(id), token ? { token } : {})
    if (current()) {
      publication.value = result
      if (result.analyticsEnabled === true) {
        measurementEnabled = true; enableAnalytics(true)
        const viewerContext = props.management ? 'management' : 'publication_link'
        const pageContext = props.management ? 'management' : 'publication'
        if (!portalViewed) { track('portal_viewed', eventAttributes({ pageContext, entryMode: viewerContext })); portalViewed = true }
        await nextTick()
        if (current() && result.preview && Number.isInteger(result.revision) && result.revision > 0) track('publication_preview_viewed', eventAttributes({ pageContext, entryMode: viewerContext, viewerContext, previewRevision: result.revision }), { publicationId: id })
      }
    }
  } catch (error) {
    if (current()) {
      if ([401, 403, 404, 410].includes(error.status)) publication.value = null
      publicationError.value = errorText(error)
    }
  } finally {
    if (current()) publicationLoading.value = false
  }
}

async function mutatePublication(action) {
  const current = publication.value
  const id = publicationId.value
  if (!id || !current || publicationBusy.value || publicationLoading.value) return
  if (props.management && !props.managementEnabled) { publicationError.value = '管理写入尚未启用。'; return }
  const token = props.management ? '' : publicationToken(id)
  if (!props.management && !token) {
    publicationError.value = '此私有预览链接的临时授权已不可用，请重新打开作者提供的完整链接。'
    return
  }
  const sequence = ++publicationRequestSequence
  const isCurrent = () => sequence === publicationRequestSequence && publicationId.value === id
  publicationBusy.value = true
  publicationError.value = ''
  try {
    const result = await apiRequest(`${publicationPath(id)}/${action === 'confirm' ? 'confirm' : 'retry'}`, {
      method: 'POST',
      ...(token ? { token } : {}),
      body: action === 'confirm' ? { revision: current.revision, digest: current.digest } : {},
    })
    if (isCurrent()) publication.value = result
  } catch (error) {
    if (!isCurrent()) return
    publicationError.value = errorText(error)
    try {
      const result = await apiRequest(publicationPath(id), token ? { token } : {})
      if (isCurrent()) { publication.value = result; publicationError.value = errorText(error) }
    } catch { /* Keep the original action error when status refresh also fails. */ }
  } finally {
    if (isCurrent()) publicationBusy.value = false
  }
}

function applicationUrl(appId) {
  const url = new URL(props.management ? publicPath('/') : window.location.pathname, window.location.origin)
  url.searchParams.set('app', appId)
  return url.href
}

async function returnToCatalog() {
  if (props.management && window.history.state?.plazaManagementPreview) { window.history.back(); return }
  const appId = publication.value?.appId
  publicationRequestSequence += 1
  publicationId.value = ''
  publication.value = null
  publicationError.value = ''
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`)
  if (props.management) return
  query.value = ''
  selectedTags.value = []
  page.value = 1
  await nextTick()
  updateCatalogPageSize(false)
  catalogReady = true
  await loadCatalog()
  if (appId) {
    catalogNotice.value = '目录已刷新，以下为已收录应用的最新详情。'
    await openApp(appId, { entryContext: 'after_publication' })
  }
}

onMounted(async () => {
  window.addEventListener('hashchange', handleHashChange)
  window.addEventListener('popstate', handlePopState)
  window.addEventListener('keydown', handleDetailKey, true)
  window.addEventListener('resize', scheduleCatalogLayout)
  window.addEventListener('focus', refreshVisibleAccess)
  document.addEventListener('visibilitychange', onVisibilityChange)
  if (preparePublicationRoute()) return
  if (props.management) return

  const appId = new URLSearchParams(window.location.search).get('app')
  await nextTick()
  updateCatalogPageSize(false)
  catalogReady = true
  await loadCatalog({ trigger: 'initial' })
  if (appId) await openApp(appId)
})

onUnmounted(() => {
  disposed = true
  catalogRequestSequence += 1
  detailRequestSequence += 1
  instructionRequestSequence += 1
  contractRequestSequence += 1
  publicationRequestSequence += 1
  primaryRequestSequence += 1
  randomRequestSequence += 1
  window.removeEventListener('popstate', handlePopState)
  window.removeEventListener('keydown', handleDetailKey, true)
  window.removeEventListener('hashchange', handleHashChange)
  window.removeEventListener('resize', scheduleCatalogLayout)
  window.removeEventListener('focus', refreshVisibleAccess)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  clearExposureObserver()
  layoutObserver?.disconnect()
  tagObserver?.disconnect()
  cancelAnimationFrame(layoutFrame)
  cancelAnimationFrame(tagFrame)
})
</script>

<template>
  <div v-if="publicationId" class="publication-shell">
    <header v-if="!props.management" class="publication-topbar">
      <a class="publication-brand" :href="publicPath('/')">AI应用广场</a>
      <span class="publication-private-label">私有预览</span>
    </header>
    <main class="publication-main">
      <button v-if="props.management" type="button" class="secondary-button management-return" data-testid="return-management" :disabled="publicationBusy" @click="returnToCatalog">返回后台列表</button>
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
        <p class="publication-audience">{{ identity.enabled ? (isUpdate ? '确认更新保持既有负责人和分享范围。' : '首次收录将绑定当前核验身份为负责人，默认仅自己可见；之后可在应用权限中调整分享。') : '确认收录后，应用目录对所有能访问本门户的人开放。' }}</p>
        <el-alert v-if="publication?.requiresIdentity" title="请先使用天宫身份登录，再核对本次发布资料。发布票据不代替应用维护授权。" type="info" :closable="false" />
        <p v-if="publication?.expiresAt" class="publication-expiry">预览有效期至 {{ formatDate(publication.expiresAt) }}</p>
        <p v-if="publicationExpired" class="publication-action-error" role="alert">此预览已过期，不能确认或重试；当前仅展示已保存的资料。</p>
        <div v-if="publicationLoading" class="publication-message" role="status">{{ publication ? '正在更新发布状态…' : '正在读取服务端发布状态…' }}</div>
        <div v-else-if="publicationError && !publication" class="publication-message is-error" role="alert">{{ publicationError }}</div>
        <div v-else-if="publication?.status === 'checking'" class="publication-message" role="status">
          服务正在检查提交内容，状态更新后请重新加载此页面。
        </div>
        <div v-else-if="publication?.status === 'failed'" class="publication-message is-error" role="alert">
          {{ publication.error?.message || '服务未能完成收录。' }}
        </div>
        <p v-if="publication?.status === 'failed' && publication.nextAction === 'submit_again'" class="publication-message">
          请让 Agent 更新应用资料并重新提交。
        </p>
        <div v-else-if="publication?.status === 'cancelled'" class="publication-message">此发布已取消，无法继续确认。</div>
        <div v-else-if="publication?.status === 'registered'" class="publication-message is-success" role="status">
          {{ isUnchanged ? '该内容已收录，无需重复发布。' : isUpdate ? '新版本已生效，原应用链接保持不变。' : '应用已进入目录。' }}
        </div>
        <div v-else-if="publication?.status === 'preview_ready'" class="publication-message">
          {{ isUpdate ? '请核对版本变化及公开内容，确认后更新原应用；确认前原版本仍可使用。' : '请核对下方公开内容与源码提交，确认后应用将进入目录。' }}
        </div>
        <section v-if="isUpdate" class="publication-change" data-testid="update-preview">
          <strong>{{ formatVersion(publication.change.previousVersion) }} <span aria-label="更新至">→</span> {{ formatVersion(publication.preview?.version) }}</strong>
          <p>{{ publication.change.changedFields.length ? `变更项：${publication.change.changedFields.join('、')}` : '更新代码版本，公开资料未变。' }}</p>
        </section>
        <div v-if="publication?.status === 'preview_ready' && !publication.digest && !publication.requiresIdentity" class="publication-action-error" role="alert">
          服务未提供内容摘要校验值，暂时无法确认收录；请重新读取发布状态。
        </div>
        <div v-if="publicationError && publication" class="publication-action-error" role="alert">{{ publicationError }}</div>
        <div class="publication-actions">
          <button
            v-if="publication?.status === 'preview_ready'"
            class="primary-button"
            data-testid="confirm-publication"
            :disabled="publicationBusy || publicationLoading || publicationExpired || !publication.digest || (props.management && !props.managementEnabled)"
            @click="mutatePublication('confirm')"
          >
            {{ publicationBusy ? '正在确认…' : isUpdate ? '确认更新' : '确认收录' }}
          </button>
          <button
            v-if="publication?.status === 'failed' && publication.nextAction !== 'submit_again'"
            class="primary-button"
            data-testid="retry-publication"
            :disabled="publicationBusy || publicationLoading || publicationExpired || (props.management && !props.managementEnabled)"
            @click="mutatePublication('retry')"
          >
            {{ publicationBusy ? '正在重试…' : isUpdate ? '重试更新' : '重试收录' }}
          </button>
          <button
            v-if="publication?.status === 'registered'"
            class="primary-button"
            data-testid="refresh-catalog"
            :disabled="catalogLoading"
            @click="returnToCatalog"
          >
            {{ props.management ? '返回后台列表' : catalogLoading ? '正在刷新目录…' : '刷新目录并查看应用' }}
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
          <span v-if="publication.preview.version" class="public-app-version">{{ formatVersion(publication.preview.version) }}</span>
        </div>
        <p class="publication-source-commit">
          源码提交
          <code>{{ publication.preview.source?.commitSha || '未提供提交标识' }}</code>
        </p>
        <AppPublicContent :app="publication.preview" @access-lost="loadPublication()" />
      </section>
    </main>
  </div>

  <div v-else class="directory-shell" :class="{ 'plaza-public': !props.management }">
    <slot v-if="props.management" name="management" :open-app="openApp" :open-update="openShareDialog" :open-publication="openPublication" :open-create="openShareDialog" />
    <header v-if="!props.management" class="plaza-header">
      <a class="plaza-brand" :href="publicPath('/')" aria-label="AI 应用广场首页"><span class="plaza-brand-mark" aria-hidden="true"><i/><i/><i/><i/></span><span>AI 应用广场<small>更多应用，更好用</small></span></a>
      <nav class="plaza-modules" aria-label="主要导航"><a class="active" :href="publicPath('/')" aria-current="page"><PlazaIcon name="catalog"/>应用广场</a><a :href="publicPath('/admin')"><PlazaIcon name="management"/>管理中心</a></nav>
      <button class="share-button" data-testid="share-button" @click="openShareDialog()"><PlazaIcon name="plus"/>分享我的 AI 应用</button>
    </header>
    <aside v-if="!props.management" class="discovery-sidebar">
      <div class="sidebar-title"><PlazaIcon name="catalog"/><strong>应用广场</strong></div>
      <nav class="discovery-tabs" aria-label="发现应用">
        <button :aria-pressed="discoveryTab === 'catalog'" data-testid="tab-catalog" @click="selectDiscovery('catalog')"><PlazaIcon name="catalog"/>全部应用</button>
        <button :aria-pressed="discoveryTab === 'random'" data-testid="tab-random" @click="selectDiscovery('random')"><PlazaIcon name="random"/>随便看看</button>
      </nav>
      <p class="sidebar-note">让好用的应用<br>被更多人发现</p>
    </aside>
    <main v-if="!props.management" v-show="!detailVisible" ref="directoryMain" class="directory-main">
      <CatalogWheel v-if="discoveryTab === 'random'" :items="randomItems" v-model:index="randomIndex" :loading="randomLoading" :revalidating="randomRevalidating" :error="randomError" :all-shown="randomAllShown" @refresh="loadRandom" @return="selectDiscovery('catalog')" @detail="openApp" @primary="usePrimary" @tag="filterFromWheel" />
      <section v-show="discoveryTab === 'catalog'" class="search-section" aria-label="搜索 AI 应用">
        <div class="catalog-toolbar">
          <div class="catalog-intro"><div class="catalog-heading-main"><h1 id="catalog-heading">发现好用的 AI 应用</h1><span class="catalog-total" aria-label="应用数量">{{ total }}</span></div></div>
          <div class="catalog-controls">
            <div class="search-row">
              <el-input v-model="query" class="search-input" data-testid="search-input" clearable placeholder="搜索应用名称、用途或能力" aria-label="搜索应用名称、用途或能力" @keyup.enter="searchCatalog" @clear="searchCatalog"><template #prefix><PlazaIcon name="search"/></template></el-input>
              <el-button class="search-submit" type="primary" data-testid="search-button" @click="searchCatalog">搜索</el-button>
            </div>
            <div class="catalog-usage-filter" role="group" aria-label="按使用方式筛选"><button v-for="option in usageOptions" :key="option.value" class="usage-filter-button" :class="{ active: selectedUsage === option.value }" :data-testid="`usage-${option.value}`" :aria-pressed="selectedUsage === option.value" @click="selectUsage(option.value)">{{ option.label }}</button></div>
            <span class="catalog-sort" aria-label="排序：最近更新">最近更新 ↓</span>
          </div>
        </div>
        <div ref="tagRow" class="tag-filter-row" aria-label="按作者标签筛选">
          <span class="tag-filter-label">想做什么</span>
          <button class="filter-chip tag-all" :class="{active: !selectedTags.length}" :aria-pressed="!selectedTags.length" @click="clearTags">全部</button>
          <button v-for="tag in visibleTags" :key="tag" class="filter-chip" :class="{ active: selectedTags.includes(tag) }" data-testid="tag-chip" :aria-pressed="selectedTags.includes(tag)" @click="toggleTag(tag)">{{ tag }}</button>
          <ElPopover v-if="overflowTags.length" trigger="click" placement="bottom-end" :width="280">
            <template #reference><button class="tag-more" data-testid="tag-more" :aria-label="`还有 ${overflowTags.length} 个标签`">+{{ overflowTags.length }}</button></template>
            <div class="overflow-tags" aria-label="更多标签"><button v-for="tag in overflowTags" :key="tag" class="filter-chip" :class="{ active: selectedTags.includes(tag) }" data-testid="tag-chip" :aria-pressed="selectedTags.includes(tag)" @click="toggleTag(tag)">{{ tag }}</button></div>
          </ElPopover>
          <button v-if="query || selectedTags.length || selectedUsage !== 'all'" class="clear-filters" @click="clearFilters">清除筛选</button>
        </div>
        <div ref="tagMeasure" class="tag-measure" aria-hidden="true" inert><span v-for="tag in authorTags" :key="tag" class="filter-chip">{{ tag }}</span><span class="tag-more">+{{ authorTags.length }}</span></div>
      </section>
      <section v-show="discoveryTab === 'catalog'" class="catalog-section" aria-labelledby="catalog-heading">
        <div ref="catalogHeading" class="catalog-heading-row"></div>
        <div v-if="catalogError" class="catalog-state is-error" role="alert">
          <strong>目录暂时无法加载</strong>
          <p>{{ catalogError }}</p>
          <button class="secondary-button" :disabled="catalogLoading" @click="loadCatalog">重试</button>
        </div>
        <div v-else-if="catalogLoading && !apps.length" class="catalog-state" role="status">正在读取应用目录…</div>
        <div v-else-if="!apps.length" class="catalog-state empty-state">
          <div class="empty-mark" aria-hidden="true">⌕</div>
          <strong>{{ query || selectedTags.length || selectedUsage !== 'all' ? '没有找到匹配的应用' : '目录中还没有应用' }}</strong>
          <p>{{ query || selectedTags.length || selectedUsage !== 'all' ? '试试其他关键词、使用方式或清除筛选条件。' : '应用收录后会显示在这里。' }}</p>
          <button v-if="query || selectedTags.length || selectedUsage !== 'all'" class="secondary-button" @click="clearFilters">清除筛选</button>
        </div>
        <div v-if="apps.length" class="catalog-results" :aria-busy="catalogLoading">
          <span v-if="catalogLoading" class="catalog-refreshing" role="status">正在更新…</span>
          <div v-if="catalogNotice" class="catalog-notice" role="status">{{ catalogNotice }}</div>
          <section v-for="group in catalogGroups" :key="group.value" class="catalog-group" :data-testid="`catalog-group-${group.value}`" :aria-label="group.label">
            <div class="app-grid">
            <CatalogCard v-for="app in group.apps" :key="app.id" :app="app" :selected-tags="selectedTags" @detail="openApp" @primary="usePrimary" @tag="toggleTag" />
            </div>
          </section>
        </div>
        <div ref="paginationRow" class="pagination-row" data-testid="pagination">
          <ListPagination
            v-if="apps.length"
            :page="page"
            :page-size="pageSize"
            :total="total"
            @change="changePage"
          />
        </div>
      </section>
    </main>

    <component
      :is="props.management ? ElDialog : 'section'"
      v-if="props.management || detailVisible"
      v-bind="props.management ? { modelValue: detailVisible, width: 'min(1180px, 94vw)', alignCenter: true, destroyOnClose: true } : {}"
      :class="props.management ? 'app-detail-dialog' : 'public-detail'"
      @close="closeDetail"
    >
      <header v-if="!props.management" class="public-detail-heading">
        <button class="secondary-button detail-return" data-testid="return-discovery" @click="returnFromDetail">← {{ props.personalReturn ? '返回我的收藏' : detailError ? '返回并刷新' : discoveryTab === 'random' ? '返回随便看看' : '返回应用目录' }}</button>
        <h1 tabindex="-1" ref="detailHeading">应用详情</h1>
      </header>
      <template v-if="props.management" #header>
        <div class="detail-dialog-heading">
          <span>应用详情</span>
          <button v-if="props.management && selectedApp && !detailLoading && selectedApp.lifecycle?.status !== 'deleted'" type="button" class="detail-update-link" data-testid="publish-update" :disabled="!props.managementEnabled" @click="openShareDialog(selectedApp.id)">发布新版本</button>
        </div>
      </template>
      <div v-if="detailLoading" class="dialog-state" role="status">{{ selectedApp ? '正在更新应用详情…' : '正在读取应用详情…' }}</div>
      <div v-if="detailError" class="dialog-state is-error" role="alert">
        <strong>{{ selectedApp ? '应用详情更新未完成' : '应用详情暂时无法加载' }}</strong>
        <p>{{ detailError }} 请返回刷新，查看当前可用的应用。</p>
        <button v-if="selectedApp" class="secondary-button" @click="openApp(selectedApp.id, { fromHistory: true, revalidating: true })">重试</button>
      </div>
      <div v-if="selectedApp" class="detail-layout" data-testid="app-detail">
        <div class="detail-content-scroll">
          <AppDetailOverview
            :app="selectedApp"
            @read-documents="detailDocumentsVisible = true"
            @read-source="detailSourceVisible = true"
          />
        </div>
        <aside class="detail-actions" aria-label="应用使用入口" data-testid="detail-actions">
          <div class="detail-action-heading">
            <h2>使用入口</h2>
            <FavoriteButton v-if="!props.management" :app-id="selectedApp.id" />
          </div>
          <div v-if="!selectedAppEntries.length" class="entry-empty">作者尚未登记使用入口。</div>
          <div v-for="entry in selectedAppEntries" :key="entry.id" class="entry-action">
            <template v-if="entry.kind === 'web'">
              <span v-if="selectedAppEntries.length > 1 && entry.label" class="entry-label">{{ entry.label }}</span>
              <a
                v-if="safeHttpUrl(entry.url)"
                class="primary-button entry-button"
                data-testid="use-web"
                :href="safeHttpUrl(entry.url)"
                target="_blank"
                rel="noopener noreferrer"
                @click="recordEntry(selectedApp, entry, 'detail')"
              >打开应用</a>
              <button v-else class="primary-button entry-button" disabled>应用入口不可用</button>
            </template>
            <template v-else-if="entry.kind === 'agent'">
              <span v-if="selectedAppEntries.length > 1 && entry.label" class="entry-label">{{ entry.label }}</span>
              <button class="primary-button entry-button" data-testid="use-agent"
                :disabled="selectedApp.entryAvailability?.[entry.id]?.status === 'disabled'"
                @click="recordEntry(selectedApp, entry, 'detail'); loadAgentInstructions(entry)">接入我的Agent</button>
              <p v-if="selectedApp.entryAvailability?.[entry.id]?.status === 'disabled'" class="entry-label" data-testid="agent-disabled-reason">
                {{ selectedApp.entryAvailability[entry.id].reason }}
              </p>
            </template>
          </div>

          <AppExamples
            :examples="selectedApp.manifest?.examples"
            presentation="selector"
            class="detail-examples"
            @copy="copyExample($event)"
          />
        </aside>
      </div>
    </component>

    <el-dialog
      v-model="instructionDialogVisible"
      :title="instructionEntry?.label || 'Agent 接入说明'"
      width="min(760px, 92vw)"
      top="6vh"
      append-to-body
      destroy-on-close
      data-testid="agent-instruction-dialog"
      @close="closeAgentInstructions"
    >
      <div class="agent-instruction-dialog-body" data-testid="agent-instruction-content">
        <p class="agent-upgrade-intro">交给 Agent 检查本地版本：未安装则安装，已有旧版则按指引升级，并保留配置与本地修改。</p>
        <p v-if="instructionEntry?.compatibility" class="instruction-compatibility">兼容信息：{{ instructionEntry.compatibility }}</p>
        <p v-if="instructionLoading" class="instruction-state" role="status">{{ instruction ? '正在更新作者接入说明…' : '正在读取作者接入说明…' }}</p>
        <p v-if="instructionError" class="instruction-state is-error" role="alert">{{ instructionError }}</p>
        <template v-if="instruction">
          <p v-if="instruction.compatibility && instruction.compatibility !== instructionEntry?.compatibility" class="instruction-compatibility">
            兼容信息：{{ typeof instruction.compatibility === 'string' ? instruction.compatibility : JSON.stringify(instruction.compatibility) }}
          </p>
          <p v-if="instruction.source" class="instruction-source">说明来源：{{ typeof instruction.source === 'string' ? instruction.source : JSON.stringify(instruction.source) }}</p>
          <div class="instruction-markdown markdown-body" v-html="instructionHtml" />
          <el-button
            v-if="instruction.distribution?.status !== 'disabled'"
            class="copy-instruction-button"
            data-testid="copy-agent-prompt"
            @click="copyAgentInstructions"
          >复制安装／升级提示词</el-button>
        </template>
      </div>
    </el-dialog>

    <el-dialog
      v-model="detailDocumentsVisible"
      title="完整应用资料"
      width="min(820px, 92vw)"
      top="5vh"
      append-to-body
      destroy-on-close
      data-testid="detail-documents-dialog"
    >
      <div v-if="selectedApp" class="detail-material-scroll" data-testid="detail-documents-content">
        <AppPublicContent
          :app="selectedApp"
          @access-lost="refreshVisibleAccess"
          :show-header="false"
          :show-examples="false"
          :show-source="false"
        />
      </div>
    </el-dialog>

    <el-dialog
      v-model="detailSourceVisible"
      title="来源与版本"
      width="min(720px, 92vw)"
      top="8vh"
      append-to-body
      destroy-on-close
      data-testid="detail-source-dialog"
    >
      <div v-if="selectedApp" class="detail-material-scroll" data-testid="detail-source-content">
        <AppPublicContent
          :app="selectedApp"
          @access-lost="refreshVisibleAccess"
          :show-header="false"
          :show-capabilities="false"
          :show-conditions="false"
          :show-examples="false"
          :show-documents="false"
          :show-entries="false"
        />
      </div>
    </el-dialog>

    <el-dialog v-model="shareVisible" :title="shareAppId ? '发布新版本' : '分享我的AI应用'" width="min(720px, 92vw)" top="8vh" append-to-body data-testid="publish-contract-dialog" @close="closeShareDialog">
      <div v-if="contractLoading" class="dialog-state" role="status">{{ publishContract ? '正在更新发布说明…' : '正在读取发布说明…' }}</div>
      <div v-if="contractError" class="dialog-state is-error" role="alert">
        <strong>发布说明暂时无法加载</strong>
        <p>{{ contractError }}</p>
        <button class="secondary-button" @click="openShareDialog(shareAppId)">重试</button>
      </div>
      <div v-if="publishContract" class="share-flow">
        <p v-if="publishContract.updateTarget" class="share-intro" data-testid="update-target">
          {{ publishContract.updateTarget.name }} · 当前 {{ formatVersion(publishContract.updateTarget.version) }}<br>
          让项目 Agent 准备新版本，再由你预览确认。应用链接保持不变。
        </p>
        <p v-else-if="publishContract.mode === 'managed'" class="share-intro" data-testid="managed-share-intro">把提示词交给当前项目的 AI，它会整理并上传源码与应用资料，再由你预览确认。无需提前创建 GitLab 仓库。</p>
        <p v-else class="share-intro">把发布提示词交给你的 Agent，由 Agent 提交应用资料，再由你预览确认。</p>
        <ol class="share-steps">
          <li><strong>{{ shareAppId ? '复制更新提示词' : '复制发布提示词' }}</strong><span>{{ shareAppId ? '自动带入项目与应用信息。' : '包含资料规范与发布步骤。' }}</span></li>
          <li><strong>交给项目 Agent</strong><span>{{ publishContract.mode === 'managed' ? '自动整理上传，返回预览链接。' : '准备资料和版本 Release，提交预览。' }}</span></li>
          <li><strong>预览并确认</strong><span>{{ shareAppId ? '核对版本变化与内容，确认更新。' : '核对公开内容，确认收录。' }}</span></li>
        </ol>
        <div class="publish-prompt-wrap">
          <div class="prompt-heading"><strong>发布提示词</strong><span>完整内容</span></div>
          <pre class="publish-prompt">{{ publishContract.prompt }}</pre>
          <el-button
            type="primary"
            data-testid="copy-publish-prompt"
            :disabled="!publishContract.prompt"
            @click="copyPublishPrompt"
          >{{ shareAppId ? '复制更新提示词' : '复制发布提示词' }}</el-button>
        </div>
        <div class="share-links">
          <span v-if="publishContract.audience"><strong>目录可见范围</strong>{{ publishContract.audience }}</span>
          <a v-if="safeHttpUrl(publishContract.managed?.groupUrl || publishContract.gitlabUrl)" :href="safeHttpUrl(publishContract.managed?.groupUrl || publishContract.gitlabUrl)" target="_blank" rel="noopener noreferrer">{{ publishContract.mode === 'managed' ? '统一托管空间' : '项目托管平台' }}</a>
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
:global(body) { background: var(--plaza-canvas); color: var(--plaza-ink); font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
 .directory-shell { width:100%;height:100%;overflow-y:auto;background:var(--plaza-canvas); }
.directory-main { --catalog-columns:3;--catalog-card-height:270px;--catalog-gap:20px;display:flex;flex-direction:column;width:calc(100% - 196px);height:calc(100% - 64px);margin-left:196px;padding:28px 28px 12px; }
.plaza-header{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:24px;height:64px;padding:0 24px;background:var(--plaza-surface);border-bottom:1px solid var(--plaza-line)}
.plaza-brand{display:flex;align-items:center;gap:12px;flex:none;width:184px;color:var(--plaza-ink);font-size:17px;font-weight:700;text-decoration:none;white-space:nowrap;line-height:26px;}.plaza-brand small{display:block;margin-top:4px;font-size:11px;font-weight:400;color:var(--plaza-muted);line-height:18px;}
.plaza-brand-mark{display:grid;grid-template-columns:12px 12px;gap:4px;padding:4px}.plaza-brand-mark i{height:12px;border-radius:4px;background:var(--plaza-brand)}.plaza-brand-mark i:nth-child(2){background:var(--plaza-share);transform:rotate(14deg)}.plaza-brand-mark i:nth-child(3){background:var(--plaza-brand-soft)}
.plaza-modules{display:flex;gap:8px}.plaza-modules a{display:flex;align-items:center;gap:8px;min-height:40px;padding:0 16px;border-radius:9px;text-decoration:none;color:var(--plaza-text);font-size:14px;white-space:nowrap;line-height:22px;}.plaza-modules a.active{background:var(--plaza-brand-soft);color:var(--plaza-brand);font-weight:650}.plaza-modules a:hover{background:var(--plaza-brand-soft)}
.share-button,.primary-button,.secondary-button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:36px;padding:7px 14px;border:1px solid var(--plaza-brand);border-radius:9px;background:var(--plaza-brand);color:var(--plaza-surface);font:inherit;font-size:14px;text-decoration:none;cursor:pointer}
.share-button{margin-left:auto;background:var(--plaza-share);border-color:var(--plaza-share);color:var(--plaza-share-ink);font-weight:650;white-space:nowrap}.share-button:hover{background:var(--plaza-share);border-color:var(--plaza-share)}.primary-button:hover{filter:brightness(1.06)}.secondary-button{background:var(--plaza-surface);border-color:var(--plaza-line);color:var(--plaza-text)}.secondary-button:hover{background:var(--plaza-surface)}.primary-button:disabled,.secondary-button:disabled,.share-button:disabled{opacity:.55;cursor:not-allowed}
.plaza-public button:focus-visible,.plaza-public a:focus-visible{outline:2px solid var(--plaza-brand);outline-offset:3px}
.discovery-sidebar{position:fixed;top:64px;bottom:0;left:0;display:flex;flex-direction:column;width:196px;padding:18px 10px;background:var(--plaza-canvas);border-right:1px solid var(--plaza-line)}.sidebar-title{display:flex;align-items:center;gap:12px;min-height:40px;margin:0 12px 12px;font-size:14px;line-height:22px;}.sidebar-note{margin:auto 14px 12px;color:var(--plaza-muted);font-size:12px;line-height:18px}
.discovery-tabs{display:flex;flex-direction:column;gap:4px}.discovery-tabs button{display:flex;align-items:center;gap:12px;min-height:44px;padding:10px 14px;border:0;border-radius:10px;background:transparent;color:var(--plaza-text);font:inherit;font-size:14px;text-align:left;cursor:pointer}.discovery-tabs button:hover{background:var(--plaza-brand-soft)}.discovery-tabs button[aria-pressed=true]{color:var(--plaza-brand);background:var(--plaza-brand-soft);font-weight:650}
.search-section{flex:none;margin:0 0 22px}.catalog-toolbar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:18px;margin-bottom:24px}.catalog-intro h1{font-size:24px;line-height:32px;font-weight:650;letter-spacing:-.35px;margin:0}.catalog-intro p{color:var(--plaza-muted);font-size:12px;margin:8px 0 0;line-height:18px;}.catalog-heading-main{display:flex;align-items:center;gap:14px}.catalog-total{display:grid;place-items:center;min-width:38px;min-height:34px;padding:4px 10px;border:1px solid var(--plaza-line);border-radius:6px;background:var(--plaza-surface);color:var(--plaza-muted);font-size:12px;line-height:18px;}
.catalog-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.search-row{display:flex;gap:8px}.search-input{width:260px;--el-input-height:36px}.search-submit{min-height:36px}.catalog-usage-filter{display:flex;gap:2px;padding:3px;border:1px solid var(--plaza-line);border-radius:9px;background:var(--plaza-surface)}.usage-filter-button{min-height:28px;padding:3px 9px;border:0;border-radius:6px;background:transparent;color:var(--plaza-text);font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}.usage-filter-button.active{background:var(--plaza-brand-soft);color:var(--plaza-brand)}.catalog-sort{font-size:12px;color:var(--plaza-muted);white-space:nowrap;line-height:18px;}
.tag-filter-row{display:flex;align-items:center;flex-wrap:nowrap;gap:7px;min-width:0}.tag-filter-label{flex:none;white-space:nowrap;margin-right:8px;font-size:12px;color:var(--plaza-muted);line-height:18px;}.filter-chip,.tag-more{flex:none;min-height:32px;padding:5px 12px;border:1px solid transparent;border-radius:20px;background:transparent;color:var(--plaza-text);font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}.filter-chip:hover,.tag-more:hover{background:var(--plaza-brand-soft)}.filter-chip.active{background:var(--plaza-ink);color:var(--plaza-surface)}.tag-more{background:var(--plaza-brand-soft);color:var(--plaza-brand);font-weight:650}.clear-filters{flex:none;border:0;background:none;color:var(--plaza-brand);font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}.tag-measure{position:fixed;left:0;top:0;visibility:hidden;display:flex;gap:7px;pointer-events:none;white-space:nowrap}.overflow-tags{display:flex;flex-wrap:wrap;gap:4px;max-height:240px;overflow-y:auto}
.catalog-section{display:flex;flex:1;flex-direction:column;min-height:0}.catalog-heading-row{height:0;margin:0;flex:none}.catalog-results{flex:1 0 auto;position:relative}.catalog-refreshing{position:absolute;right:0;top:-20px;color:var(--plaza-muted);font-size:11px;line-height:18px;}.app-grid{display:grid;grid-template-columns:repeat(var(--catalog-columns),minmax(0,1fr));gap:var(--catalog-gap)}.pagination-row{display:flex;flex:0 0 48px;align-items:center;justify-content:center;margin-top:auto}
.catalog-state{display:flex;min-height:200px;flex-direction:column;align-items:center;justify-content:center;gap:9px;padding:28px;border:1px solid var(--plaza-line);border-radius:16px;background:var(--plaza-surface);color:var(--plaza-muted);font-size:14px;text-align:center;line-height:22px;}.catalog-state strong{color:var(--plaza-ink);font-size:17px;line-height:26px;}.catalog-state p{margin:0 0 4px}.catalog-state.is-error{color:var(--plaza-danger);margin-bottom:16px}.empty-mark{font-size:27px}.catalog-notice{margin-bottom:12px;padding:9px 12px;border:1px solid var(--plaza-line);border-radius:9px;background:var(--plaza-surface);color:var(--plaza-success);font-size:12px;line-height:18px;}
.public-detail{width:calc(100% - 252px);margin:28px 28px 28px 224px;padding:24px;border:1px solid var(--plaza-line);border-radius:16px;background:var(--plaza-surface)}.public-detail-heading{display:flex;align-items:center;gap:20px;margin-bottom:24px}.public-detail-heading h1{margin:0;font-size:24px;line-height:32px;}.public-detail .detail-layout{height:calc(100vh - 240px)}.public-app-version{padding:3px 7px;color:var(--plaza-muted);font-size:11px;line-height:18px;}
.detail-return{min-height:40px;border-color:var(--plaza-brand);background:var(--plaza-brand-soft);color:var(--plaza-brand);font-weight:650}.detail-return:hover{background:var(--plaza-brand-soft)}
.detail-dialog-heading { display: flex; align-items: center; justify-content: space-between; padding-right: 18px; color: var(--plaza-ink); font-size: 17px; font-weight: 650;line-height:26px;}
.detail-update-link { border: 0; background: none; color: var(--plaza-text); font: inherit; font-size: 12px; font-weight: 400; cursor: pointer; padding: 2px 4px; }
.detail-update-link:hover { color: var(--plaza-brand); text-decoration: underline; }
.agent-upgrade-intro { color: var(--plaza-muted); line-height:22px; font-size: 14px; margin: 0 0 14px; }
.publication-change { padding: 14px 16px; margin: 14px 0; border: 1px solid var(--plaza-line); border-radius: 8px; background: var(--plaza-brand-soft); }
.publication-change strong { color: var(--plaza-ink); font-size:17px;line-height:26px;}
.publication-change span { margin: 0 10px; color: var(--plaza-text); }
.publication-change p { color: var(--plaza-text); font-size: 14px; margin: 8px 0 0;line-height:22px;}
.detail-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 330px); gap: 24px; height: min(570px, calc(100vh - 144px)); min-height: 0; }
.detail-content-scroll { min-width: 0; min-height: 0; max-height: 100%; overflow-x: hidden; overflow-y: auto; padding: 0 16px 12px 2px; }
.detail-actions { align-self: start; min-width: 0; max-height: 100%; overflow-x: hidden; overflow-y: auto; padding: 15px; border: 1px solid var(--plaza-line); border-radius: 8px; background: var(--plaza-surface); }
.detail-action-heading { padding-bottom: 12px; border-bottom: 1px solid var(--plaza-line); }
.detail-action-heading h2 { margin: 0; color: var(--plaza-ink); font-size: 17px;line-height:26px;}
.detail-action-heading p { margin: 5px 0 0; color: var(--plaza-muted); font-size: 12px;line-height:18px;}
.entry-action { margin-top: 11px; }
.entry-label { display: block; margin-bottom: 5px; color: var(--plaza-muted); font-size: 11px; line-height:18px; overflow-wrap: anywhere; }
.entry-button { width: 100%; min-height: 38px; }
.entry-empty { padding: 15px 0; color: var(--plaza-muted); font-size: 12px; line-height:18px; }
.detail-examples { padding-top: 13px; border-top: 1px solid var(--plaza-line); }
.detail-material-scroll { max-height: 72vh; overflow-x: hidden; overflow-y: auto; padding: 0 14px 12px 2px; }
.agent-instruction-dialog-body { max-height: 72vh; overflow: auto; }
.instruction-compatibility, .instruction-source, .instruction-state { color: var(--plaza-muted); font-size: 11px; line-height:18px; overflow-wrap: anywhere; }
.instruction-state.is-error { color: var(--plaza-danger); }
.instruction-markdown { max-height: 280px; overflow-y: auto; padding: 9px 10px; border: 1px solid var(--plaza-line); border-radius: 6px; background: var(--plaza-surface); color: var(--plaza-text); font-size: 12px; line-height:18px; overflow-wrap: anywhere; }
.instruction-markdown :deep(p) { margin: 6px 0; }
.instruction-markdown :deep(ul), .instruction-markdown :deep(ol) { padding-left: 18px; }
.instruction-markdown :deep(a) { color: var(--plaza-brand); }
.instruction-markdown :deep(pre) { overflow-x: auto; padding: 8px; background: var(--plaza-canvas); }
.copy-instruction-button { width: 100%; margin-top: 9px; }
.dialog-state { display: flex; min-height: 160px; flex-direction: column; align-items: center; justify-content: center; gap: 9px; color: var(--plaza-muted); font-size: 14px; text-align: center;line-height:22px;}
.dialog-state strong { color: var(--plaza-ink); font-size: 17px;line-height:26px;}
.dialog-state p { max-width: 560px; margin: 0; line-height: 1.6; }
.dialog-state.is-error { color: var(--plaza-danger); }
.dialog-state.is-error strong { color: var(--plaza-danger); }
.share-flow { color: var(--plaza-text); }
.share-intro { margin: 0 0 15px; font-size: 14px; line-height:22px; }
.share-steps { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; counter-reset: share-step; }
.share-steps li { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 1px 10px; align-items: baseline; counter-increment: share-step; }
.share-steps li::before { grid-row: span 2; display: grid; width: 24px; height: 24px; place-items: center; border-radius: 50%; background: var(--plaza-brand-soft); color: var(--plaza-brand); content: counter(share-step); font-size: 12px; font-weight: 650;line-height:18px;}
.share-steps strong { color: var(--plaza-ink); font-size: 14px;line-height:22px;}
.share-steps span { color: var(--plaza-muted); font-size: 12px; line-height:18px; }
.publish-prompt-wrap { margin-top: 19px; padding: 13px; border: 1px solid var(--plaza-line); border-radius: 7px; background: var(--plaza-surface); }
.prompt-heading { display: flex; justify-content: space-between; margin-bottom: 9px; color: var(--plaza-text); font-size: 12px;line-height:18px;}
.prompt-heading span { color: var(--plaza-muted); font-weight: 400; }
.publish-prompt { max-height: 245px; overflow: auto; margin: 0 0 12px; padding: 11px; border: 1px solid var(--plaza-line); border-radius: 5px; background: var(--plaza-surface); color: var(--plaza-text); font: 12px/1.65 Consolas, "Microsoft YaHei", sans-serif; white-space: pre-wrap; overflow-wrap: anywhere; }
.share-links { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 18px; margin-top: 14px; color: var(--plaza-muted); font-size: 12px;line-height:18px;}
.share-links span { display: flex; flex-basis: 100%; gap: 8px; }
.share-links span strong { color: var(--plaza-text); font-weight: 550; }
.share-links a { color: var(--plaza-brand); text-decoration: none; }
.share-links a:hover { text-decoration: underline; }
.manual-copy-help { margin: 0 0 10px; color: var(--plaza-muted); font-size: 14px;line-height:22px;}
.manual-copy-textarea { width: 100%; min-height: 220px; resize: vertical; padding: 10px; border: 1px solid var(--plaza-line); border-radius: 6px; color: var(--plaza-text); font: 12px/1.65 Consolas, "Microsoft YaHei", sans-serif; }
.publication-shell { width: 100%; height: 100%; overflow-y: auto; background: var(--plaza-canvas); }
.publication-topbar { display: flex; height: 58px; align-items: center; justify-content: space-between; padding: 0 max(24px, calc((100% - 1080px) / 2)); border-bottom: 1px solid var(--plaza-line); background: var(--plaza-surface); }
.publication-brand { color: var(--plaza-ink); font-size: 17px; font-weight: 650; text-decoration: none;line-height:26px;}
.publication-private-label { padding: 4px 8px; border: 1px solid var(--plaza-line); border-radius: 5px; background: var(--plaza-surface); color: var(--plaza-muted); font-size: 11px;line-height:18px;}
.publication-main { width: min(1080px, calc(100% - 48px)); margin: 24px auto 50px; }
.publication-status-card, .publication-preview { padding: 22px 24px; border: 1px solid var(--plaza-line); border-radius: 9px; background: var(--plaza-surface); }
.publication-status-heading { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.eyebrow { margin: 0 0 5px; color: var(--plaza-muted); font-size: 11px; letter-spacing: .02em;line-height:18px;}
.publication-status-heading h1, .preview-section-heading h2 { margin: 0; color: var(--plaza-ink); font-size:17px; font-weight: 650;line-height:26px;}
.publication-status-value { padding: 5px 9px; border: 1px solid var(--plaza-line); border-radius: 5px; background: var(--plaza-surface); color: var(--plaza-muted); font-size: 11px;line-height:18px;}
.status-preview_ready { border-color: var(--plaza-line); background: var(--plaza-brand-soft); color: var(--plaza-text); }
.status-registered { border-color: var(--plaza-line); background: var(--plaza-surface); color: var(--plaza-success); }
.status-failed { border-color: var(--plaza-line); background: var(--plaza-surface); color: var(--plaza-danger); }
.publication-audience { margin: 13px 0 0; color: var(--plaza-text); font-size: 14px; line-height:22px; }
.publication-expiry { margin: 7px 0 0; color: var(--plaza-muted); font-size: 11px;line-height:18px;}
.publication-message { margin-top: 12px; color: var(--plaza-muted); font-size: 14px; line-height:22px; }
.publication-message.is-error, .publication-action-error { color: var(--plaza-danger); }
.publication-message.is-success { color: var(--plaza-success); }
.publication-actions { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 17px; }
.publication-preview { margin-top: 16px; }
.preview-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 14px; border-bottom: 1px solid var(--plaza-line); }
.publication-source-commit { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin: 13px 0; color: var(--plaza-muted); font-size: 11px;line-height:18px;}
.publication-source-commit code { color: var(--plaza-text); font-family: Consolas, monospace; overflow-wrap: anywhere; }
@media(min-width:1780px){.directory-main{--catalog-columns:4}}
@media(max-width:1120px){.directory-main{--catalog-columns:2}}
@media(min-width:761px) and (max-height:800px){.directory-main{--catalog-card-height:190px}}
@media(max-width:900px){.detail-layout{grid-template-columns:minmax(0,1fr);height:75vh;max-height:75vh}.detail-content-scroll{max-height:47vh;padding-right:3px}.detail-actions{max-height:25vh}.public-detail .detail-layout{height:auto;max-height:none}.public-detail .detail-content-scroll,.public-detail .detail-actions{max-height:none;overflow:visible}}
@media(max-width:760px){.plaza-header{height:auto;min-height:64px;gap:12px;flex-wrap:wrap;padding:12px 16px}.plaza-brand{width:auto;font-size:17px;line-height:26px;}.plaza-modules{order:3;width:100%;gap:4px}.plaza-modules a{min-height:34px;padding:0 12px;font-size:12px;line-height:18px;}.share-button{padding:7px 9px;font-size:12px;line-height:18px;}.share-button .plaza-icon{display:none}.discovery-sidebar{position:static;width:100%;padding:8px 16px;border-right:0;border-bottom:1px solid var(--plaza-line)}.sidebar-title,.sidebar-note{display:none}.discovery-tabs{flex-direction:row}.discovery-tabs button{min-height:40px}.directory-main{width:100%;height:auto;min-height:calc(100% - 170px);margin:0;padding:20px 16px 12px}.catalog-intro h1{font-size:24px;line-height:32px;}.catalog-controls{width:100%;gap:8px}.search-row{width:100%}.search-input{width:auto;flex:1;min-width:0}.catalog-toolbar{gap:18px;margin-bottom:18px}.tag-filter-row{max-height:78px}.public-detail{width:calc(100% - 32px);margin:16px;padding:18px}.public-detail-heading{gap:12px;flex-wrap:wrap}}
@media(max-width:650px){.directory-main{--catalog-columns:1;--catalog-gap:16px}.publication-main{width:calc(100% - 24px);margin-top:12px}.publication-status-card,.publication-preview{padding:17px 15px}.publication-status-heading h1,.preview-section-heading h2{font-size:17px;line-height:26px;}}
</style>

<style scoped>
.management-return { margin-bottom: 14px; }
</style>
