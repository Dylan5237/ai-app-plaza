<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElButton, ElInput, ElMessageBox, ElTabPane, ElTabs } from 'element-plus'
import { apiRequest } from '../lib/api.js'
import { formatDateTime } from '../lib/date.ts'
import { uuid } from '../lib/analytics.js'
import { loadShareTemplates, renderShareTemplate, renderTemplate } from '../lib/share-template.ts'

const activeTab = ref('smart-search')

const view = ref(null)
const draft = ref('')
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const templatesError = ref('')
const notice = ref('')
const uncertain = ref(false)
let pending = null
let requestVersion = 0

const effective = computed(() => view.value?.template ?? view.value?.defaultPrompt ?? '')
const customized = computed(() => view.value?.template != null)
const dirty = computed(() => Boolean(view.value) && draft.value.trim() !== effective.value.trim())
const canSave = computed(() => Boolean(view.value) && !busy.value && !uncertain.value && dirty.value && draft.value.trim().length > 0)

const templatesView = ref(null)
const templateDrafts = reactive({})
const templateBusy = reactive({})
const templateUncertain = reactive({})
const templateErrors = reactive({})
const templateNotices = reactive({})
const templatePending = reactive({})
const retryAction = ref('load')
let failedTemplatePurpose = ''
let failedTemplateDraft
let failedPromptDraft
let templatesVersion = 0

const publishItems = computed(() => {
  const items = templatesView.value?.items
  return items ? ['publish_managed_new', 'publish_managed_update'].map(k => items[k]).filter(Boolean) : []
})
const shareItems = computed(() => {
  const items = templatesView.value?.items
  return items ? ['share_agent', 'share_platform'].map(k => items[k]).filter(Boolean) : []
})

function effectiveTemplate(item) {
  return item.template ?? item.defaultTemplate
}
function isTemplateCustomized(item) {
  return item.template != null
}
function isTemplateDirty(item) {
  return (templateDrafts[item.purpose] ?? '').trim() !== effectiveTemplate(item).trim()
}
function canSaveTemplate(item) {
  return !templateBusy[item.purpose] && !templateUncertain[item.purpose] && isTemplateDirty(item) && (templateDrafts[item.purpose] ?? '').trim().length > 0
}
function previewTemplate(item) {
  const body = templateDrafts[item.purpose] ?? effectiveTemplate(item)
  if (item.group === 'share') {
    const samples = Object.fromEntries(item.placeholders.map(p => [p.name, p.sample]))
    return renderShareTemplate(body, {
      name: samples.name || '示例应用',
      summary: samples.summary || '',
      url: samples.url || 'https://plaza.example.com/?app=example',
    })
  }
  const samples = Object.fromEntries(item.placeholders.map(p => [p.name, p.sample]))
  return renderTemplate(body, samples)
}

function applyPromptResult(promptResult, expectedDraft) {
  const previousEffective = view.value ? (view.value.template ?? view.value.defaultPrompt) : null
  const nextEffective = promptResult.template ?? promptResult.defaultPrompt
  view.value = promptResult
  if (
    previousEffective === null ||
    draft.value.trim() === previousEffective.trim() ||
    (expectedDraft !== undefined && draft.value === expectedDraft)
  ) {
    draft.value = nextEffective
  }
}

function applyTemplatesResult(result, updatedPurpose = '', expectedDraft = undefined) {
  const prevEffective = Object.fromEntries(
    Object.entries(templatesView.value?.items || {}).map(([purpose, item]) => [purpose, effectiveTemplate(item)]),
  )
  templatesView.value = result
  for (const [purpose, item] of Object.entries(result?.items || {})) {
    const nextValue = effectiveTemplate(item)
    if (
      templateDrafts[purpose] === undefined ||
      templateDrafts[purpose] === prevEffective[purpose] ||
      (purpose === updatedPurpose && expectedDraft !== undefined && templateDrafts[purpose] === expectedDraft)
    ) {
      templateDrafts[purpose] = nextValue
    }
  }
}

