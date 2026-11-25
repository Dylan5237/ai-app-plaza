<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { apiRequest } from '../lib/api.js'
import { uuid } from '../lib/analytics.js'
import { deletePendingMetadataEdit, getPendingMetadataEdit, setPendingMetadataEdit } from '../lib/pending-metadata-edits.ts'
import { savePublicationTicket } from '../lib/publication-tickets.ts'

const props = defineProps({
  appId: { type: String, default: '' },
  publicationId: { type: String, default: '' },
  publicationToken: { type: String, default: '' },
  management: { type: Boolean, default: false },
  readOnly: { type: Boolean, default: false },
  readOnlyReason: { type: String, default: '' },
})
const emit = defineEmits(['close', 'saved', 'pending-change', 'access-lost'])
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const context = ref(null)
const manifest = ref(null)
const documents = ref({})
const expectedRevision = ref(0)
const activeTab = ref('overview')
const pending = ref(null)
const persistenceFallback = ref(false)
const localReadOnlyReason = ref('')
const TERMINAL_READONLY_CONFLICTS = new Set([
  'PUBLICATION_STATE_CONFLICT',
  'PUBLICATION_CANCELLED',
  'APP_DELETED',
  'APP_RESTORE_REQUIRED',
])
let unmounted = false
onUnmounted(() => {
  unmounted = true
  sequence++
})
const isPublicationMode = computed(() => Boolean(props.publicationId))
const targetKey = computed(() => isPublicationMode.value
  ? `${props.management ? 'mgmt-pub' : 'pub'}:${props.publicationId}`
  : props.appId ? `app:${props.appId}` : '')
