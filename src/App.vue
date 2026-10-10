<script setup>
import { computed } from 'vue'
import ToolDirectory from './pages/ToolDirectory.vue'
import PortalFrame from './components/PortalFrame.vue'

const showPrototype = computed(() => new URLSearchParams(window.location.search).get('prototype') === '1')
</script>

<template>
  <PortalFrame v-if="showPrototype" />
  <ToolDirectory v-else />
</template>
