<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import AppPublicContent from '../components/AppPublicContent.vue'
import plazaMark from '../assets/plaza-mark.svg'
import { apiRequest } from '../lib/api.js'

const sessionState = ref('loading')
const authenticated = ref(false)
const sessionLoading = ref(false)
const sessionError = ref('')
const password = ref('')
const loginLoading = ref(false)
const loginError = ref('')
const logoutLoading = ref(false)
const logoutError = ref('')

const query = ref('')
const status = ref('all')
const page = ref(1)
const pageSize = 20
const items = ref([])
const total = ref(0)
const counts = ref({ all: 0, preview_ready: 0, expired: 0, checking: 0, failed: 0 })
const listLoading = ref(false)
const listError = ref('')

const detailVisible = ref(false)
const drawerSize = ref(window.innerWidth <= 700 ? '100%' : '76%')
const detailLoading = ref(false)
const detailError = ref('')
const selectedPublication = ref(null)
const selectedId = ref('')
const detailChangedFields = computed(() => {
  const value = selectedPublication.value?.change?.changedFields
  if (Array.isArray(value)) return value.map((field) => String(field))
  if (typeof value === 'string') return value.split(',').map((field) => field.trim()).filter(Boolean)
  if (value && typeof value === 'object') return Object.keys(value)
  return []
})

let sessionSequence = 0
let listSequence = 0
let detailSequence = 0
let loginSequence = 0
let logoutSequence = 0

function requestError(error, action) {
  if (error?.status === 403) return '当前管理会话无权执行此操作，请重新登录后再访问。'
  if (error?.status === 429) return '访问过于频繁，请稍后再试。'
  if (error?.status === 404 && action === 'session') return '私有预览管理功能尚未启用。'
  if (error?.status === 404 && action === 'detail') return '这条发布记录已不存在或当前无法读取。'
  return error?.message || '服务暂时无法完成请求，请稍后再试。'
}

function clearPrivateState() {
  listSequence += 1
  detailSequence += 1
  items.value = []
  total.value = 0
  page.value = 1
  counts.value = { all: 0, preview_ready: 0, expired: 0, checking: 0, failed: 0 }
  listError.value = ''
  listLoading.value = false
  detailVisible.value = false
  detailLoading.value = false
  detailError.value = ''
  selectedPublication.value = null
  selectedId.value = ''
}

function handleExpiredSession(message = '管理员会话已失效，请重新登录。') {
  clearPrivateState()
  authenticated.value = false
  sessionState.value = 'ready'
  sessionError.value = message
}

async function checkSession() {
  const sequence = ++sessionSequence
  sessionLoading.value = true
  sessionState.value = 'loading'
  sessionError.value = ''
  try {
    const result = await apiRequest('/api/preview-admin/session')
    if (sequence !== sessionSequence) return
    sessionState.value = 'ready'
    authenticated.value = result?.authenticated === true
    if (authenticated.value) void loadList(1)
  } catch (error) {
    if (sequence !== sessionSequence) return
    authenticated.value = false
    if (error?.status === 401) {
      sessionState.value = 'ready'
      sessionError.value = ''
    } else if (error?.status === 404) {
      sessionState.value = 'disabled'
      sessionError.value = requestError(error, 'session')
    } else {
      sessionState.value = 'error'
      sessionError.value = requestError(error, 'session')
    }
  } finally {
    if (sequence === sessionSequence) sessionLoading.value = false
  }
}

async function submitLogin() {
  if (loginLoading.value || !password.value) return
  const sequence = ++loginSequence
  loginLoading.value = true
  loginError.value = ''
  const requestBody = { password: password.value }
  password.value = ''
  try {
    const result = await apiRequest('/api/preview-admin/session', { method: 'POST', body: requestBody })
    if (sequence !== loginSequence) return
    if (result?.authenticated !== true) {
      loginError.value = '登录未完成，请检查管理员口令后重试。'
      return
    }
    authenticated.value = true
    sessionState.value = 'ready'
    sessionError.value = ''
    logoutError.value = ''
    clearPrivateState()
    void loadList(1)
  } catch (error) {
    if (sequence !== loginSequence) return
    if (error?.status === 401) loginError.value = '管理员口令不正确，请检查后重试。'
    else if (error?.status === 404) {
      sessionState.value = 'disabled'
      sessionError.value = requestError(error, 'session')
    } else loginError.value = requestError(error, 'login')
  } finally {
    requestBody.password = ''
    if (sequence === loginSequence) loginLoading.value = false
  }
}