async function load() {
  const version = ++requestVersion
  loading.value = true
  error.value = ''
  templatesError.value = ''
  try {
    const [promptSettled, templatesSettled] = await Promise.allSettled([
      apiRequest('/api/access/smart-search-prompt'),
      apiRequest('/api/access/text-templates'),
    ])
    if (version !== requestVersion) return
    if (promptSettled.status === 'fulfilled') {
      retryAction.value = 'load'
      failedPromptDraft = undefined
      applyPromptResult(promptSettled.value)
    } else {
      const err = promptSettled.reason
      if (err?.status === 401 || err?.status === 403) view.value = null
      retryAction.value = 'reload-prompt'
      failedPromptDraft = undefined
      error.value = err?.message || '提示词配置加载失败，请稍后重试。'
    }
    if (templatesSettled.status === 'fulfilled') {
      failedTemplatePurpose = ''
      failedTemplateDraft = undefined
      applyTemplatesResult(templatesSettled.value)
    } else {
      const err = templatesSettled.reason
      if (err?.status === 401 || err?.status === 403) templatesView.value = null
      failedTemplatePurpose = ''
      failedTemplateDraft = undefined
      templatesError.value = err?.message || '模板配置加载失败，请稍后重试。'
    }
  } finally {
    if (version === requestVersion) loading.value = false
  }
}

async function reloadSmartSearchPrompt(expectedDraft = undefined) {
  const version = ++requestVersion
  error.value = ''
  try {
    const promptResult = await apiRequest('/api/access/smart-search-prompt')
    if (version !== requestVersion) return
    retryAction.value = 'load'
    failedPromptDraft = undefined
    applyPromptResult(promptResult, expectedDraft)
  } catch (err) {
    if (version === requestVersion) {
      if (err.status === 401 || err.status === 403) view.value = null
      retryAction.value = 'reload-prompt'
      failedPromptDraft = expectedDraft
      error.value = err.message || '提示词配置加载失败，请稍后重试。'
    }
  }
}

async function reloadTemplates(updatedPurpose = '', expectedDraft = undefined) {
  const version = ++templatesVersion
  templatesError.value = ''
  try {
    const result = await apiRequest('/api/access/text-templates')
    if (version !== templatesVersion) return
    failedTemplatePurpose = ''
    failedTemplateDraft = undefined
    applyTemplatesResult(result, updatedPurpose, expectedDraft)
  } catch (err) {
    if (version === templatesVersion) {
      failedTemplatePurpose = updatedPurpose
      failedTemplateDraft = expectedDraft
      templatesError.value = err.message || '模板配置加载失败，请稍后重试。'
    }
  }
}

function retryTopError() {
  if (pending) {
    void write(pending.template)
    return
  }
  if (retryAction.value === 'reload-prompt') {
    void reloadSmartSearchPrompt(failedPromptDraft)
    return
  }
  void load()
}

async function write(template) {
  if (busy.value) return
  if (!pending) {
    if (uncertain.value) return
    const requestId = uuid()
    if (!requestId) {
      error.value = '当前浏览器无法生成安全请求标识，请更换现代浏览器或通过 HTTPS 访问后再保存。'
      return
    }
    pending = { requestId, confirmed: true, template }
  }
  const request = pending
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const draftAtSave = draft.value
    await apiRequest('/api/access/smart-search-prompt', { method: 'PUT', body: request })
    pending = null
    uncertain.value = false
    notice.value = request.template === null ? '已恢复默认提示词，后续检索立即使用默认模板。' : '提示词已保存，后续检索立即生效。'
    await reloadSmartSearchPrompt(draftAtSave)
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
  if (busy.value || uncertain.value || !customized.value) return
  try {
    await ElMessageBox.confirm('恢复默认提示词后，自定义内容将被清除，后续检索立即使用默认模板。', '恢复默认', {
      confirmButtonText: '恢复默认', cancelButtonText: '取消', type: 'warning',
    })
  } catch { return }
  await write(null)
}

async function writeTemplate(purpose, template) {
  if (templateBusy[purpose]) return
  if (!templatePending[purpose]) {
    if (templateUncertain[purpose]) return
    const requestId = uuid()
    if (!requestId) {
      templateErrors[purpose] = '当前浏览器无法生成安全请求标识，请更换现代浏览器或通过 HTTPS 访问后再保存。'
      return
    }
    templatePending[purpose] = { requestId, confirmed: true, purpose, template }
  }
  const request = templatePending[purpose]
  templateBusy[purpose] = true
  templateErrors[purpose] = ''
  templateNotices[purpose] = ''
  try {
    const draftAtSave = templateDrafts[purpose]
    await apiRequest('/api/access/text-templates', { method: 'PUT', body: request })
    delete templatePending[purpose]
    templateUncertain[purpose] = false
    templateNotices[purpose] = request.template === null ? '已恢复默认模板，后续操作立即使用默认内容。' : '模板已保存，后续操作立即生效。'
    if (purpose === 'share_agent' || purpose === 'share_platform') void loadShareTemplates(true, { bypassInFlight: true })
    await reloadTemplates(purpose, draftAtSave)
  } catch (err) {
    const isUncertain = !err.status || err.status >= 500
    templateUncertain[purpose] = isUncertain
    if (isUncertain) {
      templateErrors[purpose] = '保存结果尚未确认。可重试同一请求，或刷新后核对当前模板。'
    } else {
      delete templatePending[purpose]
      templateErrors[purpose] = err.message || '保存未完成，请稍后重试。'
    }
  } finally {
    templateBusy[purpose] = false
  }
}

