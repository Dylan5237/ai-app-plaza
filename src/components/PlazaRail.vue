<script setup>
import { computed } from 'vue'
import IdentityBar from './IdentityBar.vue'
import PlazaIcon from './PlazaIcon.vue'
import { identity } from '../lib/identity.js'
import { publicBasePath, publicPath } from '../lib/public-path.js'
import { discoverTabFromParam } from '../lib/discovery.ts'

const props = defineProps({ active: { type: String, default: '' } })
const emit = defineEmits(['discover', 'favorites', 'groups'])

const path = window.location.pathname.replace(publicBasePath(), '').replace(/\/$/, '') || '/'
const params = new URLSearchParams(window.location.search)
const space = params.get('space')
const fallbackActive = path === '/admin'
  ? 'mine'
  : space === 'favorites'
    ? 'favorites'
    : space === 'groups'
      ? 'groups'
      : space === 'transfers'
        ? 'handover'
        : space === 'governance'
          ? 'governance'
          : space === 'operations'
            ? 'dashboard'
            : space === 'administrators'
              ? 'admins'
              : space === 'smart-search'
                ? 'smart-search'
                : discoverTabFromParam(params.get('discover'))
const active = computed(() => props.active || fallbackActive)
</script>

<template>
  <aside class="plaza-rail" aria-label="广场导航">
    <a class="rail-brand" :href="publicPath('/')" aria-label="AI 应用广场首页">
      <span class="rail-brand-mark" aria-hidden="true"><i /><i /><i /><i /></span>
      <span class="rail-brand-copy"><strong>AI 应用广场</strong><small>团队应用目录</small></span>
    </a>

    <nav class="rail-nav" aria-label="主导航">
      <p class="rail-group-label">浏览</p>
      <button class="rail-item" :class="{ active: active === 'catalog' }" :aria-current="active === 'catalog' ? 'page' : undefined" type="button" data-testid="tab-catalog" @click="emit('discover', 'catalog')">
        <PlazaIcon name="catalog" /><span>全部应用</span>
      </button>
      <button class="rail-item" :class="{ active: active === 'random' }" :aria-current="active === 'random' ? 'page' : undefined" type="button" data-testid="tab-random" @click="emit('discover', 'random')">
        <PlazaIcon name="random" /><span>随便看看</span>
      </button>
      <button class="rail-item" :class="{ active: active === 'search' }" :aria-current="active === 'search' ? 'page' : undefined" type="button" data-testid="tab-search" @click="emit('discover', 'search')">
        <PlazaIcon name="search" /><span>智能查找</span>
      </button>
      <button v-if="identity?.user" class="rail-item" :class="{ active: active === 'favorites' }" type="button" @click="emit('favorites')">
        <PlazaIcon name="bookmark" /><span>我的收藏</span>
      </button>
      <a v-if="!(identity?.user?.administrator || identity?.user?.superAdministrator || identity?.user?.identityAdmin)" class="rail-item" :class="{ active: active === 'mine' }" :aria-current="active === 'mine' ? 'page' : undefined" :href="publicPath('/admin')">
        <PlazaIcon name="management" /><span>管理中心</span>
      </a>

      <p v-if="identity?.user" class="rail-group-label">我的</p>
      <a v-if="identity?.user" class="rail-item" :class="{ active: active === 'mine' }" :aria-current="active === 'mine' ? 'page' : undefined" :href="publicPath('/admin')">
        <PlazaIcon name="management" /><span>我的应用</span>
      </a>
      <a v-if="identity?.user" class="rail-item" :class="{ active: active === 'handover' }" :aria-current="active === 'handover' ? 'page' : undefined" :href="publicPath('/?space=transfers')">
        <PlazaIcon name="handover" /><span>应用交接</span>
      </a>

      <template v-if="identity?.user?.administrator || identity?.user?.superAdministrator || identity?.user?.identityAdmin">
        <p class="rail-group-label">管理中心</p>
        <a v-if="identity?.user?.administrator || identity?.user?.superAdministrator" class="rail-item" :class="{ active: active === 'dashboard' }" :aria-current="active === 'dashboard' ? 'page' : undefined" :href="publicPath('/?space=operations')">
          <PlazaIcon name="operations" /><span>运营看板</span>
        </a>
        <a v-if="identity?.user?.administrator || identity?.user?.superAdministrator" class="rail-item" :class="{ active: active === 'governance' }" :aria-current="active === 'governance' ? 'page' : undefined" :href="publicPath('/?space=governance')">
          <PlazaIcon name="access" /><span>应用负责人</span>
        </a>
        <button v-if="identity?.user?.identityAdmin" class="rail-item" :class="{ active: active === 'groups' }" type="button" @click="emit('groups')">
          <PlazaIcon name="groups" /><span>成员与小组</span>
        </button>
        <a v-if="identity?.user?.superAdministrator" class="rail-item" :class="{ active: active === 'smart-search' }" :aria-current="active === 'smart-search' ? 'page' : undefined" :href="publicPath('/?space=smart-search')">
          <PlazaIcon name="agent" /><span>智能查找</span>
        </a>
        <a v-if="identity?.user?.superAdministrator" class="rail-item" :class="{ active: active === 'admins' }" :aria-current="active === 'admins' ? 'page' : undefined" :href="publicPath('/?space=administrators')">
          <PlazaIcon name="admins" /><span>管理员配置</span>
        </a>
      </template>
    </nav>

    <div class="rail-foot">
      <p class="rail-slogan">让好用的应用，被更多人发现</p>
      <IdentityBar rail />
    </div>
  </aside>
