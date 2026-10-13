<script setup>
import { computed } from 'vue'

const props = defineProps({
  app: { type: Object, required: true },
})

const emit = defineEmits(['read-documents', 'read-source'])

const manifest = computed(() => props.app?.manifest || {})
const capabilities = computed(() => manifest.value.capabilities || {})
const tags = computed(() => Array.isArray(manifest.value.tags) ? manifest.value.tags : [])
const maintainers = computed(() => {
  const values = manifest.value.maintainers
  return Array.isArray(values) ? values : values ? [values] : []
})
const maintainerLabel = computed(() => maintainers.value.map((value) => {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  return typeof value.name === 'string' ? value.name : ''
}).filter(Boolean).join('、') || '未登记')
const scenarios = computed(() => toList(capabilities.value.scenarios))
const visibleScenarios = computed(() => scenarios.value.slice(0, 3))
const requirements = computed(() => toList(manifest.value.requirements))
const limitations = computed(() => toList(manifest.value.limitations))
const visibleRequirements = computed(() => requirements.value.slice(0, 2))
const visibleLimitations = computed(() => limitations.value.slice(0, 2))
const hiddenConditionCount = computed(() => Math.max(0, requirements.value.length - 2) + Math.max(0, limitations.value.length - 2))
const useSteps = computed(() => {
  const entries = Array.isArray(manifest.value.entries) ? manifest.value.entries : []
  const kinds = new Set(entries.map((entry) => entry?.kind).filter(Boolean))
  const hasAgent = kinds.has('agent')
  const hasWeb = kinds.has('web')

  if (hasAgent && hasWeb) {
    return [
      '复制右侧接入提示词，交给 Agent；也可直接打开平台入口。',
      'Agent 按作者说明完成接入验证。',
      '提供任务并核对执行结果。',
    ]
  }
  if (hasAgent) {
    return [
      '复制右侧接入提示词，交给你的 Agent。',
      'Agent 按作者说明完成接入与验证。',
      '提供任务并核对执行结果。',
    ]
  }
  if (hasWeb) {
    return [
      '打开右侧平台入口。',
      '准备当前任务所需材料。',
      '执行任务并核对结果。',
    ]
  }
  return []
})

function toList(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined && item !== '')
  if (typeof value === 'string' && value.trim()) return [value]
  return []
}

function labelOf(value) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return String(value ?? '')
  return value.name || value.displayName || value.label || ''
}

function formatDate(value) {
  if (!value) return '未登记'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return String(value)
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(parsed)
}

function formatVersion(value) {
  if (value === null || value === undefined || value === '') return ''
  const version = String(value)
  return /^\d/.test(version) ? `v${version}` : version
}
</script>

<template>
  <article class="detail-overview">
    <header class="overview-hero">
      <div class="overview-title-row">
        <h2>{{ manifest.name || '未命名应用' }}</h2>
        <span v-if="app.version" class="overview-version">{{ formatVersion(app.version) }}</span>
      </div>
      <p class="overview-summary">{{ manifest.summary || '暂无应用简介。' }}</p>
      <div v-if="tags.length" class="overview-tags" aria-label="应用标签">
        <span v-for="tag in tags" :key="tag">{{ tag }}</span>
      </div>
      <div class="overview-meta">
        <span class="overview-author" data-testid="detail-author">作者：{{ maintainerLabel }}</span>
        <span class="overview-dates">
          <time :datetime="app.createdAt || undefined">创建于 {{ formatDate(app.createdAt) }}</time>
          <time :datetime="app.updatedAt || undefined">更新于 {{ formatDate(app.updatedAt) }}</time>
        </span>
      </div>
    </header>

    <section v-if="visibleScenarios.length" class="overview-section">
      <h3>主要用途</h3>
      <ul class="overview-use-list">
        <li v-for="(scenario, index) in visibleScenarios" :key="index">{{ labelOf(scenario) }}</li>
      </ul>
      <p v-if="scenarios.length > visibleScenarios.length" class="overview-hidden-hint">
        另有 {{ scenarios.length - visibleScenarios.length }} 项用途，
        <button type="button" @click="emit('read-documents')">查看完整资料</button>
      </p>
    </section>

    <section v-if="requirements.length || limitations.length" class="overview-conditions">
      <div v-if="visibleRequirements.length" class="overview-condition-line">
        <strong>使用条件</strong>
        <span>{{ visibleRequirements.map(labelOf).join('；') }}</span>
      </div>
      <div v-if="visibleLimitations.length" class="overview-condition-line">
        <strong>重要边界</strong>
        <span>{{ visibleLimitations.map(labelOf).join('；') }}</span>
      </div>
      <p v-if="hiddenConditionCount" class="overview-hidden-hint">
        另有 {{ hiddenConditionCount }} 项条件或边界，
        <button type="button" @click="emit('read-documents')">查看全部</button>
      </p>
    </section>

    <section v-if="useSteps.length" class="overview-section overview-steps-section">
      <h3>开始使用</h3>
      <ol class="overview-steps">
        <li v-for="(step, index) in useSteps" :key="index">
          <span>{{ index + 1 }}</span>
          <p>{{ step }}</p>
        </li>
      </ol>
    </section>

    <footer class="overview-reading-links">
      <button type="button" data-testid="read-full-docs" @click="emit('read-documents')">阅读完整应用资料</button>
      <button type="button" class="secondary" data-testid="read-source" @click="emit('read-source')">来源与版本</button>
    </footer>
  </article>
