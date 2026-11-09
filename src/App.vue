<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import ToolDirectory from './pages/ToolDirectory.vue'
import PortalFrame from './components/PortalFrame.vue'
import AppManagement from './pages/AppManagement.vue'
import IdentityBar from './components/IdentityBar.vue'
import IdentityGroups from './components/IdentityGroups.vue'
import PersonalSpace from './pages/PersonalSpace.vue'
import { identity } from './lib/identity.js'
import { publicBasePath, publicPath } from './lib/public-path.js'
import { primaryAction } from './lib/catalog.ts'

const showPrototype = computed(() => new URLSearchParams(window.location.search).get('prototype') === '1')
const showManagement = computed(() => ['/admin', '/private-previews'].includes(window.location.pathname.slice(publicBasePath().length).replace(/\/$/, '')))
const showGroups = ref(false)
const showPersonal = ref(false), detailFromPersonal = ref(false), directory = ref(null)
let personalFocus = null
let initialPersonalPending = new URLSearchParams(location.search).get('space') === 'favorites'
watch(() => identity.epoch, () => {
  showGroups.value = false; showPersonal.value = false; detailFromPersonal.value = false
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
function showFavorites() {
  if (showManagement.value) { location.assign(publicPath('/?space=favorites')); return }
  showGroups.value = false; showPersonal.value = true; detailFromPersonal.value = false
}
function filterTag(tag) { showPersonal.value = false; detailFromPersonal.value = false; directory.value?.filterByTag(tag) }
async function usePersonalApp(app) {
  if (primaryAction(app).entry?.kind === 'agent') await openPersonalApp(app.id)
  await directory.value?.usePrimary(app)
}
</script>

<template>
  <PortalFrame v-if="showPrototype" />
  <div v-else :class="identity.enabled ? 'identity-layout plaza-public' : 'identity-disabled'">
    <IdentityBar @groups="showGroups = true; showPersonal = false" @personal="showFavorites" />
    <IdentityGroups v-if="showGroups && identity.user?.identityAdmin" :key="identity.epoch" @close="showGroups = false" />
    <PersonalSpace v-if="identity.user && (showPersonal || detailFromPersonal)" v-show="showPersonal" :key="identity.epoch" @close="showPersonal = false" @detail="openPersonalApp" @primary="usePersonalApp" @tag="filterTag" />
    <AppManagement v-show="!showGroups && !showPersonal" v-if="showManagement && !detailFromPersonal" />
    <ToolDirectory v-show="!showGroups && !showPersonal" v-else ref="directory" :personal-return="detailFromPersonal" @return="returnToPersonal" />
  </div>
</template>

<style>
.identity-disabled { display: contents; }
.identity-layout { display: flex; flex-direction: column; height: 100dvh; overflow: hidden; }
.identity-layout > .directory-shell, .identity-layout > .publication-shell, .identity-layout > .management-shell { flex: 1; min-height: 0; height: auto; }
</style>
