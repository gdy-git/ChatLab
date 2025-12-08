/**
 * AI 查询模块
 * 提供关键词搜索和最近消息获取功能（在 Worker 线程中执行）
 */

import { openDatabase, buildTimeFilter, type TimeFilter } from '../core'

// ==================== 消息搜索 ====================

/**
 * 搜索消息结果类型
 */
export interface SearchMessageResult {
  id: number
  senderName: string
  senderPlatformId: string
  content: string
  timestamp: number
  type: number
}

/**
 * 获取最近的消息（用于概览性问题）
 * @param sessionId 会话 ID
 * @param filter 时间过滤器
 * @param limit 返回数量限制
 */
export function getRecentMessages(
  sessionId: string,
  filter?: TimeFilter,
  limit: number = 100
): { messages: SearchMessageResult[]; total: number } {
  const db = openDatabase(sessionId)
  if (!db) return { messages: [], total: 0 }

  // 构建时间过滤条件
  const { clause: timeClause, params: timeParams } = buildTimeFilter(filter)
  const timeCondition = timeClause ? timeClause.replace('WHERE', 'AND') : ''

  // 排除系统消息，只获取文本消息（type=0）
  const systemFilter = "AND COALESCE(m.account_name, '') != '系统消息' AND msg.type = 0 AND msg.content IS NOT NULL AND msg.content != ''"

  // 查询总数
  const countSql = `
    SELECT COUNT(*) as total
    FROM message msg
    JOIN member m ON msg.sender_id = m.id
    WHERE 1=1
    ${timeCondition}
    ${systemFilter}
  `
  const totalRow = db.prepare(countSql).get(...timeParams) as { total: number }
  const total = totalRow?.total || 0

  // 查询最近消息（按时间降序）
  const sql = `
    SELECT
      msg.id,
      COALESCE(m.group_nickname, m.account_name, m.platform_id) as senderName,
      m.platform_id as senderPlatformId,
      msg.content,
      msg.ts as timestamp,
      msg.type
    FROM message msg
    JOIN member m ON msg.sender_id = m.id
    WHERE 1=1
    ${timeCondition}
    ${systemFilter}
    ORDER BY msg.ts DESC
    LIMIT ?
  `

  const rows = db.prepare(sql).all(...timeParams, limit) as SearchMessageResult[]

  // 返回时按时间正序排列（便于阅读）
  return { messages: rows.reverse(), total }
}

/**
 * 关键词搜索消息
 * @param sessionId 会话 ID
 * @param keywords 关键词数组（OR 逻辑），可以为空数组
 * @param filter 时间过滤器
 * @param limit 返回数量限制
 * @param offset 偏移量（分页）
 * @param senderId 可选的发送者成员 ID，用于筛选特定成员的消息
 */
export function searchMessages(
  sessionId: string,
  keywords: string[],
  filter?: TimeFilter,
  limit: number = 20,
  offset: number = 0,
  senderId?: number
): { messages: SearchMessageResult[]; total: number } {
  const db = openDatabase(sessionId)
  if (!db) return { messages: [], total: 0 }

  // 构建关键词条件（OR 逻辑）
  let keywordCondition = '1=1' // 默认条件（始终为真）
  const keywordParams: string[] = []
  if (keywords.length > 0) {
    keywordCondition = `(${keywords.map(() => `msg.content LIKE ?`).join(' OR ')})`
    keywordParams.push(...keywords.map((k) => `%${k}%`))
  }

  // 构建时间过滤条件
  const { clause: timeClause, params: timeParams } = buildTimeFilter(filter)
  const timeCondition = timeClause ? timeClause.replace('WHERE', 'AND') : ''

  // 排除系统消息
  const systemFilter = "AND COALESCE(m.account_name, '') != '系统消息'"

  // 构建发送者筛选条件
  let senderCondition = ''
  const senderParams: number[] = []
  if (senderId !== undefined) {
    senderCondition = 'AND msg.sender_id = ?'
    senderParams.push(senderId)
  }

  // 查询总数
  const countSql = `
    SELECT COUNT(*) as total
    FROM message msg
    JOIN member m ON msg.sender_id = m.id
    WHERE ${keywordCondition}
    ${timeCondition}
    ${systemFilter}
    ${senderCondition}
  `
  const totalRow = db.prepare(countSql).get(...keywordParams, ...timeParams, ...senderParams) as { total: number }
  const total = totalRow?.total || 0

  // 查询消息
  const sql = `
    SELECT
      msg.id,
      COALESCE(m.group_nickname, m.account_name, m.platform_id) as senderName,
      m.platform_id as senderPlatformId,
      msg.content,
      msg.ts as timestamp,
      msg.type
    FROM message msg
    JOIN member m ON msg.sender_id = m.id
    WHERE ${keywordCondition}
    ${timeCondition}
    ${systemFilter}
    ${senderCondition}
    ORDER BY msg.ts DESC
    LIMIT ? OFFSET ?
  `

  const rows = db.prepare(sql).all(...keywordParams, ...timeParams, ...senderParams, limit, offset) as SearchMessageResult[]

  return { messages: rows, total }
}

