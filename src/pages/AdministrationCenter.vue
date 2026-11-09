<script setup>
import { computed, onMounted, ref } from 'vue'
import { apiRequest } from '../lib/api.js'
import { identity } from '../lib/identity.js'
import { publicPath } from '../lib/public-path.js'

const props = defineProps({ mode: { type: String, default: 'governance' } })
const rows = ref([]), choices = ref([]), loading = ref(false), busy = ref(false), error = ref(''), notice = ref('')
const selected = ref(null), ownerId = ref(''), role = ref('member'), reason = ref(''), verified = ref(false), uncertain = ref(false)
let pending = null, generation = 0
const title = computed(() => ({ governance: '应用归属核验', administrators: '管理员配置', transfers: '负责人交接' })[props.mode])
const label = user => `${user.name}${user.account ? `（${user.account}）` : ''}`
async function load() {
  const version = ++generation
  loading.value = true
  try {
    const path = props.mode === 'governance' ? 'governance' : props.mode === 'administrators' ? 'administrators' : 'transfers'
    const data = await apiRequest(`/api/access/${path}`)
    if (version === generation) rows.value = data.items
  } catch (err) { if (version === generation) { rows.value = []; error.value = err.message } }
  finally { if (version === generation) loading.value = false }
}
async function edit(row) {
  error.value = ''; notice.value = ''; pending = null; uncertain.value = false; reason.value = ''; verified.value = false; ownerId.value = ''; role.value = row.role || 'member'
  if (props.mode === 'governance') {
    try { choices.value = (await apiRequest('/api/access/candidates')).users } catch (err) { error.value = err.message; return }
  }
  selected.value = row
}
async function write(path, method, body, message) {
  if (busy.value) return
  if (!pending) pending = { path, method, body: { ...body, requestId: crypto.randomUUID(), confirmed: true }, message }
  const request = pending
  busy.value = true; error.value = ''
  try {
    await apiRequest(request.path, { method: request.method, body: request.body })
    pending = null; uncertain.value = false; selected.value = null; notice.value = request.message
    await load()
  } catch (err) {
    uncertain.value = !err.status || err.status >= 500
    error.value = uncertain.value ? '操作结果尚未确认。请重试同一请求，或先读取原操作结果。' : err.message
    if (!uncertain.value) { pending = null; if (err.status === 409) { selected.value = null; await load() } }
  } finally { busy.value = false }
}
function save() {
  if (uncertain.value && pending) { write(); return }
  if (!selected.value || !reason.value.trim()) return
  if (props.mode === 'governance') {
    if (!ownerId.value || !verified.value) return
    write(`/api/access/apps/${selected.value.id}/adopt`, 'POST', { ownerId: ownerId.value, expectedAppRevision: selected.value.revision, reason: reason.value.trim(), sourceAuthorizationConfirmed: true }, '负责人已核验指定，原公开范围保持不变。')
  } else write('/api/access/administrators', 'PUT', { userId: selected.value.id, role: role.value, revision: selected.value.revision, reason: reason.value.trim() }, '管理员配置已保存并回读。')
}
function transfer(row, action) {
  write(`/api/access/transfers/${row.id}`, 'POST', { action }, action === 'accept' ? '已接受负责人职责。' : action === 'decline' ? '已拒绝本次交接。' : '交接请求已取消。')
}
onMounted(load)
</script>

