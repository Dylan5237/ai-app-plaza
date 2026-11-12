<script setup>
import { onMounted, reactive, ref } from 'vue'
import { apiRequest } from '../lib/api.js'
import ToolDirectory from './ToolDirectory.vue'
import ApplicationMetadataEditor from '../components/ApplicationMetadataEditor.vue'
import ManagementList from '../components/ManagementList.vue'
import ApplicationAccessDialog from '../components/ApplicationAccessDialog.vue'
const listState = reactive({ view: 'apps', query: '', status: 'all', page: 1, pageSize: 5 })
const managementEnabled = ref(false)
const managementMode = ref('disabled')
const editorAppId = ref('')
const accessAppId = ref('')
const list = ref(null)
function saved(publicationId, openPublication) { editorAppId.value = ''; openPublication(publicationId) }
onMounted(async () => {
  try {
    const health = await apiRequest('/api/health')
    managementEnabled.value = health.managementEnabled === true
    managementMode.value = ['local', 'intranet', 'identity'].includes(health.managementMode) ? health.managementMode : 'disabled'
  } catch { /* The list reports connection errors. */ }
})
</script>

<template>
  <div class="management-shell">
    <ToolDirectory management :management-enabled="managementEnabled">
      <template #management="{ openApp, openUpdate, openPublication, openCreate }">
        <ManagementList ref="list" :state="listState" :management-enabled="managementEnabled" :management-mode="managementMode" @open-access="accessAppId = $event" @open-editor="editorAppId = $event" @open-create="openCreate()" @open-app="openApp" @open-update="openUpdate" @open-publication="openPublication" />
        <ApplicationMetadataEditor :app-id="editorAppId" @close="editorAppId = ''" @saved="saved($event, openPublication)" />
        <ApplicationAccessDialog :app-id="accessAppId" @close="accessAppId = ''" />
      </template>
    </ToolDirectory>
  </div>
</template>

<style scoped>
.management-shell { display: flex; flex: 1; min-height: 0; flex-direction: column; overflow: hidden; background: var(--plaza-canvas); }
.management-shell :deep(.directory-shell), .management-shell :deep(.publication-shell) { flex: 1; min-height: 0; height: auto; }
</style>