<script setup>
import { computed,ref,onUnmounted } from 'vue'
import AppEmblem from './AppEmblem.vue'
import PlatformOpenButton from './PlatformOpenButton.vue'
import { appFormats, catalogUsage, primaryAction, safeHttpUrl } from '../lib/catalog.ts'
const props = defineProps({ app: { type: Object, required: true }, selectedTags: { type: Array, default: () => [] } })
const emit = defineEmits(['detail', 'primary', 'tag'])
const action = computed(() => primaryAction(props.app))
const name = computed(() => props.app.manifest?.name || '未命名应用')
const tags = computed(() => props.app.tags || props.app.manifest?.tags || [])
const hoverOpen=ref(false),keyboardOpen=ref(false)
let hoverTimer,selecting=false,dismissed=false
function dismissHover(){clearTimeout(hoverTimer);hoverTimer=undefined;hoverOpen.value=false}
function hover(event){
  if(dismissed||event.pointerType==='touch'||!matchMedia('(hover: hover) and (pointer: fine)').matches)return
  if(event.target.closest('.app-tag')||selecting){dismissHover();return}
  if(!hoverOpen.value&&!hoverTimer)hoverTimer=setTimeout(()=>{hoverOpen.value=true;hoverTimer=undefined},120)
}
function leave(){dismissHover();selecting=false;dismissed=false}
function focus(event){keyboardOpen.value=!event.target.closest('.app-tag')}
function blur(event){if(!event.currentTarget.contains(event.relatedTarget))keyboardOpen.value=false}
function beginSelection(event){if(!event.target.closest('button,a')){selecting=true;dismissHover()}}
function closeActions(event){dismissed=true;dismissHover();event.currentTarget.querySelector('.app-title')?.focus({preventScroll:true});keyboardOpen.value=false}
onUnmounted(()=>clearTimeout(hoverTimer))
const author = computed(() => {
  const value = props.app.manifest?.maintainers
  return (Array.isArray(value) ? value : value ? [value] : []).map(item => typeof item === 'string' ? item : item?.name).filter(Boolean).join('、') || '作者未登记'
})
function date(value) {
  const parsed = new Date(value)
  return !value || Number.isNaN(parsed.getTime()) ? '未登记' : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(parsed).replaceAll('/', '-')
}
function detail(event) {
  if (event.target.closest('button, a') && !event.target.closest('.app-title')) return
  const selection = window.getSelection()
  if (selection?.toString() && (event.currentTarget.contains(selection.anchorNode) || event.currentTarget.contains(selection.focusNode))) return
  emit('detail', props.app.id)
}
</script>

