/**
 * dsh-session-bot 插件入口。
 *
 * 一个普通的 DSH 会话，认领一下就是 BOT。插件只往上挂档案、记忆和任务，
 * 不新建会话体系、不改 agent preset、不动你已有的工作目录。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { Bots } from './bots.ts'
import { registerHttp } from './server.ts'

// DSH 的命令服务声明。
import type {} from '@deepseek-ai/dsh-commands'
import { ConfigSchema, type Config } from './config.ts'

export const name = 'dsh-session-bot'

export const inject = ['tools', 'systemPrompt', 'sessionController', 'agents', 'workspaceRegistry', 'webServer', 'commands', 'sessionPersistence']

export const config = ConfigSchema

/** 启动诊断：插件加载失败不会让 DSH 报错，只会表现得像没装。 */
function boot(stateDir: string, message: string): void {
  try {
    mkdirSync(stateDir, { recursive: true })
    appendFileSync(join(stateDir, 'boot.log'), `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch { /* 诊断写不出去不该影响主流程 */ }
}

/** 从回合结束事件里捞出发言者最后说的话，给兜底通知用。 */
function lastWordsOf(data: unknown): string {
  const events = (data as { events?: { data?: { message?: { content?: { type?: string; text?: string }[] } } }[] })?.events
  if (!Array.isArray(events)) return ''
  for (let i = events.length - 1; i >= 0; i--) {
    const content = events[i]?.data?.message?.content
    if (!Array.isArray(content)) continue
    const text = content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
    if (text) return text
  }
  return ''
}

export function apply(ctx: Context, raw: Config): void {
  const parsed = ConfigSchema.safeParse(raw)
  const fallback = typeof (raw as { stateDir?: unknown })?.stateDir === 'string'
    ? (raw as { stateDir: string }).stateDir
    : process.cwd()
  boot(fallback, `apply called; config ${parsed.success ? 'ok' : `invalid: ${parsed.error.issues.map(issue => issue.path.join('.')).join(',')}`}`)
  if (!parsed.success) return

  const settings = parsed.data
  const bots = new Bots(ctx, settings)

  // 预置档案：配置里写了会话 id 的，启动时直接认领并挂上工具。
  for (const preset of settings.bots) {
    const bot = bots.claim(preset.sessionId, {
      name: preset.name,
      brief: preset.brief,
      detail: preset.detail,
      ...preset.project ? { project: preset.project } : {},
    })
    if (preset.peers.length && bot.peers.length !== preset.peers.length) {
      bot.peers = preset.peers
      bots.storePeers(bot)
    }
  }

  // 新会话：立刻装饰。
  ctx.on('agent/created', ({ agent }: { agent: Agent }) => { bots.decorate(agent) })

  // 已存在的会话：插件装上去之前就开着的那些，也要能认领。
  // 这一步是「零迁移」的关键——不然只有新会话能变成 BOT，老会话永远没入口。
  for (const agent of ctx.agents.list()) {
    if (agent.session.header.origin === 'subagent') continue
    bots.decorate(agent)
  }

  // 会话被唤醒时补一次装饰。
  //
  // 为什么必须在这里补：BOT 的工具是插件注册到会话作用域上的，而插件重启后那些注册全没了。
  // 已存在的会话不会重新走 `agent/created`（它是 resume 不是 create），于是重启之后
  // 所有 BOT 都会变成「unknown tool」——这正是实际踩到的。
  // `user/message` 在 turn 开始之前触发，此时补装饰，工具表对紧接着的请求就有效。
  ctx.on('session/event', (session: { id: string }, event: { type: string; data?: unknown }) => {
    if (event.type === 'user/message' || event.type === 'turn/start') {
      const agent = ctx.agents.get(session.id as never)
      if (agent) bots.decorate(agent)
    }
    if (event.type !== 'turn/end') return
    void bots.turnEnded(session.id, lastWordsOf(event.data))
  })

  // /bot_new_session：BOT 自己开新的一段。
  //
  // DSH 的命令是全局注册的，插件不能只给 BOT 会话挂，所以「仅 BOT 可用」在 handler 里挡。
  ctx.commands.register({
    definitionId: CommandDefinitionId('dsh-session-bot:new-session'),
    name: 'bot_new_session',
    description: 'BOT 专用：把当前这一段归档，开新的一段（可附一段交接笔记）',
    input: { hint: '[交接笔记]' },
    handler: async (invocation: { agent: Agent; rawInput: string }) => {
      const sessionId = invocation.agent.id
      const bot = bots.botOfSession(sessionId)
      if (bot === undefined) {
        return { kind: 'error' as const, text: '这个会话还不是 BOT。先在会话菜单里「BOT 信息 / 认领为 BOT」。' }
      }
      if (bot.sessionId !== sessionId) {
        return { kind: 'error' as const, text: '这里是历史段，不是当前段。换段只能在 BOT 的当前这一段里做。' }
      }
      // 一步到底：笔记由插件从「它最后说的话 + 记忆」自动生成，不让用户写、也不多跑一轮。
      // 换段会改状态、开新会话、唤醒它；任何一步失败都要说清楚，不能只回一句「已换段」。
      try {
        const result = await bots.rotate(bot.id) as { sessionId: string; woke: boolean }
        if (!result.woke) {
          return { kind: 'error' as const, text: `旧段已归档、新段是 ${result.sessionId}，但没能把它唤醒。它可能停在空白状态，去侧栏找它说句话即可。` }
        }
        return { kind: 'success' as const, text: `已换段。旧段归档，新段是 ${result.sessionId}，已经在跑了。` }
      } catch (error) {
        return { kind: 'error' as const, text: `换段失败：${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })

  const disposeHttp = registerHttp(ctx, bots)
  ctx.effect(() => () => { disposeHttp(); bots.stop() })
  bots.start()
  boot(settings.stateDir, `ready; ${settings.bots.length} preset bot(s)`)
}