const editorEndpoint = computed(() => {
  if (isPublicationMode.value) {
    return props.management
      ? `/api/management/publications/${encodeURIComponent(props.publicationId)}/editor`
      : `/api/publications/${encodeURIComponent(props.publicationId)}/editor`
  }
  return `/api/management/apps/${encodeURIComponent(props.appId)}/editor`
})
const requestToken = computed(() => isPublicationMode.value && !props.management ? props.publicationToken : '')
const locked = computed(() => saving.value || Boolean(pending.value))
const readOnlyContext = computed(() => Boolean(!pending.value && (props.readOnly || localReadOnlyReason.value || (context.value && !context.value.editable))))
const formDisabled = computed(() => locked.value || readOnlyContext.value)
watch(locked, value => emit('pending-change', value), { immediate: true })
let sequence = 0
const clone = value => JSON.parse(JSON.stringify(value))
const content = value => JSON.stringify({ ...value, projectVersion: undefined })
const changed = computed(() => Boolean(manifest.value && context.value?.app && (
  content(manifest.value) !== content(context.value.app.manifest) ||
  JSON.stringify(documents.value) !== JSON.stringify(context.value.app.documents)
)))
const arrayFields = [
  ['scenarios', '应用场景'], ['inputs', '输入内容'], ['outputs', '输出结果'],
]
const documentLabels = computed(() => {
  const labels = {}
  if (!manifest.value) return labels
  labels[manifest.value.docs.readme] = '完整介绍'
  labels[manifest.value.docs.usage] = labels[manifest.value.docs.usage] ? '介绍与使用说明' : '使用说明'
  for (const entry of manifest.value.entries) if (entry.kind === 'agent') labels[entry.instructionsPath] = `Agent 说明 · ${entry.label}`
  return labels
})
function lines(value) { return (value || []).join('\n') }
function setLines(object, field, value) { object[field] = value.split('\n').map(item => item.trim()).filter(Boolean) }
async function load() {
  const current = ++sequence
  const key = targetKey.value
  const saved = getPendingMetadataEdit(key)
  loading.value = true
  error.value = ''
  localReadOnlyReason.value = ''
  context.value = null
  manifest.value = null
  pending.value = null
  persistenceFallback.value = false
  activeTab.value = 'overview'
  const applySavedPending = (loadedContext = null) => {
    if (!saved) return false
    context.value = loadedContext
    pending.value = saved
    expectedRevision.value = saved.body.expectedAppRevision ?? 0
    manifest.value = clone(saved.body.manifest)
    documents.value = clone(saved.body.documents)
    return true
  }
  try {
    const result = await apiRequest(editorEndpoint.value, requestToken.value ? { token: requestToken.value } : {})
    if (current !== sequence) return
    if (!result.editable) {
      if (!applySavedPending(result)) context.value = result
      return
    }
    context.value = result
    expectedRevision.value = result.expectedAppRevision ?? result.app.revision
    manifest.value = clone(result.app.manifest)
    manifest.value.projectVersion = result.suggestedVersion
    documents.value = clone(result.app.documents)
    if (saved) applySavedPending(result)
  } catch (e) {
    if (current === sequence && !unmounted) {
      if ([403, 404].includes(e?.status)) deletePendingMetadataEdit(key)
      context.value = null
      manifest.value = null
      documents.value = {}
      pending.value = null
      persistenceFallback.value = false
      error.value = e?.message || '读取编辑资料失败。'
      if ([401, 403, 404].includes(e?.status)) emit('access-lost', e.status)
    }
  }
  finally { if (current === sequence && !unmounted) loading.value = false }
}
watch(targetKey, key => {
  sequence++
  saving.value = false
  if (key) {
    load()
    return
  }
  loading.value = false
  error.value = ''
  localReadOnlyReason.value = ''
  context.value = null
  manifest.value = null
  documents.value = {}
  pending.value = null
  persistenceFallback.value = false
}, { immediate: true })
async function close() {
  if (saving.value) return
  if (pending.value) {
    try { await ElMessageBox.confirm('本次保存结果尚未确认。关闭后仍可在“上传占位”或“待收录与更新”查看进度。', '关闭编辑', { confirmButtonText: '关闭', cancelButtonText: '继续核对', type: 'warning' }) } catch { return }
  }
  sequence++
  emit('close')
}
async function save() {
  if (saving.value || readOnlyContext.value || (!pending.value && !context.value?.editable) || !manifest.value) return
  if (!pending.value && !changed.value) return
  if (!pending.value) {
    const key = uuid()
    if (!key) {
      error.value = '当前浏览器无法生成安全请求标识，请更换现代浏览器或通过 HTTPS 访问后再保存。'
      return
    }
    pending.value = {
      key,
      cacheKey: targetKey.value,
      endpoint: editorEndpoint.value,
      token: requestToken.value,
      publicationMode: isPublicationMode.value,
      management: props.management,
      body: clone({ expectedAppRevision: expectedRevision.value, manifest: manifest.value, documents: documents.value }),
    }
  }
  const operation = pending.value
  const currentSequence = sequence
  const operationKey = operation.cacheKey
  const endpoint = editorEndpoint.value
  const publicationMode = isPublicationMode.value
  const management = props.management
  const isCurrent = () => !unmounted && currentSequence === sequence && targetKey.value === operationKey
  const persisted = setPendingMetadataEdit(operation.cacheKey, {
    ...operation,
    endpoint,
    publicationMode,
    management,
  })
  persistenceFallback.value = !persisted
  saving.value = true
  error.value = ''
  try {
    const token = publicationMode && !management ? requestToken.value : ''
    const result = await apiRequest(endpoint, {
      method: 'POST',
      body: operation.body,
      idempotencyKey: operation.key,
      ...(token ? { token } : {}),
    })
    if (publicationMode) {
      const nextPublication = management ? result.managementPublication : result.publication
      if (!nextPublication?.id) throw new Error('未能确认保存结果，请保留本次请求重试。')
      if (!isCurrent()) return
      if (!management && result.ticket) savePublicationTicket(nextPublication.id, result.ticket)
      pending.value = null
      persistenceFallback.value = false
      emit('saved', {
        publicationId: nextPublication.id,
        publication: nextPublication,
        ...(result.ticket ? { ticket: result.ticket } : {}),
      })
      deletePendingMetadataEdit(operation.cacheKey, operation.key)
    } else {
      if (!result.managementPublication?.id) throw new Error('未能确认保存结果，请保留本次请求重试。')
      if (!isCurrent()) return
      pending.value = null
      persistenceFallback.value = false
      emit('saved', result.managementPublication.id)
      deletePendingMetadataEdit(operation.cacheKey, operation.key)
    }
  } catch (e) {
    if ([401, 403, 404].includes(e?.status)) {
      if ([403, 404].includes(e.status)) deletePendingMetadataEdit(operation.cacheKey, operation.key)
      if (isCurrent()) {
        context.value = null
        manifest.value = null
        documents.value = {}
        pending.value = null
        persistenceFallback.value = false
        error.value = e.message || '当前已无权继续编辑此内容。'
        emit('access-lost', e.status)
      }
      return
    }
    // Deterministic validation/conflict failures retain the editable draft while clearing pending retry state.
    if ([400, 413, 422].includes(e.status) || (e.status === 409 && [
      'REVISION_CONFLICT',
      'VERSION_NOT_NEWER',
      'TAG_CONFLICT',
      'RELEASE_CONFLICT',
      'PUBLICATION_STATE_CONFLICT',
      'PUBLICATION_CANCELLED',
      'APP_DELETED',
      'APP_RESTORE_REQUIRED',
      'IDEMPOTENCY_CONFLICT',
      'MANAGED_SOURCE_CONFLICT',
    ].includes(e.code))) {
      deletePendingMetadataEdit(operation.cacheKey, operation.key)
      if (isCurrent()) {
        if (!pending.value || pending.value.key === operation.key) {
          pending.value = null
          persistenceFallback.value = false
        }
        if (e.status === 409 && TERMINAL_READONLY_CONFLICTS.has(e.code)) {
          localReadOnlyReason.value = e.message || '当前原预览已失效，无法再保存；以下草稿已切换为只读，方便复制后前往最新预览继续编辑。'
        }
      }
    }
    if (isCurrent()) error.value = e.message || '保存未完成。'
  } finally {
    if (isCurrent()) saving.value = false
  }
}
</script>

