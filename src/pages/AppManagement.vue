<script setup>
import { onMounted, reactive, ref } from 'vue'
import { apiRequest } from '../lib/api.js'
import ToolDirectory from './ToolDirectory.vue'
import ApplicationMetadataEditor from '../components/ApplicationMetadataEditor.vue'
import ManagementList from '../components/ManagementList.vue'
import ApplicationAccessDialog from '../components/ApplicationAccessDialog.vue'
import plazaMark from '../assets/plaza-mark.svg'
import { publicPath } from '../lib/public-path.js'
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
    <header class="management-topbar">
      <a :href="publicPath('/')" class="management-brand"><img :src="plazaMark" alt="" />AI应用广场</a>
      <span class="management-context">管理后台</span>
      <a :href="publicPath('/')" class="management-plaza-link">返回应用广场</a>
    </header>
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
.management-shell { display: flex; flex-direction: column; height: 100dvh; overflow: hidden; background: #f4f6f9; }
.management-shell :deep(.directory-shell), .management-shell :deep(.publication-shell) { flex: 1; min-height: 0; height: auto; }
.management-topbar { flex-shrink: 0; box-sizing: border-box; display: flex; align-items: center; gap: 18px; min-height: 60px; padding: 12px 24px; border-bottom: 1px solid #e4e8ef; background: white; }
.management-brand { display: flex; align-items: center; gap: 9px; color: #1f2c3d; font-size: 16px; font-weight: 650; text-decoration: none; }
.management-brand img { width: 28px; height: 28px; }
.management-context { padding-left: 16px; border-left: 1px solid #e4e8ef; color: #64748b; font-size: 14px; }
.management-plaza-link { margin-left: auto; color: var(--plaza-brand); font-size: 13px; text-decoration: none; }
@media (max-width: 560px) { .management-topbar { gap: 10px; padding: 10px 14px; } .management-brand { font-size: 14px; } .management-context { padding-left: 10px; font-size: 12px; } .management-plaza-link { font-size: 12px; } }
</style>