async function loadList(nextPage = page.value) {
  if (!authenticated.value || listLoading.value) return
  const sequence = ++listSequence
  listLoading.value = true
  listError.value = ''
  const params = new URLSearchParams({
    query: query.value.trim(),
    status: status.value,
    page: String(nextPage),
  })
  try {
    const result = await apiRequest(`/api/preview-admin/publications?${params.toString()}`)
    if (sequence !== listSequence) return
    items.value = Array.isArray(result?.items) ? result.items : []
    total.value = Number.isFinite(Number(result?.total)) ? Number(result.total) : 0
    page.value = Number.isFinite(Number(result?.page)) && Number(result.page) > 0 ? Number(result.page) : nextPage
    counts.value = {
      all: Number(result?.counts?.all) || 0,
      preview_ready: Number(result?.counts?.preview_ready) || 0,
      expired: Number(result?.counts?.expired) || 0,
      checking: Number(result?.counts?.checking) || 0,
      failed: Number(result?.counts?.failed) || 0,
    }
  } catch (error) {
    if (sequence !== listSequence) return
    if (error?.status === 401 || error?.status === 403) {
      handleExpiredSession(error?.status === 403 ? '当前管理权限不可用，请重新验证管理员身份。' : undefined)
      return
    }
    items.value = []
    total.value = 0
    counts.value = { all: 0, preview_ready: 0, expired: 0, checking: 0, failed: 0 }
    listError.value = requestError(error, 'list')
  } finally {
    if (sequence === listSequence) listLoading.value = false
  }
}

function submitSearch() {
  page.value = 1
  void loadList(1)
}

function changeStatus(value) {
  status.value = value
  page.value = 1
  void loadList(1)
}

function changePage(value) {
  page.value = value
  void loadList(value)
}

async function openDetail(item) {
  if (!item?.id || (detailLoading.value && selectedId.value === item.id)) return
  const sequence = ++detailSequence
  selectedId.value = item.id
  selectedPublication.value = null
  detailError.value = ''
  detailLoading.value = true
  detailVisible.value = true
  try {
    const result = await apiRequest(`/api/preview-admin/publications/${encodeURIComponent(item.id)}`)
    if (sequence !== detailSequence) return
    selectedPublication.value = result
  } catch (error) {
    if (sequence !== detailSequence) return
    if (error?.status === 401 || error?.status === 403) {
      handleExpiredSession(error?.status === 403 ? '当前管理权限不可用，请重新验证管理员身份。' : undefined)
      return
    }
    selectedPublication.value = null
    detailError.value = requestError(error, 'detail')
  } finally {
    if (sequence === detailSequence) detailLoading.value = false
  }
}

function closeDetail() {
  detailSequence += 1
  detailVisible.value = false
  detailLoading.value = false
  detailError.value = ''
  selectedPublication.value = null
  selectedId.value = ''
}

async function logout() {
  if (logoutLoading.value) return
  const sequence = ++logoutSequence
  logoutLoading.value = true
  logoutError.value = ''
  try {
    await apiRequest('/api/preview-admin/session', { method: 'DELETE' })
    if (sequence !== logoutSequence) return
    clearPrivateState()
    authenticated.value = false
    sessionState.value = 'ready'
    sessionError.value = ''
    password.value = ''
  } catch (error) {
    if (sequence !== logoutSequence) return
    if (error?.status === 401 || error?.status === 403) handleExpiredSession()
    else logoutError.value = requestError(error, 'logout')
  } finally {
    if (sequence === logoutSequence) logoutLoading.value = false
  }
}

function displayName(item) {
  return item?.name || '未命名应用'
}

function maintainerLabel(item) {
  const value = item?.maintainers
  const maintainers = Array.isArray(value) ? value : value ? [value] : []
  const names = maintainers.map((maintainer) => {
    if (typeof maintainer === 'string') return maintainer
    if (!maintainer || typeof maintainer !== 'object') return ''
    const name = maintainer.name || ''
    const englishName = maintainer.nameEn || ''
    return name && englishName && name !== englishName ? `${name}（${englishName}）` : name || englishName
  }).filter(Boolean)
  return names.join('、') || '作者未登记'
}

function statusKey(item) {
  return item?.expired === true ? 'expired' : item?.status || 'checking'
}

function statusLabel(item) {
  return ({
    preview_ready: '等待作者确认',
    expired: '预览已过期',
    checking: '来源核验中',
    failed: '发布未完成',
  })[statusKey(item)] || '状态未知'
}

