<script setup lang="ts">
import { onMounted } from 'vue'
import { useChatStore } from '@/stores/chat'

const chatStore = useChatStore()

// 应用启动时从数据库加载会话列表
onMounted(async () => {
  await chatStore.loadSessions()
})
</script>

<template>
  <UApp>
    <router-view />
  </UApp>
</template>
