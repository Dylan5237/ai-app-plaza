<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, toRefs, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { apiRequest } from '../lib/api.js'
import ListPagination from './ListPagination.vue'
import { formatDateTime } from '../lib/date.ts'

const emit = defineEmits(['open-app', 'open-update', 'open-publication', 'open-editor', 'open-create', 'open-access'])
const props = defineProps({ state: { type: Object, required: true }, managementEnabled: { type: Boolean, default: false }, managementMode: { type: String, default: 'disabled' } })
const { view, query, status, page, pageSize } = toRefs(props.state)
const records = ref(null)
const table = ref(null)
const footer = ref(null)
let layoutObserver
let layoutFrame = 0
const rows = ref([])
const total = ref(0)
const loading = ref(false)
const error = ref('')
const mutating = ref('')
const isApps = computed(() => ['apps', 'trash'].includes(view.value))
let sequence = 0
const title = computed(() => ({ apps: '应用管理', publications: '待收录与更新', uploads: '上传占位', trash: '回收站' })[view.value])
const description = computed(() => ({
  apps: '集中管理应用详情、版本更新和上下架。',
  publications: '打开原发布预览，核对应用详情与版本，再确认收录或更新。',
  uploads: props.managementMode === 'identity' ? '展示本人可维护应用尚未生成预览的上传；首次上传通过原私有回执继续。' : '展示尚未生成预览的托管上传；资料就绪后转入待收录列表。',
  trash: '删除的应用保留源码与历史版本，恢复后保持下架状态。',
})[view.value])
const stageLabels = { prepared: '上传已占位', project_ready: '项目已准备', commit_ready: '源码已上传', tag_ready: '版本已创建', release_ready: '正在生成预览', submitted: '预览已生成' }
function date(value) { return formatDateTime(value) }
function name(row) { return row.manifest?.name || row.name || row.appKey || '待核验应用' }
function key(row) { return row.manifest?.appKey || row.appKey || '' }
function authors(row) { const list = row.manifest?.maintainers || row.maintainers || []; return list.map(item => typeof item === 'string' ? item : item.name).filter(Boolean).join('、') || '待资料就绪' }
function version(row) { const value = row.version || row.tag; return value ? (/^v/.test(value) ? value : `v${value}`) : '—' }
function stateLabel(row) { if (isApps.value) return ({ published: '已上架', offline: '已下架', deleted: '已删除' })[row.lifecycle?.status || 'published']; if (row.expired) return '预览已过期'; return ({ preview_ready: '等待确认', checking: '来源核验中', failed: '发布未完成' })[row.status] || stageLabels[row.status] || row.status }
async function load() {
  const current = ++sequence
  loading.value = true
  error.value = ''
  const params = new URLSearchParams({ query: query.value.trim(), page: String(page.value), pageSize: String(pageSize.value) })
  if (isApps.value) params.set('status', view.value === 'trash' ? 'deleted' : status.value)
  if (view.value === 'publications') params.set('status', status.value)
  const path = isApps.value ? (props.managementEnabled ? '/api/management/apps' : '/api/apps') : `/api/management/${view.value}`
  try {
    const response = await apiRequest(`${path}?${params}`)
    if (current !== sequence) return
    total.value = Number(response.total) || 0
    const lastPage = Math.max(1, Math.ceil(total.value / pageSize.value))
    if (page.value > lastPage) { page.value = lastPage; await load(); return }
    rows.value = response.items || []
    table.value?.setScrollTop(0)
  } catch (e) {
    if (current === sequence) {
      if ([401, 403, 404].includes(e.status)) { rows.value = []; total.value = 0 }
      error.value = e.message || '暂时无法读取记录。'
    }
  }
  finally { if (current === sequence) loading.value = false }
}
function changeView(value) { view.value = value; query.value = ''; status.value = 'all'; page.value = 1; load() }
function search() { page.value = 1; load() }
function changePage(value) { page.value = value; load() }
function updatePageSize(reload = true) {
  if (!records.value || !footer.value || (reload && error.value)) return
  const header = records.value.querySelector('.el-table__header-wrapper')
  // Reserve the horizontal scrollbar as well as the table heading and pager.
  const available = records.value.clientHeight - footer.value.offsetHeight - (header?.offsetHeight || 40) - 14
  const capacity = Math.max(1, Math.min(20, Math.floor(available / 64)))
  if (capacity === pageSize.value) return
  pageSize.value = capacity
  page.value = 1
  if (reload) load()
}
function scheduleLayout() {
  cancelAnimationFrame(layoutFrame)
  layoutFrame = requestAnimationFrame(() => updatePageSize())
}
async function changeLifecycle(row, action) {
  const texts = {
    offline: ['下架应用', '下架后广场将隐藏此应用，后台仍可查看和修改。', '确认下架'],
    online: ['上架应用', '上架后，广场访问者可以查看和使用当前已收录版本。', '确认上架'],
    delete: ['删除应用', '应用将移入回收站，并从广场隐藏；GitLab 源码与历史版本继续保留。', '移入回收站'],
    restore: ['恢复应用', '应用将恢复到管理列表，保持下架状态。核对后可手动上架。', '恢复为下架'],
  }
  const [title, message, confirmButtonText] = texts[action]
  try { await ElMessageBox.confirm(message, title, { confirmButtonText, cancelButtonText: '取消', type: action === 'delete' ? 'warning' : 'info' }) } catch { return }
  mutating.value = row.id
  error.value = ''
  try {
    await apiRequest(`/api/management/apps/${encodeURIComponent(row.id)}/lifecycle`, { method: 'POST', body: { action, expectedAppRevision: row.revision, expectedLifecycleRevision: row.lifecycle?.revision || 1 } })
    ElMessage.success({ offline: '应用已下架', online: '应用已上架', delete: '应用已移入回收站', restore: '应用已恢复，当前为下架状态' }[action])
    await load()
  } catch (e) { error.value = e.message || '操作未完成，请刷新后核对当前状态。' }
  finally { mutating.value = '' }
}
defineExpose({ reload: load })
function revalidateAccess() { if (props.managementMode === 'identity' && !mutating.value) void load() }
watch(() => props.managementEnabled, load)
onMounted(async () => {
  window.addEventListener('focus', revalidateAccess)
  await nextTick()
  updatePageSize(false)
  layoutObserver = new ResizeObserver(scheduleLayout)
  layoutObserver.observe(records.value)
  layoutObserver.observe(footer.value)
  load()
})
onUnmounted(() => { ++sequence; window.removeEventListener('focus', revalidateAccess); layoutObserver?.disconnect(); cancelAnimationFrame(layoutFrame) })

