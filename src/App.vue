<script setup>
import { computed } from 'vue'
import ToolDirectory from './pages/ToolDirectory.vue'
import PortalFrame from './components/PortalFrame.vue'
import PrivatePreviewAdmin from './pages/PrivatePreviewAdmin.vue'

const showPrototype = computed(() => new URLSearchParams(window.location.search).get('prototype') === '1')
const showPrivatePreviewAdmin = computed(() => window.location.pathname === '/private-previews')
</script>

<template>
  <PortalFrame v-if="showPrototype" />
  <PrivatePreviewAdmin v-else-if="showPrivatePreviewAdmin" />
  <ToolDirectory v-else />
</template>
