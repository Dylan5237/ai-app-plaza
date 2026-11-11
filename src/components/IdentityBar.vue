<script setup>
import { onMounted } from 'vue'
import { identity, initializeIdentity, signIn, signOut } from '../lib/identity.js'
import { publicPath } from '../lib/public-path.js'
import { favorites, refreshFavoriteIds } from '../lib/personal.js'
defineProps({ rail: { type: Boolean, default: false } })
defineEmits(['groups', 'personal'])
onMounted(initializeIdentity)
</script>

<template>
  <div v-if="identity.enabled || identity.retryable" class="identity-bar" :class="{ rail }" aria-label="广场身份">
    <div class="identity-actions">
      <span v-if="identity.user">{{ identity.user.name }} <small>{{ identity.user.superAdministrator ? '超级管理员 · 天宫身份' : identity.user.administrator ? '管理员 · 天宫身份' : '天宫身份' }}</small></span>
      <span v-else>访客浏览</span>
      <template v-if="!rail">
        <button v-if="identity.user" type="button" @click="$emit('personal')">我的收藏</button>
        <a v-if="identity.user" :href="publicPath('/admin')">我的应用</a>
        <a v-if="identity.user" :href="publicPath('/?space=transfers')">负责人交接</a>
        <a v-if="identity.user?.administrator" :href="publicPath('/?space=governance')">应用归属核验</a>
        <a v-if="identity.user?.administrator" :href="publicPath('/?space=operations')">运营看板</a>
        <a v-if="identity.user?.superAdministrator" :href="publicPath('/?space=administrators')">管理员配置</a>
        <button v-if="identity.user?.identityAdmin" type="button" @click="$emit('groups')">成员与小组</button>
      </template>
      <button v-if="identity.user" type="button" :disabled="identity.busy" @click="signOut">退出广场</button>
      <button v-else-if="identity.switchRequired" type="button" :disabled="identity.busy" @click="signIn(true)">确认切换为天宫当前账号</button>
      <button v-else-if="!identity.retryable" type="button" :disabled="identity.busy" @click="signIn(false)">{{ identity.busy ? '正在核验身份…' : '使用天宫身份登录' }}</button>
    </div>
    <p v-if="identity.error" class="identity-error" role="alert">{{ identity.error }} <button v-if="identity.retryable" type="button" :disabled="identity.busy" @click="initializeIdentity">重试身份核验</button></p>
    <p v-else-if="favorites.error" class="identity-error" role="alert">{{ favorites.error }} <button type="button" @click="refreshFavoriteIds">重新读取收藏状态</button></p>
  </div>
</template>

<style scoped>
.identity-bar { flex-shrink: 0; padding: 8px 24px; background: var(--plaza-surface); border-bottom: 1px solid var(--plaza-line); color: var(--plaza-ink); font-size: 14px;;line-height:22px;}
.identity-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 14px; align-items: center; }
small { color: var(--plaza-muted); margin-left: 6px; }
button,a { min-height: 36px; box-sizing: border-box; display: inline-flex; align-items: center; border: 0; background: transparent; color: var(--plaza-brand); cursor: pointer; padding: 5px; font: inherit; text-decoration: none; }
button:focus-visible { outline: 3px solid var(--plaza-brand); outline-offset: 2px; }
button:disabled { opacity: .5; cursor: default; }
.identity-error { color: var(--plaza-danger); margin: 6px 0 0; text-align: right; }
.identity-bar.rail { display: block; padding: 10px; border: 1px solid var(--plaza-line); border-radius: 12px; background: var(--plaza-surface); box-shadow: 0 1px 2px rgb(28 37 51 / .04); font-size: 12px;;line-height:18px;}
.identity-bar.rail .identity-actions { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; }
.identity-bar.rail .identity-actions > span { display: block; width: 100%; padding: 3px 2px 7px; color: var(--plaza-ink); font-weight: 600; }
.identity-bar.rail .identity-actions > span small { display: block; margin: 2px 0 0; color: var(--plaza-muted); font-weight: 400; font-size: 10.5px; }
.identity-bar.rail button { min-height: 30px; padding: 4px 6px; color: var(--plaza-text); font-size: 12px; text-align: left; border-radius: 7px; }
.identity-bar.rail button:hover { background: rgb(32 42 59 / .05); color: var(--plaza-ink); }
.identity-bar.rail .identity-error { text-align: left; font-size: 11px; line-height: 1.55; }
@media(pointer:coarse) { button,a { min-height: 44px; } }
</style>
