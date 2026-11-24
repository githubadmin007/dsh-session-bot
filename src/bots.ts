/**
 * BOT 与任务的运行时。
 *
 * 会话是 DSH 的，这里只做三件事：把会话认领成 BOT、给 BOT 挂工具和提示词、
 * 派活并把结果收齐。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Config } from './config.ts'
import {
  botIdOf, DEFAULT_TIMEOUT_MINUTES, MAX_TARGETS, MEMORY_LIMIT, isLive, isPending,
  type Ask, type Bot, type Event, type ReportKind, type Task,
} from './domain.ts'
import { BOT_PROMPT, CLAIM_PROMPT, expiredMessage, resultMessage, taskMessage, unreportedMessage } from './prompt.ts'
import { Store } from './store.ts'

// DSH 在 Context 上提供的服务声明，以及本插件自己的消息来源。
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-session-bot': { kind: 'dsh-session-bot' } & ContextFormed
  }
}

/** 往某个会话投一条消息。`wake` 为假时只注入，不打断它当前的工作。 */
function deliver(agent: Agent, text: string, key: string, wake: boolean): void {
  const message = freezeMessage({
    id: MessageId(`dsh-session-bot:${key}`),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'dsh-session-bot', form: 'relay' },
  })
  if (wake) agent.followup(message)
  else agent.inject(message)
}

/** 把工具注册到会话自己的作用域里，返回注销用的 disposer。 */
function register(agent: Agent, name: string, description: string, schema: z.ZodType,
  execute: (args: unknown, signal: AbortSignal) => Promise<unknown>): () => void {
  return agent.ctx.tools.register({
    name,
    description,
    parameters: z.toJSONSchema(schema),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    },
    execute: (args: unknown, execution: { signal: AbortSignal }) => execute(schema.parse(args), execution.signal),
  })
}

