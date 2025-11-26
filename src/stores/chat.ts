import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { AnalysisSession, ImportProgress } from '@/types/chat'

export const useChatStore = defineStore(
  'chat',
  () => {
    // 会话列表
    const sessions = ref<AnalysisSession[]>([])
    // 当前选中的会话ID
    const currentSessionId = ref<string | null>(null)
    // 导入状态
    const isImporting = ref(false)
    const importProgress = ref<ImportProgress | null>(null)

    // 当前选中的会话
    const currentSession = computed(() => {
      if (!currentSessionId.value) return null
      return sessions.value.find((s) => s.id === currentSessionId.value) || null
    })

    // 是否已初始化
    const isInitialized = ref(false)

    /**
     * 从数据库加载会话列表
     */
    async function loadSessions() {
      try {
        const list = await window.chatApi.getSessions()
        sessions.value = list
        // 如果当前选中的会话不存在了，清除选中状态
        if (currentSessionId.value && !list.find((s) => s.id === currentSessionId.value)) {
          currentSessionId.value = null
        }
        isInitialized.value = true
      } catch (error) {
        console.error('加载会话列表失败:', error)
        isInitialized.value = true
      }
    }

    /**
     * 选择文件并导入
     */
    async function importFile(): Promise<{ success: boolean; error?: string }> {
      try {
        // 选择文件
        const result = await window.chatApi.selectFile()
        if (!result || !result.filePath) {
          return { success: false, error: '未选择文件' }
        }
        if (result.error) {
          return { success: false, error: result.error }
        }

        // 使用共享的导入逻辑
        return await importFileFromPath(result.filePath)
      } catch (error) {
        return { success: false, error: String(error) }
      }
    }

    /**
     * 从文件路径直接导入（用于拖拽导入）
     */
    async function importFileFromPath(filePath: string): Promise<{ success: boolean; error?: string }> {
      try {
        // 开始导入
        isImporting.value = true
        importProgress.value = {
          stage: 'reading',
          progress: 0,
          message: '准备导入...',
        }

        // 监听导入进度
        const unsubscribe = window.chatApi.onImportProgress((progress) => {
          importProgress.value = progress
        })

        // 执行导入
        const importResult = await window.chatApi.import(filePath)

        // 取消监听
        unsubscribe()

        if (importResult.success && importResult.sessionId) {
          // 刷新会话列表
          await loadSessions()
          // 自动选中新导入的会话，进入分析页面
          currentSessionId.value = importResult.sessionId
          return { success: true }
        } else {
          return { success: false, error: importResult.error || '导入失败' }
        }
      } catch (error) {
        return { success: false, error: String(error) }
      } finally {
        isImporting.value = false
        // 延迟清除进度，让用户看到完成状态
        setTimeout(() => {
          importProgress.value = null
        }, 1500)
      }
    }

    /**
     * 选择会话
     */
    function selectSession(id: string) {
      currentSessionId.value = id
    }

    /**
     * 删除会话
     */
    async function deleteSession(id: string): Promise<boolean> {
      try {
        const success = await window.chatApi.deleteSession(id)
        if (success) {
          // 从列表中移除
          const index = sessions.value.findIndex((s) => s.id === id)
          if (index !== -1) {
            sessions.value.splice(index, 1)
          }
          // 如果删除的是当前选中的会话，清除选中状态
          if (currentSessionId.value === id) {
            currentSessionId.value = null
          }
        }
        return success
      } catch (error) {
        console.error('删除会话失败:', error)
        return false
      }
    }

    /**
     * 清除选中状态
     */
    function clearSelection() {
      currentSessionId.value = null
    }

    return {
      // State
      sessions,
      currentSessionId,
      isImporting,
      importProgress,
      isInitialized,
      // Computed
      currentSession,
      // Actions
      loadSessions,
      importFile,
      importFileFromPath,
      selectSession,
      deleteSession,
      clearSelection,
    }
  },
  {
    persist: {
      // 只持久化 currentSessionId，sessions 从数据库加载
      pick: ['currentSessionId'],
    },
  }
)
