<script setup>
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { createFuxiWidgetResponder } from '../lib/fuxi-widget.ts'

const props = defineProps({
  policy: { type: Object, required: true },
  confirmPolicy: { type: Function, required: true },
  variant: { type: String, default: 'card' },
})
const iframe = ref(null)
const statusMessages = {
  STORAGE_DENIED: '浏览器未允许读取天宫登录状态，请在天宫入口重试。',
  REQUEST_EXPIRED: '本次入口请求已过期，请重新进入。',
  POPUP_BLOCKED: '浏览器阻止了伏羲窗口，请允许此入口打开窗口后重试。',
  POLICY_UNAVAILABLE: '无法确认伏羲入口，请稍后重试。',
  POLICY_DISABLED: '伏羲入口已停用或配置不符，请联系维护者。',
  CREDENTIAL_MISSING: '未取得天宫登录凭证，请在天宫登录后重试。',
  HANDOFF_FAILED: '本次身份交接未完成，请重新进入。',
}
let responder
const reset = () => {
  responder?.dispose()
  responder = createFuxiWidgetResponder(window, props.policy, () => iframe.value?.contentWindow || null, props.confirmPolicy,
    code => { if (Object.hasOwn(statusMessages, code)) ElMessage.error(statusMessages[code]) })
}
onMounted(reset)
watch(() => props.policy, () => { if (iframe.value) reset() })
onUnmounted(() => responder?.dispose())
</script>

<template>
  <iframe
    ref="iframe"
    class="fuxi-widget"
    :class="`fuxi-widget--${variant}`"
    :src="policy.widget.url"
    title="从天宫进入伏羲"
    data-testid="fuxi-portal-widget"
    sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-storage-access-by-user-activation"
    allow="storage-access"
    referrerpolicy="no-referrer"
  />
</template>

<style scoped>
.fuxi-widget { display: block; border: 0; height: 30px; max-width: 100%; }
/* Keep the portal's label on one line when the browser raises its minimum font size. */
.fuxi-widget--card { width: 144px; flex-shrink: 0; }
.fuxi-widget--detail { width: 100%; }
</style>
