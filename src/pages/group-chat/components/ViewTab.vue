<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { SubTabs } from '@/components/UI'
import { MessageView, WordcloudView, PortraitView } from '@/components/view'
import UserSelect from '@/components/common/UserSelect.vue'

const { t } = useI18n()

interface TimeFilter {
  startTs?: number
  endTs?: number
}

// Props
const props = defineProps<{
  sessionId: string
  timeFilter?: TimeFilter
}>()

// 子 Tab 配置
const subTabs = computed(() => [
  { id: 'message', label: t('message'), icon: 'i-heroicons-chat-bubble-left-right' },
  { id: 'wordcloud', label: t('wordcloud'), icon: 'i-heroicons-cloud' },
  { id: 'portrait', label: t('portrait'), icon: 'i-heroicons-user-circle' },
])

const activeSubTab = ref('message')

// 成员筛选
const selectedMemberId = ref<number | null>(null)
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- 子 Tab 导航（右侧插槽放成员筛选） -->
    <SubTabs v-model="activeSubTab" :items="subTabs" persist-key="groupViewTab">
      <template #right>
        <UserSelect v-model="selectedMemberId" :session-id="props.sessionId" />
      </template>
    </SubTabs>

    <!-- 子 Tab 内容 -->
    <div class="flex-1 min-h-0 overflow-auto">
      <Transition name="fade" mode="out-in">
        <MessageView
          v-if="activeSubTab === 'message'"
          :session-id="props.sessionId"
          :time-filter="props.timeFilter"
          :member-id="selectedMemberId"
        />
        <WordcloudView
          v-else-if="activeSubTab === 'wordcloud'"
          :session-id="props.sessionId"
          :time-filter="props.timeFilter"
          :member-id="selectedMemberId"
        />
        <PortraitView
          v-else-if="activeSubTab === 'portrait'"
          :session-id="props.sessionId"
          :time-filter="props.timeFilter"
          :member-id="selectedMemberId"
        />
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>

<i18n>
{
  "zh-CN": {
    "message": "消息",
    "wordcloud": "词云",
    "portrait": "对话画像"
  },
  "en-US": {
    "message": "Messages",
    "wordcloud": "Word Cloud",
    "portrait": "Chat Portrait"
  }
}
</i18n>
