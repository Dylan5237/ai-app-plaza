<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElButton, ElInput } from 'element-plus'
import CatalogCard from './CatalogCard.vue'
import PlazaIcon from './PlazaIcon.vue'
import { apiRequest } from '../lib/api.js'

const props = defineProps({ active: { type: Boolean, default: true } })
const emit = defineEmits(['detail', 'primary', 'tag', 'return', 'results'])

const task = ref('')
const messages = ref([])
const searching = ref(false)
const expandedOthers = ref({})
const thread = ref(null)
const input = ref(null)
let searchToken = 0
let savedThreadScroll = 0

const submittedTask = computed(() => [...messages.value].reverse().find(message => message.kind === 'user')?.text ?? '')
const hasResults = () => messages.value.some(m => m.kind === 'results' || m.kind === 'empty')
// Only an actual unsubmitted draft marks the visible results as the previous round;
// the cleared composer right after a submit is not a draft.
const draftDirty = () => hasResults() && task.value.trim() !== '' && task.value.trim() !== submittedTask.value
const activeResultsIndex = computed(() => {
  for (let index = messages.value.length - 1; index >= 0; index--) if (messages.value[index].kind === 'results') return index
  return -1
})

function scrollBottom() {
  void nextTick(() => { if (thread.value) thread.value.scrollTop = thread.value.scrollHeight })
}

function newConversation() {
  searchToken++
  messages.value = []
  task.value = ''
  searching.value = false
  expandedOthers.value = {}
}

async function runSearch(text) {
  const token = ++searchToken
  searching.value = true
  scrollBottom()
  try {
    const params = new URLSearchParams({ query: text })
    const result = await apiRequest(`/api/apps/smart-search?${params}`)
    if (token !== searchToken) return
    searching.value = false
    if (!result.items?.length) {
      messages.value.push({ kind: 'empty', taskSummary: text })
      emit('results', [])
    } else {
      messages.value.push({
        kind: 'results', taskSummary: text,
        candidates: result.items.map(item => ({ app: item, matched: result.matches?.[item.id] || [] })),
      })
      emit('results', result.items)
    }
    scrollBottom()
  } catch (error) {
    if (token !== searchToken) return
    searching.value = false
    messages.value.push({ kind: 'error', taskSummary: text, message: error.message || '检索暂时不可用，请重试。' })
    scrollBottom()
  }
}

function submit() {
  const text = task.value.trim()
  if (!text || searching.value) return
  messages.value.push({ kind: 'user', text })
  task.value = ''
  void runSearch(text)
}

function onEnter(event) {
  // The Enter that commits an IME composition must not submit the half-typed task.
  if (event.isComposing) return
  submit()
}

function cancelSearch() {
  searchToken++
  searching.value = false
  scrollBottom()
}

function editTask(text) {
  task.value = text
  void nextTick(() => input.value?.focus())
}

function toggleOthers(index) {
  expandedOthers.value = { ...expandedOthers.value, [index]: !expandedOthers.value[index] }
}

// v-show switches destroy the thread's scroll position; save it on leaving and restore
// on returning, covering tab switches, detail round trips and plaza overlays.
watch(() => props.active, active => {
  if (!active) { savedThreadScroll = thread.value?.scrollTop ?? 0; return }
  void nextTick(() => { if (thread.value) thread.value.scrollTop = savedThreadScroll })
})

// Results can age while the page is in the background (access revoked, app taken
// offline). Revalidate the active round on focus like the random wheel does.
async function revalidateResults() {
  const index = activeResultsIndex.value
  const message = messages.value[index]
  if (!props.active || !message || message.kind !== 'results' || !message.candidates.length) return
  const checked = await Promise.allSettled(message.candidates.map(candidate => apiRequest(`/api/apps/${encodeURIComponent(candidate.app.id)}`)))
  if (messages.value[activeResultsIndex.value] !== message) return
  let dropped = false
  const candidates = []
  for (const [position, result] of checked.entries()) {
    const candidate = message.candidates[position]
    if (result.status === 'fulfilled') candidates.push({ ...candidate, app: { ...candidate.app, ...result.value, documents: {} } })
    else if ([403, 404].includes(result.reason?.status)) dropped = true
    else candidates.push(candidate)
  }
  if (!dropped) return
  if (!candidates.length) messages.value[index] = { kind: 'empty', taskSummary: message.taskSummary }
  else message.candidates = candidates
  emit('results', candidates.map(candidate => candidate.app))
}

