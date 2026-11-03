<script setup>
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import PlatformOpenButton from './PlatformOpenButton.vue'
import { createPortalParentEntry } from '../lib/portal-parent-entry.ts'

const props = defineProps({ policy: { type: Object, required: true }, confirmPolicy: { type: Function, required: true }, variant: { type: String, default: 'card' } })
const ready = ref(false)
const messages = { POPUP_BLOCKED: '浏览器阻止了伏羲窗口，请允许打开后重试。', POLICY_DISABLED: '入口已停用或配置发生变化，请重新进入。', POLICY_UNAVAILABLE: '无法确认入口状态，请稍后重试。', REQUEST_EXPIRED: '本次入口已过期，请重新进入。', CREDENTIAL_MISSING: '未取得天宫登录状态，请在天宫登录后重试。', HANDOFF_FAILED: '身份交接未完成，请重新进入。' }
let launcher
const reset = () => {
  launcher?.dispose()
  ready.value = false
  launcher = createPortalParentEntry(window, props.policy, props.confirmPolicy, value => { ready.value = value }, code => { if (messages[code]) ElMessage.error(messages[code]) })
}
onMounted(reset)
watch(() => props.policy, reset)
onUnmounted(() => launcher?.dispose())
</script>

<template>
  <PlatformOpenButton :disabled="!ready" :class="{ 'platform-open-button--wide': variant === 'detail' }" data-testid="open-platform" @click="launcher?.launch($event)" />
</template>

<style scoped>
.platform-open-button--wide { width: 100%; }
</style>