async function saveTemplate(purpose) {
  const item = templatesView.value?.items?.[purpose]
  if (!item || !canSaveTemplate(item)) return
  await writeTemplate(purpose, templateDrafts[purpose].trim())
}

async function resetTemplate(purpose) {
  const item = templatesView.value?.items?.[purpose]
  if (!item || templateBusy[purpose] || templateUncertain[purpose] || !isTemplateCustomized(item)) return
  try {
    await ElMessageBox.confirm('恢复默认模板后，自定义内容将被清除，后续操作立即使用默认内容。', '恢复默认', {
      confirmButtonText: '恢复默认', cancelButtonText: '取消', type: 'warning',
    })
  } catch { return }
  await writeTemplate(purpose, null)
}

onMounted(load)
</script>

<template>
  <main class="prompt-admin" aria-labelledby="prompt-title">
    <header class="page-head">
      <div>
        <div class="eyebrow">管理中心 <span>·</span> 提示词与模板</div>
        <h1 id="prompt-title">提示词与模板</h1>
        <p>统一维护智能查找系统提示词、发布提示词与应用分享模板；修改后立即生效，并记入操作审计。</p>
      </div>
    </header>

    <div v-if="error || (uncertain && !busy)" class="state error" role="alert"><span>{{ error || '保存结果尚未确认。可重试同一请求，或刷新后核对当前提示词。' }}</span><button type="button" :disabled="busy" @click="retryTopError">{{ uncertain ? '重试同一请求' : '重试' }}</button></div>
    <div v-if="templatesError" class="state error" role="alert"><span>{{ templatesError }}</span><button type="button" @click="reloadTemplates(failedTemplatePurpose, failedTemplateDraft)">重试</button></div>
    <div v-if="loading && !view && !templatesView" class="state" role="status">正在读取提示词与模板配置…</div>

    <el-tabs v-if="view || templatesView" v-model="activeTab" class="template-tabs">
      <el-tab-pane label="智能查找提示词" name="smart-search">
        <div v-if="notice" class="state ok" role="status">{{ notice }}</div>
        <section v-if="view" class="panel editor" aria-label="提示词编辑">
          <div class="editor-head">
            <div>
              <h2>系统提示词</h2>
              <p>提示词决定智能查找如何理解任务与写出推荐理由；无可用变量，直接书写规则。</p>
            </div>
            <div class="editor-head-right">
              <span class="status-chip" :class="{ custom: customized }">{{ customized ? `已自定义 · ${formatDateTime(view.updatedAt)}` : '使用默认' }}</span>
              <div class="editor-actions">
                <el-button :disabled="!customized || busy || uncertain" data-testid="prompt-reset" @click="resetDefault">恢复默认</el-button>
                <el-button type="primary" :disabled="!canSave" data-testid="prompt-save" @click="save">{{ busy ? '正在保存…' : '保存模板' }}</el-button>
              </div>
            </div>
          </div>
          <el-input
            v-model="draft"
            type="textarea"
            :rows="16"
            :disabled="busy || uncertain"
            :maxlength="view.limit"
            show-word-limit
            resize="vertical"
            spellcheck="false"
            aria-label="系统提示词模板正文"
            data-testid="prompt-editor"
          />
          <p class="hint">服务端输出校验始终生效：推荐只允许候选内应用、最多 3 项、失败自动降级为关键词检索；提示词只影响推荐质量，不影响权限与数据范围。</p>
        </section>
        <div v-else class="state" role="status">智能查找提示词暂未加载，请点击上方重试按钮。</div>
      </el-tab-pane>

      <el-tab-pane label="发布提示词" name="publish">
        <div v-if="templatesView" class="template-stack">
          <section v-for="item in publishItems" :key="item.purpose" class="panel editor" :aria-label="item.label">
            <div class="editor-head">
              <div>
                <h2>{{ item.label }}</h2>
                <p>{{ item.description }}</p>
              </div>
              <div class="editor-head-right">
                <span class="tpl-status-chip" :class="{ custom: isTemplateCustomized(item) }">
                  {{ isTemplateCustomized(item) ? `已自定义 · ${formatDateTime(item.updatedAt)}` : '使用默认' }}
                </span>
                <div class="editor-actions">
                  <el-button :disabled="!isTemplateCustomized(item) || templateBusy[item.purpose] || Boolean(templateUncertain[item.purpose])" :data-testid="`template-reset-${item.purpose}`" @click="resetTemplate(item.purpose)">恢复默认</el-button>
                  <el-button type="primary" :disabled="!canSaveTemplate(item)" :data-testid="`template-save-${item.purpose}`" @click="saveTemplate(item.purpose)">{{ templateBusy[item.purpose] ? '正在保存…' : '保存模板' }}</el-button>
                </div>
              </div>
            </div>
            <div v-if="templateErrors[item.purpose]" class="state error" role="alert">
              <span>{{ templateErrors[item.purpose] }}</span>
              <button v-if="templatePending[item.purpose]" type="button" :disabled="Boolean(templateBusy[item.purpose])" @click="writeTemplate(item.purpose, templatePending[item.purpose].template)">重试同一请求</button>
            </div>
            <div v-if="templateNotices[item.purpose]" class="state ok" role="status">{{ templateNotices[item.purpose] }}</div>
            <el-input
              v-model="templateDrafts[item.purpose]"
              type="textarea"
              :rows="12"
              :disabled="Boolean(templateBusy[item.purpose] || templateUncertain[item.purpose])"
              :maxlength="item.limit"
              show-word-limit
              resize="vertical"
              spellcheck="false"
              :aria-label="item.label"
              :data-testid="`template-editor-${item.purpose}`"
            />
            <div class="placeholders-box">
              <strong>可用占位符</strong>
              <div class="placeholder-list">
                <span v-for="ph in item.placeholders" :key="ph.name" class="placeholder-item">
                  <code>{{ `\{\{${ph.name}\}\}` }}</code>
                  <span>{{ ph.description }}</span>
                </span>
              </div>
            </div>
            <details class="template-preview">
              <summary>渲染预览（按示例参数展开）</summary>
              <pre>{{ previewTemplate(item) }}</pre>
            </details>
          </section>
        </div>
        <div v-else class="state" role="status">发布提示词暂未加载，请点击上方重试按钮。</div>
      </el-tab-pane>

      <el-tab-pane label="应用分享模板" name="share">
        <div v-if="templatesView" class="template-stack">
          <section v-for="item in shareItems" :key="item.purpose" class="panel editor" :aria-label="item.label">
            <div class="editor-head">
              <div>
                <h2>{{ item.label }}</h2>
                <p>{{ item.description }}</p>
              </div>
              <div class="editor-head-right">
                <span class="tpl-status-chip" :class="{ custom: isTemplateCustomized(item) }">
                  {{ isTemplateCustomized(item) ? `已自定义 · ${formatDateTime(item.updatedAt)}` : '使用默认' }}
                </span>
                <div class="editor-actions">
                  <el-button :disabled="!isTemplateCustomized(item) || templateBusy[item.purpose] || Boolean(templateUncertain[item.purpose])" :data-testid="`template-reset-${item.purpose}`" @click="resetTemplate(item.purpose)">恢复默认</el-button>
                  <el-button type="primary" :disabled="!canSaveTemplate(item)" :data-testid="`template-save-${item.purpose}`" @click="saveTemplate(item.purpose)">{{ templateBusy[item.purpose] ? '正在保存…' : '保存模板' }}</el-button>
                </div>
              </div>
            </div>
            <div v-if="templateErrors[item.purpose]" class="state error" role="alert">
              <span>{{ templateErrors[item.purpose] }}</span>
              <button v-if="templatePending[item.purpose]" type="button" :disabled="Boolean(templateBusy[item.purpose])" @click="writeTemplate(item.purpose, templatePending[item.purpose].template)">重试同一请求</button>
            </div>
            <div v-if="templateNotices[item.purpose]" class="state ok" role="status">{{ templateNotices[item.purpose] }}</div>
            <el-input
              v-model="templateDrafts[item.purpose]"
              type="textarea"
              :rows="4"
              :disabled="Boolean(templateBusy[item.purpose] || templateUncertain[item.purpose])"
              :maxlength="item.limit"
              show-word-limit
              resize="vertical"
              spellcheck="false"
              :aria-label="item.label"
              :data-testid="`template-editor-${item.purpose}`"
            />
            <div class="placeholders-box">
              <strong>可用占位符</strong>
              <div class="placeholder-list">
                <span v-for="ph in item.placeholders" :key="ph.name" class="placeholder-item">
                  <code>{{ `\{\{${ph.name}\}\}` }}</code>
                  <span>{{ ph.description }}</span>
                </span>
              </div>
            </div>
            <div class="template-preview static">
              <strong>复制效果预览</strong>
              <pre>{{ previewTemplate(item) }}</pre>
            </div>
          </section>
        </div>
        <div v-else class="state" role="status">应用分享模板暂未加载，请点击上方重试按钮。</div>
      </el-tab-pane>
    </el-tabs>
  </main>
