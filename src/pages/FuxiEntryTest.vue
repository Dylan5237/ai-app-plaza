<script setup>
import { onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { apiRequest } from '../lib/api.js'
import { createFuxiLauncher } from '../lib/fuxi-entry.ts'
import { requestPortalCredential } from '../lib/tiangong-credential.ts'

const profile = ref(null)
const error = ref('')
const notice = ref('')
const launcher = shallowRef(null)
const sameProfile = (left, right) => right?.enabled === true && left.plazaOrigin === right.plazaOrigin &&
  left.portalOrigin === right.portalOrigin && left.fuxiOrigin === right.fuxiOrigin
onMounted(async () => {
  try {
    profile.value = await apiRequest('/api/integration/fuxi-test/config')
    if (!profile.value?.enabled) { error.value = '伏羲测试接入尚未启用。'; return }
    if (!window.opener) { error.value = '请从已登录天宫的专用测试页打开此入口。'; return }
    const fixed = { ...profile.value }
    launcher.value = createFuxiLauncher(window, message => { error.value = message; notice.value = '' }, {
      getCredential: signal => requestPortalCredential(window, fixed.portalOrigin, signal),
      confirmPolicy: async () => sameProfile(fixed, await apiRequest('/api/integration/fuxi-test/config')),
    })
  } catch { error.value = '测试配置暂不可用，请从天宫专用测试页重试。' }
})
function enter() {
  if (!launcher.value || !profile.value?.enabled) return
  error.value = ''
  notice.value = '请在新打开的伏羲页面查看验证结果；发送凭证不代表登录成功。'
  launcher.value.launch({ ...profile.value, appId: 'fuxi-test', entryId: 'fuxi-test' })
}
onUnmounted(() => launcher.value?.dispose())
</script>

<template>
  <main class="fuxi-test-page">
    <p class="test-label">测试环境 · 16077</p>
    <h1>天宫身份进入伏羲</h1>
    <p>此入口用于验证天宫与伏羲测试环境的身份交接。共享目录中的正式伏羲入口保持原地址。</p>
    <p>请先在天宫登录，再从天宫专用测试页打开本页。仅点击下方按钮时请求本次登录凭证。</p>
    <button data-testid="enter-fuxi-test" :disabled="!launcher || !profile?.enabled" @click="enter">进入伏羲测试环境</button>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <a href="/">返回应用广场</a>
  </main>
</template>

<style scoped>
.fuxi-test-page { max-width: 760px; margin: 64px auto; padding: 28px; color: #253347; font: 16px/1.7 system-ui, sans-serif; }
.test-label { color: #985a08; font-weight: 600; }
button { margin: 16px 0; padding: 10px 18px; color: #fff; background: #165dff; border: 0; border-radius: 5px; font: inherit; cursor: pointer; }
button:disabled { opacity: .5; cursor: not-allowed; }
[role=alert] { color: #b42318; }
a { display: inline-block; margin-top: 20px; color: #165dff; }
</style>
