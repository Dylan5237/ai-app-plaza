<script setup>
import { computed } from 'vue'
import FavoriteButton from './FavoriteButton.vue'
import PlatformOpenButton from './PlatformOpenButton.vue'
import { appFormats, catalogUsage, primaryAction, safeHttpUrl } from '../lib/catalog.ts'
import { formatDate } from '../lib/date.ts'
const props = defineProps({ app: { type: Object, required: true }, selectedTags: { type: Array, default: () => [] } })
const emit = defineEmits(['detail', 'primary', 'tag'])
const action = computed(() => primaryAction(props.app))
const name = computed(() => props.app.manifest?.name || '未命名应用')
const tags = computed(() => props.app.tags || props.app.manifest?.tags || [])
const author = computed(() => {
  const value = props.app.manifest?.maintainers
  return (Array.isArray(value) ? value : value ? [value] : []).map(item => typeof item === 'string' ? item : item?.name).filter(Boolean).join('、') || '作者未登记'
})
function date(value) {
  const parsed = new Date(value)
  return !value || Number.isNaN(parsed.getTime()) ? '未登记' : formatDate(parsed)
}
function detail(event) {
  if (event.target.closest('button, a')) return
  const selection = window.getSelection()
  if (selection?.toString() && (event.currentTarget.contains(selection.anchorNode) || event.currentTarget.contains(selection.focusNode))) return
  emit('detail', props.app.id)
}
</script>

<template>
  <article class="app-card" data-testid="app-card" :data-app-id="app.id" :data-usage="catalogUsage(app)" @click="detail">
    <div class="app-card-top">
      <div class="app-card-identity"><button class="app-title" data-testid="card-title" :aria-label="`查看 ${name} 详情`" @click.stop="emit('detail', app.id)">{{ name }}</button><span v-if="app.version" class="app-version">{{ /^\d/.test(app.version) ? `v${app.version}` : app.version }}</span></div>
      <FavoriteButton v-if="!app.isAuthorPreview" :app-id="app.id" />
    </div>
    <p class="app-summary">{{ app.manifest?.summary || '暂无应用简介。' }}</p>
    <div class="app-tags" aria-label="应用形态与能力标签">
      <span class="app-category" :class="catalogUsage(app)" data-testid="app-category">{{ catalogUsage(app) === 'platform' ? '平台应用' : 'Agent 能力' }}</span>
      <span v-for="format in appFormats(app)" v-show="!(catalogUsage(app) === 'agent' && format === 'Agent能力')" :key="format" class="app-format" data-testid="app-format">{{ format }}</span>
      <button v-for="tag in tags.slice(0, 3)" :key="tag" class="app-tag" :class="{ active: selectedTags.includes(tag) }" :aria-label="`按标签 ${tag} 筛选`" @click.stop="emit('tag', tag)">{{ tag }}</button>
      <span v-if="tags.length > 3" class="app-tag-more">+{{ tags.length - 3 }}</span>
    </div>
    <div class="app-card-footer" :class="{ 'has-entry-reason': action.reason }">
      <span class="app-author"><svg class="app-author-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21a8 8 0 0 0-16 0" /><circle cx="12" cy="7" r="4" /></svg><span class="app-author-name">{{ author }}</span></span>
      <div class="app-meta">
        <div v-if="!action.reason" class="app-dates">
          <time :datetime="app.createdAt" :title="`创建于 ${date(app.createdAt)}`">{{ date(app.createdAt) }}</time>
          <time :datetime="app.updatedAt" :title="`更新于 ${date(app.updatedAt)}`">{{ date(app.updatedAt) }}</time>
        </div>
        <p v-if="action.reason" class="app-primary-reason" :title="action.reason" data-testid="primary-disabled-reason">{{ action.reason }}</p>
        <PlatformOpenButton v-else-if="action.entry?.kind === 'web'" class="app-primary-action" data-testid="open-platform" :href="safeHttpUrl(action.entry.url)" @click.prevent="emit('primary', app)" />
        <button v-else class="app-primary-action" data-testid="card-primary-agent" @click.stop="emit('primary', app)">{{ action.label }} <span aria-hidden="true">→</span></button>
      </div>
    </div>
  </article>
</template>

