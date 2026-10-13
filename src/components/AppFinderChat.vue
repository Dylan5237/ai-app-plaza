<script setup>
import { nextTick, ref } from 'vue'
import { apiRequest } from '../lib/api.js'

const open = ref(false)
const busy = ref(false)
const draft = ref('')
const transcript = ref(null)
const inputBox = ref(null)
const messages = ref([{
  role: 'assistant',
  content: '你好！告诉我你想完成什么工作，我会从广场已收录的应用里帮你查找。无需知道应用名称。',
  cards: [],
  mode: 'welcome',
}])
const examples = ['找一个能连接禅道的 MCP 工具', '我想让 AI 处理文档', '哪些应用可以接入我的 Agent？']

async function scrollToEnd() {
  await nextTick()
  if (transcript.value) transcript.value.scrollTop = transcript.value.scrollHeight
}

async function togglePanel() {
  open.value = !open.value
  if (open.value) {
    await nextTick()
    inputBox.value?.focus()
    await scrollToEnd()
  }
}

function clearChat() {
  messages.value = [{
    role: 'assistant',
    content: '已清空本次聊天。描述工作目标，我会重新查找。',
    cards: [],
    mode: 'welcome',
  }]
  draft.value = ''
  void scrollToEnd()
}

async function send(text = draft.value) {
  const message = String(text).trim()
  if (!message || busy.value || message.length > 500) return
  messages.value.push({ role: 'user', content: message, cards: [] })
  draft.value = ''
  busy.value = true
  await scrollToEnd()
  try {
    const history = messages.value.slice(-8).map(item => ({ role: item.role, content: item.content }))
    const result = await apiRequest('/api/app-finder/chat', { method: 'POST', body: { messages: history } })
    messages.value.push({
      role: 'assistant',
      content: result.answer,
      cards: Array.isArray(result.cards) ? result.cards : [],
      mode: result.mode,
      notice: result.notice || '',
    })
  } catch (error) {
    messages.value.push({
      role: 'assistant',
      content: error?.message || '查找暂时失败，可以继续使用网页原有搜索。',
      cards: [],
      mode: 'error',
    })
  } finally {
    busy.value = false
    await scrollToEnd()
    inputBox.value?.focus()
  }
}

function openApp(id) {
  if (!id) return
  const url = new URL(window.location.href)
  url.searchParams.delete('prototype')
  url.searchParams.set('app', id)
  url.hash = ''
  window.location.assign(url.href)
}
</script>

<template>
  <div class="finder-root" data-testid="app-finder">
    <section v-if="open" class="finder-panel" role="dialog" aria-label="查找 AI 应用助手" data-testid="app-finder-panel">
      <header class="finder-header">
        <div class="finder-avatar" aria-hidden="true">✦</div>
        <div class="finder-headline">
          <strong>AI 应用查找助手</strong>
          <span>只推荐广场已确认收录的应用</span>
        </div>
        <button class="finder-icon-button" type="button" aria-label="清空聊天" title="清空聊天" @click="clearChat">↺</button>
        <button class="finder-icon-button" type="button" aria-label="关闭聊天" title="关闭聊天" @click="togglePanel">×</button>
      </header>

      <div ref="transcript" class="finder-messages" role="log" aria-label="对话记录" aria-live="polite">
        <article
          v-for="(item, index) in messages"
          :key="index"
          class="finder-message"
          :class="item.role === 'user' ? 'is-user' : 'is-assistant'"
        >
          <div class="finder-bubble">{{ item.content }}</div>
          <div v-if="item.mode === 'basic' && item.notice" class="finder-mode-note">{{ item.notice }}</div>
          <div v-else-if="item.mode === 'error'" class="finder-mode-note">你也可以使用页面原有搜索框。</div>
          <div v-if="item.cards?.length" class="finder-cards">
            <button
              v-for="card in item.cards"
              :key="card.id"
              class="finder-card"
              type="button"
              :aria-label="'查看' + card.name + '的应用详情'"
              data-testid="app-finder-card"
              @click="openApp(card.id)"
            >
              <span class="finder-card-title">
                <strong>{{ card.name }}</strong>
                <small>{{ card.version }}</small>
              </span>
              <span class="finder-card-summary">{{ card.summary }}</span>
              <span v-if="card.matchedCapability" class="finder-card-capability">适用场景：{{ card.matchedCapability }}</span>
              <span class="finder-card-link">查看应用详情 →</span>
            </button>
          </div>
        </article>
        <div v-if="busy" class="finder-thinking" role="status">正在查找已收录应用…</div>
      </div>

      <div v-if="messages.length === 1" class="finder-examples" aria-label="示例问题">
        <button v-for="example in examples" :key="example" type="button" @click="send(example)">{{ example }}</button>
      </div>

      <form class="finder-form" @submit.prevent="send()">
        <label class="finder-sr-only" for="finder-input">描述你想完成的工作</label>
        <textarea
          id="finder-input"
          ref="inputBox"
          v-model="draft"
          rows="2"
          maxlength="500"
          placeholder="例如：我想让 AI 帮我处理禅道任务…"
          :disabled="busy"
          aria-label="描述你想完成的工作"
          @keydown.enter.exact.prevent="send()"
        />
        <button class="finder-send" type="submit" :disabled="busy || !draft.trim()" data-testid="app-finder-send">发送</button>
      </form>
      <p class="finder-safety">不输入口令、患者信息或敏感资料。推荐结果请以应用详情为准。</p>
    </section>

    <button
      class="finder-launch"
      type="button"
      :aria-expanded="open"
      aria-controls="app-finder-panel"
      data-testid="app-finder-launch"
      @click="togglePanel"
    >
      <span aria-hidden="true">{{ open ? '×' : '✦' }}</span>
      <span>{{ open ? '收起助手' : 'AI 找应用' }}</span>
    </button>
  </div>
