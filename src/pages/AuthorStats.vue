<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { apiRequest } from '../lib/api.js'

const data = ref(null)
const loading = ref(false)
const error = ref('')
let requestVersion = 0

async function load() {
  const version = ++requestVersion
  loading.value = true
  error.value = ''
  try {
    const result = await apiRequest('/api/access/author-stats')
    if (version === requestVersion) data.value = result
  } catch (err) {
    if (version === requestVersion) {
      if (err.status === 401 || err.status === 403) data.value = null
      error.value = err.message || '应用数据加载失败，请稍后重试。'
    }
  } finally {
    if (version === requestVersion) loading.value = false
  }
}

function clearOnIdentityChange() {
  requestVersion++
  data.value = null
  loading.value = false
  error.value = '身份状态已变化，请重新核验后重试。'
}
onMounted(() => { window.addEventListener('plaza-identity-invalid', clearOnIdentityChange); load() })
onUnmounted(() => { requestVersion++; window.removeEventListener('plaza-identity-invalid', clearOnIdentityChange) })
</script>

<template>
  <main class="author-stats" aria-labelledby="author-stats-title">
    <header class="page-head">
      <div>
        <div class="eyebrow">我的 <span>·</span> 应用数据</div>
        <h1 id="author-stats-title">我的应用数据</h1>
        <p>近 {{ data?.rangeDays || 30 }} 天你负责或维护的应用被发现与使用的情况；数据匿名聚合，不含搜索内容。</p>
      </div>
    </header>

    <div v-if="error" class="state error" role="alert"><span>{{ error }}</span><button type="button" @click="load">重试</button></div>
    <div v-if="loading && !data" class="state" role="status">正在读取应用数据…</div>

    <template v-else-if="data?.status === 'available'">
      <div v-if="!data.items.length" class="empty panel">
        <strong>你还没有负责或维护的应用</strong>
        <p>分享你的第一个 AI 应用后，这里会出现它的曝光、详情、使用与分享数据。</p>
      </div>
      <table v-else class="panel stats-table" aria-label="我的应用数据">
        <thead><tr><th scope="col">应用</th><th scope="col" aria-label="卡片曝光次数">曝光</th><th scope="col" aria-label="查看详情的会话数">详情会话</th><th scope="col" aria-label="打开平台与复制接入词次数">使用</th><th scope="col" aria-label="分享链接复制次数">分享</th></tr></thead>
        <tbody>
          <tr v-for="item in data.items" :key="item.id">
            <td class="app-name">{{ item.name }}</td>
            <td class="num">{{ item.exposed }}</td>
            <td class="num">{{ item.detailSessions }}</td>
            <td class="num">{{ item.usages }}</td>
            <td class="num">{{ item.shares }}</td>
          </tr>
        </tbody>
      </table>
      <p class="hint">曝光=卡片被看到；详情会话=去重后的查看详情；使用=打开平台或复制接入提示词；分享=同事复制了分享链接。</p>
    </template>
    <div v-else-if="data?.status === 'unavailable'" class="empty panel"><strong>统计采集未启用</strong><p>{{ data.reason }}，暂时无法提供应用数据。</p></div>
  </main>
</template>

<style scoped>
.author-stats { display: flex; flex-direction: column; gap: 16px; padding: 26px 32px; overflow-y: auto; color: var(--plaza-ink); }
.page-head .eyebrow { margin: 0 0 6px; color: var(--plaza-muted); font-size: 12px; letter-spacing: .06em; }
.page-head .eyebrow span { color: var(--plaza-line); }
.page-head h1 { margin: 0; font-size: 24px; font-weight: 680; letter-spacing: -.02em; }
.page-head p { margin: 6px 0 0; color: var(--plaza-muted); font-size: 13px; }
.panel { padding: 20px; border: 1px solid var(--plaza-line); border-radius: 14px; background: var(--plaza-surface); }
.state { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border-radius: 10px; font-size: 13px; }
.state.error { border: 1px solid #f3c6c6; background: #fdf1f1; color: #8f3030; }
.state button { flex: none; padding: 4px 10px; border: 1px solid currentColor; border-radius: 8px; background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer; }
.empty { display: grid; gap: 6px; justify-items: start; padding: 24px; }
.empty strong { font-size: 14px; }
.empty p { margin: 0; color: var(--plaza-muted); font-size: 12.5px; }
.stats-table { width: 100%; border-collapse: collapse; }
.stats-table th { padding: 10px; border-bottom: 1px solid rgb(32 42 59 / .1); color: var(--plaza-muted); font-size: 11.5px; font-weight: 600; text-align: right; }
.stats-table th:first-child { text-align: left; }
.stats-table td { padding: 12px 10px; border-bottom: 1px solid rgb(32 42 59 / .06); font-size: 13px; }
.app-name { color: var(--plaza-ink); font-weight: 600; overflow-wrap: anywhere; }
.num { text-align: right; font-variant-numeric: tabular-nums; color: var(--plaza-text); }
.hint { margin: 0; color: var(--plaza-muted); font-size: 11.5px; line-height: 1.7; }
@media (max-width: 760px) { .author-stats { padding: 18px 14px; } .stats-table th:nth-child(2), .stats-table td.num:nth-child(2) { display: none; } }
</style>