</template>

<style scoped>
.detail-overview { min-width: 0; color: #273449; }
.overview-hero { padding: 2px 0 16px; border-bottom: 1px solid #e8ebf0; }
.overview-title-row { display: flex; min-width: 0; align-items: flex-start; justify-content: space-between; gap: 12px; }
.overview-title-row h2 { min-width: 0; margin: 0; color: #1f2c3d; font-size: 22px; font-weight: 650; line-height: 1.4; overflow-wrap: anywhere; }
.overview-version { flex: none; margin-top: 3px; padding: 3px 8px; border: 1px solid #d9e1ee; border-radius: 5px; background: #f5f8fc; color: #526c91; font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
.overview-summary { margin: 8px 0 10px; color: #536174; font-size: 13px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.overview-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.overview-tags span { max-width: 100%; padding: 3px 8px; border: 1px solid #e4e8ee; border-radius: 4px; background: #fafbfc; color: #667386; font-size: 12px; overflow-wrap: anywhere; }
.overview-meta { display: flex; min-width: 0; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 14px; margin-top: 11px; color: #8993a2; font-size: 12px; }
.overview-author { min-width: 0; color: #53657b; overflow-wrap: anywhere; }
.overview-dates { display: flex; min-width: 0; flex-wrap: wrap; gap: 4px 13px; }
.overview-section { min-width: 0; margin-top: 17px; }
.overview-section h3 { margin: 0 0 8px; color: #2b394c; font-size: 14px; font-weight: 650; }
.overview-use-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; color: #536174; font-size: 13px; line-height: 1.6; }
.overview-use-list li { position: relative; min-width: 0; padding-left: 14px; overflow-wrap: anywhere; }
.overview-use-list li::before { position: absolute; left: 2px; color: #7892bb; content: '·'; font-weight: 700; }
.overview-conditions { display: grid; gap: 6px; min-width: 0; margin-top: 15px; padding: 10px 12px; border-radius: 6px; background: #f7f9fc; color: #536174; font-size: 12px; line-height: 1.65; }
.overview-condition-line { display: grid; grid-template-columns: 68px minmax(0, 1fr); gap: 8px; min-width: 0; }
.overview-condition-line strong { color: #475873; font-weight: 550; }
.overview-condition-line span { min-width: 0; overflow-wrap: anywhere; }
.overview-hidden-hint { margin: 1px 0 0; color: #7b8798; font-size: 10px; }
.overview-hidden-hint button { padding: 0; border: 0; background: transparent; color: #315fbd; font: inherit; cursor: pointer; }
.overview-hidden-hint button:hover { text-decoration: underline; text-underline-offset: 2px; }
.overview-steps-section { margin-top: 16px; }
.overview-steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 0; padding: 0; list-style: none; }
.overview-steps li { display: flex; min-width: 0; align-items: flex-start; gap: 7px; color: #55647a; font-size: 12px; line-height: 1.55; }
.overview-steps li > span { display: grid; width: 20px; height: 20px; flex: none; place-items: center; border-radius: 50%; background: #edf2fb; color: #496eae; font-size: 10px; }
.overview-steps p { min-width: 0; margin: 1px 0 0; overflow-wrap: anywhere; }
.overview-reading-links { display: flex; flex-wrap: wrap; gap: 9px 18px; margin-top: 16px; padding-top: 12px; border-top: 1px solid #e8ebf0; }
.overview-reading-links button { padding: 0; border: 0; background: transparent; color: #315fbd; font: inherit; font-size: 11px; line-height: 1.6; cursor: pointer; }
.overview-reading-links button.secondary { color: #778395; }
.overview-reading-links button:hover { text-decoration: underline; text-underline-offset: 3px; }
@media (max-width: 900px) {
  .overview-steps { grid-template-columns: 1fr; gap: 7px; }
}
@media (max-width: 620px) {
  .overview-title-row h2 { font-size: 19px; }
  .overview-meta { justify-content: flex-start; }
}
</style>