export class Bots {
  private readonly store: Store
  /**
   * 当前挂着工具的那个 agent 实例 → 它的清理函数。
   *
   * 不能用「sessionId 记过的就跳过」：会话 resume 时旧 ctx 会被清理，工具跟着没掉，
   * 而那个 Set 还记着，于是永远不再重建——表现就是 BOT 重启后变成 unknown tool。
   * 按 agent 实例记，重建前先把旧的拆干净，每次都是全新的一副工具。
   */
  private readonly decorations = new WeakMap<Agent, (() => void)[]>()
  /** sessionId → 已经请它写交接笔记、正在等提交。 */
  private readonly awaitingNote = new Set<string>()
  private readonly disposers = new Map<string, (() => void)[]>()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly ctx: Context, private readonly config: Config) {
    this.store = new Store(config.stateDir)
  }

  start(): void {
    this.timer = setInterval(() => { void this.expire() }, 60_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  // ── 档案 ─────────────────────────────────────────────────────

  /** 会话对应的档案；历史段也算，因为归档之后还能从段 id 找回同一个 BOT。 */
  botOfSession(sessionId: string): Bot | undefined {
    return Object.values(this.store.current.bots)
      .find(bot => bot.sessionId === sessionId || bot.segments.includes(sessionId))
  }

  /** 认领：把一个普通会话变成 BOT。由人触发（界面或对话里的明确要求）。 */
  claim(sessionId: string, input: { name: string; brief?: string; detail?: string; project?: string; workdir?: string }): Bot {
    const id = botIdOf(sessionId)
    const existing = this.store.current.bots[id]
    if (existing) return existing
    const agent = this.ctx.agents.get(sessionId as SessionId)
    const cwd = agent?.session.header.cwd
    const bot: Bot = {
      id,
      sessionId,
      ...cwd ? { workdir: cwd } : {},
      segments: [],
      name: input.name,
      brief: input.brief ?? '',
      detail: input.detail ?? '',
      memory: '',
      peers: [],
      ...input.project ? { project: input.project } : {},
      ...input.workdir ? { workdir: input.workdir } : {},
      createdAt: new Date().toISOString(),
    }
    this.store.saveBot(bot)
    this.record('claim', `认领了会话 ${sessionId} 作为「${bot.name}」`, { botId: bot.id })
    this.redecorate(sessionId)
    return bot
  }

  /** 改可协作名单并落盘。档案的这部分由人设定，所以只在这里被改。 */
  storePeers(bot: Bot): void {
    this.store.updateBot(bot.id, item => { item.peers = bot.peers })
  }

  /** 撤掉旧工具再装饰一遍；认领之后要从「只有一个认领入口」换成「全套」。 */
  redecorate(sessionId: string): void {
    for (const dispose of this.disposers.get(sessionId) ?? []) dispose()
    this.disposers.delete(sessionId)
    const agent = this.ctx.agents.get(sessionId as SessionId)
    if (agent) this.decorate(agent)
  }

  /** 给会话挂提示词与工具：未认领的只有一个认领入口，已认领的是全套。 */
  decorate(agent: Agent): void {
    try {
      this.applyDecoration(agent)
    } catch (error) {
      this.ctx.logger?.warn?.('dsh-session-bot: decorating %s failed: %s', agent.id, String(error))
    }
  }

  private applyDecoration(agent: Agent): void {
    // 每次进来都先把上一次挂的东西拆干净，再重新挂。看着浪费，但这是唯一能跟上
    // agent 实例更替的做法：会话 resume 之后旧 ctx 被清理，工具跟着没了，
    // 如果用一个「装饰过的 sessionId」集合去防重，就再也补不回来了。
    const previous = this.decorations.get(agent)
    if (previous) {
      for (const dispose of previous) {
        try { dispose() } catch { /* 已经失效的清理器忽略 */ }
      }
      this.decorations.delete(agent)
    }
    // 只有已经认领的会话才装饰。没认领的会话等于插件不存在——这是零迁移的代价与卖点：
    // 装完不会往你每个会话里塞工具和提示词，认领从界面做。
    if (this.botOfSession(agent.id) === undefined) return
    const sessionId = agent.id
    const disposers: (() => void)[] = []
    this.disposers.set(sessionId, disposers)
    // 提示词每次请求重算，所以认领之后这一段的文字会自动换成 BOT 版。
    // 这个 disposer 一定要收下：section 是按名字占位的，同名注册两次会打架。
    disposers.push(agent.ctx.systemPrompt.section({
      name: 'dsh-session-bot',
      order: 9000,
      interpolate: false,
      text: () => {
        const current = this.botOfSession(sessionId)
        if (!current) return CLAIM_PROMPT
        const head = `## 你是 ${current.name}\n${current.brief}`
        // 详情整段提到最前并框成「工作约束」：它同时装着职责（不写代码）和事实（仓库在哪），
        // 两者都是「你该怎么做」，分开存反而要 BOT 猜应该写进哪一格。
        const rules = current.detail ? `\n\n## 工作约束（必须遵守）\n${current.detail}` : ''
        return `${head}${rules}\n\n${BOT_PROMPT}${this.historySection(current)}${this.peerSection(current)}`
      },
    }))
    const bot = this.botOfSession(sessionId)
    // 未认领的会话什么都不挂：零侵入是这套东西的卖点，认领从界面做。
    if (bot) {
      this.botTools(agent, bot, disposers)
    }
    // 登记下来，下次 decorate 时先拆这一副；context 销毁时也由它自己清干净。
    this.decorations.set(agent, disposers)
    agent.ctx.effect(() => () => {
      for (const dispose of disposers) dispose()
      if (this.decorations.get(agent) === disposers) this.decorations.delete(agent)
    })
  }

  /**
   * 历史段清单 + 搜索指引。
   *
   * 交接笔记只在开新段那一刻有用——它作为新会话的第一条消息进去了，之后就属于那段历史。
   * 所以这里不重复它，只告诉它「以前有过哪几段、要找内容用 session_search」。
   * 这样也不会出现「切回旧段时看到别的段的交接」那种张冠李戴。
   */
  private historySection(bot: Bot): string {
    if (!bot.segments.length) return ''
    const lines = bot.segments.map((id, index) => `- 第 ${index + 1} 段：${id}`)
    return `\n\n## 你的历史段\n共 ${bot.segments.length} 段，已归档。\n${lines.join('\n')}`
      + '\n\n要翻旧内容，用 `session_search`（可传 `sessionIds` 限定到某几段）。'
  }

  /** 可协作清单写进提示词，省得每次都要调 bot_list。 */
  private peerSection(bot: Bot): string {
    if (!bot.peers.length) return '\n\n## 可协作的 BOT\n（还没设置。用 bot_list 看有哪些，但现在谁都叫不动。）'
    const lines = bot.peers.flatMap(peerId => {
      const peer = this.store.current.bots[peerId]
      return peer ? [`- ${peer.name}（${peer.id}）：${peer.brief || '（无简介）'}`] : []
    })
    return lines.length ? `\n\n## 可协作的 BOT\n${lines.join('\n')}` : ''
  }

  // ── 工具 ─────────────────────────────────────────────────────


  private botTools(agent: Agent, bot: Bot, disposers: (() => void)[]): void {
    disposers.push(register(agent, 'bot_list', '列出所有 BOT：名称、简介、状态，并标注你可不可以叫它。',
      z.object({}).strict(),
      async () => ({ bots: this.listFor(bot) })))

    disposers.push(register(agent, 'bot_info', '看某个 BOT 的详情（不含它的记忆）。',
      z.object({ bot_id: z.string().describe('BOT id') }).strict(),
      async raw => {
        const { bot_id: id } = raw as { bot_id: string }
        const target = this.store.current.bots[id]
        if (!target) throw new Error(`没有这个 BOT：${id}`)
        return {
          id: target.id, name: target.name, brief: target.brief, detail: target.detail,
          project: target.project, segments: target.segments.length,
          canCall: bot.peers.includes(id), live: isLive(target),
        }
      }))

    disposers.push(register(agent, 'bot_edit',
      '改自己的简介和工作约束。用户告诉你「你是谁、该做什么、不该做什么」时用它记下来。改不了工具开关和可协作名单——那些由人在界面定。',
      z.object({
        brief: z.string().optional().describe('一句话说明你是做什么的'),
        detail: z.string().optional().describe('工作约束：该做什么、不该做什么，以及仓库位置、约定'),
      }).strict(),
      async raw => {
        const patch = raw as { brief?: string; detail?: string }
        if (patch.brief === undefined && patch.detail === undefined) {
          throw new Error('至少给一个要改的字段')
        }
        this.store.updateBot(bot.id, item => {
          if (patch.brief !== undefined) item.brief = patch.brief
          if (patch.detail !== undefined) item.detail = patch.detail
        })
        return { updated: Object.keys(patch), note: '下一轮开始生效。' }
      }))

    disposers.push(register(agent, 'bot_remember', '把一件跨对话该记住的事写进自己的记忆。',
      z.object({ note: z.string().min(1).describe('要记住的内容，一句话说清') }).strict(),
      async raw => {
        const { note } = raw as { note: string }
        const next = `${bot.memory}${bot.memory ? '\n' : ''}- ${note.trim()}`
        const bytes = Buffer.byteLength(next, 'utf8')
        if (bytes > MEMORY_LIMIT) {
          throw new Error(`记忆已满（${bytes}/${MEMORY_LIMIT} 字节）。先用 bot_forget 把整段重写成要点，再写新的。`)
        }
        this.store.updateBot(bot.id, item => { item.memory = next })
        return { bytes, limit: MEMORY_LIMIT }
      }))

    disposers.push(register(agent, 'bot_forget', '整段重写或清空自己的记忆。',
      z.object({ memory: z.string().default('').describe('新的整段记忆；留空就是清空') }).strict(),
      async raw => {
        const { memory } = raw as { memory: string }
        const bytes = Buffer.byteLength(memory, 'utf8')
        if (bytes > MEMORY_LIMIT) throw new Error(`超过上限 ${MEMORY_LIMIT} 字节`)
        this.store.updateBot(bot.id, item => { item.memory = memory })
        return { bytes }
      }))

    disposers.push(register(agent, 'bot_ask', '需要人决定时问他。问完本轮可以结束，不会卡住。',
      z.object({
        question: z.string().min(1).describe('一个具体到可以回答的问题'),
        options: z.array(z.string()).max(6).optional().describe('可选的几个答案'),
      }).strict(),
      async raw => {
        const { question, options } = raw as { question: string; options?: string[] }
        const ask: Ask = {
          id: `ask-${Date.now().toString(36)}`,
          botId: bot.id,
          question,
          ...options?.length ? { options } : {},
          createdAt: new Date().toISOString(),
        }
        this.store.saveAsk(ask)
        this.record('ask', `${bot.name} 提问：${question}`, { botId: bot.id })
        return { ask_id: ask.id, note: '已记入待办，用户会在面板看到。本轮可以结束。' }
      }))
  }

  // ── 任务 ─────────────────────────────────────────────────────

  private taskView(task: Task) {
    return {
      id: task.id,
      targets: task.targets,
      expect: task.expect,
      done: task.completed.length,
      status: task.status,
      expiresAt: task.expiresAt,
      completed: task.completed.map(item => {
        const name = this.store.current.bots[item.botId]?.name ?? item.botId
        return `${name}（${item.kind}）：${item.summary}`
      }),
    }
  }

  /**
   * BOT 名册。每个条目带两个方向的未完成任务数：
   * - `sentPending`：它派出去还没回来的
   * - `receivedPending`：别人派给它、它还没交的
   *
   * 只看一个方向会误判「它在忙」：一个人手上压着别人派的活，和它自己派了三单出去，
   * 是两种完全不同的状态。经理靠这两个数就能分辨谁卡住、谁在等。
   */
  private listFor(self: Bot | undefined) {
    const pending = Object.values(this.store.current.tasks).filter(isPending)
    return Object.values(this.store.current.bots).filter(isLive).map(bot => ({
      id: bot.id,
      name: bot.name,
      brief: bot.brief,
      project: bot.project,
      canCall: self?.peers.includes(bot.id) ?? false,
      sentPending: pending.filter(task => task.initiator === bot.id).length,
      receivedPending: pending.filter(task => task.targets.includes(bot.id)).length,
    }))
  }

  /** 发起任务：校验名单、建 Task、逐个投递、登记兜底表。 */
  async createTask(initiator: Bot, entries: { bot: string; brief: string }[], expect?: number, timeoutMinutes?: number): Promise<unknown> {
    const notPeer = entries.filter(item => !initiator.peers.includes(item.bot)).map(item => item.bot)
    if (notPeer.length) throw new Error(`这些 BOT 不在你的可协作清单里：${notPeer.join('、')}。先让用户把它们加进你的档案。`)
    const unknown = entries.filter(item => this.store.current.bots[item.bot] === undefined).map(item => item.bot)
    if (unknown.length) throw new Error(`没有这些 BOT：${unknown.join('、')}`)

    const now = new Date()
    const minutes = timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES
    const task: Task = {
      id: `T-${now.getTime().toString(36)}`,
      initiator: initiator.id,
      targets: entries.map(item => item.bot),
      entries: entries.map(item => ({ bot: item.bot, brief: item.brief })),
      expect: Math.min(expect ?? entries.length, entries.length),
      completed: [],
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + minutes * 60_000).toISOString(),
    }
    this.store.saveTask(task)
    this.record('task', `${initiator.name} 派活给 ${entries.map(item => this.store.current.bots[item.bot]?.name ?? item.bot).join('、')}`, { botId: initiator.id, taskId: task.id })

    const delivered: string[] = []
    const failed: string[] = []
    for (const entry of entries) {
      const target = this.store.current.bots[entry.bot]!
      const resolved = await this.ctx.sessionController.resolveAgent(target.sessionId as SessionId)
      if ('error' in resolved) { failed.push(`${target.name}: 会话打不开`); continue }
      this.store.setPending(target.sessionId, task.id)
      deliver(resolved.agent, taskMessage({
        taskId: task.id,
        fromName: initiator.name,
        fromId: initiator.id,
        brief: entry.brief,
        expiresAt: task.expiresAt,
      }), `task:${task.id}:${entry.bot}`, true)
      delivered.push(target.name)
    }
    return { task: this.taskView(task), delivered, failed }
  }

  /** 上报：去重、记账、凑齐就通知发起方。 */
  report(taskId: string, bot: Bot, kind: ReportKind, summary: string): unknown {
    const task = this.store.current.tasks[taskId]
    if (!task) throw new Error(`没有这个任务：${taskId}`)
    if (!task.targets.includes(bot.id)) throw new Error('这个任务不是派给你的')
    this.store.clearPending(bot.sessionId)
    if (task.status !== 'pending') return { note: `任务已是 ${task.status}，这次只记录不改状态`, task: this.taskView(task) }
    if (task.completed.some(item => item.botId === bot.id)) return { note: '已经报过一次，这次忽略', task: this.taskView(task) }

    this.store.updateTask(taskId, item => {
      item.completed.push({ botId: bot.id, kind, summary, at: new Date().toISOString() })
      const enough = item.completed.length >= item.expect
      const everyone = item.targets.every(target => item.completed.some(done => done.botId === target))
      if (enough || everyone) item.status = 'done'
    })
    const next = this.store.current.tasks[taskId]!
    this.record('report', `${bot.name} 上报 ${next.id}：${kind} — ${summary}`, { botId: bot.id, taskId })
    if (next.status === 'done') void this.notifyInitiator(next)
    return { task: this.taskView(next) }
  }

  /** 凑齐后叫醒发起方，把结果一次给全。 */
  private async notifyInitiator(task: Task): Promise<void> {
    const initiator = this.store.current.bots[task.initiator]
    if (!initiator) return
    const resolved = await this.ctx.sessionController.resolveAgent(initiator.sessionId as SessionId)
    if ('error' in resolved) return
    deliver(resolved.agent, resultMessage({
      taskId: task.id,
      done: task.completed.length,
      expect: task.expect,
      lines: task.completed.map(item => {
        const name = this.store.current.bots[item.botId]?.name ?? item.botId
        return `- ${name}（${item.kind}）：${item.summary}`
      }),
    }), `result:${task.id}`, true)
  }

  /** 每分钟扫一次，把过期的任务叫醒发起方。 */
  async expire(): Promise<void> {
    const now = Date.now()
    for (const task of Object.values(this.store.current.tasks)) {
      if (!isPending(task) || Date.parse(task.expiresAt) > now) continue
      this.store.updateTask(task.id, item => { item.status = 'expired' })
      this.record('expire', `任务 ${task.id} 超时`, { taskId: task.id })
      const initiator = this.store.current.bots[task.initiator]
      if (!initiator) continue
      const resolved = await this.ctx.sessionController.resolveAgent(initiator.sessionId as SessionId)
      if ('error' in resolved) continue
      deliver(resolved.agent, expiredMessage({
        taskId: task.id,
        missing: task.targets.filter(target => !task.completed.some(done => done.botId === target))
          .map(target => this.store.current.bots[target]?.name ?? target),
        lines: task.completed.map(item => {
          const name = this.store.current.bots[item.botId]?.name ?? item.botId
          return `- ${name}：${item.summary}`
        }),
      }), `expire:${task.id}`, true)
    }
  }

  /**
   * 回合结束兜底：只对「持有未上报任务」的会话生效。
   *
   * 收窄到这一步是关键——每个回合都发通知的话，一次普通对话也会被当成任务结束。
   */
  async turnEnded(sessionId: string, lastWords: string): Promise<void> {
    const taskId = this.store.current.pending[sessionId]
    if (taskId === undefined) return
    const bot = this.botOfSession(sessionId)
    if (!bot) { this.store.clearPending(sessionId); return }
    const task = this.store.current.tasks[taskId]
    if (!task || task.status !== 'pending' || task.completed.some(item => item.botId === bot.id)) {
      this.store.clearPending(sessionId)
      return
    }
    const initiator = this.store.current.bots[task.initiator]
    if (!initiator) return
    const resolved = await this.ctx.sessionController.resolveAgent(initiator.sessionId as SessionId)
    if ('error' in resolved) return
    deliver(resolved.agent, unreportedMessage({ taskId, botName: bot.name, lastWords: lastWords.slice(0, 400) }),
      `unreported:${taskId}:${bot.id}:${Date.now()}`, false)
  }

  /** 记一条动态。失败不影响主流程——动态流是旁路。 */
  private record(kind: Event['kind'], text: string, link: { botId?: string; taskId?: string } = {}): void {
    try {
      this.store.pushEvent({
        id: `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        at: new Date().toISOString(),
        kind,
        text,
        ...link,
      })
    } catch (error) {
      this.ctx.logger?.warn?.('dsh-session-bot: recording event failed: %s', String(error))
    }
  }

  /**
   * 修一个会话的标题与归属。
   *
   * 换段在没有继承 workspace 的版本里跑过，产出的新段掉进了「未分组」且叫「未命名」。
   * 这个接口把那样的会话摆回原来的分组与名字；以后别的地方要补也一样走它。
   */
  /**
   * 把一个历史段从 BOT 上解除关联。
   *
   * 只断开档案里的引用，**不删会话、不改标题**——那一段可能还有有用的对话，
   * 解除之后它就退回成一个普通会话，右键还能重新认领。
   */
  removeSegment(botId: string, sessionId: string): { ok: boolean; reason?: string } {
    const bot = this.store.current.bots[botId]
    if (!bot) return { ok: false, reason: '没有这个 BOT' }
    if (bot.sessionId === sessionId) return { ok: false, reason: '当前段不能移除，先切到别的段' }
    if (!bot.segments.includes(sessionId)) return { ok: false, reason: '这一段不在历史里' }
    this.store.updateBot(botId, item => {
      item.segments = item.segments.filter(id => id !== sessionId)
    })
    this.record('rotate', `${bot.name} 解除了对历史段 ${sessionId} 的关联`, { botId })
    return { ok: true }
  }

  /**
   * 把一个历史段切回成当前段。
   *
   * 换段不是单向的：人可能取消归档了旧段，想回去继续做。这时不能新建 BOT（那就重复了），
   * 而是把 bot.sessionId 指回那一段，原来的当前段退成历史。归档过的那一段要先解归档，
   * 否则 DSH 拒绝在它上面跑任何一步。
   */
  async setCurrent(botId: string, sessionId: string): Promise<{ ok: boolean; reason?: string }> {
    const bot = this.store.current.bots[botId]
    if (!bot) return { ok: false, reason: '没有这个 BOT' }
    if (bot.sessionId === sessionId) return { ok: true }
    if (!bot.segments.includes(sessionId)) return { ok: false, reason: '这个会话不属于这个 BOT' }
    if (this.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId as never)) {
      try {
        await this.ctx.workspaceRegistry.unarchiveSession(sessionId as never)
      } catch (error) {
        return { ok: false, reason: `解归档失败：${String(error)}` }
      }
    }
    const previous = bot.sessionId
    this.store.updateBot(botId, item => {
      item.segments = [...item.segments.filter(id => id !== sessionId), previous]
      item.sessionId = sessionId
    })
    this.redecorate(sessionId)
    this.record('rotate', `${bot.name} 切回旧段 ${sessionId}`, { botId })
    return { ok: true }
  }

  async fixSession(sessionId: string, patch: { title?: string; workspacePath?: string }): Promise<{ title?: string; workspace?: string }> {
    if (patch.title) {
      await this.ctx.sessionController.rename({ sessionId: sessionId as SessionId, title: patch.title })
    }
    let attached: string | undefined
    if (patch.workspacePath) {
      const workspace = await this.ctx.workspaceRegistry.resolveByPath(patch.workspacePath)
      if (workspace) {
        if (!workspace.sessionIds.includes(sessionId as never)) await workspace.attachSession(sessionId as never)
        attached = workspace.path
      }
    }
    return { ...patch.title ? { title: patch.title } : {}, ...attached ? { workspace: attached } : {} }
  }

  /** 动态流，新的在前。 */
  listEvents(limit = 50) {
    return [...this.store.current.events].reverse().slice(0, limit)
  }

  /**
   * 回答一条待办：写入答案并唤醒问的那个 BOT。
   *
   * 这是「BOT 等人」唯一的出口。答完待办就从列表里消失，BOT 收到一条普通消息接着干。
   */
  async answer(askId: string, answer: string): Promise<{ ok: boolean; botId?: string }> {
    const ask = this.store.current.asks[askId]
    if (!ask) return { ok: false }
    if (ask.answer !== undefined) return { ok: true, botId: ask.botId }
    this.store.saveAsk({ ...ask, answer, answeredAt: new Date().toISOString() })
    const bot = this.store.current.bots[ask.botId]
    this.record('answer', `回答 ${bot?.name ?? ask.botId} 的问题：${answer}`, { botId: ask.botId })
    if (!bot) return { ok: true, botId: ask.botId }
    const resolved = await this.ctx.sessionController.resolveAgent(bot.sessionId as SessionId)
    if ('error' in resolved) return { ok: true, botId: ask.botId }
    deliver(resolved.agent, [
      '[你之前问的问题有人回答了]',
      '',
      `问：${ask.question}`,
      `答：${answer}`,
      '',
      '接着做。',
    ].join('\n'), `answer:${askId}`, true)
    return { ok: true, botId: ask.botId }
  }

  // ── 管理接口（面板与菜单按钮用，不给 BOT 调）─────────────────

  /** 全部 BOT 的一句话视图。 */
  listAll() {
    return Object.values(this.store.current.bots).map(bot => ({
      id: bot.id,
      sessionId: bot.sessionId,
      name: bot.name,
      brief: bot.brief,
      project: bot.project,
      live: isLive(bot),
      segments: bot.segments.length,
      segmentIds: bot.segments,
      peers: bot.peers,
      memoryBytes: Buffer.byteLength(bot.memory, 'utf8'),
    }))
  }

  /** 一个 BOT 的完整档案，含记忆与可协作名单——这是给人看的，不是给 BOT 看的。 */
  viewOf(id: string) {
    const bot = this.store.current.bots[id]
    if (!bot) return undefined
    return {
      id: bot.id,
      sessionId: bot.sessionId,
      name: bot.name,
      brief: bot.brief,
      detail: bot.detail,
      memory: bot.memory,
      lastNote: bot.lastNote ?? '',
      workdir: bot.workdir ?? '',
      peers: bot.peers,
      project: bot.project,
      live: isLive(bot),
      segments: bot.segments,
      createdAt: bot.createdAt,
      tasks: Object.values(this.store.current.tasks)
        .filter(task => task.initiator === id || task.targets.includes(id))
        .slice(-20)
        .map(task => this.taskView(task)),
    }
  }

  /** 等用户决定的事，最近的在前。 */
  listAsks() {
    return Object.values(this.store.current.asks)
      .filter(ask => ask.answer === undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(ask => ({
        id: ask.id,
        botId: ask.botId,
        botName: this.store.current.bots[ask.botId]?.name ?? ask.botId,
        question: ask.question,
        options: ask.options ?? [],
        createdAt: ask.createdAt,
      }))
  }

  /** 最近的派活，新的在前。 */
  listTasks() {
    return Object.values(this.store.current.tasks)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 50)
      .map(task => this.taskView(task))
  }

  /**
   * 改档案：名称、简介、详情、可协作名单。
   *
   * 这是唯一能改档案的入口，而且只由人从面板触发——BOT 自己没有任何工具能改它自己。
   * 提示词每次请求都重算，所以改完下一轮就生效，不需要重建会话。
   */
  update(id: string, patch: { name?: string; brief?: string; detail?: string; project?: string; peers?: string[]; memory?: string }) {
    const bot = this.store.current.bots[id]
    if (!bot) return undefined
    const peers = patch.peers === undefined
      ? undefined
      : [...new Set(patch.peers)].filter(peer => this.store.current.bots[peer] !== undefined && peer !== id)
    this.store.updateBot(id, item => {
      if (patch.name !== undefined) item.name = patch.name.trim() || item.name
      if (patch.brief !== undefined) item.brief = patch.brief
      if (patch.detail !== undefined) item.detail = patch.detail
      if (patch.project !== undefined) item.project = patch.project || undefined
      if (peers !== undefined) item.peers = peers
      // 记忆原本是 BOT 自己写的，但人也可以直接改——他看到的是「它记住了什么」，
      // 有错就该能当场纠正，而不是绕着让 BOT 自己重写一遍。
      if (patch.memory !== undefined) item.memory = patch.memory.slice(0, MEMORY_LIMIT)
    })
    return this.viewOf(id)
  }

  /** 设置可协作清单；人从面板改。 */
  setPeers(id: string, peers: string[]) {
    const bot = this.store.current.bots[id]
    if (!bot) return undefined
    const valid = [...new Set(peers)].filter(peer => this.store.current.bots[peer] !== undefined && peer !== id)
    this.store.updateBot(id, item => { item.peers = valid })
    return this.viewOf(id)
  }

  /** 归档一个 BOT：会话归档，档案标记归档。 */
  async archive(id: string): Promise<boolean> {
    const bot = this.store.current.bots[id]
    if (!bot) return false
    try {
      await this.ctx.workspaceRegistry.archiveSession(bot.sessionId as SessionId, { stopActivity: true })
    } catch (error) {
      this.ctx.logger?.warn?.('dsh-session-bot: archiving %s failed: %s', bot.sessionId, String(error))
    }
    this.store.updateBot(id, item => { item.archivedAt = new Date().toISOString() })
    return true
  }

  /**
   * 请 BOT 自己写交接笔记，写完再换段。
   *
   * 换段最值钱的东西就是那份笔记，让用户手写等于把这件事推回给人。所以在动手之前先问它：
   * 这一段做了什么、剩下什么。它调 bot_note 提交之后才真的归档。
   */
  async askForNote(sessionId: string): Promise<{ ok: boolean; reason?: string }> {
    const bot = this.botOfSession(sessionId)
    if (!bot) return { ok: false, reason: '这个会话还不是 BOT' }
    if (bot.sessionId !== sessionId) return { ok: false, reason: '这里是历史段，换段只能在当前段里做' }
    const agent = this.ctx.agents.get(sessionId as SessionId)
    if (!agent) return { ok: false, reason: '会话没在运行，叫不动它' }
    this.awaitingNote.add(sessionId)
    deliver(agent, [
      '[准备换段]',
      '',
      '你这一段要结束了，下一条消息会在一个全新的会话里继续。',
      '请写一份交接笔记，让「接下来的你」能无缝接上：',
      '- 这一段做了什么、结论是什么',
      '- 还有什么事没做完',
      '- 需要原样记住的约定、路径、命令',
      '',
      '写完调用 bot_note(note: "<笔记全文>")。提交之后这一段会被归档。',
    ].join('\n'), `rotate-ask:${Date.now()}`, true)
    return { ok: true }
  }

  /** BOT 提交交接笔记：真正执行换段。 */
  async submitNote(sessionId: string, bot: Bot, note: string): Promise<unknown> {
    if (!this.awaitingNote.has(sessionId)) {
      throw new Error('现在没有在等交接笔记。换段请先用 /bot_new_session 发起。')
    }
    this.awaitingNote.delete(sessionId)
    return await this.rotate(bot.id, note)
  }

  /** 换段：写交接笔记 → 归档旧会话 → 新开一段 → 把笔记注入新段。 */
  /** 从这一段最后一条助手发言 + 记忆里拼出一份交接。不需要额外的模型调用。 */
  private autoNote(bot: Bot): string {
    let last = ''
    const agent = this.ctx.agents.get(bot.sessionId as SessionId)
    if (agent) {
      const events = agent.session.snapshotEvents() as unknown as {
        type?: string
        data?: { message?: { content?: { type?: string; text?: string }[] } }
      }[]
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]?.type !== 'assistant/message') continue
        const content = events[i]?.data?.message?.content
        if (!Array.isArray(content)) continue
        const text = content.filter(block => block.type === 'text').map(block => block.text ?? '').join('').trim()
        if (text) { last = text; break }
      }
    }
    return [
      `# 交接（自动生成 · ${new Date().toISOString()}）`,
      '',
      '## 这一段最后说的话',
      last ? last.slice(0, 3000) : '（没有留下文字）',
      '',
      '## 记忆',
      bot.memory || '（还没有记忆）',
      '',
      '## 更早的段',
      '这一段之前已经换过 ' + bot.segments.length + ' 次段；那些内容已归档，',
      '需要时用 session_search 搜（可传 sessionIds 限定）。',
    ].join('\n')
  }

  async rotate(botId: string, note = ''): Promise<unknown> {
    const bot = this.store.current.bots[botId]
    if (!bot) throw new Error(`没有这个 BOT：${botId}`)
    const dir = join(this.config.stateDir, 'notes', botId)
    mkdirSync(dir, { recursive: true })
    const part = bot.segments.length + 2
    const text = note.trim() || this.autoNote(bot)
    writeFileSync(join(dir, `part-${part - 1}.md`), text, 'utf8')
    // 同时留在档案里：新段每次请求都会把它带进提示词，
    // 这样即使新会话还没跑过回合，用户一开口它就知道上一段做了什么。
    this.store.updateBot(botId, item => { item.lastNote = text })
    const previous = bot.sessionId
    // 归档之前先把「新的一段应该长在哪」问清楚：同一个 workspace、同一个 cwd。
    // 不问就去建，新会话会掉进侧栏的「未分组」，名字也会变成「未命名」。
    const live = await this.ctx.sessionController.resolveAgent(previous as SessionId)
    const previousCwd = !('error' in live) ? (live.agent.session.header.cwd ?? this.config.workspace) : this.config.workspace
    // 工作目录是 BOT 的属性：优先用它记着的那个，其次才是上一段所在的地方。
    const workdir = bot.workdir ?? previousCwd
    const home = this.ctx.workspaceRegistry.list().find(item => item.path === workdir)
      ?? this.ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(previous as never))
      ?? await this.ctx.workspaceRegistry.resolveByPath(workdir)
    try {
      await this.ctx.workspaceRegistry.archiveSession(previous as SessionId, { stopActivity: true })
    } catch (error) {
      this.ctx.logger?.warn?.('dsh-session-bot: archiving %s failed: %s', previous, String(error))
    }
    // 段名从**原始段**派生，不是从当前段：否则第二次换段会得到 `S-p2-p3`，
    // 第三次 `S-p2-p3-p4`，越滚越长，语义也乱了。同一批段应该共享一个基底。
    const base = bot.segments[0] ?? bot.sessionId
    // 旧段可能还占着这个名字（用户移除关联后会话还在）。复用它会带上旧的 cwd，
    // 所以一路往后跳，直到找到一个没被占用的编号。
    let fresh = `${base}-p${part}`
    let next = part
    for (let guard = 0; guard < 50; guard++) {
      const probe = await this.ctx.sessionController.resolveAgent(fresh as SessionId)
      if ('error' in probe) break
      next += 1
      fresh = `${base}-p${next}`
    }
    const existed = await this.ctx.sessionController.resolveAgent(fresh as SessionId)
    if ('error' in existed) {
      // 有 workspace 就挂回同一个 workspace，这样侧栏里它还在原来的分组下；
      // 没有（原本就在未分组）就沿用旧的 cwd，位置不变。
      await this.ctx.sessionController.create(home
        ? { sessionId: fresh as SessionId, workspaceId: home.id }
        : { sessionId: fresh as SessionId, cwd: workdir })
      await this.ctx.sessionController.rename({ sessionId: fresh as SessionId, title: bot.name })
    }
    this.store.updateBot(botId, item => {
      item.segments.push(previous)
      item.sessionId = fresh
    })
    this.record('rotate', `${bot.name} 换段：旧段已归档`, { botId })
    const reopened = await this.ctx.sessionController.resolveAgent(fresh as SessionId)
    let woke = false
    if (!('error' in reopened)) {

      this.decorate(reopened.agent)
    }
    // 用 sessionController.prompt 而不是 agent.followup：
    // 新会话还没有回合在跑，followup 只会排进 inbox 等一个永远不会到来的回合。
    // prompt 是 UI 输入框走的那条路，它会真正把会话唤醒并跑一轮。
    try {
      await this.ctx.sessionController.prompt({
        requestId: `dsh-session-bot:rotate:${botId}:${part}` as never,
        sessionId: fresh as never,
        mode: 'queue',
        content: [{ type: 'text' as const, text: `[新的一段 · 上一段的交接]\n\n${text}` }],
      }, AbortSignal.timeout(30_000))
      woke = true
    } catch (error) {
      this.ctx.logger?.warn?.('dsh-session-bot: waking the new segment failed: %s', String(error))
    }
    return { botId, archived: previous, sessionId: fresh, note: join(dir, `part-${part - 1}.md`), woke }
  }
}