</template>

<style scoped>
.finder-root { position: fixed; bottom: 22px; right: 24px; z-index: 100; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; color: #29394e; }
.finder-launch { display: flex; align-items: center; gap: 8px; margin-left: auto; border: 1px solid #274c8b; border-radius: 25px; background: #315fbd; box-shadow: 0 5px 18px rgb(30 58 110 / 17%); color: #fff; padding: 11px 17px; font: 600 13px/1.4 inherit; cursor: pointer; }
.finder-launch > span:first-child { font-size: 19px; line-height: 1; }
.finder-launch:hover { background: #274f9d; }
.finder-panel { display: flex; flex-direction: column; width: min(425px, calc(100vw - 32px)); height: min(630px, calc(100dvh - 110px)); min-height: 290px; margin-bottom: 13px; overflow: hidden; background: #fff; border: 1px solid #dfe5ee; border-radius: 15px; box-shadow: 0 12px 35px rgb(35 53 78 / 16%); }
.finder-header { flex: none; display: flex; align-items: center; gap: 9px; padding: 14px 14px 12px; border-bottom: 1px solid #e9edf3; }
.finder-avatar { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; background: #eef3fc; color: #315fbd; font-size: 21px; }
.finder-headline { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 3px; }
.finder-headline strong { font-size: 14px; }
.finder-headline span { color: #8490a2; font-size: 11px; }
.finder-icon-button { flex: none; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: #8490a2; font-size: 22px; cursor: pointer; }
.finder-icon-button:hover { background: #f2f5f9; color: #405778; }
.finder-messages { flex: 1; min-height: 0; overflow-y: auto; padding: 15px 13px 10px; background: #fbfcfe; overscroll-behavior: contain; }
.finder-message { display: flex; flex-direction: column; align-items: flex-start; margin-bottom: 14px; }
.finder-message.is-user { align-items: flex-end; }
.finder-bubble { max-width: 94%; padding: 10px 12px; border-radius: 11px 11px 11px 3px; background: #eef2f8; color: #3c4b61; font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; white-space: pre-wrap; }
.is-user .finder-bubble { border-radius: 11px 11px 3px 11px; background: #315fbd; color: white; }
.finder-mode-note { margin: 6px 0 0; color: #8994a3; font-size: 11px; line-height: 1.55; }
.finder-cards { display: grid; width: 100%; gap: 7px; margin-top: 9px; }
.finder-card { width: 100%; display: grid; gap: 6px; padding: 11px 12px; background: #fff; border: 1px solid #dce5f0; border-radius: 9px; color: #475972; text-align: left; cursor: pointer; }
.finder-card:hover { border-color: #98b5dc; background: #fafcff; }
.finder-card-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: #293c57; font-size: 13px; }
.finder-card-title small { flex: none; color: #8290a2; font-size: 11px; }
.finder-card-summary { font-size: 12px; line-height: 1.5; }
.finder-card-capability { color: #8190a3; font-size: 11px; line-height: 1.5; }
.finder-card-link { color: #315fbd; font-size: 11px; font-weight: 600; }
.finder-thinking { color: #7c899b; font-size: 12px; padding: 7px; }
.finder-examples { flex: none; display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 11px 0; }
.finder-examples button { border: 1px solid #e0e7f1; border-radius: 14px; background: white; padding: 5px 8px; color: #5d7090; font: inherit; font-size: 11px; cursor: pointer; }
.finder-examples button:hover { border-color: #adbfdb; }
.finder-form { flex: none; display: flex; align-items: flex-end; gap: 7px; padding: 11px 12px 4px; }
.finder-form textarea { flex: 1; width: 100%; min-width: 0; min-height: 54px; max-height: 110px; resize: vertical; border: 1px solid #dce4ed; border-radius: 8px; padding: 9px 10px; outline: none; font: 12px/1.6 inherit; }
.finder-form textarea:focus { border-color: #8faad7; box-shadow: 0 0 0 2px #edf3fc; }
.finder-send { flex: none; border: none; border-radius: 7px; padding: 11px 13px; background: #315fbd; color: white; font-size: 12px; font-weight: 600; cursor: pointer; }
.finder-send:disabled { opacity: .5; cursor: not-allowed; }
.finder-safety { flex: none; padding: 0 13px 10px; margin: 0; color: #9ba4b1; font-size: 10px; line-height: 1.5; }
.finder-launch:focus-visible, .finder-card:focus-visible, .finder-icon-button:focus-visible, .finder-examples button:focus-visible, .finder-send:focus-visible { outline: 3px solid #9ec0ed; outline-offset: 2px; }
.finder-sr-only { position: absolute; width: 1px; height: 1px; clip: rect(0,0,0,0); overflow: hidden; white-space: nowrap; }
@media (max-width: 620px) { .finder-root { bottom: 12px; right: 12px; } .finder-panel { height: min(615px, calc(100dvh - 90px)); } }
</style>