</template>

<style scoped>
.prompt-admin { display: flex; flex-direction: column; gap: 14px; padding: 26px 32px; overflow-y: auto; color: var(--plaza-ink); }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.eyebrow { margin: 0 0 6px; color: var(--plaza-muted); font-size: 12px; letter-spacing: .06em; }
.eyebrow span { color: var(--plaza-line); }
.page-head h1 { margin: 0; font-size: 24px; font-weight: 680; letter-spacing: -.02em; }
.page-head p { margin: 6px 0 0; color: var(--plaza-muted); font-size: 13px; }
.template-tabs :deep(.el-tabs__content) { overflow: visible; }
.template-stack { display: flex; flex-direction: column; gap: 16px; }
.status-chip, .tpl-status-chip { flex: none; padding: 4px 12px; border: 1px solid var(--plaza-line); border-radius: 999px; background: var(--plaza-surface); color: var(--plaza-muted); font-size: 12px; white-space: nowrap; }
.status-chip.custom, .tpl-status-chip.custom { border-color: var(--plaza-brand); color: var(--plaza-brand); background: var(--plaza-brand-soft); }
.panel { padding: 20px; border: 1px solid var(--plaza-line); border-radius: 14px; background: var(--plaza-surface); }
.editor-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
.editor-head h2 { margin: 0; font-size: 15px; font-weight: 650; }
.editor-head p { margin: 5px 0 0; color: var(--plaza-muted); font-size: 12px; }
.editor-head-right { display: flex; flex: none; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 10px; }
.editor-actions { display: flex; flex: none; gap: 8px; }
.hint { margin: 10px 0 0; color: var(--plaza-muted); font-size: 11.5px; line-height: 1.7; }
.state { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; padding: 10px 14px; border-radius: 10px; font-size: 13px; }
.state.error { border: 1px solid #f3c6c6; background: #fdf1f1; color: #8f3030; }
.state.ok { border: 1px solid #cfe3cf; background: #f1f8f1; color: #2f6b3a; }
.state button { flex: none; padding: 4px 10px; border: 1px solid currentColor; border-radius: 8px; background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer; }
.placeholders-box { margin-top: 12px; padding: 10px 12px; border-radius: 9px; background: var(--plaza-canvas); font-size: 12px; }
.placeholders-box strong { display: block; margin-bottom: 6px; color: var(--plaza-ink); font-weight: 600; }
.placeholder-list { display: flex; flex-wrap: wrap; gap: 8px 16px; }
.placeholder-item { display: inline-flex; align-items: center; gap: 6px; color: var(--plaza-muted); }
.placeholder-item code { padding: 1px 6px; border-radius: 5px; background: var(--plaza-surface); border: 1px solid var(--plaza-line); color: var(--plaza-brand); font-family: Consolas, monospace; font-size: 11.5px; }
.template-preview { margin-top: 10px; padding: 10px 12px; border: 1px solid var(--plaza-line); border-radius: 9px; background: var(--plaza-surface); font-size: 12px; }
.template-preview summary { cursor: pointer; color: var(--plaza-brand); font-weight: 500; }
.template-preview.static strong { display: block; margin-bottom: 6px; color: var(--plaza-ink); font-weight: 600; }
.template-preview pre { margin: 8px 0 0; max-height: 220px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.6 Consolas, "Microsoft YaHei", sans-serif; color: var(--plaza-text); }
@media (max-width: 760px) { .prompt-admin { padding: 18px 14px; } .editor-head { flex-direction: column; } .editor-head-right { justify-content: flex-start; } }
</style>
