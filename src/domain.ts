/** 领域类型。纯数据：不碰 DSH，不碰磁盘。 */

/** 一个 BOT：未归档的 DSH 会话 + 一份档案。 */
export interface Bot {
  id: string
  /** 当前段的 DSH 会话 id。 */
  sessionId: string
  /** 历史段的会话 id，旧的在前。 */
  segments: string[]
  name: string
  /** 简介：一句话说明用途。 */
  brief: string
  /** 详情：仓库地址、工作目录、约定等。 */
  detail: string
  /** 记忆：BOT 自己累积。 */
  memory: string
  /**
   * 这个 BOT 的工作目录。认领时从会话的 cwd 记下来，之后换段都回到这里。
   *
   * 为什么不「继承上一个段」：上一个段可能是早期版本建错的（落在插件默认目录里），
   * 一路继承下去就一直错。工作目录是 BOT 的属性，不是段的属性。
   */
  workdir?: string
  /** 最近一次换段留下的交接笔记。新段每次请求都会把它带进提示词。 */
  lastNote?: string
  /** 可协作的 BOT id，单向。 */
  peers: string[]
  /** 可选的归属，面板分组用。 */
  project?: string
  createdAt: string
  archivedAt?: string
}

export type ReportKind = 'done' | 'blocked' | 'failed'

export interface Completion {
  botId: string
  kind: ReportKind
  summary: string
  at: string
}

/** 一次派活。id 同时就是 turnId。 */
export interface Task {
  id: string
  /** 发起方：botId，或 'human'。 */
  initiator: string
  targets: string[]
  /** 派给每个人的原话，`bot_activity` 靠它回答「它手上是些什么活」。 */
  entries: { bot: string; brief: string }[]
  /** 期望几个完成，默认等于 targets.length。 */
  expect: number
  completed: Completion[]
  status: 'pending' | 'done' | 'expired' | 'cancelled'
  createdAt: string
  expiresAt: string
}

/** 一件等用户决定的事。 */
export interface Ask {
  id: string
  botId: string
  question: string
  options?: string[]
  /** 关联的任务 id。 */
  task?: string
  answer?: string
  createdAt: string
  answeredAt?: string
}

/**
 * 动态流的一条记录。面板第三区读它。
 *
 * 刻意只存「一句话 + 指向谁」，不存完整对象：动态流是索引，细节去任务表和档案里看。
 */
export interface Event {
  id: string
  at: string
  kind: 'claim' | 'rotate' | 'task' | 'report' | 'expire' | 'ask' | 'answer'
  botId?: string
  taskId?: string
  text: string
}

export interface State {
  bots: Record<string, Bot>
  tasks: Record<string, Task>
  asks: Record<string, Ask>
  events: Event[]
  /** sessionId → 未上报的 taskId，用于回合结束兜底。 */
  pending: Record<string, string>
}

export const emptyState = (): State => ({ bots: {}, tasks: {}, asks: {}, events: [], pending: {} })

/** 稳定短 id：FNV-1a，够区分就够。 */
export function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** BOT 的 id 由会话 id 推导，重启后不依赖内存。 */
export const botIdOf = (sessionId: string): string => `bot-${hash(sessionId)}`

export const isLive = (bot: Bot): boolean => bot.archivedAt === undefined

export const isPending = (task: Task): boolean => task.status === 'pending'

/** 记忆上限：够记几十条，又不至于把上下文撑爆。 */
export const MEMORY_LIMIT = 8 * 1024

/** 默认任务超时（分钟）。 */
export const DEFAULT_TIMEOUT_MINUTES = 30

/** 动态流保留多少条；再多就丢掉最旧的。 */
export const EVENT_LIMIT = 300

/** 一段对话最多几个 BOT 同时被派活。 */
export const MAX_TARGETS = 6
