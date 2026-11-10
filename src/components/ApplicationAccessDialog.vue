<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { apiRequest } from '../lib/api.js'

const props = defineProps({ appId: { type: String, default: '' } })
const emit = defineEmits(['close', 'saved'])
const current = ref(null), choices = ref({ users: [], groups: [] }), loading = ref(false), busy = ref(false)
const section = ref('sharing'), scope = ref('self'), members = ref([]), groups = ref([]), maintainers = ref([]), receiver = ref('')
const error = ref(''), notice = ref(''), uncertain = ref(false)
let generation = 0, pending = null
const label = person => `${person.name}${person.account ? `（${person.account}）` : ''}`
const scopes = { all: '全体成员（公开，可未登录浏览）', members: '指定成员', groups: '指定小组', self: '仅自己' }
const sorted = values => [...values].sort()
const payload = computed(() => section.value === 'sharing'
  ? { scope: scope.value, memberIds: scope.value === 'members' ? sorted(members.value) : [], groupIds: scope.value === 'groups' ? sorted(groups.value) : [] }
  : section.value === 'maintainers' ? { maintainerIds: sorted(maintainers.value) } : { receiverId: receiver.value })
const changed = computed(() => {
  if (!current.value?.canShare) return false
  if (section.value === 'transfer') return Boolean(receiver.value && receiver.value !== current.value.owner_id)
  const before = section.value === 'sharing' ? { scope: current.value.scope, memberIds: sorted(current.value.member_ids), groupIds: sorted(current.value.group_ids) } : { maintainerIds: sorted(current.value.maintainer_ids) }
  return JSON.stringify(payload.value) !== JSON.stringify(before)
})
const valid = computed(() => {
  if (section.value !== 'sharing') return true
  return scope.value === 'members' ? members.value.length > 0 : scope.value !== 'groups' || groups.value.length > 0
})
const effect = computed(() => section.value === 'sharing'
  ? scope.value === 'all' ? '保存后允许未登录浏览。对源码仓库和目标应用的权限仍由对应系统控制。'
    : scope.value === 'self' ? '普通访问仅负责人本人可见。旧链接与收藏不再授予他人读取权；明确维护者仍可读取维护所需资料。'
      : `${scope.value === 'members' ? members.value.length + ' 位成员' : groups.value.length + ' 个小组的当前成员'}可浏览；分享不授予维护或转授权。收紧后旧链接与收藏重新核权。`
  : section.value === 'maintainers' ? '所选人员可维护此应用，不能继续委派或更改分享。移除后停止维护权限，独立的分享可见权限按原设置判断。'
    : '接收人接受前，负责人保持不变。接受后保留版本与分享；原负责人不自动保留维护权限，发布凭据需重新核对。')
async function load(revalidating = false) {
  const version = ++generation, id = props.appId
  if (!id) { current.value = null; return }
  if (!revalidating) current.value = null
  loading.value = true
  try {
    const data = await apiRequest(`/api/access/apps/${id}`)
    const options = data.canShare ? await apiRequest(`/api/access/candidates?appId=${id}`) : { users: data.people, groups: data.groups }
    if (version !== generation || id !== props.appId) return
    const preserveDraft = revalidating && current.value && changed.value && data.canShare
    current.value = preserveDraft ? { ...data, revision: current.value.revision } : data; choices.value = options
    if (!preserveDraft) { scope.value = data.scope; members.value = [...data.member_ids]; groups.value = [...data.group_ids]; maintainers.value = [...data.maintainer_ids]; receiver.value = '' }
  } catch (err) { if (version === generation) { if ([401, 403, 404].includes(err.status)) current.value = null; error.value = err.message } }
  finally { if (version === generation) loading.value = false }
}
watch(() => props.appId, () => { pending = null; uncertain.value = false; error.value = ''; notice.value = ''; section.value = 'sharing'; load() }, { immediate: true })
function revalidate() { if (props.appId && !busy.value && !uncertain.value) void load(true) }
function beforeClose(done) {
  if (uncertain.value) { ElMessage.warning('原请求结果尚未确认，请先重试同一请求，确认后再关闭。'); return }
  done()
}
function requestClose() {
  if (uncertain.value) { ElMessage.warning('原请求结果尚未确认，请先重试同一请求，确认后再关闭。'); return }
  emit('close')
}
onMounted(() => window.addEventListener('focus', revalidate))
onUnmounted(() => { generation++; window.removeEventListener('focus', revalidate) })
async function save() {
  if (busy.value || !current.value || !valid.value || !changed.value && !uncertain.value) return
  const version = generation, id = props.appId
  if (!pending) pending = { path: section.value === 'transfer' ? 'transfers' : section.value,
    method: section.value === 'transfer' ? 'POST' : 'PUT', body: { ...payload.value, revision: current.value.revision, requestId: crypto.randomUUID(), confirmed: true } }
  busy.value = true; error.value = ''; notice.value = ''
  try {
    await apiRequest(`/api/access/apps/${id}/${pending.path}`, { method: pending.method, body: pending.body })
    if (version !== generation || id !== props.appId) return
    const transfer = pending.path === 'transfers'
    pending = null; uncertain.value = false
    notice.value = transfer ? '交接请求已发送，等待接收人接受。' : '配置已保存，已回读当前结果。'
    await load(); emit('saved')
  } catch (err) {
    if (version !== generation || id !== props.appId) return
    uncertain.value = !err.status || err.status >= 500
    error.value = uncertain.value ? '保存结果尚未确认。保留本次请求，重试时核对原操作，不创建另一份变更。' : err.message
    if (!uncertain.value) { pending = null; if (err.status === 409) await load(); if ([401,403,404].includes(err.status)) current.value = null }
  } finally { busy.value = false }
}
</script>

