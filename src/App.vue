<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import ToolDirectory from './pages/ToolDirectory.vue'
import PortalFrame from './components/PortalFrame.vue'
import AppFinderChat from './components/AppFinderChat.vue'

const showPrototype = computed(() => new URLSearchParams(window.location.search).get('prototype') === '1')
const inPrivatePreview = ref(false)
function syncPreviewRoute() {
  inPrivatePreview.value = new URLSearchParams(window.location.hash.replace(/^#/, '')).has('publish')
}
onMounted(() => {
  syncPreviewRoute()
  window.addEventListener('hashchange', syncPreviewRoute)
})
onUnmounted(() => window.removeEventListener('hashchange', syncPreviewRoute))
</script>

<template>
  <PortalFrame v-if="showPrototype" />
  <template v-else>
    <ToolDirectory />
    <AppFinderChat v-if="!inPrivatePreview" />
  </template>
</template>