/**
 * 获取消息上下文（指定消息前后的消息）
 * 使用消息 ID 方式获取精确的前后 N 条消息
 *
 * @param sessionId 会话 ID
 * @param messageIds 消息 ID 列表（支持单个或批量）
 * @param contextSize 上下文大小，前后各多少条消息，默认 20
 */
export function getMessageContext(
  sessionId: string,
  messageIds: number | number[],
  contextSize: number = 20
): SearchMessageResult[] {
  const db = openDatabase(sessionId)
  if (!db) return []

  // 统一转为数组
  const ids = Array.isArray(messageIds) ? messageIds : [messageIds]
  if (ids.length === 0) return []

  // 收集所有上下文消息的 ID（使用 Set 去重）
  const contextIds = new Set<number>()

  for (const messageId of ids) {
    // 添加目标消息本身
    contextIds.add(messageId)

    // 获取前 contextSize 条消息（id < messageId，按 id 降序取前 N 个）
    const beforeSql = `
      SELECT id FROM message
      WHERE id < ?
      ORDER BY id DESC
      LIMIT ?
    `
    const beforeRows = db.prepare(beforeSql).all(messageId, contextSize) as { id: number }[]
    beforeRows.forEach((row) => contextIds.add(row.id))

    // 获取后 contextSize 条消息（id > messageId，按 id 升序取前 N 个）
    const afterSql = `
      SELECT id FROM message
      WHERE id > ?
      ORDER BY id ASC
      LIMIT ?
    `
    const afterRows = db.prepare(afterSql).all(messageId, contextSize) as { id: number }[]
    afterRows.forEach((row) => contextIds.add(row.id))
  }

  // 如果没有找到任何消息
  if (contextIds.size === 0) return []

  // 批量查询所有上下文消息
  const idList = Array.from(contextIds)
  const placeholders = idList.map(() => '?').join(', ')

  const sql = `
    SELECT
      msg.id,
      COALESCE(m.group_nickname, m.account_name, m.platform_id) as senderName,
      m.platform_id as senderPlatformId,
      msg.content,
      msg.ts as timestamp,
      msg.type
    FROM message msg
    JOIN member m ON msg.sender_id = m.id
    WHERE msg.id IN (${placeholders})
    ORDER BY msg.id ASC
  `

  const rows = db.prepare(sql).all(...idList) as SearchMessageResult[]

  return rows
}

/**
 * 获取两个成员之间的对话
 * 提取两人相邻发言形成的对话片段
 * @param sessionId 会话 ID
 * @param memberId1 成员1的 ID
 * @param memberId2 成员2的 ID
 * @param filter 时间过滤器
 * @param limit 返回消息数量限制
 */
export function getConversationBetween(
  sessionId: string,
  memberId1: number,
  memberId2: number,
  filter?: TimeFilter,
  limit: number = 100
): { messages: SearchMessageResult[]; total: number; member1Name: string; member2Name: string } {
  const db = openDatabase(sessionId)
  if (!db) return { messages: [], total: 0, member1Name: '', member2Name: '' }

  // 获取成员名称
  const member1 = db.prepare(`
    SELECT COALESCE(group_nickname, account_name, platform_id) as name
    FROM member WHERE id = ?
  `).get(memberId1) as { name: string } | undefined

  const member2 = db.prepare(`
    SELECT COALESCE(group_nickname, account_name, platform_id) as name
    FROM member WHERE id = ?
  `).get(memberId2) as { name: string } | undefined

  if (!member1 || !member2) {
    return { messages: [], total: 0, member1Name: '', member2Name: '' }
  }

  // 构建时间过滤条件
  const { clause: timeClause, params: timeParams } = buildTimeFilter(filter)
  const timeCondition = timeClause ? timeClause.replace('WHERE', 'AND') : ''

  // 查询两人之间的所有消息
  const countSql = `
    SELECT COUNT(*) as total
    FROM message msg
    JOIN member m ON msg.sender_id = m.id
    WHERE msg.sender_id IN (?, ?)
    ${timeCondition}
    AND msg.content IS NOT NULL AND msg.content != ''
  `
  const totalRow = db.prepare(countSql).get(memberId1, memberId2, ...timeParams) as { total: number }
  const total = totalRow?.total || 0

  // 查询消息
  const sql = `
    SELECT
      msg.id,
      COALESCE(m.group_nickname, m.account_name, m.platform_id) as senderName,
      m.platform_id as senderPlatformId,
      msg.content,
      msg.ts as timestamp,
      msg.type
    FROM message msg
    JOIN member m ON msg.sender_id = m.id
    WHERE msg.sender_id IN (?, ?)
    ${timeCondition}
    AND msg.content IS NOT NULL AND msg.content != ''
    ORDER BY msg.ts DESC
    LIMIT ?
  `

  const rows = db.prepare(sql).all(memberId1, memberId2, ...timeParams, limit) as SearchMessageResult[]

  // 返回时按时间正序排列（便于阅读对话）
  return {
    messages: rows.reverse(),
    total,
    member1Name: member1.name,
    member2Name: member2.name,
  }
}

