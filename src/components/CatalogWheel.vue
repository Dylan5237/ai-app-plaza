<script setup>
import { ref, watch, onUnmounted } from 'vue'
import CatalogCard from './CatalogCard.vue'
const props = defineProps({ items: { type: Array, required: true }, index: { type: Number, default: 0 }, loading: Boolean, revalidating: Boolean, error: String, allShown: Boolean })
const emit = defineEmits(['update:index', 'refresh', 'return', 'detail', 'primary', 'tag'])
const wheel = ref(null)
let touchStart = null
let touchTarget = null
let swiped = false
const visualPosition = ref(props.index)
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
let targetPosition = props.index
let animationFrame = 0
let lastFrameAt = 0
let snapTimer
let lastWheelAt = 0
let wheelDirection = 0
const normalizedIndex = value => props.items.length ? ((Math.round(value) % props.items.length) + props.items.length) % props.items.length : 0
function publishIndex() {
  const index = normalizedIndex(targetPosition)
  if (index !== props.index) emit('update:index', index)
}
function frame(time) {
  animationFrame = 0
  const elapsed = lastFrameAt ? Math.min(32, time - lastFrameAt) : 16
  lastFrameAt = time
  const distance = targetPosition - visualPosition.value
  if (reducedMotion.matches || Math.abs(distance) < .002) {
    visualPosition.value = targetPosition
    lastFrameAt = 0
    return
  }
  visualPosition.value += distance * (1 - Math.exp(-elapsed / 85))
  animationFrame = requestAnimationFrame(frame)
}
function animate() {
  if (reducedMotion.matches) {
    cancelAnimationFrame(animationFrame)
    animationFrame = 0
    lastFrameAt = 0
    visualPosition.value = Math.round(targetPosition)
  } else if (!animationFrame) animationFrame = requestAnimationFrame(frame)
}
function move(delta) {
  if (props.items.length < 2) return
  clearTimeout(snapTimer)
  targetPosition = Math.round(targetPosition) + delta
  publishIndex()
  animate()
}
function scrollCards(event) {
  if (event.ctrlKey || event.metaKey || event.defaultPrevented || props.loading || props.items.length < 2) return
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
  if (!delta) return
  if (event.cancelable) event.preventDefault()
  const now = performance.now(), direction = Math.sign(delta)
  if (now - lastWheelAt > 180) wheelDirection = 0
  if (wheelDirection && direction !== wheelDirection) targetPosition = visualPosition.value
  lastWheelAt = now
  wheelDirection = direction
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? wheel.value?.clientHeight || 370 : 1
  const step = Math.max(-1, Math.min(1, delta * unit / 110))
  // Keep the target close to what is on screen; momentum must not queue a long spin.
  targetPosition = Math.max(visualPosition.value - 1.1, Math.min(visualPosition.value + 1.1, targetPosition + step))
  publishIndex()
  animate()
  clearTimeout(snapTimer)
  snapTimer = setTimeout(() => {
    targetPosition = Math.round(targetPosition)
    publishIndex()
    animate()
  }, 120)
}
function offset(index) {
  const count = props.items.length
  if (count < 2) return 0
  return ((index - visualPosition.value % count + count * 1.5) % count) - count / 2
}
function opacity(index) {
  if (props.items.length < 2) return 1
  const distance = Math.abs(offset(index))
  // A card crosses the wrap boundary while invisible, never through the foreground.
  const edge = Math.min(1, Math.max(0, (props.items.length / 2 - distance) / .65))
  return Math.max(0, 1 - distance * .18) * edge
}
function aim(index) {
  clearTimeout(snapTimer)
  let delta = index - normalizedIndex(targetPosition)
  if (delta > props.items.length / 2) delta -= props.items.length
  if (delta < -props.items.length / 2) delta += props.items.length
  targetPosition = Math.round(targetPosition) + delta
  publishIndex()
  animate()
}
function select(index) {
  aim(index)
  wheel.value?.focus({ preventScroll: true })
}
watch(() => props.index, index => {
  if (index !== normalizedIndex(targetPosition)) aim(index)
})
watch(() => props.items.map(app => app.id).join('|'), () => {
  clearTimeout(snapTimer)
  cancelAnimationFrame(animationFrame)
  animationFrame = 0
  lastFrameAt = 0
  lastWheelAt = 0
  wheelDirection = 0
  targetPosition = normalizedIndex(props.index)
  visualPosition.value = targetPosition
})
onUnmounted(() => { clearTimeout(snapTimer); cancelAnimationFrame(animationFrame) })
function start(event) {
  swiped = false
  touchTarget = null
  if (event.pointerType === 'touch') touchStart = { x: event.clientX, y: event.clientY, target: event.target }
}
function end(event) {
  if (!touchStart) return
  const x = event.clientX - touchStart.x, y = event.clientY - touchStart.y
  const target = touchStart.target
  touchStart = null
  if (Math.abs(x) > 45 && Math.abs(x) > Math.abs(y)) {
    swiped = true
    move(x < 0 ? 1 : -1)
  } else if (Math.abs(x) < 10 && Math.abs(y) < 10) {
    touchTarget = target.closest('button, a')
  }
}
function finishTouch(event) {
  // Handle a tap once, independently of the browser's post-swipe compatibility click.
  if (swiped || touchTarget) event.preventDefault()
  if (touchTarget) touchTarget.click()
  touchTarget = null
}
function click(event) {
  if (!swiped) return
  event.preventDefault()
  event.stopPropagation()
  swiped = false
}
</script>

