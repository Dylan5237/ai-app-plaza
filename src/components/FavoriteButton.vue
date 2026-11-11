<script setup>
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import PlazaIcon from './PlazaIcon.vue'
import { identity } from '../lib/identity.js'
import { favorites, refreshFavoriteIds, toggleFavorite } from '../lib/personal.js'
const props = defineProps({ appId: { type: String, required: true } })
const saved = computed(() => favorites.ids.includes(props.appId))
async function toggle() {
  if (identity.user && !favorites.loaded) { if (favorites.error) await refreshFavoriteIds(); return }
  try { await toggleFavorite(props.appId) }
  catch (error) { ElMessage.error(error.message) }
}
</script>
<template>
  <button v-if="identity.enabled" class="favorite-button" :class="{ saved }" type="button" :aria-pressed="saved" :aria-label="identity.user && !favorites.loaded ? favorites.error ? '收藏状态读取失败，点击重试' : '正在读取收藏状态' : saved ? '取消收藏' : identity.user ? '收藏应用' : '登录后收藏'" :title="identity.user && !favorites.loaded && favorites.error ? '读取失败，单击重试' : undefined" :disabled="identity.busy || (identity.user && !favorites.loaded && favorites.loading) || favorites.busy.includes(appId)" @click.stop="toggle" @pointerover.stop @pointerdown.stop>
    <PlazaIcon name="bookmark" />
  </button>
</template>
<style scoped>
.favorite-button { position: relative; display: inline-flex; width: 30px; height: 30px; flex: none; align-items: center; justify-content: center; padding: 0; border: 0; border-radius: 8px; background: transparent; color: #8a93a2; cursor: pointer; transition: color .12s, background .12s; }
.favorite-button :deep(svg) { width: 17px; height: 17px; }
@media (pointer: coarse) { .favorite-button { width: 44px; height: 44px; margin: -7px -7px -7px 0; } }
.favorite-button:hover { color: var(--plaza-brand); background: var(--plaza-brand-soft); }
.favorite-button.saved { color: var(--plaza-brand); }
.favorite-button.saved :deep(svg) { fill: #d0d9ff; stroke: var(--plaza-brand); }
.favorite-button:focus-visible { outline: 2px solid var(--plaza-brand); outline-offset: 2px; }
.favorite-button:disabled { opacity: .55; cursor: wait; }
</style>