onMounted(() => window.addEventListener('focus', revalidateResults))
onUnmounted(() => window.removeEventListener('focus', revalidateResults))
</script>

<template>
  <section class="smart-search" aria-label="智能查找">
    <div class="smart-head">
      <div class="smart-title"><h1>智能查找</h1><p>说说你要完成的工作，好用的应用就在对话里。</p></div>
      <div class="smart-actions"><el-button text @click="newConversation">新对话</el-button></div>
    </div>

    <div ref="thread" class="thread" role="region" aria-label="对话记录">
      <div v-if="!messages.length" class="empty-hero">
        <span class="hero-mark"><PlazaIcon name="agent" /></span>
        <h2>你想完成什么工作？</h2>
        <p>直接描述任务和已有材料，不用先知道工具名称。</p>
      </div>

      <template v-for="(m, i) in messages" :key="i">
        <div v-if="m.kind === 'user'" class="msg user"><p>{{ m.text }}</p></div>

        <div v-else-if="m.kind === 'error'" class="msg assistant">
          <div class="msg-label"><small>广场助手</small></div>
          <p class="msg-text">{{ m.message }}</p>
          <div class="inline-actions"><el-button text size="small" @click="runSearch(m.taskSummary)">重试</el-button><el-button text size="small" @click="emit('return')">回到目录</el-button></div>
        </div>

        <div v-else-if="m.kind === 'empty'" class="msg assistant" :class="{ stale: draftDirty() && i === messages.length - 1 }">
          <div class="msg-label"><small>广场助手</small></div>
          <p class="msg-text">当前可见的上架应用中没有匹配结果。可以调整任务描述，或回到目录按标签浏览。</p>
          <div class="inline-actions"><span v-if="draftDirty() && i === messages.length - 1" class="stale-tag">上一轮结果</span><el-button text size="small" @click="editTask(m.taskSummary)">调整描述</el-button><el-button text size="small" @click="emit('return')">回到目录</el-button></div>
        </div>

        <div v-else-if="m.kind === 'results'" class="msg assistant results" :class="{ stale: draftDirty() && i === messages.length - 1 }" :data-active="i === activeResultsIndex ? 'true' : null">
          <div class="msg-label"><small>广场助手</small></div>
          <el-alert title="尚未接入智能服务，当前为基础检索：按关键词匹配，不代表对任务的理解。" type="info" :closable="false" show-icon class="basic-banner" />
          <div class="result-context">
            <span class="result-task">{{ m.taskSummary }}</span>
            <span v-if="draftDirty() && i === messages.length - 1" class="stale-tag">上一轮结果</span>
            <el-button text size="small" @click="editTask(m.taskSummary)">修改需求</el-button>
          </div>
          <div class="recommendations">
            <template v-for="(c, ci) in m.candidates" :key="c.app.id">
              <div v-if="ci === 0 || expandedOthers[i]" class="recommendation">
                <CatalogCard :app="c.app" @detail="emit('detail', $event)" @primary="emit('primary', $event)" @tag="emit('tag', $event)" />
                <div class="rec-reason">
                  <div class="reason-block">
                    <strong>为什么出现</strong>
                    <p v-if="c.matched.length">命中：{{ c.matched.join('、') }}。</p>
                    <p>{{ c.app.manifest?.summary || '暂无应用简介。' }}</p>
                  </div>
                  <p class="reason-hint">适用条件、入口与版本以详情为准；推荐不代表效果承诺。</p>
                </div>
              </div>
            </template>
          </div>
          <el-button v-if="m.candidates.length > 1" text class="others-toggle" @click="toggleOthers(i)">
            {{ expandedOthers[i] ? '收起其他匹配应用' : `其他匹配应用（${m.candidates.length - 1}）` }}
          </el-button>
        </div>
      </template>

      <div v-if="searching" class="msg assistant searching">
        <div class="msg-label"><small>广场助手</small></div>
        <p class="msg-text">正在检索适用应用… <el-button text size="small" @click="cancelSearch">取消</el-button></p>
      </div>
    </div>

    <div class="composer">
      <div class="composer-row">
        <el-input ref="input" v-model="task" class="composer-input" maxlength="200" placeholder="描述目标、已有材料与必要条件" aria-label="描述你想完成的任务" clearable @keydown.enter="onEnter" />
        <el-button type="primary" class="composer-send" :disabled="!task.trim() || searching" @click="submit()">发送</el-button>
      </div>
      <p class="composer-hint">输入会用于站内检索；不会上传到外部服务。</p>
    </div>
  </section>
