/**
 * 面板与菜单按钮背后的管理接口。
 *
 * 认领和设置协作都从这里走——它们是人的动作，不提供工具给 BOT 自己调。
 * 路由挂在 `/session-bot/api` 下，只接受同源请求。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { Bots } from './bots.ts'

// DSH 的 web server 服务声明。
import type {} from '@deepseek-ai/dsh-host-webserver'

const PREFIX = '/session-bot/api'

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/** 只接受同源请求：面板跑在 DSH 自己的页面上。 */
function sameOrigin(req: IncomingMessage, port: number): boolean {
  const origin = req.headers.origin
  if (typeof origin !== 'string') return true
  try {
    const url = new URL(origin)
    return (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && (url.port === String(port) || url.port === '')
  } catch {
    return false
  }
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > maxBytes) throw new Error('Request body too large')
    chunks.push(buffer)
  }
  if (!total) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** 注册管理路由，返回注销用的 disposer。 */
export function registerHttp(ctx: Context, bots: Bots): () => void {
  return ctx.webServer.register({
    kind: 'prefix',
    path: '/session-bot',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith(`${PREFIX}/`)) { res.writeHead(404); res.end(); return }
      if (!sameOrigin(req, ctx.webServer.port)) { json(res, 403, { error: 'Same-origin request required' }); return }
      const parts = url.pathname.slice(PREFIX.length + 1).split('/').filter(Boolean)
      const method = req.method ?? 'GET'
      try {
        // GET /bots —— 所有 BOT 的档案与状态
        if (method === 'GET' && parts.length === 1 && parts[0] === 'bots') {
          json(res, 200, { bots: bots.listAll() })
          return
        }
        // POST /bots —— 认领一个会话
        if (method === 'POST' && parts.length === 1 && parts[0] === 'bots') {
          const body = await readBody(req, 256 * 1024) as {
            sessionId?: string; name?: string; brief?: string; detail?: string; project?: string
          }
          if (!body?.sessionId || !body.name) { json(res, 400, { error: 'sessionId and name are required' }); return }
          const bot = bots.claim(body.sessionId, {
            name: body.name, brief: body.brief, detail: body.detail,
            ...body.project ? { project: body.project } : {},
          })
          json(res, 200, { bot: bots.viewOf(bot.id) })
          return
        }
        // GET /asks —— 等用户决定的事
        if (method === 'GET' && parts.length === 1 && parts[0] === 'asks') {
          json(res, 200, { asks: bots.listAsks() })
          return
        }
        // GET /tasks —— 最近的派活
        if (method === 'GET' && parts.length === 1 && parts[0] === 'tasks') {
          json(res, 200, { tasks: bots.listTasks() })
          return
        }
        // DELETE /bots/<id>/segments/<sessionId> —— 解除历史段与 BOT 的关联
        if (method === 'DELETE' && parts.length === 4 && parts[0] === 'bots' && parts[2] === 'segments') {
          const result = bots.removeSegment(parts[1]!, parts[3]!)
          if (!result.ok) { json(res, 400, { error: result.reason ?? 'failed' }); return }
          json(res, 200, { bot: bots.viewOf(parts[1]!) })
          return
        }
        // POST /bots/<id>/current —— 把一个历史段切回当前段
        if (method === 'POST' && parts.length === 3 && parts[0] === 'bots' && parts[2] === 'current') {
          const body = await readBody(req, 64 * 1024) as { sessionId?: string }
          if (!body?.sessionId) { json(res, 400, { error: 'sessionId is required' }); return }
          const result = await bots.setCurrent(parts[1]!, body.sessionId)
          if (!result.ok) { json(res, 400, { error: result.reason ?? 'failed' }); return }
          json(res, 200, { bot: bots.viewOf(parts[1]!) })
          return
        }
        // POST /fix-session —— 修一个会话的标题与归属（一次性修补用）
        if (method === 'POST' && parts.length === 1 && parts[0] === 'fix-session') {
          const body = await readBody(req, 64 * 1024) as { sessionId?: string; title?: string; workspacePath?: string }
          if (!body?.sessionId) { json(res, 400, { error: 'sessionId is required' }); return }
          json(res, 200, { result: await bots.fixSession(body.sessionId, { title: body.title, workspacePath: body.workspacePath }) })
          return
        }
        // GET /events —— 动态流
        if (method === 'GET' && parts.length === 1 && parts[0] === 'events') {
          const limit = Number(url.searchParams.get('limit') ?? '50')
          json(res, 200, { events: bots.listEvents(Number.isFinite(limit) ? limit : 50) })
          return
        }
        // POST /asks/<id>/answer —— 回答一条待办
        if (method === 'POST' && parts.length === 3 && parts[0] === 'asks' && parts[2] === 'answer') {
          const body = await readBody(req, 64 * 1024) as { answer?: string }
          if (!body?.answer?.trim()) { json(res, 400, { error: 'answer is required' }); return }
          const result = await bots.answer(parts[1]!, body.answer.trim())
          if (!result.ok) { json(res, 404, { error: 'Unknown ask' }); return }
          json(res, 200, result)
          return
        }
        // POST /bots/<id>/rotate —— 换段
        if (method === 'POST' && parts.length === 3 && parts[0] === 'bots' && parts[2] === 'rotate') {
          const body = await readBody(req, 64 * 1024) as { note?: string }
          const note = body?.note?.trim() || `用户在 ${new Date().toISOString()} 手动换段；上一段没有留下笔记。`
          const result = await bots.rotate(parts[1]!, note)
          json(res, 200, { result })
          return
        }
        // GET /bots/<id> —— 一个 BOT 的详情（含记忆，因为这是给人看的）
        if (method === 'GET' && parts.length === 2 && parts[0] === 'bots') {
          const view = bots.viewOf(parts[1]!)
          if (!view) { json(res, 404, { error: 'Unknown bot' }); return }
          json(res, 200, { bot: view })
          return
        }
        // PUT /bots/<id> —— 改档案（名称、简介、详情、可协作）
        if (method === 'PUT' && parts.length === 2 && parts[0] === 'bots') {
          const body = await readBody(req, 256 * 1024) as {
            name?: string; brief?: string; detail?: string; project?: string; peers?: string[]; kind?: 'worker' | 'manager'
          }
          const view = bots.update(parts[1]!, body ?? {})
          if (!view) { json(res, 404, { error: 'Unknown bot' }); return }
          json(res, 200, { bot: view })
          return
        }
        // PUT /bots/<id>/peers —— 设置可协作清单
        if (method === 'PUT' && parts.length === 3 && parts[0] === 'bots' && parts[2] === 'peers') {
          const body = await readBody(req, 64 * 1024) as { peers?: string[] }
          if (!Array.isArray(body?.peers)) { json(res, 400, { error: 'peers must be an array' }); return }
          const view = bots.setPeers(parts[1]!, body.peers)
          if (!view) { json(res, 404, { error: 'Unknown bot' }); return }
          json(res, 200, { bot: view })
          return
        }
        // DELETE /bots/<id> —— 归档一个 BOT
        if (method === 'DELETE' && parts.length === 2 && parts[0] === 'bots') {
          const archived = await bots.archive(parts[1]!)
          json(res, 200, { archived })
          return
        }
        json(res, 404, { error: 'Unknown operation' })
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
}
