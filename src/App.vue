<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import ToolDirectory from './pages/ToolDirectory.vue'
import PortalFrame from './components/PortalFrame.vue'
import AppManagement from './pages/AppManagement.vue'
import PlazaRail from './components/PlazaRail.vue'
import IdentityGroups from './components/IdentityGroups.vue'
import PersonalSpace from './pages/PersonalSpace.vue'
import OperationsDashboard from './pages/OperationsDashboard.vue'
import AdministrationCenter from './pages/AdministrationCenter.vue'
import { identity } from './lib/identity.js'
import { publicBasePath, publicPath } from './lib/public-path.js'
import { primaryAction } from './lib/catalog.ts'

const showPrototype = computed(() => new URLSearchParams(window.location.search).get('prototype') === '1')
const showManagement = computed(() => ['/admin', '/private-previews'].includes(window.location.pathname.slice(publicBasePath().length).replace(/\/$/, '')))
const showGroups = ref(false)
const showPersonal = ref(false), detailFromPersonal = ref(false), directory = ref(null)
const discoverView = ref(new URLSearchParams(location.search).get('discover') === 'random' ? 'random' : 'catalog')
let personalFocus = null
let initialPersonalPending = new URLSearchParams(location.search).get('space') === 'favorites'
const center = new URLSearchParams(location.search).get('space') || ''
const isCenter = ['operations', 'governance', 'administrators', 'transfers'].includes(center)
const centerAllowed = computed(() => center === 'transfers' ? Boolean(identity.user) : center === 'administrators' ? identity.user?.superAdministrator : identity.user?.administrator)
let initialGroupPending = center === 'groups'
const railActive = computed(() => {
  if (showManagement.value) return 'mine'
  if (isCenter) return { operations: 'dashboard', governance: 'governance', administrators: 'admins', transfers: 'handover' }[center] || ''
  if (showGroups.value) return 'groups'
  if (showPersonal.value) return 'favorites'
  return discoverView.value
})
watch(() => identity.epoch, () => {
  showGroups.value = false; showPersonal.value = false; detailFromPersonal.value = false
  if (initialGroupPending && identity.user?.identityAdmin) { initialGroupPending = false; showGroups.value = true }
  if (initialPersonalPending && identity.user) {
    initialPersonalPending = false
    detailFromPersonal.value = new URLSearchParams(location.search).has('app')
    showPersonal.value = !detailFromPersonal.value
  }
})
async function openPersonalApp(id) {
  personalFocus = document.activeElement
  showPersonal.value = false; detailFromPersonal.value = true
  await nextTick()
  await directory.value?.openApp(id)
}
async function returnToPersonal() {
  if (!detailFromPersonal.value) return
  detailFromPersonal.value = false; showPersonal.value = true
  await nextTick()
  personalFocus?.focus({ preventScroll: true })
}
function filterTag(tag) { showPersonal.value = false; detailFromPersonal.value = false; directory.value?.filterByTag(tag) }
function showFavorites() {
  if (showManagement.value || isCenter) { location.assign(publicPath('/?space=favorites')); return }
  showGroups.value = false; showPersonal.value = true; detailFromPersonal.value = false
}
function openGroups() {
  if (showManagement.value || isCenter) { location.assign(publicPath('/?space=groups')); return }
  showGroups.value = true; showPersonal.value = false
}
function showDiscovery(tab) {
  discoverView.value = tab
  const preview = new URLSearchParams(location.hash.replace(/^#/, '')).has('publish')
  if (preview || showManagement.value || isCenter) {
    location.assign(publicPath(tab === 'random' ? '/?discover=random' : '/'))
    return
  }
  showGroups.value = false
  showPersonal.value = false
  detailFromPersonal.value = false
  if (directory.value) { void directory.value.selectDiscovery(tab); return }
  location.assign(publicPath(tab === 'random' ? '/?discover=random' : '/'))
}
async function usePersonalApp(app) {
  if (primaryAction(app).entry?.kind === 'agent') await openPersonalApp(app.id)
  await directory.value?.usePrimary(app)
}
</script>

<template>
  <PortalFrame v-if="showPrototype" />
  <div v-else class="plaza-app plaza-public">
    <PlazaRail :active="railActive" @discover="showDiscovery" @favorites="showFavorites" @groups="openGroups" />
    <div class="plaza-content">
      <IdentityGroups v-if="showGroups && identity.user?.identityAdmin" :key="identity.epoch" @close="showGroups = false" />
      <PersonalSpace v-if="identity.user && (showPersonal || detailFromPersonal)" v-show="showPersonal" :key="identity.epoch" @close="showPersonal = false" @detail="openPersonalApp" @primary="usePersonalApp" @tag="filterTag" />
      <template v-if="isCenter">
        <OperationsDashboard v-if="centerAllowed && center === 'operations'" :key="identity.epoch" />
        <AdministrationCenter v-else-if="centerAllowed" :key="identity.epoch" :mode="center" />
        <main v-else class="center-denied plaza-public"><h1>{{ identity.user ? '当前身份没有此页面权限' : '请先核验天宫身份' }}</h1><p>运营看板与治理功能仅对获授权管理员开放，应用交接需本人登录。</p><a :href="publicPath('/')">返回应用广场</a></main>
      </template>
      <template v-else>
        <AppManagement v-show="!showGroups && !showPersonal" v-if="showManagement && !detailFromPersonal" :key="identity.epoch" />
        <ToolDirectory v-show="!showGroups && !showPersonal" v-else :key="identity.epoch" ref="directory" :personal-return="detailFromPersonal" :discover="discoverView" @discover="discoverView = $event" @return="returnToPersonal" />
      </template>
    </div>
  </div>
</template>

<style>
.plaza-app { display: grid; grid-template-columns: 252px minmax(0, 1fr); height: 100dvh; overflow: hidden; background: var(--plaza-canvas); }
.plaza-content { display: flex; min-width: 0; min-height: 0; flex-direction: column; overflow: hidden; }
.plaza-content > * { flex: 1; min-height: 0; }
.center-denied { padding: 32px; color: var(--plaza-ink); }.center-denied p { color: var(--plaza-muted); }.center-denied a { color: var(--plaza-brand); }
@media (max-width: 760px) { .plaza-app { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); width: 100%; max-width: 100vw; } .plaza-content { overflow: auto; min-width: 0; width: 100%; } }
</style>
