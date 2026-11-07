<script setup>
import { computed } from 'vue'
import PlazaIcon from './PlazaIcon.vue'
const props=defineProps({app:{type:Object,required:true}})
const appearance=computed(()=>{
  const tags=(props.app.tags||props.app.manifest?.tags||[]).join(' ')
  if(/设计|原型/.test(tags))return {tone:'peach',icon:'catalog'}
  if(/研发|代码/.test(tags))return {tone:'mint',icon:'agent'}
  if(/质量|测试/.test(tags))return {tone:'mint',icon:'access'}
  if(/数据/.test(tags))return {tone:'blue',icon:'operations'}
  if(/协作|会议/.test(tags))return {tone:'rose',icon:'groups'}
  return {tone:'blue',icon:'drafts'}
})
</script>
<template><span class="app-emblem" :class="appearance.tone" aria-hidden="true"><PlazaIcon :name="appearance.icon"/></span></template>
<style scoped>
.app-emblem{display:grid;place-items:center;flex:none;width:42px;height:42px;border-radius:13px;border:1px solid rgb(255 255 255 / 70%);box-shadow:inset 0 -3px 8px rgb(30 40 65 / 3%);background:#e9edff;color:#3e58ce}
.app-emblem.peach{background:#fff0df;color:#9b571e}.app-emblem.mint{background:#e5f4ee;color:#287057}.app-emblem.rose{background:#f9e9ef;color:#a3486b}
.app-emblem :deep(svg){width:23px;height:23px}
</style>