<template>
  <el-dialog :model-value="Boolean(appId)" title="应用归属与权限" width="min(680px, 92vw)" class="application-access-dialog" :close-on-click-modal="false" :show-close="!busy && !uncertain" :close-on-press-escape="!busy && !uncertain" :before-close="beforeClose" @close="requestClose">
    <div v-loading="loading" class="access-form">
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
      <p v-if="notice" role="status">{{ notice }}</p>
      <el-alert v-if="uncertain" title="原请求结果尚未确认。请重试同一请求，确认后再关闭此弹窗。" type="warning" :closable="false" show-icon />
      <template v-if="current">
        <p>负责人：{{ label(current.people.find(item => item.id === current.owner_id) || { name: '已核验用户' }) }}</p>
        <p v-if="!current.canShare">当前范围：{{ scopes[current.scope] }}。你可维护此应用，归属、分享及委派由负责人调整。</p>
        <template v-else>
          <el-radio-group v-model="section" :disabled="busy || uncertain" aria-label="权限配置项目"><el-radio-button value="sharing">分享范围</el-radio-button><el-radio-button value="maintainers">维护授权</el-radio-button><el-radio-button value="transfer">负责人交接</el-radio-button></el-radio-group>
          <el-form label-position="top" :disabled="busy || uncertain" @submit.prevent="save">
            <template v-if="section === 'sharing'">
              <el-form-item label="谁可以浏览"><el-select v-model="scope" aria-label="分享范围"><el-option v-for="(name,key) in scopes" :key="key" :value="key" :label="name" /></el-select></el-form-item>
              <el-form-item v-if="scope === 'members'" label="指定成员"><el-select v-model="members" multiple filterable aria-label="指定成员"><el-option v-for="person in choices.users" :key="person.id" :value="person.id" :label="label(person)" /></el-select></el-form-item>
              <el-form-item v-if="scope === 'groups'" label="指定小组"><el-select v-model="groups" multiple filterable aria-label="指定小组"><el-option v-for="group in choices.groups" :key="group.id" :value="group.id" :label="group.name" /></el-select></el-form-item>
            </template>
            <el-form-item v-else-if="section === 'maintainers'" label="应用维护者"><el-select v-model="maintainers" multiple filterable aria-label="应用维护者"><el-option v-for="person in choices.users.filter(item => item.id !== current.owner_id)" :key="person.id" :value="person.id" :label="label(person)" /></el-select></el-form-item>
            <el-form-item v-else label="交接接收人"><el-select v-model="receiver" filterable aria-label="交接接收人"><el-option v-for="person in choices.users.filter(item => item.id !== current.owner_id)" :key="person.id" :value="person.id" :label="label(person)" /></el-select></el-form-item>
          </el-form>
          <p class="access-impact" role="status">{{ effect }}</p>
        </template>
      </template>
    </div>
    <template #footer><el-button :disabled="busy || uncertain" @click="requestClose">关闭</el-button><el-button v-if="current?.canShare" type="primary" :loading="busy" :disabled="!uncertain && (!changed || !valid)" @click="save">{{ uncertain ? '核对并重试原操作' : section === 'transfer' ? '确认发起交接' : section === 'maintainers' ? '确认更改维护授权' : '确认更改分享范围' }}</el-button></template>
  </el-dialog>
</template>

<style scoped>
.access-form { display: grid; gap: 16px; min-height: 140px; color: var(--plaza-ink); }.access-form p { margin: 0; line-height: 1.7; }.access-form :deep(.el-select) { width: 100%; }.access-form :deep(.el-form) { margin-top: 8px; }.access-impact { padding: 14px 16px; border-radius: var(--plaza-control-radius,9px); background: var(--plaza-canvas); color: var(--plaza-muted); }
</style>
