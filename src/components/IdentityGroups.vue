<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { apiRequest } from '../lib/api.js'
import { uuid } from '../lib/analytics.js'
const emit = defineEmits(['close'])
const groups = ref([]), users = ref([]), error = ref(''), loading = ref(false), saving = ref(false), editing = ref(false)
const form = reactive({ id: '', requestId: '', revision: undefined, name: '', enabled: true, members: [] })
const previousMembers = computed(() => groups.value.find(group => group.id === form.id)?.members || [])
const added = computed(() => form.members.filter(id => !previousMembers.value.includes(id)))
const removed = computed(() => previousMembers.value.filter(id => !form.members.includes(id)))
const changed = computed(() => {
  const group = groups.value.find(item => item.id === form.id)
  return !group || group.name !== form.name.trim() || group.enabled !== form.enabled || added.value.length || removed.value.length
})
async function load() {
  loading.value = true; error.value = ''
  try {
    const [groupResult, userResult] = await Promise.all([apiRequest('/api/identity/groups'), apiRequest('/api/identity/users')])
    groups.value = groupResult.items; users.value = userResult.items
  } catch (e) { error.value = e.message }
  finally { loading.value = false }
}
function edit(group) {
  Object.assign(form, group ? { id: group.id, revision: group.revision, name: group.name, enabled: group.enabled, members: [...group.members] } :
    { id: '', requestId: uuid(), revision: undefined, name: '', enabled: true, members: [] })
  error.value = ''; editing.value = true
}
function userName(id) {
  const user = users.value.find(user => user.id === id)
  return user ? `${user.name}（${user.account || user.subject}）` : '未能读取成员'
}
async function save() {
  if (saving.value) return
  saving.value = true; error.value = ''
  try {
    await apiRequest(`/api/identity/groups${form.id ? `/${form.id}` : ''}`, { method: form.id ? 'PUT' : 'POST',
      body: { name: form.name.trim(), enabled: form.enabled, members: form.members, confirmed: true, ...(form.id ? { revision: form.revision } : { requestId: form.requestId }) } })
    editing.value = false
    await load()
  } catch (e) { error.value = e.code === 'REVISION_CONFLICT' ? '小组已被其他人修改。请取消后刷新，重新核对。' : e.status ? e.message : '保存结果尚未确认。重试会沿用本次内容，也可取消后刷新核对。' }
  finally { saving.value = false }
}
onMounted(load)
</script>

<template>
  <main class="identity-groups">
    <header><div><h1>成员与小组</h1><p>小组由广场维护。加入小组不代表拥有应用管理或审核权限。</p></div><el-button native-type="button"  @click="emit('close')">返回应用广场</el-button></header>
    <p>成员来自已通过天宫核验并登录广场的用户；新成员需先登录一次。</p>
    <div class="group-toolbar"><el-button native-type="button" type="primary" @click="edit()">新建小组</el-button><el-button native-type="button"  :disabled="loading" @click="load">刷新</el-button></div>
    <p v-if="error && !editing" role="alert">{{ error }}</p>
    <p v-if="loading" role="status">正在读取成员与小组…</p>
    <p v-else-if="!groups.length && !error">暂无小组。</p>
    <el-table v-else :data="groups" aria-label="广场小组">
      <el-table-column label="小组" prop="name" />
      <el-table-column label="状态"><template #default="{ row }">{{ row.enabled ? '启用' : '停用' }}</template></el-table-column>
      <el-table-column label="成员"><template #default="{ row }">{{ row.members.length }} 人</template></el-table-column>
      <el-table-column label="操作"><template #default="{ row }"><el-button  native-type="button" :aria-label="`编辑 ${row.name}`" @click="edit(row)">编辑</el-button></template></el-table-column>
    </el-table>
    <el-dialog v-model="editing" :title="form.id ? '编辑小组' : '新建小组'" width="min(600px, 92vw)" :close-on-click-modal="false" :before-close="done => { if (!saving) done() }">
        <label class="field-label" for="group-name">小组名称</label><el-input id="group-name" v-model="form.name" maxlength="80" :disabled="saving" />
        <label class="field-label" for="group-members">成员</label>
        <el-select id="group-members" v-model="form.members" multiple filterable placeholder="选择已登记成员" style="width: 100%" :disabled="saving">
          <el-option v-for="user in users" :key="user.id" :label="userName(user.id)" :value="user.id" />
        </el-select>
        <label class="field-label"><input v-model="form.enabled" type="checkbox" :disabled="saving" /> 启用此小组</label>
      <div class="group-confirm" aria-label="本次变更的影响">
        <p>保存后成员：{{ form.members.length ? form.members.map(userName).join('、') : '无' }}</p>
        <p v-if="added.length">新增成员：{{ added.map(userName).join('、') }}</p>
        <p v-if="removed.length">移出成员：{{ removed.map(userName).join('、') }}</p>
        <p>移出成员或停用小组后，该小组不再提供相应的分享访问资格；独立授权不随之撤销。此操作不改变应用归属。</p>
      </div>
      <p v-if="error" role="alert">{{ error }}</p>
      <template #footer>
        <el-button native-type="button" :disabled="saving" @click="editing = false">取消</el-button>
        <el-button native-type="button" type="primary" :disabled="saving || !form.name.trim() || !changed" @click="save">{{ saving ? '正在保存…' : '确认保存小组' }}</el-button>
      </template>
    </el-dialog>
  </main>
</template>

<style scoped>
.identity-groups { flex: 1; min-height: 0; overflow: auto; padding: 28px 32px; background: var(--plaza-canvas); color: var(--plaza-ink); }
header { display: flex; justify-content: space-between; align-items: center; gap: 20px; }
h1 { margin: 0; font-size: 24px; }
p { line-height: 1.7; color: var(--plaza-text); }
.group-toolbar { display: flex; gap: 12px; margin: 24px 0; }
.field-label { display: block; margin: 18px 0 8px; }
[role="alert"] { color: var(--plaza-danger); }
.group-confirm { margin-top: 18px; padding: 12px 16px; background: var(--plaza-brand-soft); border-radius: var(--plaza-control-radius); overflow-wrap: anywhere; }
@media(max-width:600px) { .identity-groups { padding: 18px; } header { align-items: flex-start; } }
</style>