function statusType(item) {
  return ({ preview_ready: 'success', expired: 'warning', checking: 'info', failed: 'danger' })[statusKey(item)] || 'info'
}

function dateLabel(value, withTime = false) {
  if (!value) return '未登记'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return String(value)
  const options = withTime
    ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: '2-digit', day: '2-digit' }
  return new Intl.DateTimeFormat('zh-CN', options).format(parsed)
}

function versionLabel(value) {
  if (value === null || value === undefined || value === '') return '未登记'
  const text = String(value)
  return /^\d/.test(text) ? `v${text}` : text
}

function nextActionLabel(value) {
  return ({
    confirm: '等待作者通过原私有预览链接确认',
    checking: '来源核验进行中',
    retry: '需要查看发布记录的处理状态',
    none: '当前无需处理',
  })[value] || value || '未提供'
}

function changeKindLabel(value) {
  return ({ update: '应用更新', unchanged: '版本未变化', create: '首次收录' })[value] || value || '发布变更'
}

function returnToPlaza() {
  window.location.assign('/')
}

function updateDrawerSize() {
  drawerSize.value = window.innerWidth <= 700 ? '100%' : '76%'
}

onMounted(() => {
  window.addEventListener('resize', updateDrawerSize)
  void checkSession()
})

onUnmounted(() => {
  window.removeEventListener('resize', updateDrawerSize)
})
</script>