</script>

<template>
  <main class="management-main">
    <div class="management-heading"><div><h1>{{ title }}</h1><p>{{ description }}</p></div><div class="management-heading-actions"><span v-if="managementMode === 'local'" class="local-label">本地集成版本</span><span v-else-if="managementMode === 'intranet'" class="local-label">内网管理</span><el-button v-if="managementEnabled" type="primary" data-testid="management-create" @click="emit('open-create')">新增应用</el-button></div></div>
    <nav class="management-tabs" aria-label="后台管理视图">
      <button v-for="item in [['apps','应用管理'],['publications','待收录与更新'],['uploads','上传占位'],['trash','回收站']]" :key="item[0]" type="button" :disabled="!managementEnabled && item[0] !== 'apps'" :class="{ active: view === item[0] }" :data-testid="`management-tab-${item[0]}`" @click="changeView(item[0])">{{ item[1] }}</button>
    </nav>
    <el-alert v-if="!managementEnabled" class="management-alert" title="管理写入尚未启用，当前仅可查看应用。" description="本地试用可设置 PLAZA_LOCAL_MANAGEMENT=1；受信任的内网部署可设置 PLAZA_INTRANET_MANAGEMENT=1 并使用 RFC1918 私网 IPv4 门户地址。" type="info" :closable="false" />
    <form class="management-toolbar" @submit.prevent="search">
      <el-input v-model="query" clearable placeholder="搜索应用名称、标识或作者" aria-label="搜索后台应用" data-testid="management-search-input" @clear="search" />
      <el-select v-if="view === 'apps'" v-model="status" aria-label="按应用状态筛选" data-testid="management-status" @change="search"><el-option label="全部状态" value="all" /><el-option label="已上架" value="published" /><el-option label="已下架" value="offline" /></el-select>
      <el-select v-if="view === 'publications'" v-model="status" aria-label="按发布状态筛选" @change="search">
        <el-option label="全部状态" value="all" /><el-option label="等待确认" value="preview_ready" /><el-option label="来源核验中" value="checking" /><el-option label="发布未完成" value="failed" /><el-option label="预览已过期" value="expired" />
      </el-select>
      <el-button type="primary" native-type="submit" data-testid="management-search">查询</el-button><el-button :disabled="loading" @click="load">刷新</el-button>
    </form>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="management-alert" />
    <section ref="records" class="management-records" :aria-busy="loading">
      <el-table ref="table" :data="rows" row-key="id" height="100%" v-loading="loading" empty-text="暂无符合条件的记录" data-testid="management-table">
        <el-table-column label="应用" min-width="240"><template #default="{ row }"><div class="record-app"><button v-if="isApps" type="button" :title="name(row)" class="record-name" @click="emit('open-app', row.id)">{{ name(row) }}</button><strong v-else :title="name(row)">{{ name(row) }}</strong><span :title="key(row)">{{ key(row) }}</span></div></template></el-table-column>
        <el-table-column label="版本" min-width="110" show-overflow-tooltip><template #default="{ row }">{{ version(row) }}</template></el-table-column>
        <el-table-column v-if="view !== 'uploads'" label="作者" min-width="150" show-overflow-tooltip><template #default="{ row }">{{ authors(row) }}</template></el-table-column>
        <el-table-column label="状态" min-width="130"><template #default="{ row }"><el-tag :type="row.expired || row.status === 'failed' ? 'warning' : 'info'" effect="light">{{ stateLabel(row) }}</el-tag></template></el-table-column>
        <el-table-column label="更新时间" min-width="180" show-overflow-tooltip><template #default="{ row }">{{ date(row.updatedAt || row.createdAt) }}</template></el-table-column>
        <el-table-column label="操作" :width="isApps ? managementMode === 'identity' ? 450 : 360 : 190"><template #default="{ row }"><div class="management-actions">
          <template v-if="isApps">
            <el-button link type="primary" :data-testid="`management-detail-${row.id}`" @click="emit('open-app', row.id)">详情</el-button>
            <el-button v-if="managementMode === 'identity'" link type="primary" @click="emit('open-access', row.id)">归属与权限</el-button>
            <template v-if="view !== 'trash'">
              <el-button link type="primary" :disabled="!managementEnabled || Boolean(mutating)" :data-testid="`management-edit-${row.id}`" @click="emit('open-editor', row.id)">修改</el-button>
              <el-button link type="primary" :disabled="!managementEnabled || Boolean(mutating)" :data-testid="`management-update-${row.id}`" @click="emit('open-update', row.id)">发布新版本</el-button>
              <el-button link type="primary" :disabled="!managementEnabled || Boolean(mutating)" :data-testid="`management-visibility-${row.id}`" @click="changeLifecycle(row, row.lifecycle?.status === 'offline' ? 'online' : 'offline')">{{ row.lifecycle?.status === 'offline' ? '上架' : '下架' }}</el-button>
              <el-button link type="danger" :disabled="!managementEnabled || Boolean(mutating)" :data-testid="`management-delete-${row.id}`" @click="changeLifecycle(row, 'delete')">删除</el-button>
            </template>
            <el-button v-else link type="primary" :disabled="!managementEnabled || Boolean(mutating)" :data-testid="`management-restore-${row.id}`" @click="changeLifecycle(row, 'restore')">恢复</el-button>
          </template>
          <el-button v-else-if="view === 'publications'" link type="primary" :data-testid="`management-preview-${row.id}`" @click="emit('open-publication', row.id)">{{ row.status === 'preview_ready' && !row.expired ? '查看并确认' : '查看详情' }}</el-button>
          <el-button v-else link disabled title="上传资料尚未就绪，生成预览后可以收录">收录</el-button>
        </div></template></el-table-column>
      </el-table>
      <footer ref="footer" class="management-footer" data-testid="management-pagination"><span>共 {{ total }} 项</span><div class="management-pager"><ListPagination :page="page" :page-size="pageSize" :total="total" @change="changePage" /></div></footer>
    </section>
    <p v-if="view === 'uploads'" class="management-note">上传占位尚无完整详情和作者资料，不能确认收录。上传完成后，在“待收录与更新”打开原预览流程核对。</p>
  </main>