<template>
  <section class="random-section" aria-label="随便看看" data-testid="random-discovery">
    <div class="random-heading">
      <div><h2>随便看看</h2><p>随机遇见一个好用的应用</p></div>
      <div class="random-actions">
        <button @click="emit('return')">返回应用目录</button>
        <button class="refresh-button" data-testid="random-refresh" :disabled="loading" @click="emit('refresh')">{{ loading ? revalidating ? '正在核验…' : '正在抽取…' : '换一批' }}</button>
      </div>
    </div>
    <p v-if="error" role="alert" class="random-error">{{ error }}</p>
    <p v-if="loading && !items.length" class="random-state" role="status">正在读取随机应用…</p>
    <p v-else-if="!error && !items.length" class="random-state">目录中还没有可展示的应用。</p>
    <template v-if="items.length">
      <div ref="wheel" class="wheel" data-testid="catalog-wheel" tabindex="0" aria-label="应用轮盘，可使用鼠标滚轮或左右方向键切换"
        @wheel="scrollCards"
        @keydown.left.prevent="move(-1)" @keydown.right.prevent="move(1)"
        @pointerdown="start" @pointerup="end" @pointercancel="touchStart = null; touchTarget = null" @touchend="finishTouch" @click.capture="click">
        <div v-for="(app, position) in items" :key="app.id" class="wheel-card" :class="{ 'is-current': position === index }"
          :style="{ '--offset': offset(position), '--distance': Math.abs(offset(position)), '--wheel-opacity': opacity(position), zIndex: Math.round((items.length - Math.abs(offset(position))) * 100) }"
          :inert="opacity(position) < .02"
          :data-testid="position === index ? 'wheel-current' : 'wheel-side'">
          <CatalogCard :app="app" :inert="position !== index" :aria-hidden="position !== index ? 'true' : undefined"
            @detail="emit('detail', $event)" @primary="emit('primary', $event)" @tag="emit('tag', $event)" />
          <button v-if="position !== index" class="side-select" :aria-label="`切换到 ${app.manifest.name}`" @click="select(position)"></button>
        </div>
      </div>
      <div class="wheel-controls">
        <button aria-label="上一个应用" :disabled="items.length < 2" @click="move(-1)">←</button>
        <div class="wheel-dots" aria-label="本批应用">
          <button v-for="(app, position) in items" :key="app.id" :aria-label="`第 ${position + 1} 项：${app.manifest.name}`" :aria-pressed="position === index" @click="select(position)"></button>
        </div>
        <button aria-label="下一个应用" :disabled="items.length < 2" @click="move(1)">→</button>
      </div>
      <p class="wheel-status" role="status">{{ index + 1 }} / {{ items.length }}<span v-if="allShown" data-testid="random-all-shown"> · 已展示全部</span></p>
      <p v-if="items.length > 1" class="wheel-hint">在卡片区域滚动鼠标，或用 ← → 切换</p>
    </template>
  </section>
</template>

<style scoped>
.random-section { min-height: 400px; }
.random-heading { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin: 18px 0; }
h2 { margin: 0; font-size: 17px;;line-height:26px;}
.random-heading p { margin: 7px 0 0; color: var(--plaza-muted); font-size: 14px;;line-height:22px;}
.random-actions { display: flex; gap: 8px; }
button { min-height: 36px; padding: 6px 12px; border: 1px solid var(--plaza-line); border-radius: var(--plaza-control-radius); background: var(--plaza-surface); color: var(--plaza-text); font: inherit; font-size: 14px; cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .5; }
.refresh-button { background: var(--plaza-brand); border-color: var(--plaza-brand); color: var(--plaza-surface); }
.wheel { position: relative; height: 370px; overflow: hidden; touch-action: pan-y; }
.wheel-card { position: absolute; width: min(390px, 76%); left: 50%; top: 24px; transform: translate3d(calc(-50% + var(--offset) * 51%),calc(var(--distance) * 14px),0) scale(calc(1 - var(--distance) * .12)); opacity: var(--wheel-opacity); will-change: transform,opacity; }
.wheel-card :deep(.app-card) { --catalog-card-height: 290px; }
.side-select { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: transparent; }
.wheel-controls, .wheel-dots { display: flex; justify-content: center; align-items: center; gap: 12px; }
.wheel-dots button { position: relative; display: grid; width: 24px; height: 24px; min-height: 24px; place-items: center; padding: 0; border: 0; border-radius: 50%; background: transparent; }
.wheel-dots button::before { width: 10px; height: 10px; border-radius: 50%; background: var(--plaza-line); content: ""; }
.wheel-dots button[aria-pressed="true"] { outline: 2px solid var(--plaza-brand); outline-offset: 1px; }
.wheel-dots button[aria-pressed="true"]::before { background: var(--plaza-brand); }

.wheel-status, .random-state { color: var(--plaza-muted); font-size: 14px; text-align: center;;line-height:22px;}
.wheel-hint { margin: 8px 0 0; color: var(--plaza-muted); font-size: 11px; text-align: center;;line-height:18px;}
.random-state { padding: 80px 0; }
.random-error { padding: 12px; color: var(--plaza-danger); background: var(--plaza-surface); border-radius: 6px; font-size: 14px;;line-height:22px;}
button:focus-visible, .wheel:focus-visible { outline: 3px solid var(--plaza-brand); outline-offset: 2px; }
@media (max-width: 620px) { .random-heading { align-items: flex-start; flex-direction: column; } .wheel-card { width: 86%; } }
@media (hover: none), (pointer: coarse) { .wheel { height: 410px; }.wheel-hint{display:none} }
@media (prefers-reduced-motion: reduce) { .wheel-card { will-change: auto; } }
</style>