<template>
  <div class="private-preview-admin">
    <header class="admin-topbar">
      <button class="admin-brand" type="button" aria-label="返回 AI 应用广场" @click="returnToPlaza">
        <span class="brand-mark" aria-hidden="true"><img :src="plazaMark" alt="" /></span>
        <span>AI 应用广场</span>
      </button>
      <div class="topbar-context">
        <span class="context-dot" aria-hidden="true" />
        私有预览管理
      </div>
      <el-button class="return-button" plain @click="returnToPlaza">返回广场</el-button>
      <el-button
        v-if="authenticated"
        class="logout-button"
        plain
        :loading="logoutLoading"
        :disabled="logoutLoading"
        @click="logout"
      >
        退出管理
      </el-button>
    </header>

    <main class="admin-main">
      <section v-if="sessionState === 'loading'" class="state-card" aria-live="polite">
        <span class="state-icon loading-spinner" aria-hidden="true" />
        <h1>正在验证管理员会话</h1>
        <p>请稍候，系统正在读取受保护的管理状态。</p>
      </section>

      <section v-else-if="sessionState === 'disabled'" class="state-card state-card-error" role="status">
        <span class="state-icon warning-mark" aria-hidden="true">!</span>
        <h1>管理入口不可用</h1>
        <p>{{ sessionError }}</p>
        <el-button type="primary" @click="returnToPlaza">返回应用广场</el-button>
      </section>

      <section v-else-if="sessionState === 'error'" class="state-card state-card-error" role="alert">
        <span class="state-icon warning-mark" aria-hidden="true">!</span>
        <h1>暂时无法验证管理会话</h1>
        <p>{{ sessionError }}</p>
        <p class="state-hint">请检查服务连接后刷新此页面。</p>
      </section>

      <section v-else-if="!authenticated" class="login-layout">
        <div class="login-intro">
          <p class="eyebrow">PRIVATE PREVIEW ADMIN</p>
          <h1>私有预览管理</h1>
          <p>登录后查看作者尚未确认的发布记录。此页面只提供受保护的只读查看，作者仍通过原私有预览链接完成确认。</p>
        </div>
        <el-card class="login-card" shadow="never">
          <div class="login-heading">
            <span class="login-lock" aria-hidden="true">▣</span>
            <div>
              <h2>管理员登录</h2>
              <p>使用已配置的管理员口令</p>
            </div>
          </div>
          <el-alert v-if="sessionError" class="session-alert" :title="sessionError" type="warning" :closable="false" show-icon />
          <form class="login-form" @submit.prevent="submitLogin">
            <label class="field-label" for="admin-password">管理员口令</label>
            <el-input
              id="admin-password"
              v-model="password"
              type="password"
              autocomplete="current-password"
              placeholder="请输入管理员口令"
              show-password
              :disabled="loginLoading"
              @keyup.enter="submitLogin"
            />
            <p v-if="loginError" class="inline-error" role="alert">{{ loginError }}</p>
            <el-button class="login-submit" type="primary" native-type="submit" :loading="loginLoading" :disabled="loginLoading || !password">
              {{ loginLoading ? '正在验证…' : '安全登录' }}
            </el-button>
          </form>
          <p class="login-note">管理员会话有效期为30分钟。</p>
        </el-card>
      </section>

      <section v-else class="workspace" aria-labelledby="admin-heading">
        <div class="page-heading">
          <div>
            <p class="eyebrow">PRIVATE PREVIEW ADMIN</p>
            <h1 id="admin-heading">私有预览管理</h1>
            <p class="page-subtitle">集中查看尚未完成作者确认的发布记录与来源信息。</p>
          </div>
          <span class="readonly-badge"><span class="readonly-mark" aria-hidden="true">R</span> 只读管理</span>
        </div>

        <p v-if="logoutError" class="inline-error page-error" role="alert">{{ logoutError }}</p>

        <div class="summary-grid" aria-label="发布记录数量">
          <article class="summary-card summary-all"><span>全部记录</span><strong>{{ counts.all }}</strong><small>作者尚未确认</small></article>
          <article class="summary-card summary-ready"><span>等待确认</span><strong>{{ counts.preview_ready }}</strong><small>私有预览可用</small></article>
          <article class="summary-card summary-expired"><span>已过期</span><strong>{{ counts.expired }}</strong><small>原预览已失效</small></article>
          <article class="summary-card summary-checking"><span>来源核验中</span><strong>{{ counts.checking }}</strong><small>服务正在检查</small></article>
          <article class="summary-card summary-failed"><span>发布未完成</span><strong>{{ counts.failed }}</strong><small>未进入确认阶段</small></article>
        </div>

        <section class="records-panel" aria-label="作者发布确认列表">
          <div class="records-toolbar">
            <form class="search-form" role="search" @submit.prevent="submitSearch">
              <label class="sr-only" for="publication-search">搜索应用名称、应用标识或作者</label>
              <el-input
                id="publication-search"
                v-model="query"
                class="search-input"
                clearable
                placeholder="搜索应用名称、应用标识或作者"
                :disabled="listLoading"
                @keyup.enter="submitSearch"
              >
                <template #prefix><span class="search-mark" aria-hidden="true">⌕</span></template>
              </el-input>
              <el-button type="primary" native-type="submit" :disabled="listLoading">查询</el-button>
            </form>
            <label class="filter-control">
              <span>状态</span>
              <el-select :model-value="status" aria-label="按状态筛选" :disabled="listLoading" @change="changeStatus">
                <el-option label="全部状态" value="all" />
                <el-option label="等待作者确认" value="preview_ready" />
                <el-option label="预览已过期" value="expired" />
                <el-option label="来源核验中" value="checking" />
                <el-option label="发布未完成" value="failed" />
              </el-select>
            </label>
          </div>

          <div class="table-context">
            <span>发布记录</span>
            <span>共 {{ total }} 项</span>
          </div>
          <el-alert v-if="listError" class="list-alert" :title="listError" type="error" :closable="false" show-icon />
          <el-table
            :data="items"
            row-key="id"
            v-loading="listLoading"
            class="publication-table"
            :empty-text="listError ? '当前无法显示发布记录' : '暂无符合条件的发布记录'"
          >
            <el-table-column label="应用" min-width="220">
              <template #default="scope">
                <div class="app-cell">
                  <strong>{{ displayName(scope.row) }}</strong>
                  <span>{{ scope.row.appKey || '未登记应用标识' }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="版本" width="105">
              <template #default="scope">{{ versionLabel(scope.row.version) }}</template>
            </el-table-column>
            <el-table-column label="作者" min-width="160">
              <template #default="scope">{{ maintainerLabel(scope.row) }}</template>
            </el-table-column>
            <el-table-column label="当前状态" width="140">
              <template #default="scope"><el-tag :type="statusType(scope.row)" effect="light">{{ statusLabel(scope.row) }}</el-tag></template>
            </el-table-column>
            <el-table-column label="提交时间" width="155">
              <template #default="scope">{{ dateLabel(scope.row.createdAt, true) }}</template>
            </el-table-column>
            <el-table-column label="预览有效期" width="155">
              <template #default="scope">{{ dateLabel(scope.row.expiresAt, true) }}</template>
            </el-table-column>
            <el-table-column label="查看" fixed="right" width="100" align="center">
              <template #default="scope">
                <el-button link type="primary" :disabled="detailLoading && selectedId === scope.row.id" @click="openDetail(scope.row)">详情</el-button>
              </template>
            </el-table-column>
            <template #empty>
              <el-empty :description="listError ? '暂时无法读取记录' : '暂无符合条件的发布记录'" :image-size="70" />
            </template>
          </el-table>

          <div class="table-footer">
            <span>每页 20 项</span>
            <el-pagination
              v-if="total > pageSize"
              background
              layout="prev, pager, next"
              :current-page="page"
              :page-size="pageSize"
              :total="total"
              :disabled="listLoading"
              @current-change="changePage"
            />
          </div>
        </section>
        <p class="privacy-note"><span aria-hidden="true">▣</span> 仅管理员会话可查看。此页面不执行收录、确认或发布操作。</p>
      </section>
    </main>

    <el-drawer
      v-model="detailVisible"
      title="发布详情"
      :size="drawerSize"
      :with-header="false"
      :append-to-body="true"
      destroy-on-close
      class="preview-detail-drawer"
      @close="closeDetail"
    >
      <div class="detail-shell">
        <header class="detail-header">
          <div>
            <p class="eyebrow">PUBLICATION DETAILS</p>
            <h2>发布详情</h2>
          </div>
          <el-button plain @click="closeDetail">返回列表</el-button>
        </header>
        <div v-if="detailLoading" class="detail-state" aria-live="polite">
          <el-skeleton :rows="5" animated />
          <p>正在安全读取发布详情…</p>
        </div>
        <div v-else-if="detailError" class="detail-state detail-error" role="alert">
          <span class="detail-warning-mark" aria-hidden="true">!</span>
          <h3>暂时无法读取这条记录</h3>
          <p>{{ detailError }}</p>
        </div>
        <template v-else-if="selectedPublication">
          <section class="detail-overview">
            <div class="detail-title-row">
              <div>
                <p class="detail-app-key">{{ selectedPublication.appKey || '未登记应用标识' }}</p>
                <h3>{{ displayName(selectedPublication) }}</h3>
              </div>
              <el-tag :type="statusType(selectedPublication)" effect="light">{{ statusLabel(selectedPublication) }}</el-tag>
            </div>
            <p class="detail-guidance">{{ statusKey(selectedPublication) === 'expired'
              ? '原私有链接已过期；以下为保留的只读快照，不延长链接有效期。'
              : statusKey(selectedPublication) === 'preview_ready'
                ? '作者仍需通过原私有预览链接确认；此管理页面只提供只读查看。'
                : statusKey(selectedPublication) === 'checking'
                  ? '服务正在核验发布来源，当前记录尚未进入作者确认阶段。'
                  : '本次发布尚未进入作者确认阶段。' }}</p>
            <dl class="detail-meta-grid">
              <div><dt>发布版本</dt><dd>{{ versionLabel(selectedPublication.version) }}</dd></div>
              <div><dt>作者</dt><dd>{{ maintainerLabel(selectedPublication) }}</dd></div>
              <div><dt>提交时间</dt><dd>{{ dateLabel(selectedPublication.createdAt, true) }}</dd></div>
              <div><dt>最近更新</dt><dd>{{ dateLabel(selectedPublication.updatedAt, true) }}</dd></div>
              <div><dt>预览有效期</dt><dd>{{ dateLabel(selectedPublication.expiresAt, true) }}</dd></div>
              <div><dt>记录状态</dt><dd>{{ statusLabel(selectedPublication) }}</dd></div>
              <div class="meta-wide"><dt>当前处理状态</dt><dd>{{ nextActionLabel(selectedPublication.nextAction) }}</dd></div>
            </dl>
          </section>

          <el-alert
            v-if="selectedPublication.error"
            class="detail-service-error"
            :title="selectedPublication.error.message || '发布服务未能完成来源核验。'"
            :description="selectedPublication.error.code ? `错误代码：${selectedPublication.error.code}` : undefined"
            type="error"
            :closable="false"
            show-icon
          />

          <section v-if="selectedPublication.change" class="detail-change">
            <h3>版本变化</h3>
            <p>{{ changeKindLabel(selectedPublication.change.kind) }}<span v-if="selectedPublication.change.previousVersion">，上一版本 {{ versionLabel(selectedPublication.change.previousVersion) }}</span></p>
            <div v-if="detailChangedFields.length" class="changed-fields">
              <span v-for="field in detailChangedFields" :key="field">{{ field }}</span>
            </div>
          </section>

          <section v-if="selectedPublication.preview" class="full-preview-section">
            <div class="section-heading">
              <div><p class="eyebrow">FULL PREVIEW</p><h3>应用预览与来源</h3></div>
              <span>内容来自受保护的发布详情</span>
            </div>
            <AppPublicContent :app="selectedPublication.preview" />
          </section>
          <section v-else class="preview-unavailable">
            <span class="info-mark" aria-hidden="true">i</span>
            <div><strong>当前记录没有可显示的应用预览</strong><p>状态和发布处理信息仍可在上方查看。</p></div>
          </section>
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.private-preview-admin { width: 100%; height: 100%; min-height: 0; overflow-y: auto; background: #f3f5f8; color: #26364b; font-family: inherit; }
.admin-topbar { position: sticky; z-index: 5; top: 0; display: flex; height: 62px; align-items: center; gap: 27px; padding: 0 clamp(18px, 3.3vw, 48px); border-bottom: 1px solid #e4e9f0; background: rgb(255 255 255 / 96%); box-shadow: 0 2px 8px rgb(34 52 77 / 3%); }
.admin-brand { display: inline-flex; flex: none; align-items: center; gap: 9px; padding: 0; border: 0; background: transparent; color: #26364b; font: inherit; font-size: 14px; font-weight: 650; cursor: pointer; }
.admin-brand:focus-visible { outline: 3px solid #bfd3f5; outline-offset: 4px; border-radius: 4px; }
.brand-mark { display: grid; width: 30px; height: 30px; place-items: center; border: 1px solid #e4e9f0; border-radius: 8px; background: #fff; }
.brand-mark img { display: block; width: 100%; height: 100%; }
.topbar-context { display: flex; align-items: center; gap: 8px; color: #617086; font-size: 12px; }
.context-dot { width: 6px; height: 6px; border-radius: 50%; background: #6a8fd6; }
.return-button { margin-left: auto; }
.logout-button { margin-left: 0; }
.admin-main { width: min(1440px, 100%); min-height: calc(100vh - 62px); margin: 0 auto; padding: 32px clamp(16px, 3.3vw, 48px) 30px; }
.workspace { min-width: 0; }
.page-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; margin: 4px 0 22px; }
.eyebrow { margin: 0 0 6px; color: #8290a3; font-size: 10px; font-weight: 650; letter-spacing: 1px; }
.page-heading h1, .login-intro h1 { margin: 0; color: #203148; font-size: 24px; font-weight: 650; line-height: 1.35; letter-spacing: -.4px; }
.page-subtitle { margin: 7px 0 0; color: #6e7d91; font-size: 13px; }
.readonly-badge { display: inline-flex; flex: none; align-items: center; gap: 7px; padding: 7px 10px; border: 1px solid #dce5f2; border-radius: 6px; background: #edf3fb; color: #496891; font-size: 12px; }
.readonly-mark { display: grid; width: 15px; height: 15px; place-items: center; border: 1px solid #8da6c7; border-radius: 3px; font-size: 8px; font-weight: 700; }
.summary-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 11px; margin-bottom: 16px; }
.summary-card { position: relative; min-width: 0; min-height: 112px; padding: 14px 16px 12px; overflow: hidden; border: 1px solid #e5eaf0; border-radius: 8px; background: #fff; box-shadow: 0 2px 5px rgb(34 52 77 / 3%); }
.summary-card::before { position: absolute; top: 0; left: 0; width: 3px; height: 100%; background: #7c92b3; content: ''; }
.summary-card span { display: block; color: #68788d; font-size: 12px; }
.summary-card strong { display: block; margin-top: 7px; color: #26364b; font-size: 25px; font-weight: 650; line-height: 1.2; }
.summary-card small { display: block; margin-top: 5px; color: #94a0af; font-size: 10px; }
.summary-ready::before { background: #32a17a; }
.summary-expired::before { background: #d89b3c; }
.summary-checking::before { background: #6b8fca; }
.summary-failed::before { background: #d56c70; }
.records-panel { overflow: hidden; border: 1px solid #e3e8ef; border-radius: 9px; background: #fff; box-shadow: 0 3px 10px rgb(34 52 77 / 3%); }
.records-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 15px 17px; border-bottom: 1px solid #edf0f4; }
.search-form { display: flex; flex: 1; max-width: 540px; gap: 9px; }
.search-mark { display: inline-block; color: #8290a2; font-size: 20px; line-height: 1; transform: rotate(-20deg); }
.search-input { min-width: 180px; }
.filter-control { display: flex; flex: none; align-items: center; gap: 9px; color: #6d7c90; font-size: 12px; }
.filter-control :deep(.el-select) { width: 160px; }
.table-context { display: flex; align-items: center; justify-content: space-between; padding: 13px 18px 10px; color: #33445b; font-size: 13px; font-weight: 600; }
.table-context span + span { color: #8793a3; font-size: 11px; font-weight: 400; }
.publication-table { width: 100%; }
.publication-table :deep(th.el-table__cell) { height: 42px; background: #f8f9fb; color: #718095; font-size: 11px; font-weight: 600; }
.publication-table :deep(td.el-table__cell) { height: 60px; color: #536278; font-size: 12px; }
.publication-table :deep(.el-table__row:hover > td.el-table__cell) { background: #f7faff; }
.app-cell { display: grid; gap: 4px; min-width: 0; }
.app-cell strong { overflow: hidden; color: #2b3c53; font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.app-cell span { overflow: hidden; color: #8995a5; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.list-alert { margin: 0 17px 10px; }
.table-footer { display: flex; min-height: 53px; align-items: center; justify-content: space-between; gap: 15px; padding: 9px 17px; border-top: 1px solid #edf0f4; color: #8a96a6; font-size: 11px; }
.privacy-note { display: flex; align-items: center; gap: 6px; margin: 13px 2px 0; color: #8491a2; font-size: 11px; }
.login-layout { display: grid; width: min(980px, 100%); min-height: min(660px, calc(100vh - 124px)); grid-template-columns: minmax(0, 1fr) minmax(320px, 410px); align-items: center; gap: clamp(34px, 6vw, 82px); margin: 0 auto; }
.login-intro { max-width: 470px; }
.login-intro h1 { font-size: 29px; }
.login-intro > p:last-child { max-width: 440px; margin: 13px 0 0; color: #68788d; font-size: 14px; line-height: 1.8; }
.login-card { border: 1px solid #e2e8f0; border-radius: 10px; background: #fff; box-shadow: 0 12px 34px rgb(37 57 83 / 7%); }
.login-card :deep(.el-card__body) { padding: 25px; }
.login-heading { display: flex; align-items: center; gap: 12px; margin-bottom: 23px; }
.login-lock { display: grid; width: 42px; height: 42px; place-items: center; border-radius: 9px; background: #eff4fc; color: #416db8; font-size: 18px; }
.login-heading h2 { margin: 0; color: #2b3c53; font-size: 16px; font-weight: 650; }
.login-heading p { margin: 4px 0 0; color: #8995a5; font-size: 11px; }
.login-form { display: grid; gap: 9px; }
.field-label { color: #536278; font-size: 12px; font-weight: 600; }
.login-submit { width: 100%; margin-top: 5px; }
.login-note { display: flex; align-items: flex-start; gap: 6px; margin: 17px 0 0; color: #8995a5; font-size: 10px; line-height: 1.6; }
.session-alert { margin: 0 0 14px; }
.inline-error { margin: 0; color: #b4424a; font-size: 12px; line-height: 1.5; }
.page-error { margin: -8px 0 16px; }
.state-card { display: flex; min-height: 300px; flex-direction: column; align-items: center; justify-content: center; padding: 30px; text-align: center; }
.state-card h1 { margin: 12px 0 5px; color: #293a52; font-size: 19px; }
.state-card p { max-width: 460px; margin: 5px 0 13px; color: #748398; font-size: 13px; line-height: 1.7; }
.state-icon { color: #5b80bd; font-size: 26px; }
.loading-spinner { width: 23px; height: 23px; border: 2px solid #dce6f4; border-top-color: #5b80bd; border-radius: 50%; animation: admin-spin .85s linear infinite; }
.warning-mark, .detail-warning-mark { display: grid; width: 25px; height: 25px; place-items: center; border: 2px solid currentColor; border-radius: 50%; font-size: 15px; font-weight: 700; }
.state-card-error .state-icon { color: #c78339; }
.state-card .state-hint { color: #929eac; font-size: 11px; }
.detail-shell { min-height: 100%; padding: 0 4px 32px; }
.detail-header { position: sticky; z-index: 2; top: -20px; display: flex; align-items: center; justify-content: space-between; gap: 18px; margin: -20px -4px 19px; padding: 17px 4px 13px; border-bottom: 1px solid #e7ebf1; background: #fff; }
.detail-header .eyebrow { margin-bottom: 2px; }
.detail-header h2 { margin: 0; color: #26364b; font-size: 19px; font-weight: 650; }
.detail-overview { padding: 17px; border: 1px solid #e5eaf0; border-radius: 8px; background: #fbfcfe; }
.detail-title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 15px; }
.detail-app-key { margin: 0 0 4px; color: #8794a5; font-size: 10px; }
.detail-title-row h3 { margin: 0; color: #27384e; font-size: 18px; line-height: 1.45; overflow-wrap: anywhere; }
.detail-guidance { margin: 11px 0 14px; color: #617188; font-size: 12px; line-height: 1.7; }
.detail-meta-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 11px 20px; margin: 0; padding-top: 13px; border-top: 1px solid #e9edf2; }
.detail-meta-grid > div { display: grid; grid-template-columns: 78px minmax(0, 1fr); gap: 7px; font-size: 11px; line-height: 1.55; }
.detail-meta-grid dt { color: #8a96a6; }
.detail-meta-grid dd { min-width: 0; margin: 0; color: #4f6077; overflow-wrap: anywhere; }
.detail-meta-grid .meta-wide { grid-column: 1 / -1; }
.detail-service-error { margin-top: 13px; }
.detail-change { margin-top: 14px; padding: 14px 16px; border: 1px solid #e7ecf2; border-radius: 8px; background: #fff; }
.detail-change h3 { margin: 0 0 7px; color: #394b62; font-size: 13px; }
.detail-change p { margin: 0; color: #708097; font-size: 11px; }
.changed-fields { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.changed-fields span { padding: 4px 7px; border: 1px solid #e2e8f1; border-radius: 4px; background: #f6f8fb; color: #617188; font-size: 10px; }
.full-preview-section { margin-top: 20px; padding-top: 17px; border-top: 1px solid #e8ecf1; }
.section-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin-bottom: 15px; }
.section-heading .eyebrow { margin-bottom: 3px; }
.section-heading h3 { margin: 0; color: #2c3d54; font-size: 16px; }
.section-heading > span { color: #94a0ae; font-size: 10px; }
.preview-unavailable { display: flex; align-items: flex-start; gap: 10px; margin-top: 18px; padding: 14px; border: 1px solid #e8edf3; border-radius: 7px; background: #fafbfd; color: #718096; }
.info-mark { display: grid; width: 18px; height: 18px; flex: none; place-items: center; margin-top: 1px; border: 1px solid #9aacc4; border-radius: 50%; color: #7c94b6; font: italic 12px Georgia, serif; }
.preview-unavailable strong { color: #53647b; font-size: 12px; }
.preview-unavailable p { margin: 4px 0 0; font-size: 11px; }
.detail-state { padding: 25px 7px; color: #8290a2; font-size: 12px; }
.detail-state > p { text-align: center; }
.detail-error { display: flex; min-height: 230px; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
.detail-warning-mark { color: #c78339; }
.detail-error h3 { margin: 10px 0 3px; color: #384b63; font-size: 15px; }
.detail-error p { max-width: 420px; color: #758499; line-height: 1.65; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@keyframes admin-spin { to { transform: rotate(360deg); } }
@media (max-width: 980px) {
  .summary-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .login-layout { width: min(760px, 100%); grid-template-columns: minmax(0, 1fr) minmax(300px, 360px); gap: 30px; }
}
@media (max-width: 700px) {
  .admin-topbar { height: 56px; gap: 12px; padding: 0 14px; }
  .topbar-context { display: none; }
  .return-button { padding: 7px 9px; font-size: 11px; }
  .admin-main { min-height: calc(100vh - 56px); padding: 22px 13px 24px; }
  .page-heading { align-items: flex-start; margin-bottom: 16px; }
  .page-heading h1, .login-intro h1 { font-size: 21px; }
  .page-subtitle { font-size: 11px; }
  .readonly-badge { padding: 6px 7px; font-size: 10px; }
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .summary-card { min-height: 96px; padding: 11px 12px; }
  .summary-card strong { font-size: 22px; }
  .records-toolbar { align-items: stretch; flex-direction: column; gap: 11px; padding: 12px; }
  .search-form { max-width: none; }
  .filter-control { justify-content: space-between; }
  .filter-control :deep(.el-select) { width: min(220px, 72%); }
  .table-footer { align-items: flex-start; flex-direction: column; }
  .table-footer :deep(.el-pagination) { align-self: center; }
  .login-layout { min-height: auto; grid-template-columns: 1fr; gap: 23px; padding: 28px 1px; }
  .login-intro > p:last-child { font-size: 12px; }
  .login-card :deep(.el-card__body) { padding: 20px; }
  .detail-meta-grid { grid-template-columns: 1fr; }
  .detail-meta-grid .meta-wide { grid-column: auto; }
  .section-heading { align-items: flex-start; flex-direction: column; }
  .logout-button { padding: 7px 9px; font-size: 11px; }
}
</style>