<template>
  <article class="app-card" :class="{'actions-open':hoverOpen||keyboardOpen,'keyboard-open':keyboardOpen}" data-testid="app-card" :data-app-id="app.id" :data-usage="catalogUsage(app)" @click="detail" @pointerover="hover" @pointerleave="leave" @pointerdown="beginSelection" @focusin="focus" @focusout="blur" @keydown.esc="closeActions">
    <div class="app-card-top">
      <AppEmblem :app="app"/>
      <div class="app-card-identity"><button class="app-title" :aria-label="`查看 ${name} 详情`">{{ name }}</button><span v-if="app.version" class="app-version">{{ /^\d/.test(app.version) ? `v${app.version}` : app.version }}</span></div>
    </div>
    <p class="app-summary">{{ app.manifest?.summary || '暂无应用简介。' }}</p>
    <div class="app-tags" aria-label="应用形态与能力标签">
      <span v-for="format in appFormats(app)" :key="format" class="app-format" data-testid="app-format">{{ format }}</span>
      <button v-for="tag in tags.slice(0, 3)" :key="tag" class="app-tag" :class="{ active: selectedTags.includes(tag) }" :aria-label="`按标签 ${tag} 筛选`" @click.stop="emit('tag', tag)">{{ tag }}</button>
      <span v-if="tags.length > 3" class="app-tag-more">+{{ tags.length - 3 }}</span>
    </div>
    <div class="app-card-footer">
      <span class="app-author">{{ author }}</span>
      <div class="app-dates">
        <time :datetime="app.createdAt">创建 {{ date(app.createdAt) }}</time>
        <time :datetime="app.updatedAt">更新 {{ date(app.updatedAt) }}</time>
      </div>
    </div>
    <div class="card-actions">
      <div class="card-action-content"><div class="card-action-buttons">
        <PlatformOpenButton v-if="action.entry?.kind === 'web' && !action.reason" data-testid="open-platform" :href="safeHttpUrl(action.entry.url)" @click.prevent="emit('primary', app)" />
        <button v-else class="card-primary" :data-testid="action.entry?.kind === 'agent' ? 'card-primary-agent' : 'unavailable-entry'" :disabled="!!action.reason" :aria-describedby="action.reason ? `entry-reason-${app.id}` : undefined" @click.stop="emit('primary', app)">{{ action.label }}</button>
        <button class="card-detail" data-testid="card-detail" @click.stop="emit('detail', app.id)">查看详情</button>
      </div>
      <p v-if="action.reason" :id="`entry-reason-${app.id}`" class="card-entry-reason" data-testid="primary-disabled-reason">{{ action.reason }}</p>
      </div>
    </div>
  </article>
</template>

