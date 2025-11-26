/**
 * 数据库服务模块
 * 管理 SQLite 数据库的创建、查询和分析
 */

import Database from 'better-sqlite3'
import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import type {
  DbMeta,
  ParseResult,
  AnalysisSession,
  MemberActivity,
  HourlyActivity,
  DailyActivity,
  MessageType,
} from '../../../src/types/chat'

// 数据库存储目录
let DB_DIR: string | null = null

/**
 * 获取数据库目录（懒加载）
 */
function getDbDir(): string {
  if (DB_DIR) return DB_DIR

  try {
    // 使用 Documents 目录，避免开发环境下 userData 被重置的问题，也方便用户管理数据
    const docPath = app.getPath('documents')
    console.log('[Database] app.getPath("documents"):', docPath)
    DB_DIR = path.join(docPath, 'ChatLens', 'databases')
  } catch (error) {
    console.error('[Database] Error getting userData path:', error)
    DB_DIR = path.join(process.cwd(), 'databases')
    console.log('[Database] Using fallback DB_DIR:', DB_DIR)
  }

  return DB_DIR
}

/**
 * 确保数据库目录存在
 */
function ensureDbDir(): void {
  const dir = getDbDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

/**
 * 生成唯一的会话ID
 */
function generateSessionId(): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).substring(2, 8)
  return `chat_${timestamp}_${random}`
}

/**
 * 获取数据库文件路径
 */
function getDbPath(sessionId: string): string {
  return path.join(getDbDir(), `${sessionId}.db`)
}

/**
 * 创建新数据库并初始化表结构
 */
function createDatabase(sessionId: string): Database.Database {
  ensureDbDir()
  const dbPath = getDbPath(sessionId)
  const db = new Database(dbPath)

  // 启用 WAL 模式提升性能
  db.pragma('journal_mode = WAL')

  // 创建表结构
  db.exec(`
    -- 元信息表（单行）
    CREATE TABLE IF NOT EXISTS meta (
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      type TEXT NOT NULL,
      imported_at INTEGER NOT NULL
    );

    -- 成员表
    CREATE TABLE IF NOT EXISTS member (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL
    );

    -- 成员昵称历史表
    CREATE TABLE IF NOT EXISTS member_name_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      start_ts INTEGER NOT NULL,
      end_ts INTEGER,
      FOREIGN KEY(member_id) REFERENCES member(id)
    );

    -- 消息表
    CREATE TABLE IF NOT EXISTS message (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      type INTEGER NOT NULL,
      content TEXT,
      FOREIGN KEY(sender_id) REFERENCES member(id)
    );

    -- 索引
    CREATE INDEX IF NOT EXISTS idx_message_ts ON message(ts);
    CREATE INDEX IF NOT EXISTS idx_message_sender ON message(sender_id);
    CREATE INDEX IF NOT EXISTS idx_member_name_history_member_id ON member_name_history(member_id);
  `)

  return db
}

/**
 * 打开已存在的数据库
 */
function openDatabase(sessionId: string): Database.Database | null {
  const dbPath = getDbPath(sessionId)
  if (!fs.existsSync(dbPath)) {
    return null
  }
  const db = new Database(dbPath, { readonly: true })
  db.pragma('journal_mode = WAL')
  return db
}

/**
 * 导入解析后的数据到数据库
 */
