<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { MemberActivity, MemberNameHistory } from '@/types/chat'
import { MemberRankList } from '@/components/charts'
import type { MemberRankItem } from '@/components/charts'

const props = defineProps<{
  sessionId: string
  memberActivity: MemberActivity[]
}>()

// Top 10 排行榜数据
const top10RankData = computed<MemberRankItem[]>(() => {
  return props.memberActivity.slice(0, 10).map((m) => ({
    id: m.memberId.toString(),
    name: m.name,
    value: m.messageCount,
    percentage: m.percentage,
  }))
})

// 完整排行榜数据
const fullRankData = computed<MemberRankItem[]>(() => {
  return props.memberActivity.map((m) => ({
    id: m.memberId.toString(),
    name: m.name,
    value: m.messageCount,
    percentage: m.percentage,
  }))
})

const isOpen = ref(false)

// 昵称变更记录
interface MemberWithHistory {
  memberId: number
  name: string
  history: MemberNameHistory[]
}

const membersWithNicknameChanges = ref<MemberWithHistory[]>([])
const isLoadingHistory = ref(false)

// 加载有昵称变更的成员
async function loadMembersWithNicknameChanges() {
  if (!props.sessionId || props.memberActivity.length === 0) return

  isLoadingHistory.value = true
  const membersWithChanges: MemberWithHistory[] = []

  try {
    // 并发查询所有成员的历史昵称
    const historyPromises = props.memberActivity.map((member) =>
      window.chatApi.getMemberNameHistory(props.sessionId, member.memberId)
    )

    const allHistories = await Promise.all(historyPromises)

    // 筛选出有昵称变更的成员（历史记录 > 1）
    props.memberActivity.forEach((member, index) => {
      const history = allHistories[index]
      if (history.length > 1) {
        membersWithChanges.push({
          memberId: member.memberId,
          name: member.name,
          history,
        })
      }
    })

    membersWithNicknameChanges.value = membersWithChanges
  } catch (error) {
    console.error('加载昵称变更记录失败:', error)
  } finally {
    isLoadingHistory.value = false
  }
}

// 监听 sessionId 和 memberActivity 变化，重新加载昵称历史
watch(
  () => [props.sessionId, props.memberActivity.length],
  () => {
    loadMembersWithNicknameChanges()
  },
  { immediate: true }
)

// 格式化时间段（用于横向展示）
function formatPeriod(startTs: number, endTs: number | null): string {
  const formatDate = (ts: number) => {
    const date = new Date(ts * 1000)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  const start = formatDate(startTs)
  if (endTs === null) {
    return `${start} ~ 至今`
  }
  const end = formatDate(endTs)
  if (start === end) {
    return start
  }
  return `${start} ~ ${end}`
}
</script>

<template>
  <div class="space-y-6">
    <!-- 成员活跃度排行 -->
    <div class="rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div class="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-800">
        <h3 class="font-semibold text-gray-900 dark:text-white">成员活跃度排行</h3>
        <!-- 完整排行榜 Dialog -->
        <UModal v-model:open="isOpen" :ui="{ width: 'max-w-3xl' }">
          <UButton v-if="memberActivity.length > 10" icon="i-heroicons-list-bullet" color="gray" variant="ghost">
            查看完整排行
          </UButton>
          <template #header>
            <div class="flex items-center justify-between">
              <h3 class="text-lg font-semibold text-gray-900 dark:text-white">完整成员排行榜</h3>
              <span>（共 {{ memberActivity.length }} 位成员）</span>
            </div>
          </template>
          <template #body>
            <div class="max-h-[60vh] overflow-y-auto">
              <MemberRankList :members="fullRankData" :session-id="sessionId" :clickable="true" />
            </div>
          </template>
        </UModal>
      </div>

      <MemberRankList :members="top10RankData" :session-id="sessionId" :clickable="true" />
    </div>

    <!-- 昵称变更记录区域 -->
    <div class="rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div class="border-b border-gray-200 px-5 py-4 dark:border-gray-800">
        <h3 class="font-semibold text-gray-900 dark:text-white">昵称变更记录</h3>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {{
            isLoadingHistory
              ? '加载中...'
              : membersWithNicknameChanges.length > 0
                ? `${membersWithNicknameChanges.length} 位成员曾修改过昵称`
                : '暂无成员修改昵称'
          }}
        </p>
      </div>

      <div
        v-if="!isLoadingHistory && membersWithNicknameChanges.length > 0"
        class="divide-y divide-gray-100 dark:divide-gray-800"
      >
        <div
          v-for="member in membersWithNicknameChanges"
          :key="member.memberId"
          class="flex items-start gap-4 px-5 py-4"
        >
          <!-- 成员名称 -->
          <div class="w-32 shrink-0 pt-0.5 font-medium text-gray-900 dark:text-white">
            {{ member.name }}
          </div>

          <!-- 昵称历史（横向展示） -->
          <div class="flex flex-1 flex-wrap items-center gap-2">
            <template v-for="(item, index) in member.history" :key="index">
              <!-- 昵称标签 -->
              <div class="flex items-center gap-1.5 rounded-lg bg-gray-50 px-3 py-1.5 dark:bg-gray-800">
                <span
                  class="text-sm"
                  :class="item.endTs === null ? 'font-semibold text-[#de335e]' : 'text-gray-700 dark:text-gray-300'"
                >
                  {{ item.name }}
                </span>
                <UBadge v-if="item.endTs === null" color="primary" variant="soft" size="xs">当前</UBadge>
                <span class="text-xs text-gray-400">({{ formatPeriod(item.startTs, item.endTs) }})</span>
              </div>

              <!-- 箭头分隔符 -->
              <span v-if="index < member.history.length - 1" class="text-gray-300 dark:text-gray-600">→</span>
            </template>
          </div>
        </div>
      </div>

      <div v-else-if="!isLoadingHistory" class="px-5 py-8 text-center text-sm text-gray-400">
        该群组所有成员均未修改过昵称
      </div>

      <div v-else class="px-5 py-8 text-center text-sm text-gray-400">正在加载昵称变更记录...</div>
    </div>
  </div>
</template>
