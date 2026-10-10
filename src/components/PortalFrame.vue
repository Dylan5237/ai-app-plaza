<script setup>
import { onMounted, onUnmounted, ref } from 'vue'

const frame = ref(null)
const ready = ref(false)
function onMessage(event) {
  if (event.origin !== window.location.origin || event.source !== frame.value?.contentWindow) return
  if (event.data?.type === 'portal-ready') ready.value = true
}
onMounted(() => window.addEventListener('message', onMessage))
onUnmounted(() => window.removeEventListener('message', onMessage))
</script>

<template>
  <main class="portal-host" aria-label="AI应用广场">
    <iframe
      ref="frame"
      class="portal-frame"
      title="AI应用广场交互原型"
      src="./portal.html"
      allow="clipboard-write"
      @load="ready = true"
    />
    <span v-if="!ready" class="load-status" role="status">正在加载应用广场…</span>
  </main>
</template>

<style>
html, body, #app { width: 100%; height: 100%; margin: 0; overflow: hidden; }
.portal-host { width: 100%; height: 100%; overflow: hidden; background: #f5f7fb; }
.portal-frame { display: block; width: 100%; height: 100%; border: 0; overflow: hidden; }
.load-status { position: fixed; right: 14px; bottom: 10px; z-index: 2; padding: 4px 8px; border-radius: 5px; color: #647187; background: #fff; font: 12px/1.5 "Segoe UI", "Microsoft YaHei", sans-serif; pointer-events: none; }
</style>