export function importData(parseResult: ParseResult): string {
  console.log('[Database] importData called')
  const sessionId = generateSessionId()
  console.log('[Database] Generated sessionId:', sessionId)

  const dbPath = getDbPath(sessionId)
  console.log('[Database] Creating database at:', dbPath)

  const db = createDatabase(sessionId)
  console.log('[Database] Database created successfully')

  try {
    // 使用事务提升性能
    const importTransaction = db.transaction(() => {
      // 插入元信息
      const insertMeta = db.prepare(`
        INSERT INTO meta (name, platform, type, imported_at)
        VALUES (?, ?, ?, ?)
      `)
      insertMeta.run(
        parseResult.meta.name,
        parseResult.meta.platform,
        parseResult.meta.type,
        Math.floor(Date.now() / 1000)
      )

      // 插入成员并建立 platformId -> id 映射
      const insertMember = db.prepare(`
        INSERT OR IGNORE INTO member (platform_id, name) VALUES (?, ?)
      `)
      const getMemberId = db.prepare(`
        SELECT id FROM member WHERE platform_id = ?
      `)

      const memberIdMap = new Map<string, number>()

      // 初始化成员表（使用初始昵称）
      for (const member of parseResult.members) {
        insertMember.run(member.platformId, member.name)
        const row = getMemberId.get(member.platformId) as { id: number }
        memberIdMap.set(member.platformId, row.id)
      }

      // 按时间戳升序排序消息（用于追踪昵称变化）
      const sortedMessages = [...parseResult.messages].sort((a, b) => a.timestamp - b.timestamp)

      // 追踪每个成员的昵称历史
      // Map<platformId, { currentName: string, lastSeenTs: number }>
      const nicknameTracker = new Map<string, { currentName: string; lastSeenTs: number }>()

      // 准备 SQL 语句
      const insertMessage = db.prepare(`
        INSERT INTO message (sender_id, ts, type, content) VALUES (?, ?, ?, ?)
      `)
      const insertNameHistory = db.prepare(`
        INSERT INTO member_name_history (member_id, name, start_ts, end_ts)
        VALUES (?, ?, ?, ?)
      `)
      const updateMemberName = db.prepare(`
        UPDATE member SET name = ? WHERE platform_id = ?
      `)
      const updateNameHistoryEndTs = db.prepare(`
        UPDATE member_name_history
        SET end_ts = ?
        WHERE member_id = ? AND end_ts IS NULL
      `)

      // 遍历排序后的消息
      for (const msg of sortedMessages) {
        const senderId = memberIdMap.get(msg.senderPlatformId)
        if (senderId === undefined) continue

        // 插入消息
        insertMessage.run(senderId, msg.timestamp, msg.type, msg.content)

        // 从消息中获取发送者的昵称
        const currentName = msg.senderName
        const tracker = nicknameTracker.get(msg.senderPlatformId)

        if (!tracker) {
          // 首次出现，记录初始昵称
          nicknameTracker.set(msg.senderPlatformId, {
            currentName,
            lastSeenTs: msg.timestamp,
          })
          // 插入第一条昵称历史记录（end_ts 为 NULL，表示当前使用中）
          insertNameHistory.run(senderId, currentName, msg.timestamp, null)
        } else if (tracker.currentName !== currentName) {
          // 昵称发生变化
          // 1. 关闭旧昵称的时间段（end_ts 设为当前消息时间戳）
          updateNameHistoryEndTs.run(msg.timestamp, senderId)

          // 2. 插入新昵称记录
          insertNameHistory.run(senderId, currentName, msg.timestamp, null)

          // 3. 更新追踪器
          tracker.currentName = currentName
          tracker.lastSeenTs = msg.timestamp
        } else {
          // 昵称未变化，仅更新最后见到的时间戳
          tracker.lastSeenTs = msg.timestamp
        }
      }

      // 更新 member 表中的最新昵称
      for (const [platformId, tracker] of nicknameTracker.entries()) {
        updateMemberName.run(tracker.currentName, platformId)
      }
    })

    console.log('[Database] Executing transaction...')
    importTransaction()
    console.log('[Database] Transaction completed')

    // 验证文件是否存在
    const dbPath = getDbPath(sessionId)
    const fileExists = fs.existsSync(dbPath)
    console.log('[Database] File exists after transaction:', fileExists, dbPath)

    return sessionId
  } catch (error) {
    console.error('[Database] Error in importData:', error)
    throw error
  } finally {
    console.log('[Database] Closing database...')
    db.close()
    console.log('[Database] Database closed')

    // 再次验证文件
    const dbPath = getDbPath(sessionId)
    const fileExists = fs.existsSync(dbPath)
    console.log('[Database] File exists after close:', fileExists)
  }
}