</template>

<style scoped>
.management-main { box-sizing: border-box; display: flex; flex-direction: column; width: min(1480px, 100%); height: 100%; min-height: 360px; margin: 0 auto; padding: 26px 32px 20px; color: var(--plaza-ink); }
.management-heading, .management-tabs, .management-toolbar, .management-alert, .management-note { flex-shrink: 0; }
.management-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.management-heading h1 { margin: 0 0 6px; color: var(--plaza-ink); font-size: 27px; line-height: 36px; font-weight: 680; letter-spacing: -.025em; }
.management-heading p { margin: 0; color: var(--plaza-muted); font-size: 12.5px; line-height: 20px; }
.local-label { flex: none; padding: 4px 9px; border: 1px solid var(--plaza-line); border-radius: 999px; background: var(--plaza-surface); color: var(--plaza-muted); font-size: 11px; line-height: 18px; }
.management-heading-actions { display: flex; align-items: center; gap: 12px; }
.management-tabs { display: flex; gap: 22px; margin-bottom: 16px; border-bottom: 1px solid rgb(32 42 59 / .08); }
.management-tabs button { position: relative; padding: 7px 1px 11px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--plaza-muted); font-size: 12.5px; font-weight: 500; cursor: pointer; line-height: 20px; }
.management-tabs button:hover { color: var(--plaza-ink); }
.management-tabs button.active { border-bottom-color: var(--plaza-brand); color: var(--plaza-ink); font-weight: 600; }
.management-toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.management-toolbar :deep(.el-input) { width: 300px; max-width: 100%; }
.management-toolbar :deep(.el-select) { width: 150px; }
.management-toolbar :deep(.el-button + .el-button) { margin-left: 0; }
.management-alert { margin-bottom: 14px; }
.management-records { display: flex; flex: 1; flex-direction: column; min-height: 118px; overflow: hidden; border: 1px solid rgb(32 42 59 / .07); border-radius: 14px; background: var(--plaza-surface); box-shadow: 0 1px 2px rgb(28 37 51 / .03); }
.management-records :deep(.el-table) { flex: 1; min-height: 0; background: transparent; }
.management-records :deep(.el-table__row) { height: 56px; }
.management-records :deep(.cell) { white-space: nowrap; }
.management-records :deep(.el-table th.el-table__cell) { padding: 12px 0 9px; }
.management-records :deep(.el-table td.el-table__cell) { padding: 11px 0; }
.record-app > * { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.record-app { display: grid; gap: 2px; line-height: 20px; }
.record-app strong, .record-name { color: var(--plaza-ink); font-size: 12.5px; font-weight: 600; line-height: 20px; }
.record-name { width: fit-content; padding: 0; border: 0; background: transparent; line-height: 20px; text-align: left; cursor: pointer; }
.record-name:hover { color: var(--plaza-brand); }
.record-app span { color: var(--plaza-muted); font-size: 11px; line-height: 16px; }
.management-actions { display: flex; gap: 11px; align-items: center; flex-wrap: wrap; }
.management-actions :deep(.el-button + .el-button) { margin-left: 0; }
.management-actions :deep(.el-button) { font-size: 12px; }
.management-footer { position: relative; display: flex; flex-shrink: 0; align-items: center; justify-content: center; gap: 12px; min-height: 48px; padding: 0 16px; border-top: 1px solid rgb(32 42 59 / .06); color: var(--plaza-muted); font-size: 11.5px; line-height: 18px; }
.management-pager { display: flex; min-height: 30px; align-items: center; justify-content: center; }
.management-footer > span { position: absolute; left: 16px; }
.management-note { color: var(--plaza-muted); font-size: 11.5px; line-height: 1.6; margin-top: 10px; }
@media (max-width: 650px) { .management-footer { flex-direction: column; gap: 8px; padding: 10px 16px; } .management-footer > span { position: static; align-self: flex-start; } .management-main { padding: 20px 14px; } .management-heading { flex-wrap: wrap; align-items: flex-start; } .management-heading-actions { margin-left: auto; } .management-heading h1 { font-size: 24px; line-height: 32px; } .management-toolbar { flex-wrap: wrap; } .management-toolbar :deep(.el-input) { flex: 1 1 100%; width: 100%; } .management-tabs { gap: 18px; } .local-label { font-size: 11px; padding: 4px 6px; line-height: 18px; } }
</style>