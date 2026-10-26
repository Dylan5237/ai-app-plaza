<script setup>
import { computed } from 'vue'
import ToolDirectory from './pages/ToolDirectory.vue'
import PortalFrame from './components/PortalFrame.vue'
import AppManagement from './pages/AppManagement.vue'
import FuxiEntryTest from './pages/FuxiEntryTest.vue'

const showPrototype = computed(() => new URLSearchParams(window.location.search).get('prototype') === '1')
const showManagement = computed(() => ['/admin', '/private-previews'].includes(window.location.pathname.replace(/\/$/, '')))
const showFuxiTest = computed(() => window.location.pathname.replace(/\/$/, '') === '/integration/fuxi-test')
</script>

<template>
  <FuxiEntryTest v-if="showFuxiTest" />
  <PortalFrame v-else-if="showPrototype" />
  <AppManagement v-else-if="showManagement" />
  <ToolDirectory v-else />
</template>