/**
 * 获取所有分析会话列表
 */
export function getAllSessions(): AnalysisSession[] {
  ensureDbDir()
  const sessions: AnalysisSession[] = []

  const dbDir = getDbDir()
  console.log('[Database] getAllSessions: DB_DIR =', dbDir)
  console.log('[Database] getAllSessions: DB_DIR exists =', fs.existsSync(dbDir))

  // 列出目录内容
  const allFiles = fs.readdirSync(dbDir)
  console.log('[Database] getAllSessions: all files in dir:', allFiles)

  const files = allFiles.filter((f) => f.endsWith('.db'))
  console.log('[Database] getAllSessions: filtered .db files:', files)

  for (const file of files) {
    const sessionId = file.replace('.db', '')
    const dbPath = getDbPath(sessionId)
    console.log('[Database] Opening database:', dbPath)

    try {
      // 不使用 readonly 模式，以便能正确读取 WAL 日志
      const db = new Database(dbPath)
      db.pragma('journal_mode = WAL')

      // 获取元信息
      const meta = db.prepare('SELECT * FROM meta LIMIT 1').get() as DbMeta | undefined
      console.log('[Database] Meta:', meta)

      if (meta) {
        // 获取消息数和成员数（排除系统消息）
        const messageCount = (
          db
            .prepare(
              `SELECT COUNT(*) as count
             FROM message msg
             JOIN member m ON msg.sender_id = m.id
             WHERE m.name != '系统消息'`
            )
            .get() as { count: number }
        ).count
        const memberCount = (
          db
            .prepare(
              `SELECT COUNT(*) as count
             FROM member
             WHERE name != '系统消息'`
            )
            .get() as { count: number }
        ).count
        console.log('[Database] Counts:', { messageCount, memberCount })

        sessions.push({
          id: sessionId,
          name: meta.name,
          platform: meta.platform as AnalysisSession['platform'],
          type: meta.type as AnalysisSession['type'],
          importedAt: meta.imported_at,
          messageCount,
          memberCount,
          dbPath,
        })
      }

      db.close()
    } catch (error) {
      // 跳过无法读取的数据库文件
      console.error(`[Database] Failed to read database ${file}:`, error)
    }
  }

  console.log('[Database] getAllSessions: returning', sessions.length, 'sessions')
  // 按导入时间倒序排列
  return sessions.sort((a, b) => b.importedAt - a.importedAt)
}

/**
 * 获取单个会话信息
 */
export function getSession(sessionId: string): AnalysisSession | null {
  const db = openDatabase(sessionId)
  if (!db) return null

  try {
    const meta = db.prepare('SELECT * FROM meta LIMIT 1').get() as DbMeta | undefined
    if (!meta) return null

    // 排除系统消息的消息数
    const messageCount = (
      db
        .prepare(
          `SELECT COUNT(*) as count
         FROM message msg
         JOIN member m ON msg.sender_id = m.id
         WHERE m.name != '系统消息'`
        )
        .get() as { count: number }
    ).count

    // 排除系统消息的成员数
    const memberCount = (
      db
        .prepare(
          `SELECT COUNT(*) as count
         FROM member
         WHERE name != '系统消息'`
        )
        .get() as { count: number }
    ).count

    return {
      id: sessionId,
      name: meta.name,
      platform: meta.platform as AnalysisSession['platform'],
      type: meta.type as AnalysisSession['type'],
      importedAt: meta.imported_at,
      messageCount,
      memberCount,
      dbPath: getDbPath(sessionId),
    }
  } finally {
    db.close()
  }
}

/**
 * 删除会话
 */