<template>
  <el-dialog :model-value="Boolean(targetKey)" :title="isPublicationMode ? '编辑应用信息' : '修改应用详情'" width="min(860px, 94vw)" class="metadata-editor" data-testid="metadata-editor" :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving" :before-close="close">
    <div v-loading="loading" class="metadata-content">
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="editor-alert" />
      <el-alert v-if="context && !context.editable && !pending" :title="context.reason || '当前来源暂不支持后台修改。'" type="info" :closable="false" />
      <template v-if="manifest">
        <p v-if="context?.app" class="editor-context">{{ context.app.manifest.name }} · 当前 v{{ context.app.version }} · {{ context.app.manifest.appKey }}</p>
        <p v-else class="editor-context">{{ manifest.name }} · {{ manifest.appKey }}</p>
        <p class="editor-note">{{ isPublicationMode ? '保存会将资料写回托管仓库并生成最新预览。核对无误后点击「确认收录」或「确认更新」，广场才会展示最新内容。' : '保存会将资料写回 GitLab 并生成新版本预览。核对并确认更新后，广场才会使用新详情。' }}</p>
        <p v-if="!changed && !pending" class="editor-note">修改资料后可保存；仅版本号变化不会创建预览。</p>
        <el-alert v-if="persistenceFallback && (saving || pending)" title="浏览器会话存储空间不足，本次编辑恢复记录仅保存在当前标签页内存中；请勿刷新或关闭标签页，直至保存完成并确认新预览。" type="warning" :closable="false" class="editor-alert" data-testid="editor-storage-fallback" />
        <el-alert v-if="readOnlyContext && manifest" :title="localReadOnlyReason || props.readOnlyReason || '当前旧预览已不可保存修改，以下草稿仅供核对或复制；请关闭后打开最新预览继续编辑。'" type="info" :closable="false" class="editor-alert" data-testid="editor-readonly-notice" />
        <el-alert v-if="pending && !saving" :title="context && !context.editable ? '该原预览已不可继续新建修改；如果此前保存可能已生成新预览，请点击「重试本次保存」找回结果与新授权。' : '保存结果待确认，资料已锁定。请使用同一请求重试，避免重复创建版本。'" type="warning" :closable="false" class="editor-alert" />
        <el-tabs v-model="activeTab">
          <el-tab-pane label="基本资料" name="overview">
            <el-form label-position="top" :disabled="formDisabled">
              <div class="editor-grid">
                <el-form-item label="应用名称"><el-input v-model="manifest.name" data-testid="editor-name" /></el-form-item>
                <el-form-item label="新版本号"><el-input v-model="manifest.projectVersion" data-testid="editor-version" placeholder="例如 1.2.1" /></el-form-item>
              </div>
              <el-form-item label="应用简介"><el-input v-model="manifest.summary" type="textarea" :rows="3" data-testid="editor-summary" /></el-form-item>
              <el-form-item label="能力标签（最多 3 个）"><el-select v-model="manifest.tags" multiple filterable allow-create default-first-option :multiple-limit="3" aria-label="能力标签"><el-option v-for="tag in (context?.app?.tags || manifest.tags || [])" :key="tag" :label="tag" :value="tag" /></el-select></el-form-item>
              <div v-for="(author, index) in manifest.maintainers" :key="index" class="editor-author">
                <el-form-item :label="`作者 ${index + 1} · 中文姓名`"><el-input v-model="author.name" /></el-form-item>
                <el-form-item label="英文全名或完整拼音"><el-input v-model="author.nameEn" /></el-form-item>
                <el-button :disabled="manifest.maintainers.length <= 1" @click="manifest.maintainers.splice(index, 1)">移除</el-button>
              </div>
              <el-button @click="manifest.maintainers.push({ name: '', nameEn: '' })">添加作者</el-button>
            </el-form>
          </el-tab-pane>
          <el-tab-pane label="能力与示例" name="capabilities">
            <el-form label-position="top" :disabled="formDisabled">
              <el-form-item v-for="[field, label] in arrayFields" :key="field" :label="`${label}（每行一项）`"><el-input type="textarea" :rows="3" :model-value="lines(manifest.capabilities[field])" @update:model-value="setLines(manifest.capabilities, field, $event)" /></el-form-item>
              <div v-for="(example, index) in manifest.examples" :key="index" class="editor-example">
                <el-form-item :label="`示例 ${index + 1} · 用户请求`"><el-input v-model="example.request" type="textarea" :rows="2" /></el-form-item>
                <el-form-item label="预期结果"><el-input v-model="example.expectedResult" type="textarea" :rows="2" /></el-form-item>
                <el-button :disabled="manifest.examples.length <= 1" @click="manifest.examples.splice(index, 1)">移除此示例</el-button>
              </div>
              <el-button @click="manifest.examples.push({ request: '', expectedResult: '' })">添加示例</el-button>
              <el-form-item label="使用条件（每行一项）"><el-input type="textarea" :rows="3" :model-value="lines(manifest.requirements)" @update:model-value="setLines(manifest, 'requirements', $event)" /></el-form-item>
              <el-form-item label="使用限制（每行一项）"><el-input type="textarea" :rows="3" :model-value="lines(manifest.limitations)" @update:model-value="setLines(manifest, 'limitations', $event)" /></el-form-item>
            </el-form>
          </el-tab-pane>
          <el-tab-pane label="入口与完整说明" name="documents">
            <el-form label-position="top" :disabled="formDisabled">
              <template v-for="entry in manifest.entries" :key="entry.id">
                <el-form-item :label="`${entry.kind === 'web' ? 'Web' : 'Agent'} 入口名称`"><el-input v-model="entry.label" /></el-form-item>
                <el-form-item v-if="entry.kind === 'web'" label="应用访问地址"><el-input v-model="entry.url" /></el-form-item>
                <el-form-item v-else label="兼容工具（每行一项）"><el-input type="textarea" :rows="2" :model-value="lines(entry.compatibility)" @update:model-value="setLines(entry, 'compatibility', $event)" /></el-form-item>
              </template>
              <el-form-item v-for="(label, path) in documentLabels" :key="path" :label="`${label} · ${path}`"><el-input v-model="documents[path]" type="textarea" :rows="10" :aria-label="label" :data-testid="`editor-doc-${path}`" /></el-form-item>
            </el-form>
          </el-tab-pane>
        </el-tabs>
      </template>
    </div>
    <template #footer>
      <el-button :disabled="saving" @click="close">取消</el-button>
      <el-button v-if="error && !pending && !(readOnlyContext && manifest)" :disabled="saving" @click="load">重新读取</el-button>
      <el-button v-if="manifest" type="primary" :loading="saving" :disabled="loading || readOnlyContext || (!changed && !pending)" data-testid="editor-save" @click="save">{{ pending && !saving ? '重试本次保存' : isPublicationMode ? '保存并刷新预览' : '保存到 GitLab 并预览' }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.metadata-content { min-height: 160px; max-height: 64vh; overflow-y: auto; padding: 0 4px; }
.editor-context { margin: 0 0 8px; color: var(--plaza-ink); font-weight: 600; }
.editor-note { margin: 0 0 16px; color: var(--plaza-muted); font-size: 14px; line-height:22px; }
.editor-alert { margin-bottom: 14px; }
.editor-grid { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; }
.editor-author { display: grid; grid-template-columns: 1fr 1fr auto; gap: 12px; align-items: end; }
.editor-author > .el-button { margin-bottom: 18px; }
.editor-example { margin-bottom: 18px; padding: 14px; border: 1px solid var(--plaza-line); border-radius: 4px; }
.metadata-content :deep(.el-select) { width: 100%; }
@media (max-width: 650px) { .editor-grid, .editor-author { grid-template-columns: 1fr; gap: 0; } }
</style>