</template>

<style scoped>
.plaza-rail { display: flex; min-height: 0; flex-direction: column; padding: 22px 14px 16px; border-right: 1px solid var(--plaza-line); background: var(--plaza-canvas); overflow-y: auto; }
.rail-brand { display: flex; align-items: center; gap: 11px; padding: 2px 8px 20px; color: inherit; text-decoration: none; }
.rail-brand:hover .rail-brand-copy strong { color: var(--plaza-brand); }
.rail-brand-mark { display: grid; width: 27px; height: 27px; flex: none; grid-template-columns: repeat(2, 12px); grid-template-rows: repeat(2, 12px); gap: 3px; transform: rotate(-7deg); }
.rail-brand-mark i { border-radius: 3px; background: #3549be; }
.rail-brand-mark i:nth-child(2) { border-radius: 3px 8px 3px 3px; background: #ffae7e; }
.rail-brand-mark i:nth-child(3) { background: #aeb9f4; }
.rail-brand-mark i:nth-child(4) { border-radius: 3px 3px 7px 3px; background: #3549be; }
.rail-brand-copy { display: grid; gap: 1px; }
.rail-brand-copy strong { font-size: 15px; font-weight: 650; line-height: 1.3; letter-spacing: -.01em; color: var(--plaza-ink); transition: color .12s; }
.rail-brand-copy small { color: #5f6878; font-size: 11px; line-height: 1.3; }
.rail-nav { display: flex; flex-direction: column; gap: 2px; }
.rail-group-label { margin: 16px 0 5px; padding: 0 10px; color: #5f6878; font-size: 11px; font-weight: 600; letter-spacing: .08em; }
.rail-group-label:first-child { margin-top: 2px; }
.rail-item { display: flex; width: 100%; height: 36px; align-items: center; gap: 10px; padding: 0 10px; border: 0; border-radius: 10px; background: transparent; color: #3f4a5c; font: inherit; font-size: 13px; font-weight: 500; text-align: left; text-decoration: none; white-space: nowrap; cursor: pointer; transition: background .12s, color .12s; }
.rail-item :deep(svg) { width: 17px; height: 17px; flex: none; color: #7a8393; }
.rail-item:hover { background: rgb(32 42 59 / .05); color: var(--plaza-ink); }
.rail-item.active { background: var(--plaza-surface); color: #2e45b8; font-weight: 600; box-shadow: 0 1px 2px rgb(28 37 51 / .06), 0 0 0 1px rgb(32 42 59 / .04); }
.rail-item.active :deep(svg) { color: var(--plaza-brand); }
.rail-item:focus-visible { outline: 2px solid var(--plaza-brand); outline-offset: 1px; }
.rail-foot { margin-top: auto; padding-top: 18px; }
.rail-slogan { margin: 0 10px 12px; color: #67707f; font-size: 11px; line-height: 1.6; }
@media (max-width: 760px) {
  .plaza-rail { padding: 10px 12px 8px; overflow: visible; min-width: 0; max-width: 100vw; overflow-x: hidden; }
  .rail-brand { padding: 0 4px 9px; }
  .rail-brand-copy small { display: none; }
  .rail-nav { display: flex; flex-direction: row; flex-wrap: nowrap; gap: 4px; overflow-x: auto; padding-bottom: 4px; scrollbar-width: none; min-width: 0; max-width: 100%; }
  .rail-nav::-webkit-scrollbar { display: none; }
  .rail-group-label { display: none; }
  .rail-item { width: auto; height: 34px; flex: 0 0 auto; justify-content: flex-start; padding: 0 10px; font-size: 12px; gap: 6px; }
  .rail-item :deep(svg) { width: 15px; height: 15px; }
  .rail-foot { margin-top: 0; padding-top: 6px; min-width: 0; }
  .rail-slogan { display: none; }
}
@media (max-width: 760px) and (max-height: 480px) {
  .plaza-rail { padding: 6px 10px; }
  .rail-brand { padding: 0 2px 5px; }
  .rail-brand-mark { width: 22px; height: 22px; grid-template-columns: repeat(2, 10px); grid-template-rows: repeat(2, 10px); gap: 2px; }
  .rail-brand-copy strong { font-size: 13px; }
  .rail-item { height: 30px; font-size: 11.5px; }
  .rail-foot { display: block; padding-top: 3px; }
}
</style>
