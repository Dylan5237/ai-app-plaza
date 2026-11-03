<script setup>
import content from './platform-open-button.content.html?raw'

defineProps({
  href: { type: String, default: undefined },
  disabled: { type: Boolean, default: false },
})
</script>

<template>
  <component
    :is="href ? 'a' : 'button'"
    class="platform-open-button"
    :href="href"
    :type="href ? undefined : 'button'"
    :target="href ? '_blank' : undefined"
    :rel="href ? 'noopener noreferrer' : undefined"
    :disabled="href ? undefined : disabled"
    @click.stop
    v-html="disabled ? '入口不可用' : content.trim()"
  />
</template>

<style src="../styles/platform-open-button.css"></style>
