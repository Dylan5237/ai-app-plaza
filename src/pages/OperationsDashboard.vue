<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { apiRequest } from '../lib/api.js'
import PlazaIcon from '../components/PlazaIcon.vue'

const period = ref('30d')
const data = ref(null)
const loading = ref(false)
const error = ref('')
let requestVersion = 0
async function load() {
  const version = ++requestVersion
  loading.value = true
  error.value = ''
  try {
    const result = await apiRequest(`/api/operations/dashboard?period=${period.value}`)
    if (version === requestVersion) data.value = result
  } catch (err) {
    if (version === requestVersion) {
      // Identity failures must remove previously visible protected data immediately.
      if (err.status === 401 || err.status === 403) data.value = null
      error.value = err.message || '看板加载失败，请稍后重试。'
    }
  } finally { if (version === requestVersion) loading.value = false }
}
function choose(value) { if (period.value !== value) { period.value = value; load() } }
function clearOnIdentityChange() { requestVersion++; data.value = null; loading.value = false; error.value = '身份状态已变化，请重新核验后重试。' }
onMounted(() => { window.addEventListener('plaza-identity-invalid', clearOnIdentityChange); window.addEventListener('focus', load); load() })
onUnmounted(() => { requestVersion++; window.removeEventListener('plaza-identity-invalid', clearOnIdentityChange); window.removeEventListener('focus', load) })
const n = value => value == null ? '—' : Number(value).toLocaleString('zh-CN')
const pct = (part,total) => part == null || !total ? '—' : `${(part/total*100).toFixed(1)}%`
const dateTime = value => {
  if (!value) return '—'
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }).formatToParts(new Date(value)).map(part => [part.type,part.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}
const trend = computed(() => {
  if (!data.value?.days?.length) return []
  const localDay = value => new Date(new Date(value).getTime()+8*3600_000).toISOString().slice(0,10)
  const start = Date.parse(`${localDay(data.value.start)}T00:00:00Z`)
  const end = Date.parse(`${localDay(new Date(new Date(data.value.end).getTime()-1))}T00:00:00Z`)
  const byDay = new Map(data.value.days.map(day => [day.day, day]))
  const result = []
  for (let time=start; time<=end; time+=86400_000) {
    const day = new Date(time).toISOString().slice(0,10)
    result.push(byDay.get(day) || {day,discoverySessions:0,usageSessions:0})
  }
  return result
})
const maxY = computed(() => Math.max(1, ...trend.value.map(item => item.discoverySessions)))
const points = key => trend.value.map((item, i) => `${trend.value.length === 1 ? 320 : 20 + i * 600 / (trend.value.length - 1)},${172 - item[key] / maxY.value * 145}`).join(' ')
const cards = computed(() => {
  const s = data.value?.summary || {}
  return [
    { label:'公开应用发现会话', value:n(s.discoverySessions), note:`${n(s.discoveryVisitors)} 个匿名档案 · 不含搜索筛选`, icon:'search' },
    { label:'使用意向会话', value:n(s.usageSessions), note:`公开应用发现会话占比 ${pct(s.usageSessions,s.discoverySessions)}`, icon:'agent' },
    { label:'主动搜索', value:'—', note:'结果范围无法区分，暂不可计算', icon:'catalog' },
    { label:'在架应用', value:n(data.value?.supply?.available), note:'当前公开且上架', icon:'operations' },
  ]
})
</script>

<template>
  <main class="ops-dashboard" aria-labelledby="ops-title">
    <header class="page-head"><div><div class="eyebrow">运营概览 <span>·</span> 实时查询</div><h1 id="ops-title">看见应用的发现与增长</h1><p>了解广场如何被发现，以及好用的应用如何积累。</p></div>
      <div class="period-control" role="group" aria-label="统计时间范围"><button v-for="item in [{v:'7d',label:'近 7 天'},{v:'30d',label:'近 30 天'},{v:'90d',label:'近 90 天'}]" :key="item.v" :aria-pressed="period===item.v" :class="{active:period===item.v}" @click="choose(item.v)">{{item.label}}</button></div>
    </header>
    <div v-if="error" class="state error" role="alert"><span>{{error}}</span><button @click="load">重试</button></div>
    <div v-if="loading && !data" class="state" role="status">正在加载运营数据…</div>
    <div v-else-if="data?.status==='unavailable'" class="state" role="status"><strong>数据暂不可用</strong><span>{{data.reason}}，请稍后重试。</span></div>
    <template v-else-if="data?.status==='available'">
      <div class="range-line"><span>{{dateTime(data.start)}} — {{dateTime(data.end)}} <small>（北京时间）</small></span><span v-if="loading" role="status">更新中…</span><span v-else-if="data.period!==period">当前显示此前的结果</span></div>
      <div v-if="data.partial" class="notice">埋点从 {{dateTime(data.collectionStart)}} 开始，本区间仅展示开始采集后的数据。</div>
      <div v-if="!data.appScopeAvailable" class="notice">公开应用范围尚未接入，应用相关指标暂不可用。</div>
      <section class="metrics" aria-label="运营概览"><article v-for="card in cards" :key="card.label" class="metric panel"><div class="metric-top"><span>{{card.label}}</span><span class="metric-icon"><PlazaIcon :name="card.icon"/></span></div><strong>{{card.value}}</strong><small>{{card.note}}</small></article></section>
      <div class="top-grid"><section class="panel chart-panel"><div class="section-head"><div><h2>公开应用发现与使用趋势</h2><p>每日去重会话，不含搜索筛选；跨日会话可能重复出现</p></div><div class="legend"><span><i class="dot blue"></i>发现应用</span><span><i class="dot orange"></i>使用意向</span></div></div>
        <div v-if="!data.appScopeAvailable" class="empty">公开应用范围未接入，暂无法展示趋势。</div>
        <div v-else-if="!trend.length" class="empty">该时段暂无已采集的发现事件。</div>
        <div v-else class="chart"><svg viewBox="0 0 640 205" role="img" aria-label="每日发现活跃和使用意向会话趋势"><line v-for="y in [27,75,123,172]" :key="y" x1="20" :y1="y" x2="620" :y2="y" stroke="var(--plaza-line)"/><polyline :points="points('discoverySessions')" fill="none" stroke="var(--plaza-brand)" stroke-width="3" stroke-linejoin="round"/><polyline :points="points('usageSessions')" fill="none" stroke="var(--plaza-share)" stroke-width="3" stroke-linejoin="round"/><circle v-if="trend.length===1" cx="320" :cy="172-trend[0].discoverySessions/maxY*145" r="4" fill="var(--plaza-brand)"/></svg><div class="chart-labels"><span>{{trend[0].day}}</span><span>{{trend[trend.length-1].day}}</span></div></div>
      </section><section class="panel intent"><div class="section-head"><div><h2>使用意向</h2><p>按具体动作分别统计</p></div></div><span class="muted">期间有效动作</span><div class="intent-number">{{data.summary.webActions == null ? '—' : n(data.summary.webActions+data.summary.agentActions)}} <small>次</small></div><p class="hint">同一访问端、应用和行为 30 分钟内去重</p><div class="intent-row"><span><i class="dot blue"></i>打开平台</span><b>{{n(data.summary.webActions)}} 次</b></div><div class="intent-row"><span><i class="dot orange"></i>成功复制 Agent 接入提示词</span><b>{{n(data.summary.agentActions)}} 次</b></div><div class="callout">使用意向不代表平台打开成功或 Agent 安装成功。</div></section></div>
      <section class="panel app-panel"><div class="section-head"><div><h2>应用发现表现</h2><p>仅显示当前公开且上架的应用；详情与使用可以直接到达。</p></div></div><div v-if="data.apps===null" class="empty">公开应用范围未接入，暂无法展示。</div><div v-else-if="!data.apps.length" class="empty">该时段暂无已采集的应用发现事件。</div><div v-else class="table-scroll"><table><thead><tr><th>应用</th><th>卡片曝光</th><th>详情会话</th><th>平台打开会话</th><th>接入复制会话</th></tr></thead><tbody><tr v-for="(app,index) in data.apps" :key="app.id"><td><span class="rank">{{String(index+1).padStart(2,'0')}}</span><b>{{app.name}}</b></td><td>{{n(app.exposure)}}</td><td>{{n(app.details)}}</td><td>{{n(app.webSessions)}}</td><td>{{n(app.agentSessions)}}</td></tr></tbody></table></div><p v-if="data.apps?.length" class="table-note">按卡片曝光排序，最多显示 50 个应用。曝光次数与会话数口径不同。</p></section>
      <div class="bottom-grid"><section class="panel"><div class="section-head"><div><h2>供给增长</h2><p>当前公开且上架；新增和更新以已记录事实为准</p></div></div><div v-if="data.supply" class="supply"><div><span>当前在架</span><strong>{{n(data.supply.available)}}</strong><small>当前快照</small></div><div><span>首次收录</span><strong>{{n(data.supply.newApps)}}</strong><small>不含基线存量</small></div><div><span>版本更新</span><strong>{{n(data.supply.updates)}}</strong><small>不含资料编辑</small></div></div><div v-else class="empty">公开应用范围未接入，暂无法展示。</div><div class="callout">收录漏斗暂不可计算：需完整关联成熟提交批次与预览、确认事件。</div></section><section class="panel"><div class="section-head"><div><h2>持续回访</h2><p>匿名浏览器档案的重复发现</p></div><span class="chip">{{!data.retention ? '暂不可计算' : data.retention.weekTotal || data.retention.repeatTotal ? '成熟批次' : '观察中'}}</span></div><div class="retention"><div><span>第 2 周发现留存</span><strong>{{data.retention ? pct(data.retention.weekReturned,data.retention.weekTotal) : '—'}}</strong><small>{{data.retention?.weekTotal ? `${data.retention.weekReturned} / ${data.retention.weekTotal} 个档案` : data.retention ? '暂无成熟批次' : '暂不可计算'}}</small></div><div><span>28 天重复发现</span><strong>{{data.retention ? pct(data.retention.repeatReturned,data.retention.repeatTotal) : '—'}}</strong><small>{{data.retention?.repeatTotal ? `${data.retention.repeatReturned} / ${data.retention.repeatTotal} 个档案` : data.retention ? '暂无成熟批次' : '暂不可计算'}}</small></div></div><p class="hint">{{data.retention ? '仅统计已满足完整观察期的首次观测批次；回访不等同于应用内留存。' : '搜索和筛选的结果范围无法区分，首次发现不完整，暂不计算留存。'}}</p></section></div>
      <p class="footnote">数据范围：当前公开且上架的应用。匿名浏览器档案不等于自然人；来源和流量类型目前未区分。浏览器事件可能漏采，数值仅反映已观测记录。管理员专用。</p>
    </template>
  </main>
</template>

<style scoped>
.ops-dashboard{box-sizing:border-box;max-width:1560px;margin:auto;padding:32px;color:var(--plaza-ink,#202a3b);font:14px/1.55 'Segoe UI','Microsoft YaHei',sans-serif}.ops-dashboard *{box-sizing:border-box}.page-head,.section-head,.metric-top,.range-line,.intent-row{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}.page-head{align-items:flex-end;margin-bottom:20px}.eyebrow{font-size:12px;color:var(--plaza-brand,#3e58ce);font-weight:650}.eyebrow span{color:var(--plaza-muted)}h1{font-size:26px;line-height:1.3;margin:7px 0 5px}h2{font-size:17px;line-height:1.5;margin:0}.page-head p,.section-head p{margin:3px 0 0;color:var(--plaza-muted,#657085);font-size:13px}.period-control{display:flex;padding:4px;background:white;border:1px solid var(--plaza-line,#e4e6ec);border-radius:10px;white-space:nowrap}.period-control button,.state button{border:0;border-radius:7px;padding:7px 13px;background:transparent;color:#596477;cursor:pointer;font:inherit}.period-control button.active{background:var(--plaza-brand-soft,#edf0ff);color:var(--plaza-brand,#3e58ce);font-weight:650}.period-control button:focus-visible,.state button:focus-visible{outline:3px solid var(--plaza-brand)}.range-line{font-size:12px;color:#657085;margin-bottom:13px}.notice,.state{padding:12px 16px;margin-bottom:16px;border-radius:10px;background:var(--plaza-brand-soft);color:#485985}.state{display:flex;align-items:center;gap:12px;background:white;border:1px solid #e4e6ec}.state.error{background:var(--plaza-surface);color:var(--plaza-danger)}.state button{margin-left:auto;color:#3e58ce;text-decoration:underline}.panel{background:var(--plaza-surface,#fff);border:1px solid var(--plaza-line,#e4e6ec);border-radius:var(--plaza-radius,16px);box-shadow:var(--plaza-shadow,0 3px 12px rgb(34 43 64 / 4%));padding:22px}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:16px}.metric{padding:18px 20px}.metric-top{color:#596477}.metric-icon{display:grid;place-items:center;width:38px;height:38px;border-radius:11px;background:#edf0ff;color:var(--plaza-brand)}.metric strong{display:block;font-size:30px;line-height:1.2;margin:10px 0 5px}.metric small,.hint,.muted,.table-note,.footnote{color:#657085;font-size:12px}.top-grid,.bottom-grid{display:grid;grid-template-columns:minmax(0,1.8fr) minmax(280px,1fr);gap:16px;margin-bottom:16px}.legend{display:flex;gap:16px;color:#657085;font-size:12px}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px}.dot.blue{background:var(--plaza-brand)}.dot.orange{background:var(--plaza-share)}.chart{margin-top:18px}.chart svg{width:100%;height:200px;display:block}.chart-labels{display:flex;justify-content:space-between;color:#657085;font-size:12px}.empty{display:flex;align-items:center;justify-content:center;min-height:120px;color:#657085}.intent-number{font-size:30px;font-weight:700;margin-top:8px}.intent-number small{font-size:13px;font-weight:400}.intent .muted{display:block;margin-top:23px}.intent-row{align-items:center;margin-top:19px}.callout{margin-top:20px;padding:11px 13px;border-radius:9px;background:var(--plaza-brand-soft);color:#657085;font-size:12px}.app-panel{margin-bottom:16px}.table-scroll{overflow-x:auto;margin-top:15px}table{border-collapse:collapse;width:100%;min-width:670px;text-align:left}th,td{padding:13px 10px;border-bottom:1px solid #eef0f4}th{font-weight:500;color:#657085;font-size:12px}td{font-size:13px}.rank{font-size:12px;color:var(--plaza-muted);margin-right:14px}.table-note{margin:12px 0 0}.bottom-grid{grid-template-columns:1fr 1fr}.supply,.retention{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:24px}.supply div,.retention div{display:flex;flex-direction:column;gap:5px}.supply span,.retention span,.supply small{color:#657085;font-size:12px}.supply strong,.retention strong{font-size:24px}.retention{grid-template-columns:1fr 1fr}.chip{padding:4px 9px;border-radius:20px;color:var(--plaza-warning);background:var(--plaza-surface);border:1px solid var(--plaza-warning);font-size:12px}.footnote{line-height:1.8;margin:8px 2px 0}@media(max-width:1050px){.metrics{grid-template-columns:repeat(2,1fr)}.top-grid,.bottom-grid{grid-template-columns:1fr}}@media(max-width:600px){.ops-dashboard{padding:16px}.page-head{display:block}.period-control{display:inline-flex;margin-top:16px}.metrics{gap:10px}.metric,.panel{padding:16px}.metric strong{font-size:24px}.legend{display:none}}
</style>