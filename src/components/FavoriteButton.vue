<script setup>
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import PlazaIcon from './PlazaIcon.vue'
import { identity } from '../lib/identity.js'
import { favorites, toggleFavorite } from '../lib/personal.js'
const props = defineProps({ appId: { type: String, required: true } })
const saved = computed(() => favorites.ids.includes(props.appId))
async function toggle() {
  try { await toggleFavorite(props.appId) }
  catch (error) { ElMessage.error(error.message) }
}
</script>
<template>
  <button v-if="identity.enabled" class="favorite-button" :class="{ saved }" type="button" :aria-pressed="saved" :aria-label="identity.user && !favorites.loaded ? '正在读取收藏状态' : saved ? '取消收藏' : identity.user ? '收藏应用' : '登录后收藏'" :disabled="identity.busy || (identity.user && !favorites.loaded) || favorites.busy.includes(appId)" @click.stop="toggle" @pointerover.stop @pointerdown.stop>
    <PlazaIcon name="favorite" />
  </button>
</template>
<style scoped>
.favorite-button { display: inline-flex; width: 44px; height: 44px; flex: none; align-items: center; justify-content: center; padding: 0; border: 1px solid var(--plaza-line); border-radius: var(--plaza-control-radius); background: var(--plaza-surface); color: var(--plaza-muted); cursor: pointer; }
.favorite-button:hover, .favorite-button.saved { color: var(--plaza-brand); background: var(--plaza-brand-soft); }
.favorite-button.saved :deep(svg) { fill: currentColor; }
.favorite-button:focus-visible { outline: 3px solid #c0cbff; outline-offset: 2px; }
.favorite-button:disabled { opacity: .55; cursor: wait; }
</style>
