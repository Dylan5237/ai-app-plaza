<script setup>
defineProps({
  page: { type: Number, required: true },
  pageSize: { type: Number, required: true },
  total: { type: Number, required: true },
})
const emit = defineEmits(['change'])
</script>

<template>
  <el-pagination
    v-if="total > pageSize"
    :current-page="page"
    :page-size="pageSize"
    :total="total"
    :pager-count="5"
    layout="prev, pager, next"
    background
    @current-change="emit('change', $event)"
  />
</template>