<style scoped>
.app-card { display: flex; height: var(--catalog-card-height); min-width: 0; flex-direction: column; padding: 18px 20px; border: 1px solid rgb(32 42 59 / .07); border-radius: 16px; background: var(--plaza-surface); box-shadow: 0 1px 2px rgb(28 37 51 / .03); cursor: pointer; position: relative; transition: transform .18s cubic-bezier(.2,.7,.3,1), border-color .18s, box-shadow .18s; }
.app-card:hover { transform: translateY(-2px); border-color: rgb(32 42 59 / .09); box-shadow: 0 16px 36px -18px rgb(28 37 51 / .30), 0 2px 4px rgb(28 37 51 / .05); }
.app-card:has(:focus-visible) { outline: 2px solid var(--plaza-brand); outline-offset: 2px; }
.app-card-top { display: flex; min-height: 30px; flex-shrink: 0; align-items: center; gap: 8px; padding-right: 0 }
.app-card-top :deep(.favorite-button) { position: relative; z-index: 2; margin: -4px -6px -4px 0; }
.app-card-identity { display: flex; min-width: 0; flex: 1; align-items: baseline; gap: 8px; }
.app-title { display: block; min-width: 0; overflow: hidden; padding: 0; border: 0; background: transparent; color: var(--plaza-ink); font: inherit; font-size: 16px; font-weight: 650; line-height: 24px; text-align: left; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.app-title:hover { color: var(--plaza-brand); }
.app-card-identity .app-version { display: inline-block; flex: none; margin: 0; padding: 0 0 0 8px; border: 0; border-left: 1px solid rgb(32 42 59 / .18); border-radius: 0; background: transparent; color: #5f6b7d; font-size: 11.5px; font-weight: 500; line-height: 18px; white-space: nowrap; }
.app-summary { display: -webkit-box; height: 40px; min-height: 40px; margin: 8px 0 10px; overflow: hidden; color: var(--plaza-text); font-size: 13px; line-height: 20px; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.app-tags { display: flex; height: 22px; min-height: 22px; flex-wrap: nowrap; align-items: center; gap: 6px; margin-top: auto; overflow: hidden; }
.app-category { display: inline-flex; height: 22px; flex: none; align-items: center; padding: 0 8px; border-radius: 999px; background: var(--plaza-brand-soft); color: #3549b8; font-size: 11px; line-height: 22px; white-space: nowrap; }
.app-category.agent { background: #e4f0e9; color: #256b4e; }
.app-format, .app-tag, .app-tag-more { max-width: calc(50% - 3px); min-width: 0; height: 22px; flex: 0 1 auto; overflow: hidden; padding: 0 8px; border: 0; border-radius: 999px; background: #f3f1ec; color: var(--plaza-text); font: inherit; font-size: 11px; line-height: 22px; text-overflow: ellipsis; white-space: nowrap; }
.app-format { max-width: 110px; }
.app-tag { max-width: calc((100% - 84px) / 3); cursor: pointer; }
.app-tag:hover, .app-tag.active { background: var(--plaza-brand-soft); color: var(--plaza-brand); }
.app-tag-more { max-width: none; flex: none; padding: 0 2px; background: transparent; color: var(--plaza-muted); }
.app-card-footer { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; padding-top: 10px; margin-top: 10px; border-top: 1px solid rgb(32 42 59 / .06); }
.app-card-footer.has-entry-reason { grid-template-columns: minmax(72px, 1fr) minmax(0, 1.5fr); }
.has-entry-reason .app-meta { min-width: 0; }
.app-author { display: inline-flex; max-width: 150px; min-width: 0; align-items: center; gap: 5px; overflow: hidden; color: var(--plaza-text); font-size: 12px; line-height: 18px; white-space: nowrap; }
.app-author-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.app-author-icon { width: 14px; height: 14px; flex: none; color: #8a93a2; }
.app-meta { position: relative; display: flex; min-width: 120px; height: 32px; align-items: center; justify-content: flex-end; font-variant-numeric: tabular-nums; }
.app-dates { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; color: #6b7383; font-size: 10.5px; line-height: 1.3; text-align: right; white-space: nowrap; transition: opacity .14s, transform .14s; }
.app-dates time:last-child { color: var(--plaza-text); font-size: 12px; }
.app-card:hover .app-dates, .app-card:focus-within .app-dates { opacity: 0; pointer-events: none; transform: translateX(-3px); }
.app-primary-action { position: absolute; right: 0; top: 50%; z-index: 2; display: inline-flex; min-height: 24px; align-items: center; gap: 3px; padding: 3px 0; border: 0; border-radius: 0; background: transparent; color: var(--plaza-brand); font: inherit; font-size: 12px; font-weight: 600; line-height: 18px; white-space: nowrap; text-decoration: none; cursor: pointer; opacity: 0; pointer-events: none; transform: translate(4px, -50%); transition: opacity .14s, transform .14s; }
.app-card:hover .app-primary-action, .app-card:focus-within .app-primary-action { opacity: 1; transform: translate(0, -50%); animation: primary-pointer-ready 0s .14s forwards; }
/* Keep the outgoing date's hit area until the replacement action has finished fading in. */
@keyframes primary-pointer-ready { to { pointer-events: auto; } }
.app-meta :deep(.platform-open-button) { min-height: 24px; padding: 3px 0; border: 0; border-radius: 0; background: transparent; color: var(--plaza-brand); font-size: 12px; font-weight: 600; line-height: 18px; }
.app-meta :deep(.platform-open-button:hover) { background: transparent; border-color: transparent; color: var(--plaza-brand); }
.app-primary-reason { display: -webkit-box; max-width: 180px; min-width: 0; margin: 0; overflow: hidden; overflow-wrap: anywhere; color: var(--plaza-muted); font-size: 11px; line-height: 1.4; text-align: right; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
@media (min-width: 761px) and (max-height: 800px) {
  .app-card { padding: 14px 20px 12px; }
  .app-summary { height: 20px; min-height: 20px; margin: 5px 0 7px; -webkit-line-clamp: 1; }
  .app-card-footer { padding-top: 8px; margin-top: 8px; }
}

.app-title:focus-visible, button:focus-visible { outline: 3px solid var(--plaza-brand); outline-offset: 2px; }
@media (hover: none) and (any-hover: none) {
  .app-card { height: auto; min-height: var(--catalog-card-height); }
  .app-dates { display: none; }
  .app-meta { min-width: 0; height: auto; }
  .app-primary-action { position: static; opacity: 1; pointer-events: auto; transform: none; }
  .app-primary-action, .app-meta :deep(.platform-open-button) { min-height: 44px; padding: 10px 0; }
  .app-card:hover .app-primary-action, .app-card:focus-within .app-primary-action { transform: none; animation: none; }
  .app-primary-reason { display: block; overflow: visible; -webkit-line-clamp: unset; }
}
@media (prefers-reduced-motion: reduce) {
  .app-card, .app-card:hover, .app-primary-action, .app-dates { transition: none; }
  .app-card:hover { transform: none; }
  .app-card:hover .app-dates, .app-card:focus-within .app-dates { transform: none; }
  .app-card:hover .app-primary-action, .app-card:focus-within .app-primary-action { pointer-events: auto; animation: none; }
}
</style>
