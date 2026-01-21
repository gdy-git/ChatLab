<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

interface TimeFilter {
  startTs?: number
  endTs?: number
}

defineProps<{
  sessionId: string
  timeFilter?: TimeFilter
  memberId?: number | null
}>()
</script>

<template>
  <div class="flex h-64 items-center justify-center">
    <div class="text-center">
      <UIcon name="i-heroicons-cloud" class="mx-auto h-12 w-12 text-gray-300 dark:text-gray-600" />
      <p class="mt-3 text-sm text-gray-400">{{ t('comingSoon') }}</p>
    </div>
  </div>
</template>

<i18n>
{
  "zh-CN": {
    "comingSoon": "词云功能开发中..."
  },
  "en-US": {
    "comingSoon": "Word cloud coming soon..."
  }
}
</i18n>