<style scoped>
.app-card { display: flex; height: var(--catalog-card-height); min-width: 0; flex-direction: column; padding: 20px; border: 1px solid var(--plaza-line,#e4e6ec); border-radius: var(--plaza-radius,16px); background: #fff; box-shadow: var(--plaza-shadow); transition: border-color .16s ease-out, box-shadow .16s ease-out; }
.app-card { cursor: pointer; }
.app-card:hover { border-color: #ccd6e4; box-shadow: 0 5px 15px rgb(25 43 67 / 5%); }
.app-card-top { display: flex; min-height: 44px; flex-shrink: 0; align-items: center; gap: 12px; padding-right:0 }
.app-card-identity{min-width:0;flex:1}.app-card-identity .app-version{display:inline-block;margin:4px 0 0;padding:0;background:transparent;color:var(--plaza-muted);font-size:11px}
.app-title { display: -webkit-box; min-width: 0; padding: 0; overflow: hidden; border: 0; background: transparent; color: #253044; font: inherit; font-size: 16px; font-weight: 650; line-height: 1.45; text-align: left; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; cursor: pointer; }
.app-title:hover { color: #315fbd; }
.app-version, .public-app-version { flex: none; padding: 2px 7px; border: 0; border-radius: 5px; background: #669cde; color: #fff; font-size: 11px; line-height: 1.3; white-space: nowrap; }
.app-summary { display: -webkit-box; height: 40px; min-height: 40px; margin: 10px 0 8px; overflow: hidden; color: #657184; font-size: 13px; line-height: 20px; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.app-tags { display: flex; height: 22px; min-height: 22px; flex-wrap: nowrap; align-items: flex-start; gap: 6px; margin-top: auto; overflow: hidden; }
.app-format { flex: none; padding: 3px 7px; border: 1px solid #d5e2ff; border-radius: 4px; background: #edf3ff; color: #315fbd; font-size: 11px; line-height: 1.25; white-space: nowrap; }
.app-tag, .app-tag-more { max-width: calc(50% - 3px); overflow: hidden; padding: 3px 7px; border: 1px solid #e5e9ef; border-radius: 4px; background: #fafbfc; color: #596477; font: inherit; font-size: 11px; line-height: 1.25; text-overflow: ellipsis; white-space: nowrap; }
.app-tag { cursor: pointer; }
.app-tag:hover, .app-tag.active { border-color: #c2d1e7; background: #f1f5fb; color: #4a6792; }
.app-tag-more { border-color: transparent; background: transparent; color: #657085; }
.app-tag { max-width: calc((100% - 10px) / 3); min-width: 0; flex-shrink: 1; }
.app-card-footer { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; padding-top: 10px; margin-top: 10px; border-top: 1px solid #edf0f3; }
.app-card-author-action { display: flex; min-width: 0; align-items: center; gap: 10px; }
.app-author { max-width: 150px; overflow: hidden; color: #53647a; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.app-dates { display: grid; gap: 2px; color: #657085; font-size: 11px; line-height: 1.4; text-align: right; white-space: nowrap; }
@media (min-width: 761px) and (max-height: 800px) {
  .app-card { padding: 12px 20px; }
  .app-summary { margin: 6px 0; }
  .app-card-footer { padding-top: 6px; margin-top: 6px; }
}

.app-card { position: relative; }

.card-actions { position:absolute;inset:0;display:grid;place-items:center;border-radius:inherit;background:linear-gradient(150deg,rgb(64 83 117 / 54%),rgb(44 62 94 / 62%));opacity:0;pointer-events:none;transition:opacity .1s ease-out; }
.actions-open .card-actions { opacity:1;transition:opacity .16s cubic-bezier(.2,.8,.2,1); }
/* A single opacity transition keeps the mask and its controls in the same visual beat. */
.card-action-content{max-width:100%;padding:24px 20px}
.actions-open .card-action-buttons > * { pointer-events:auto; }
.keyboard-open .card-actions,.keyboard-open .card-action-content{transition:none}
.card-action-buttons { display:flex;align-items:center;justify-content:center;gap:8px; }
.card-primary, .card-detail, .card-actions :deep(.platform-open-button) { min-height: 40px; box-shadow:0 2px 6px rgb(15 30 55 / 8%); transition:background-color .12s ease-out,box-shadow .12s ease-out; border: 1px solid #d6dde7; border-radius: 9px; padding: 8px 10px; background: #fff; color: #334ab4; font: inherit; font-size: 13px; line-height: 20px; white-space: nowrap; cursor: pointer; }
.card-detail{background:rgb(255 255 255 / 92%);border-color:rgb(255 255 255 / 75%);color:#405476}
.card-primary:hover:enabled, .card-detail:hover, .card-actions :deep(.platform-open-button:hover) { border-color: #a9bddf; background: #fff;box-shadow:0 4px 10px rgb(15 30 55 / 15%); }
.card-detail:hover{color:#334ab4}
.card-primary:disabled { color: #798595; cursor: not-allowed; }
.card-entry-reason { margin: 16px auto 0; max-width:280px; padding:8px 10px; border-radius:8px; background:rgb(255 255 255 / 92%); color:#26364e; font-size: 11px; line-height: 1.5; text-align: center; }
.app-title:focus-visible, button:focus-visible { outline: 3px solid #bfd3f5; outline-offset: 2px; }
@media (hover: none), (pointer: coarse) {
  .app-card { height: auto; min-height: var(--catalog-card-height); }
  .card-actions,.actions-open .card-actions { position: static; display: block; margin-top: 6px; padding-top: 4px; background: transparent; opacity: 1; transition:none; }
  .card-action-content {padding:0;}
  .card-action-buttons > * { pointer-events: auto; }
  .card-primary, .card-detail, .card-actions :deep(.platform-open-button) { min-height: 44px; }
  .app-card-top{padding-right:0}
  .card-detail{background:#fff;color:#334ab4;border-color:#d6dde7}
  .card-entry-reason { position: static; margin-top: 6px; padding:0; background:transparent; color: #8b4b37; }
}
@media (prefers-reduced-motion: reduce) { .app-card,.app-card:hover,.card-actions,.actions-open .card-actions,.card-action-content,.card-primary,.card-primary:hover:enabled,.card-detail,.card-detail:hover,.card-actions :deep(.platform-open-button),.card-actions :deep(.platform-open-button:hover){transition:none;transform:none} }
</style>