export function deleteSession(sessionId: string): boolean {
  const dbPath = getDbPath(sessionId)
  const walPath = dbPath + '-wal'
  const shmPath = dbPath + '-shm'

  try {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath)
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath)
    return true
  } catch {
    return false
  }
}

// ==================== 分析查询 ====================

/**
 * 时间过滤参数
 */
export interface TimeFilter {
  startTs?: number // 开始时间戳（秒）
  endTs?: number // 结束时间戳（秒）
}

/**
 * 构建时间过滤 WHERE 子句
 */
function buildTimeFilter(filter?: TimeFilter): { clause: string; params: number[] } {
  const conditions: string[] = []
  const params: number[] = []

  if (filter?.startTs !== undefined) {
    conditions.push('ts >= ?')
    params.push(filter.startTs)
  }
  if (filter?.endTs !== undefined) {
    conditions.push('ts <= ?')
    params.push(filter.endTs)
  }

  return {
    clause: conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '',
    params,
  }
}

/**
 * 构建排除系统消息的过滤条件
 * @param existingClause 已有的 WHERE 子句（如时间过滤）
 */
function buildSystemMessageFilter(existingClause: string): string {
  const systemFilter = "m.name != '系统消息'"

  if (existingClause.includes('WHERE')) {
    return existingClause + ' AND ' + systemFilter
  } else {
    return ' WHERE ' + systemFilter
  }
}

/**
 * 获取可用的年份列表
 */
export function getAvailableYears(sessionId: string): number[] {
  const db = openDatabase(sessionId)
  if (!db) return []

  try {
    const rows = db
      .prepare(
        `
      SELECT DISTINCT CAST(strftime('%Y', ts, 'unixepoch', 'localtime') AS INTEGER) as year
      FROM message
      ORDER BY year DESC
    `
      )
      .all() as Array<{ year: number }>

    return rows.map((r) => r.year)
  } finally {
    db.close()
  }
}

/**
 * 获取成员活跃度排行
 */
export function getMemberActivity(sessionId: string, filter?: TimeFilter): MemberActivity[] {
  const db = openDatabase(sessionId)
  if (!db) return []

  try {
    const { clause, params } = buildTimeFilter(filter)

    // 构建消息过滤条件（排除系统消息 + 时间过滤）
    const msgFilterBase = clause ? clause.replace('WHERE', 'AND') : ''
    const msgFilterWithSystem = msgFilterBase + " AND m.name != '系统消息'"

    // 计算总消息数（排除系统消息）
    const totalClauseWithSystem = buildSystemMessageFilter(clause)
    const totalMessages = (
      db
        .prepare(
          `SELECT COUNT(*) as count
         FROM message msg
         JOIN member m ON msg.sender_id = m.id
         ${totalClauseWithSystem}`
        )
        .get(...params) as { count: number }
    ).count

    const rows = db
      .prepare(
        `
      SELECT
        m.id as memberId,
        m.platform_id as platformId,
        m.name,
        COUNT(msg.id) as messageCount
      FROM member m
      LEFT JOIN message msg ON m.id = msg.sender_id ${msgFilterWithSystem}
      WHERE m.name != '系统消息'
      GROUP BY m.id
      HAVING messageCount > 0
      ORDER BY messageCount DESC
    `
      )
      .all(...params) as Array<{
      memberId: number
      platformId: string
      name: string
      messageCount: number
    }>

    return rows.map((row) => ({
      memberId: row.memberId,
      platformId: row.platformId,
      name: row.name,
      messageCount: row.messageCount,
      percentage: totalMessages > 0 ? Math.round((row.messageCount / totalMessages) * 10000) / 100 : 0,
    }))
  } finally {
    db.close()
  }
}

/**
 * 获取每小时活跃度分布
 */
