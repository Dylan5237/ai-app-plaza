<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  examples: { type: Array, default: () => [] },
  presentation: { type: String, default: 'full' },
})

const emit = defineEmits(['copy'])
const selectedIndex = ref(0)
const examples = computed(() => Array.isArray(props.examples) ? props.examples.filter((item) => item && typeof item === 'object') : [])
const selectedExample = computed(() => examples.value[selectedIndex.value] || null)

watch(examples, () => {
  selectedIndex.value = 0
})

function selectExample(index) {
  selectedIndex.value = index
}

function copySelectedExample() {
  const request = selectedExample.value?.request
  if (typeof request === 'string' && request.trim()) emit('copy', request)
}
</script>

<template>
  <section v-if="examples.length" class="app-examples" :class="{ 'example-full': props.presentation !== 'selector' }" data-testid="app-examples">
    <template v-if="props.presentation === 'selector'">
      <h3 class="examples-title">
        <strong>示例任务</strong>
        <span>可复制使用</span>
      </h3>
      <div class="example-tabs" role="tablist" aria-label="示例任务">
        <button
          v-for="(example, index) in examples"
          :key="index"
          type="button"
          role="tab"
          :aria-selected="index === selectedIndex"
          :data-testid="`example-tab-${index}`"
          @click="selectExample(index)"
        >{{ example.title || `示例 ${index + 1}` }}</button>
      </div>
      <article v-if="selectedExample" class="example-card" aria-live="polite">
        <div class="example-label">
          <span>示例输入</span>
          <span>{{ String(selectedIndex + 1).padStart(2, '0') }} / {{ String(examples.length).padStart(2, '0') }}</span>
        </div>
        <p v-if="selectedExample.request" class="example-request">{{ selectedExample.request }}</p>
        <p v-if="selectedExample.expectedResult" class="example-result">
          <span>预期结果</span>
          {{ selectedExample.expectedResult }}
        </p>
        <button
          type="button"
          class="copy-example-button"
          data-testid="copy-example"
          :disabled="!selectedExample.request"
          @click="copySelectedExample"
        >复制这段任务</button>
      </article>
    </template>
    <template v-else>
      <h3>示例任务</h3>
      <article v-for="(example, index) in examples" :key="index" class="example-card">
        <h4>{{ example.title || `示例 ${index + 1}` }}</h4>
        <p v-if="example.request"><span>输入</span>{{ example.request }}</p>
        <p v-if="example.expectedResult"><span>预期结果</span>{{ example.expectedResult }}</p>
      </article>
    </template>
  </section>
</template>

<style scoped>
.app-examples { min-width: 0; margin-top: 19px; }
.app-examples h3 { margin: 0 0 11px; color: #2b394c; font-size: 15px; font-weight: 650; }
.examples-title { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.examples-title span { color: #8993a2; font-size: 10px; font-weight: 400; }
.example-tabs { display: flex; min-width: 0; gap: 4px; margin-bottom: 10px; padding: 3px; overflow-x: auto; border-radius: 6px; background: #f0f3f7; scrollbar-width: thin; }
.example-tabs button { min-width: 0; flex: 1 0 auto; max-width: 100%; padding: 6px 8px; overflow: hidden; border: 0; border-radius: 4px; background: transparent; color: #6b778a; font: inherit; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.example-tabs button[aria-selected="true"] { background: #fff; color: #355b9a; box-shadow: 0 1px 3px rgb(38 59 73 / 7%); }
.example-tabs button:focus-visible, .copy-example-button:focus-visible { outline: 3px solid #bfd3f5; outline-offset: 2px; }
.example-card { min-width: 0; padding: 12px 13px; border: 1px solid #e4e9f0; border-radius: 7px; background: #fff; overflow-wrap: anywhere; }
.example-card + .example-card { margin-top: 8px; }
.example-card h4 { margin: 0 0 8px; color: #47566a; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.example-card p { margin: 7px 0 0; color: #536174; font-size: 12px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.example-card p span { display: block; margin-bottom: 4px; color: #8993a2; font-size: 10px; }
.example-label { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 8px; color: #7d899b; font-size: 10px; }
.example-request { min-height: 45px; color: #34445b !important; }
.example-result { margin-top: 12px !important; padding-top: 10px; border-top: 1px solid #edf0f4; color: #6b798c !important; }
.copy-example-button { width: 100%; min-height: 31px; margin-top: 12px; border: 1px solid #e3e9f2; border-radius: 4px; background: #f7f9fc; color: #4c6992; font: inherit; font-size: 11px; cursor: pointer; }
.copy-example-button:hover { background: #edf2fb; }
.copy-example-button:disabled { opacity: .55; cursor: not-allowed; }
.example-full .example-card { background: #fbfcfd; }
</style>
