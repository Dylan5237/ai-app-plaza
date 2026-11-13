<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElButton, ElInput, ElMessageBox } from 'element-plus'
import { apiRequest } from '../lib/api.js'
import { formatDateTime } from '../lib/date.ts'

const view = ref(null)
const draft = ref('')
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const uncertain = ref(false)
let pending = null
let requestVersion = 0

const effective = computed(() => view.value?.template ?? view.value?.defaultPrompt ?? '')
const customized = computed(() => view.value?.template != null)
const dirty = computed(() => Boolean(view.value) && draft.value.trim() !== effective.value.trim())
const canSave = computed(() => Boolean(view.value) && !busy.value && dirty.value && draft.value.trim().length > 0)

async function load() {
  const version = ++requestVersion
  loading.value = true
  error.value = ''
  try {
    const result = await apiRequest('/api/access/smart-search-prompt')
    if (version !== requestVersion) return
    view.value = result
    draft.value = result.template ?? result.defaultPrompt
  } catch (err) {
    if (version === requestVersion) {
      if (err.status === 401 || err.status === 403) view.value = null
      error.value = err.message || '提示词配置加载失败，请稍后重试。'
    }
  } finally {
    if (version === requestVersion) loading.value = false
  }
}

async function write(template) {
  if (busy.value) return
  if (!pending) pending = { requestId: crypto.randomUUID(), confirmed: true, template }
  const request = pending
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await apiRequest('/api/access/smart-search-prompt', { method: 'PUT', body: request })
    pending = null
    uncertain.value = false
    notice.value = template === null ? '已恢复默认提示词，后续检索立即使用默认模板。' : '提示词已保存，后续检索立即生效。'
    await load()
  } catch (err) {
    uncertain.value = !err.status || err.status >= 500
    if (uncertain.value) error.value = '保存结果尚未确认。可重试同一请求，或刷新后核对当前提示词。'
    else {
      pending = null
      error.value = err.message
    }
  } finally {
    busy.value = false
  }
}

async function save() {
  if (!canSave.value) return
  await write(draft.value.trim())
}

async function resetDefault() {
  if (busy.value || !customized.value) return
  try {
    await ElMessageBox.confirm('恢复默认提示词后，自定义内容将被清除，后续检索立即使用默认模板。', '恢复默认', {
      confirmButtonText: '恢复默认', cancelButtonText: '取消', type: 'warning',
    })
  } catch { return }
  await write(null)
}

onMounted(load)
</script>

<template>
  <main class="prompt-admin" aria-labelledby="prompt-title">
    <header class="page-head">
      <div>
        <div class="eyebrow">管理中心 <span>·</span> 智能查找</div>
        <h1 id="prompt-title">系统提示词</h1>
        <p>统一管理智能查找的系统提示词；修改后作用于后续检索，立即生效。</p>
      </div>
      <span class="status-chip" :class="{ custom: customized }">{{ customized ? `已自定义 · ${formatDateTime(view.updatedAt)}` : '使用默认' }}</span>
    </header>

    <div v-if="error" class="state error" role="alert"><span>{{ error }}</span><button type="button" @click="pending ? write(pending.template) : load()">{{ pending ? '重试同一请求' : '重试' }}</button></div>
    <div v-if="notice" class="state ok" role="status">{{ notice }}</div>
    <div v-if="loading && !view" class="state" role="status">正在读取提示词配置…</div>

    <section v-if="view" class="panel editor" aria-label="提示词编辑">
      <div class="editor-head">
        <div>
          <h2>模板正文</h2>
          <p>提示词决定智能查找如何理解任务与写出推荐理由；无可用变量，直接书写规则。</p>
        </div>
        <div class="editor-actions">
          <el-button :disabled="!customized || busy" data-testid="prompt-reset" @click="resetDefault">恢复默认</el-button>
          <el-button type="primary" :disabled="!canSave" data-testid="prompt-save" @click="save">{{ busy ? '正在保存…' : '保存模板' }}</el-button>
        </div>
      </div>
      <el-input
        v-model="draft"
        type="textarea"
        :rows="16"
        :maxlength="view.limit"
        show-word-limit
        resize="vertical"
        spellcheck="false"
        aria-label="系统提示词模板正文"
        data-testid="prompt-editor"
      />
      <p class="hint">服务端输出校验始终生效：推荐只允许候选内应用、最多 3 项、失败自动降级为关键词检索；提示词只影响推荐质量，不影响权限与数据范围。修改会记入操作审计。</p>
    </section>
  </main>
</template>

<style scoped>
.prompt-admin { display: flex; flex-direction: column; gap: 16px; padding: 26px 32px; overflow-y: auto; color: var(--plaza-ink); }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.eyebrow { margin: 0 0 6px; color: var(--plaza-muted); font-size: 12px; letter-spacing: .06em; }
.eyebrow span { color: var(--plaza-line); }
.page-head h1 { margin: 0; font-size: 24px; font-weight: 680; letter-spacing: -.02em; }
.page-head p { margin: 6px 0 0; color: var(--plaza-muted); font-size: 13px; }
.status-chip { flex: none; margin-top: 6px; padding: 4px 12px; border: 1px solid var(--plaza-line); border-radius: 999px; background: var(--plaza-surface); color: var(--plaza-muted); font-size: 12px; }
.status-chip.custom { border-color: var(--plaza-brand); color: var(--plaza-brand); background: var(--plaza-brand-soft); }
.panel { padding: 20px; border: 1px solid var(--plaza-line); border-radius: 14px; background: var(--plaza-surface); }
.editor-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
.editor-head h2 { margin: 0; font-size: 15px; font-weight: 650; }
.editor-head p { margin: 5px 0 0; color: var(--plaza-muted); font-size: 12px; }
.editor-actions { display: flex; flex: none; gap: 8px; }
.hint { margin: 10px 0 0; color: var(--plaza-muted); font-size: 11.5px; line-height: 1.7; }
.state { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border-radius: 10px; font-size: 13px; }
.state.error { border: 1px solid #f3c6c6; background: #fdf1f1; color: #8f3030; }
.state.ok { border: 1px solid #cfe3cf; background: #f1f8f1; color: #2f6b3a; }
.state button { flex: none; padding: 4px 10px; border: 1px solid currentColor; border-radius: 8px; background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer; }
@media (max-width: 760px) { .prompt-admin { padding: 18px 14px; } .editor-head { flex-direction: column; } }
</style>
