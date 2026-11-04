<script setup>
import { computed } from 'vue'
import ToolDirectory from './pages/ToolDirectory.vue'
import PortalFrame from './components/PortalFrame.vue'
import AppManagement from './pages/AppManagement.vue'

const showPrototype = computed(() => new URLSearchParams(window.location.search).get('prototype') === '1')
const showManagement = computed(() => ['/admin', '/private-previews'].includes(window.location.pathname.replace(/\/$/, '')))
</script>

<template>
  <PortalFrame v-if="showPrototype" />
  <AppManagement v-else-if="showManagement" />
  <ToolDirectory v-else />
</template>