</template>

<style scoped>
.smart-search { display: flex; flex-direction: column; height: 100%; min-height: 0; padding: 26px 32px 16px; }
.smart-head { display: flex; flex: none; align-items: flex-start; justify-content: space-between; gap: 16px; margin: 2px 0 18px; padding-bottom: 18px; border-bottom: 1px solid var(--plaza-line); }
.smart-title h1 { margin: 0; font-size: 27px; font-weight: 680; letter-spacing: -.025em; color: var(--plaza-ink); }
.smart-title p { margin: 7px 0 0; color: var(--plaza-muted); font-size: 12.5px; line-height: 20px; }
.smart-actions { display: flex; flex: none; align-items: center; }
.thread { display: flex; flex: 1; flex-direction: column; min-height: 0; overflow-y: auto; overscroll-behavior: contain; width: 100%; max-width: 1080px; margin: 0 auto; padding: 12px 8px; }
.empty-hero { margin: auto; padding: 32px 0; text-align: center; }
.hero-mark { display: grid; width: 58px; height: 58px; margin: 0 auto; place-items: center; border-radius: 18px; background: var(--plaza-brand-soft); color: var(--plaza-brand); }
.hero-mark :deep(svg) { width: 28px; height: 28px; }
.empty-hero h2 { margin: 18px 0 10px; font-size: 23px; color: var(--plaza-ink); }
.empty-hero p { margin: 0; color: var(--plaza-muted); font-size: 13px; }
.msg { flex: none; width: 100%; min-width: 0; padding: 14px 0; margin-bottom: 12px; }
.msg.user { width: fit-content; max-width: 85%; margin-left: auto; padding: 12px 18px; border-radius: 14px 14px 4px 14px; background: var(--plaza-brand-soft); }
.msg.user p { margin: 0; color: var(--plaza-ink); font-size: 14px; line-height: 1.7; overflow-wrap: anywhere; }
.msg-label { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; color: var(--plaza-muted); }
.msg-label small { font-size: 11px; }
.msg-text { margin: 5px 0; color: var(--plaza-text); font-size: 14px; line-height: 1.8; overflow-wrap: anywhere; }
.inline-actions { display: flex; gap: 4px; margin-top: 8px; }
.basic-banner { margin-bottom: 10px; }
.result-context { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 4px 0 10px; padding: 8px 12px; border: 1px solid var(--plaza-line); border-radius: 10px; background: var(--plaza-canvas); }
.results.stale .result-context { opacity: .6; }
.msg.assistant.stale .msg-text { opacity: .6; }
.result-task { color: var(--plaza-ink); font-size: 13px; font-weight: 600; }
.stale-tag { padding: 2px 8px; border: 1px solid var(--plaza-line); border-radius: 999px; color: var(--plaza-muted); font-size: 11px; }
.recommendations { display: grid; gap: 18px; margin-top: 12px; }
.recommendation { --catalog-card-height: 200px; min-width: 0; }
.rec-reason { margin-top: 8px; padding: 14px 16px; border: 1px solid var(--plaza-line); border-radius: 10px; background: var(--plaza-canvas); font-size: 12px; color: var(--plaza-text); line-height: 1.7; }
.reason-block strong { color: var(--plaza-ink); font-size: 12px; }
.reason-block p { margin: 5px 0; }
.reason-hint { margin: 6px 0 0; color: var(--plaza-muted); font-size: 11px; }
.others-toggle { margin-top: 10px; }
.searching .msg-text { color: var(--plaza-muted); }
.composer { flex: none; width: 100%; max-width: 1080px; margin: 16px auto 0; padding-top: 16px; border-top: 1px solid var(--plaza-line); }
.composer-row { display: flex; gap: 8px; }
.composer-input { flex: 1; }
.composer-input :deep(.el-input__wrapper) { min-height: 44px; }
.composer-send { height: 44px; padding: 0 24px; }
.composer-hint { margin: 9px 0 0; color: var(--plaza-muted); font-size: 11px; }
@media (max-width: 760px) {
  .smart-search { padding: 20px 16px 12px; }
  .smart-title h1 { font-size: 24px; line-height: 32px; }
  .composer-send { padding: 0 16px; }
}
</style>