<template>
  <main class="administration-center">
    <header><div><h1>{{ title }}</h1><p>{{ mode === 'governance' ? '逐项核对来源、原授权与真实负责人；不按显示姓名自动认领。' : mode === 'administrators' ? '平台管理与应用维护分别授权。普通管理员可查看看板和治理清单，超级管理员还可配置管理员与名册。' : '接收前负责人不变，接受时再次核对归属及权限。' }}</p></div><a :href="publicPath('/')">返回应用广场</a></header>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <p v-if="notice" role="status">{{ notice }}</p>
    <div class="center-tools"><el-button :disabled="loading || busy" @click="load">刷新</el-button><el-button v-if="uncertain" type="primary" :loading="busy" @click="write()">核对并重试原操作</el-button></div>
    <div class="center-table" v-loading="loading">
      <el-table :data="rows" row-key="id" empty-text="暂无记录">
        <el-table-column :label="mode === 'administrators' ? '成员' : '应用'" min-width="200"><template #default="{ row }">{{ mode === 'administrators' ? label(row) : row.name }}</template></el-table-column>
        <el-table-column v-if="mode === 'governance'" label="负责人" min-width="140"><template #default="{ row }">{{ row.owner_name || '待核验' }}</template></el-table-column>
        <el-table-column v-if="mode === 'administrators'" label="当前角色" min-width="160"><template #default="{ row }">{{ { member:'普通成员', administrator:'管理员', super_administrator:'超级管理员' }[row.role] }}</template></el-table-column>
        <el-table-column v-if="mode === 'transfers'" label="交接关系" min-width="200"><template #default="{ row }">{{ row.owner_name }} → {{ row.receiver_name }}</template></el-table-column>
        <el-table-column label="操作" min-width="170"><template #default="{ row }">
          <template v-if="mode === 'governance'"><el-button v-if="!row.owner_id" link type="primary" :disabled="busy" @click="edit(row)">核验并指定负责人</el-button><span v-else>已归属</span></template>
          <el-button v-else-if="mode === 'administrators'" link type="primary" :disabled="busy" @click="edit(row)">调整角色</el-button>
          <template v-else><el-button v-if="row.receiver_id === identity.user?.id" link type="primary" :disabled="busy || uncertain" @click="transfer(row,'accept')">接受负责人职责</el-button><el-button v-if="row.receiver_id === identity.user?.id" link :disabled="busy || uncertain" @click="transfer(row,'decline')">拒绝</el-button><el-button v-if="row.owner_id === identity.user?.id" link :disabled="busy || uncertain" @click="transfer(row,'cancel')">取消交接</el-button></template>
        </template></el-table-column>
      </el-table>
    </div>
    <p v-if="mode === 'transfers'" class="center-note">接受后保留原版本和分享。原负责人不自动保留维护权；若权限已变化，需要负责人重新发起交接。</p>
    <el-dialog :model-value="Boolean(selected)" :title="mode === 'governance' ? '核验应用负责人' : '调整平台角色'" width="min(560px, 92vw)" :close-on-click-modal="false" :show-close="!busy" :close-on-press-escape="!busy" @close="selected = null">
      <el-form v-if="selected" label-position="top" :disabled="busy || uncertain" @submit.prevent="save">
        <p>{{ mode === 'governance' ? selected.name : label(selected) }}</p>
        <el-form-item v-if="mode === 'governance'" label="核验后的负责人"><el-select v-model="ownerId" filterable aria-label="核验后的负责人"><el-option v-for="person in choices" :key="person.id" :value="person.id" :label="label(person)" /></el-select></el-form-item>
        <el-form-item v-else label="平台角色"><el-select v-model="role" aria-label="平台角色"><el-option label="普通成员" value="member" /><el-option label="管理员" value="administrator" /><el-option label="超级管理员" value="super_administrator" /></el-select></el-form-item>
        <el-form-item label="核验依据或变更原因"><el-input v-model="reason" type="textarea" maxlength="500" :rows="3" aria-label="核验依据或变更原因" /></el-form-item>
        <el-checkbox v-if="mode === 'governance'" v-model="verified">我已核对该应用的来源授权及原公开授权</el-checkbox>
        <p class="center-note">{{ mode === 'governance' ? '只指定负责人，原公开范围与稳定应用 ID 保持不变。旧发布凭据需要另行交接，不自动转移。' : '变更将影响平台管理与看板访问，不自动认领或读取私有应用。最后一位超级管理员须先安排替代。' }}</p>
      </el-form>
      <template #footer><el-button :disabled="busy" @click="selected = null">取消</el-button><el-button type="primary" :loading="busy" :disabled="!uncertain && (!reason.trim() || (mode === 'governance' ? !ownerId || !verified : role === selected?.role))" @click="save">{{ uncertain ? '核对并重试原操作' : mode === 'governance' ? '确认指定负责人' : '确认更改角色' }}</el-button></template>
    </el-dialog>
  </main>
</template>

<style scoped>
.administration-center { flex: 1; min-height: 0; overflow: auto; padding: 28px 32px; color: var(--plaza-ink); background: var(--plaza-canvas); }.administration-center header { display: flex; gap: 24px; justify-content: space-between; align-items: flex-start; }.administration-center h1 { margin: 0; font-size: 24px; line-height: 32px; }.administration-center p { line-height: 1.7; }.administration-center header p,.center-note { color: var(--plaza-muted); font-size: 14px; }.administration-center a { color: var(--plaza-brand); white-space: nowrap; }.center-tools { display: flex; gap: 12px; margin: 16px 0; }.center-table { border: 1px solid var(--plaza-line); border-radius: var(--plaza-radius,16px); overflow: hidden; background: var(--plaza-surface); }.administration-center :deep(.el-select) { width: 100%; }@media(max-width:650px) { .administration-center { padding: 20px 16px; }.administration-center header { flex-wrap: wrap; gap: 8px; } }
</style>