export function getHourlyActivity(sessionId: string, filter?: TimeFilter): HourlyActivity[] {
  const db = openDatabase(sessionId)
  if (!db) return []

  try {
    const { clause, params } = buildTimeFilter(filter)
    const clauseWithSystem = buildSystemMessageFilter(clause)

    const rows = db
      .prepare(
        `
      SELECT
        CAST(strftime('%H', msg.ts, 'unixepoch', 'localtime') AS INTEGER) as hour,
        COUNT(*) as messageCount
      FROM message msg
      JOIN member m ON msg.sender_id = m.id
      ${clauseWithSystem}
      GROUP BY hour
      ORDER BY hour
    `
      )
      .all(...params) as Array<{ hour: number; messageCount: number }>

    // 补齐所有24小时
    const result: HourlyActivity[] = []
    for (let h = 0; h < 24; h++) {
      const found = rows.find((r) => r.hour === h)
      result.push({
        hour: h,
        messageCount: found ? found.messageCount : 0,
      })
    }

    return result
  } finally {
    db.close()
  }
}

/**
 * 获取每日活跃度趋势
 */
export function getDailyActivity(sessionId: string, filter?: TimeFilter): DailyActivity[] {
  const db = openDatabase(sessionId)
  if (!db) return []

  try {
    const { clause, params } = buildTimeFilter(filter)
    const clauseWithSystem = buildSystemMessageFilter(clause)

    const rows = db
      .prepare(
        `
      SELECT
        strftime('%Y-%m-%d', msg.ts, 'unixepoch', 'localtime') as date,
        COUNT(*) as messageCount
      FROM message msg
      JOIN member m ON msg.sender_id = m.id
      ${clauseWithSystem}
      GROUP BY date
      ORDER BY date
    `
      )
      .all(...params) as Array<{ date: string; messageCount: number }>

    return rows
  } finally {
    db.close()
  }
}

/**
 * 获取消息类型分布
 */
export function getMessageTypeDistribution(
  sessionId: string,
  filter?: TimeFilter
): Array<{ type: MessageType; count: number }> {
  const db = openDatabase(sessionId)
  if (!db) return []

  try {
    const { clause, params } = buildTimeFilter(filter)
    const clauseWithSystem = buildSystemMessageFilter(clause)

    const rows = db
      .prepare(
        `
      SELECT msg.type, COUNT(*) as count
      FROM message msg
      JOIN member m ON msg.sender_id = m.id
      ${clauseWithSystem}
      GROUP BY msg.type
      ORDER BY count DESC
    `
      )
      .all(...params) as Array<{ type: number; count: number }>

    return rows.map((r) => ({
      type: r.type as MessageType,
      count: r.count,
    }))
  } finally {
    db.close()
  }
}

/**
 * 获取时间范围
 */
export function getTimeRange(sessionId: string): { start: number; end: number } | null {
  const db = openDatabase(sessionId)
  if (!db) return null

  try {
    const row = db
      .prepare(
        `
      SELECT MIN(ts) as start, MAX(ts) as end FROM message
    `
      )
      .get() as { start: number | null; end: number | null }

    if (row.start === null || row.end === null) return null

    return { start: row.start, end: row.end }
  } finally {
    db.close()
  }
}

/**
 * 获取数据库存储目录
 */
export function getDbDirectory(): string {
  ensureDbDir()
  return getDbDir()
}

/**
 * 获取成员的历史昵称记录
 */
export function getMemberNameHistory(
  sessionId: string,
  memberId: number
): Array<{ name: string; startTs: number; endTs: number | null }> {
  const db = openDatabase(sessionId)
  if (!db) return []

  try {
    const rows = db
      .prepare(
        `
      SELECT name, start_ts as startTs, end_ts as endTs
      FROM member_name_history
      WHERE member_id = ?
      ORDER BY start_ts DESC
    `
      )
      .all(memberId) as Array<{ name: string; startTs: number; endTs: number | null }>

    return rows
  } finally {
    db.close()
  }
}
