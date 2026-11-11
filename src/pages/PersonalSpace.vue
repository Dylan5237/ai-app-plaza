<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import CatalogCard from '../components/CatalogCard.vue'
import ListPagination from '../components/ListPagination.vue'
import { apiRequest } from '../lib/api.js'
import { favorites, saveFavorite } from '../lib/personal.js'
const emit = defineEmits(['close', 'detail', 'primary', 'tag'])
const items = ref([]), total = ref(0), page = ref(1), loading = ref(false), error = ref('')
let sequence = 0
async function load() {
  const request = ++sequence
  loading.value = true; error.value = ''
  try {
    const result = await apiRequest(`/api/personal/favorites?page=${page.value}&pageSize=12`)
    if (request !== sequence) return
    if (page.value > 1 && !result.items.length) { page.value--; return load() }
    items.value = result.items; total.value = result.total
  } catch (e) {
    if (request === sequence) {
      if ([401, 403, 404].includes(e.status)) { items.value = []; total.value = 0 }
      error.value = e.message
    }
  }
  finally { if (request === sequence) loading.value = false }
}
async function remove(id) {
  try { await saveFavorite(id, false) } catch (e) { error.value = e.message }
}
function changePage(value) { page.value = value; void load() }
onMounted(() => { void load(); window.addEventListener('plaza-favorites-changed', load); window.addEventListener('focus', load) })
onUnmounted(() => { sequence++; window.removeEventListener('plaza-favorites-changed', load); window.removeEventListener('focus', load) })
</script>
<template>
  <main class="personal-space plaza-public">
    <header><div><h1>我的收藏</h1><p>保存常用应用，随时回来继续使用。</p></div><el-button @click="emit('close')">返回应用广场</el-button></header>
    <p v-if="error" role="alert">{{ error }} <el-button :disabled="loading" @click="load">重试</el-button></p>
    <p v-if="loading" role="status">{{ items.length ? '正在更新收藏…' : '正在读取收藏…' }}</p>
    <div v-else-if="!total && !error" class="personal-empty"><h2>还没有收藏</h2><p>在应用卡片或详情中点击星标，即可保存在这里。</p><el-button type="primary" @click="emit('close')">去发现应用</el-button></div>
    <div class="personal-grid" :aria-busy="loading">
      <template v-for="item in items" :key="item.id">
        <CatalogCard v-if="item.app" :app="item.app" @detail="emit('detail', $event)" @primary="emit('primary', $event)" @tag="emit('tag', $event)" />
        <div v-else class="unavailable-favorite"><h2>某项收藏已不可访问</h2><p>应用可能已下架或访问权限已变化。</p><el-button :disabled="favorites.busy.includes(item.id)" @click="remove(item.id)">移除收藏</el-button></div>
      </template>
    </div>
    <ListPagination v-if="total" :page="page" :page-size="12" :total="total" @change="changePage" />
  </main>
</template>
<style scoped>
.personal-space { flex: 1; min-height: 0; overflow: auto; padding: 26px 32px 32px; background: var(--plaza-canvas); }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
h1 { margin: 0; color: var(--plaza-ink); font-size: 27px; line-height: 36px; font-weight: 680; letter-spacing: -.025em; }
header p { margin: 7px 0 0; color: var(--plaza-muted); font-size: 12.5px; line-height: 20px; }
p { margin: 8px 0; color: var(--plaza-text); line-height: 1.6; }
.personal-grid { --catalog-card-height: 250px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin: 20px 0; }
.personal-empty { padding: 64px 20px; text-align: center; border: 1px dashed rgb(32 42 59 / .12); border-radius: 16px; background: var(--plaza-surface); }
.personal-empty h2 { color: var(--plaza-ink); font-size: 18px; }
.unavailable-favorite { min-height: 220px; padding: 24px; border: 1px dashed rgb(32 42 59 / .12); border-radius: 16px; background: var(--plaza-surface); }
.unavailable-favorite h2 { color: var(--plaza-ink); font-size: 17px; }
[role="alert"] { color: var(--plaza-danger); }
@media(min-width:1780px) { .personal-grid { grid-template-columns: repeat(4,minmax(0,1fr)); } }
@media(max-width:1120px) { .personal-grid { grid-template-columns: repeat(2,minmax(0,1fr)); } }
@media(max-width:650px) { .personal-space { padding: 20px 16px; } header { align-items: flex-start; } .personal-grid { grid-template-columns: minmax(0,1fr); } }
</style>
