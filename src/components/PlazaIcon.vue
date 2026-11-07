<script setup>
import { LayoutGrid, Compass, Search, FilePenLine, Settings2, Plug, Users, ShieldCheck, ChartNoAxesCombined, Plus } from 'lucide'
defineProps({ name: String })
const icons = { catalog: LayoutGrid, random: Compass, search: Search, drafts: FilePenLine, management: Settings2, agent: Plug, groups: Users, access: ShieldCheck, operations: ChartNoAxesCombined, plus: Plus }
</script>
<template><svg class="plaza-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><component v-for="([tag,attrs],i) in icons[name]||icons.catalog" :key="i" :is="tag" v-bind="attrs"/></svg></template>
<style scoped>.plaza-icon{flex:none;vertical-align:middle}</style>
