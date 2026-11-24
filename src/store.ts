/**
 * 状态持久化：一个 JSON 文件，写时原子替换。
 *
 * 为什么不上 SQLite：量级是「几个 BOT、几百条任务」，读全量进内存最省事，
 * 出问题时用记事本就能看。真到需要索引的时候再换。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { emptyState, EVENT_LIMIT, type Ask, type Bot, type Event, type State, type Task } from './domain.ts'

export class Store {
  private readonly path: string
  private state: State

  constructor(stateDir: string) {
    this.path = join(stateDir, 'bots.json')
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    this.state = this.load()
  }

  private load(): State {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<State>
      return { bots: raw.bots ?? {}, tasks: raw.tasks ?? {}, asks: raw.asks ?? {}, events: raw.events ?? [], pending: raw.pending ?? {} }
    } catch {
      return emptyState()
    }
  }

  get current(): State { return this.state }

  private persist(): void {
    const temp = `${this.path}.tmp`
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(temp, JSON.stringify(this.state, null, 2), 'utf8')
    renameSync(temp, this.path)
  }

  saveBot(bot: Bot): void { this.state.bots[bot.id] = bot; this.persist() }
  saveTask(task: Task): void { this.state.tasks[task.id] = task; this.persist() }

  saveAsk(ask: Ask): void { this.state.asks[ask.id] = ask; this.persist() }

  /** 追加一条动态。超过上限就丢掉最旧的，避免这个文件无限长。 */
  pushEvent(event: Event): void {
    this.state.events.push(event)
    if (this.state.events.length > EVENT_LIMIT) this.state.events.splice(0, this.state.events.length - EVENT_LIMIT)
    this.persist()
  }

  setPending(sessionId: string, taskId: string): void {
    this.state.pending[sessionId] = taskId
    this.persist()
  }

  clearPending(sessionId: string): void {
    if (this.state.pending[sessionId] === undefined) return
    delete this.state.pending[sessionId]
    this.persist()
  }

  updateBot(id: string, change: (bot: Bot) => void): Bot {
    const bot = this.state.bots[id]
    if (!bot) throw new Error(`Unknown bot: ${id}`)
    change(bot)
    this.persist()
    return bot
  }

  updateTask(id: string, change: (task: Task) => void): Task {
    const task = this.state.tasks[id]
    if (!task) throw new Error(`Unknown task: ${id}`)
    change(task)
    this.persist()
    return task
  }
}
