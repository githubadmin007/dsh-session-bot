/**
 * 浏览器侧：BOT 面板、会话标题栏按钮、侧栏徽章、BOT 信息对话框。
 *
 * 认领和改档案只在这里做——BOT 自己只能改简介、工作约束和记忆，改不了协作名单。
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'

// DSH 的 client 服务声明。
import type {} from '@deepseek-ai/dsh-client-ui-slots/client'

export interface BotRow {
  id: string
  sessionId: string
  name: string
  brief: string
  live: boolean
  project?: string
  segments: number
  segmentIds: string[]
  memoryBytes: number
  peers: string[]
}

export interface BotDetail extends BotRow {
  detail: string
  memory: string
  workdir: string
  createdAt: string
}

export interface AskRow {
  id: string
  botId: string
  botName: string
  question: string
  options: string[]
  createdAt: string
}

export interface EventRow {
  id: string
  at: string
  kind: string
  botId?: string
  taskId?: string
  text: string
}

interface DialogState {
  sessionId: string
  title: string
}

/** 模块级的开关：面板和对话框是两棵独立的树，用它在中间传话。 */
let openDialog: ((state: DialogState) => void) | undefined
/** 面板打开后要重新拉数据时用。 */
let panelRefresh: (() => void) | undefined

const api = {
  async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`/session-bot/api/${path}`, init)
    if (!response.ok) {
      let detail = `HTTP ${response.status}`
      try { detail = (await response.json() as { error?: string }).error ?? detail } catch { /* 非 JSON 就用状态码 */ }
      throw new Error(detail)
    }
    return await response.json() as T
  },
  list: () => api.json<{ bots: BotRow[] }>('bots').then(value => value.bots),
  detail: (id: string) => api.json<{ bot: BotDetail }>(`bots/${id}`).then(value => value.bot),
  asks: () => api.json<{ asks: AskRow[] }>('asks').then(value => value.asks),
  events: () => api.json<{ events: EventRow[] }>('events').then(value => value.events),
  answer: (id: string, answer: string) =>
    api.json<{ ok: boolean }>(`asks/${id}/answer`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer }),
    }),
  removeSegment: (botId: string, sessionId: string) =>
    api.json<{ bot: BotDetail }>(`bots/${botId}/segments/${sessionId}`, { method: 'DELETE' })
      .then(value => value.bot),
  setCurrent: (botId: string, sessionId: string) =>
    api.json<{ bot: BotDetail }>(`bots/${botId}/current`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }),
    }).then(value => value.bot),
  claim: (input: { sessionId: string; name: string; brief: string; detail: string; project?: string }) =>
    api.json<{ bot: BotDetail }>('bots', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    }).then(value => value.bot),
  update: (id: string, patch: {
    name?: string; brief?: string; detail?: string; project?: string; peers?: string[]; memory?: string
  }) =>
    api.json<{ bot: BotDetail }>(`bots/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
    }).then(value => value.bot),
}

/**
 * 侧栏徽章和面板都要知道「哪些会话是 BOT」。会话可能有几十个，每个徽章各自请求会打爆接口，
 * 所以拉一次放这里，订阅同一份。
 */
const botSessions = {
  current: new Set<string>(),
  /** 历史段 sessionId → { botId, name }。 */
  history: new Map<string, { botId: string; name: string }>(),
  /** 当前段 sessionId → { botId, name }。 */
  owners: new Map<string, { botId: string; name: string }>(),
  listeners: new Set<() => void>(),
  snapshotKey: '',
  update(sessionIds: string[]) {
    const next = new Set(sessionIds)
    const key = [...next].sort().join(',')
    if (key === this.snapshotKey) return
    this.snapshotKey = key
    this.current = next
    for (const listener of this.listeners) listener()
  },
  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  },
  /** 用一份接口结果刷新索引：当前段与历史段一次过更新。 */
  sync(rows: BotRow[]): void {
    const live = rows.filter(bot => bot.live)
    this.owners = new Map(live.map(bot => [bot.sessionId, { botId: bot.id, name: bot.name }]))
    this.history = new Map(live.flatMap(bot =>
      (bot.segmentIds ?? []).map(id => [id, { botId: bot.id, name: bot.name }] as const)))
    this.update(live.map(bot => bot.sessionId))
  },
  /** 'owner' | 'history' | 'none'：决定徽章长什么样。 */
  stateOf(sessionId: string): string {
    if (this.owners.has(sessionId)) return 'owner'
    if (this.history.has(sessionId)) return 'history'
    return 'none'
  },
}

async function refreshBotSessions(): Promise<void> {
  try {
    botSessions.sync(await api.list())
  } catch { /* 接口不可用时安静地不显示图标 */ }
}

const surface = 'var(--dsh-color-surface-raised, var(--dsh-color-surface, #1e1e22))'
const border = '1px solid var(--dsh-color-border, rgba(255,255,255,.12))'
const muted = { opacity: .6 }

const fieldStyle = {
  width: '100%', boxSizing: 'border-box' as const, marginTop: 4, marginBottom: 12, padding: '6px 8px',
  borderRadius: 6, border: '1px solid rgba(255,255,255,.18)', background: 'rgba(255,255,255,.06)',
  color: 'inherit', font: 'inherit' as const,
}
const buttonStyle = {
  padding: '5px 12px', borderRadius: 6, border, background: 'rgba(255,255,255,.08)',
  color: 'inherit', cursor: 'pointer', font: 'inherit' as const,
}

/** 侧栏图标：一块工牌。 */
export function BadgeIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <circle cx="8.5" cy="11" r="2" />
      <path d="M5.5 16.2c.6-1.3 1.7-2 3-2s2.4.7 3 2" />
      <path d="M15 10h3.5M15 13h3.5" />
    </svg>
  )
}

interface SessionRowLike {
  id: string
  title?: string
  cwd?: string
  updatedAt?: string | number
  blank?: boolean
  retainedBy?: { mainView?: number }
}
interface SessionsLike {
  list: {
    subscribe(listener: () => void): () => void
    getSnapshot(): { byId: Record<string, SessionRowLike> }
  }
}

/**
 * 会话标题栏右上角的 BOT 按钮。
 *
 * `conversation.session.header.utilities` 的 props 是空对象，DSH 不注入 sessionId，
 * 所以自己去会话投影里找「主视图当前打开的那个」——DSH 自己的 mainSessionId() 用的
 * 判据就是 `retainedBy.mainView > 0`。
 */
export function HeaderBotButton({ sessions }: { sessions: SessionsLike }) {
  const sessionId = useSyncExternalStore(
    listener => sessions.list.subscribe(listener),
    () => {
      const list = sessions.list.getSnapshot()
      for (const row of Object.values(list.byId) as SessionRowLike[]) {
        if ((row.retainedBy?.mainView ?? 0) > 0) return row.id
      }
      return ''
    },
  )
  // 徽章索引变了也要跟着变（认领/取消之后按钮要换个样子）。
  const owned = useSyncExternalStore(
    listener => botSessions.subscribe(listener),
    () => (sessionId !== '' && botSessions.owners.has(sessionId)),
  )
  if (!sessionId) return null
  return (
    <button
      title={owned ? 'BOT 信息' : '设为 BOT'}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        height: 24, padding: '0 8px', borderRadius: 6, cursor: 'pointer', marginRight: 4,
        border: owned ? 'none' : '1px solid rgba(255,255,255,.18)',
        background: owned ? 'linear-gradient(135deg,#5B7BFF,#3D57E8)' : 'transparent',
        color: owned ? '#fff' : 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '.05em',
      }}
      onClick={() => { openDialog?.({ sessionId, title: sessionId }) }}
    >
      {owned ? 'BOT' : '+ BOT'}
    </button>
  )
}

/** 会话行首的 BOT 图标。只是标记，不可点击——入口在会话标题栏右上角。 */
export function BotBadge({ sessionId }: { sessionId: string }) {
  const state = useSyncExternalStore(
    listener => botSessions.subscribe(listener),
    () => botSessions.stateOf(sessionId),
  )
  if (state === 'none') return null
  const owned = state === 'owner'
  return (
    <span
      title={owned ? 'BOT' : '某个 BOT 的历史段'}
      style={{ display: 'inline-flex', alignItems: 'center', marginRight: 5, flex: '0 0 auto', opacity: owned ? 1 : .55 }}
    >
      <svg width={15} height={15} viewBox="0 0 1024 1024" aria-hidden style={{ display: 'block' }}>
        <path
          fill={owned ? '#4D6BFE' : '#8a8a92'}
          d="M896 468.266667V341.333333a85.333333 85.333333 0 0 0-85.333333-85.333333h-256V200.021333c13.013333-11.690667 21.333333-28.501333 21.333333-47.36a64 64 0 0 0-128 0c0 18.858667 8.32 35.669333 21.333333 47.36V256H213.333333a85.333333 85.333333 0 0 0-85.333333 85.333333v127.914667l-3.072 0.213333A42.624 42.624 0 0 0 85.333333 512v85.333333a42.666667 42.666667 0 0 0 42.666667 42.666667v213.333333a85.333333 85.333333 0 0 0 85.333333 85.333334h597.333334a85.333333 85.333333 0 0 0 85.333333-85.333334v-213.333333a42.666667 42.666667 0 0 0 42.666667-42.666667v-82.688a42.837333 42.837333 0 0 0-3.072-19.413333c-8.618667-20.821333-27.093333-25.813333-39.594667-26.965333zM298.666667 512c0-47.104 28.672-85.333333 64-85.333333s64 38.229333 64 85.333333-28.672 85.333333-64 85.333333S298.666667 559.104 298.666667 512z m383.914666 256c-42.709333-0.128-341.205333 0-341.248 0v-85.333333s298.709333-0.085333 341.418667 0l-0.170667 85.333333z m-21.248-170.666667c-35.328 0-64-38.229333-64-85.333333s28.672-85.333333 64-85.333333 64 38.229333 64 85.333333-28.672 85.333333-64 85.333333z"
        />
      </svg>
    </span>
  )
}

/** 按 BOT 的 project 分组，空 project 归到最后一个「（未分组）」。 */
function groupByProject(bots: BotRow[]): [string, BotRow[]][] {
  const groups = new Map<string, BotRow[]>()
  for (const bot of bots) {
    const key = (bot.project ?? '').trim()
    const list = groups.get(key) ?? []
    list.push(bot)
    groups.set(key, list)
  }
  return [...groups.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
}

/**
 * BOT 信息对话框。分四个 tab：档案 / 分段 / 协作。
 *
 * 分段列表里能「设为当前」或「移除」——换段是 BOT 用 `/bot_new_session` 做的，
 * 这里只负责把已有的段摆正。
 */
function Dialog() {
  const [state, setState] = useState<DialogState | undefined>(undefined)
  const [existing, setExisting] = useState<BotDetail | undefined>(undefined)
  const [others, setOthers] = useState<BotRow[]>([])
  const [name, setName] = useState('')
  const [brief, setBrief] = useState('')
  const [detail, setDetail] = useState('')
  const [project, setProject] = useState('')
  const [memory, setMemory] = useState('')
  const [peers, setPeers] = useState<string[]>([])
  const [tab, setTab] = useState<'profile' | 'segments' | 'peers'>('profile')
  const [showMemory, setShowMemory] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    openDialog = next => {
      setState(next); setError(''); setBusy(true)
      setTab('profile'); setShowMemory(false)
      void (async () => {
        try {
          const all = await api.list()
          const mine = all.find(bot => bot.sessionId === next.sessionId)
          setOthers(all.filter(bot => bot.sessionId !== next.sessionId))
          if (mine) {
            const full = await api.detail(mine.id)
            setExisting(full); setPeers(full.peers)
            setName(full.name); setBrief(full.brief); setDetail(full.detail)
            setProject(full.project ?? ''); setMemory(full.memory ?? '')
          } else {
            setExisting(undefined); setPeers([])
            setName(next.title); setBrief(''); setDetail('')
            setProject(''); setMemory('')
          }
        } catch (failure) {
          setError(String(failure))
        } finally {
          setBusy(false)
        }
      })()
    }
    return () => { openDialog = undefined }
  }, [])

  if (!state) return null
  const close = () => { setState(undefined); panelRefresh?.() }

  const submit = async () => {
    if (!name.trim()) { setError('名称不能为空'); setTab('profile'); return }
    setBusy(true); setError('')
    try {
      if (existing) {
        await api.update(existing.id, { name: name.trim(), brief, detail, project, peers, memory })
      } else {
        await api.claim({ sessionId: state.sessionId, name: name.trim(), brief, detail, project })
      }
      await refreshBotSessions()
      close()
    } catch (failure) {
      setError(String(failure))
    } finally {
      setBusy(false)
    }
  }

  const switchTo = async (segmentId: string) => {
    if (!existing) return
    setBusy(true); setError('')
    try {
      setExisting(await api.setCurrent(existing.id, segmentId))
      await refreshBotSessions()
      panelRefresh?.()
    } catch (failure) { setError(String(failure)) } finally { setBusy(false) }
  }

  const dropSegment = async (segmentId: string) => {
    if (!existing) return
    if (!window.confirm('把这个历史段从 BOT 上解除关联？\n\n只断开引用，会话本身和它的内容都留着。')) return
    setBusy(true); setError('')
    try {
      setExisting(await api.removeSegment(existing.id, segmentId))
      await refreshBotSessions()
      panelRefresh?.()
    } catch (failure) { setError(String(failure)) } finally { setBusy(false) }
  }

  const tabs: { id: typeof tab; label: string; hint?: string }[] = [
    { id: 'profile', label: '档案' },
    { id: 'segments', label: '分段', hint: existing ? String(existing.segments.length) : '—' },
    { id: 'peers', label: '协作', hint: String(peers.length) },
  ]

  const field = (label: string, node: React.ReactNode) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ ...muted, fontSize: 11, marginBottom: 3 }}>{label}</div>
      {node}
    </div>
  )

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}
      onClick={event => { if (event.target === event.currentTarget) close() }}>
      <div style={{ width: 'min(620px, 94vw)', maxHeight: '88vh', borderRadius: 12, overflow: 'hidden',
        display: 'flex', flexDirection: 'column', background: surface, border, color: 'inherit',
        font: '13px/1.6 system-ui, sans-serif', boxShadow: '0 12px 48px rgba(0,0,0,.45)' }}>

        <div style={{ padding: '16px 20px 10px', flex: '0 0 auto' }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>
            {existing ? `BOT · ${existing.name}` : '设为 BOT'}
          </div>
          <div style={{ ...muted, fontSize: 11, marginTop: 2, wordBreak: 'break-all' }}>{state.sessionId}</div>
        </div>

        <div style={{ display: 'flex', gap: 2, padding: '0 16px', borderBottom: border, flex: '0 0 auto' }}>
          {tabs.map(item => {
            const active = tab === item.id
            return (
              <button key={item.id} onClick={() => setTab(item.id)}
                style={{ padding: '7px 12px', border: 'none', background: 'transparent', color: 'inherit',
                  cursor: 'pointer', font: 'inherit', fontSize: 12.5, fontWeight: active ? 600 : 400,
                  opacity: active ? 1 : .55,
                  borderBottom: active ? '2px solid #5B7BFF' : '2px solid transparent', marginBottom: -1 }}>
                {item.label}
                {item.hint ? <span style={{ ...muted, fontSize: 10, marginLeft: 5 }}>{item.hint}</span> : null}
              </button>
            )
          })}
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
          {tab === 'profile' ? (
            <>
              {field('名称', <input style={{ ...fieldStyle, margin: 0 }} value={name}
                onChange={event => setName(event.target.value)} />)}
              {field('简介（一句话说明用途）', <input style={{ ...fieldStyle, margin: 0 }} value={brief}
                onChange={event => setBrief(event.target.value)} />)}
              {field('项目（面板按它分组）', <input style={{ ...fieldStyle, margin: 0 }} value={project}
                placeholder="例如 LCP" onChange={event => setProject(event.target.value)} />)}
              {field('工作约束（职责、仓库、约定；每轮放在提示词最前面）', <textarea
                style={{ ...fieldStyle, margin: 0, minHeight: 90 }} value={detail}
                onChange={event => setDetail(event.target.value)} />)}
              {existing ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ ...muted, fontSize: 11 }}>
                      记忆 {new TextEncoder().encode(memory).length} 字节
                    </span>
                    <button style={{ ...buttonStyle, padding: '2px 8px', fontSize: 11, marginLeft: 'auto' }}
                      onClick={() => setShowMemory(value => !value)}>
                      {showMemory ? '收起记忆' : '编辑记忆'}
                    </button>
                  </div>
                  {showMemory ? (
                    <textarea style={{ ...fieldStyle, marginTop: 6, minHeight: 120, fontSize: 12,
                      fontFamily: 'ui-monospace, monospace' }} value={memory}
                      placeholder="（还没有记忆）" onChange={event => setMemory(event.target.value)} />
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}

          {tab === 'segments' ? (
            existing ? (
              <>
                <div style={{ ...muted, fontSize: 11, marginBottom: 4 }}>当前段</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                  borderRadius: 8, border, background: 'rgba(91,123,255,.10)', marginBottom: 14 }}>
                  <span style={{ fontSize: 12, fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' }}>
                    {existing.sessionId}
                  </span>
                </div>
                <div style={{ ...muted, fontSize: 11, marginBottom: 4 }}>历史段（{existing.segments.length}）</div>
                {existing.segments.length === 0
                  ? <div style={{ ...muted, fontSize: 12 }}>还没有历史段。用 /bot_new_session 换段。</div>
                  : existing.segments.map((segmentId, index) => (
                    <div key={segmentId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' }}>
                      <span style={{ ...muted, fontSize: 11, flex: '0 0 auto' }}>第 {index + 1} 段</span>
                      <span style={{ fontSize: 11.5, fontFamily: 'ui-monospace, monospace', overflow: 'hidden',
                        textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{segmentId}</span>
                      <button style={{ ...buttonStyle, padding: '1px 8px', fontSize: 11, flex: '0 0 auto' }}
                        disabled={busy} onClick={() => void switchTo(segmentId)}>设为当前</button>
                      <button style={{ ...buttonStyle, padding: '1px 8px', fontSize: 11, flex: '0 0 auto', opacity: .65 }}
                        disabled={busy} onClick={() => void dropSegment(segmentId)}>移除</button>
                    </div>
                  ))}
              </>
            ) : <div style={muted}>先保存，才会有分段。</div>
          ) : null}

          {tab === 'peers' ? (
            <>
              <div style={{ ...muted, fontSize: 11, marginBottom: 6 }}>这个 BOT 可以派活给谁（单向）</div>
              {others.length === 0
                ? <div style={{ ...muted, fontSize: 12 }}>还没有别的 BOT。</div>
                : others.map(bot => (
                  <label key={bot.id} style={{ display: 'flex', gap: 7, alignItems: 'baseline', padding: '2px 0' }}>
                    <input type="checkbox" checked={peers.includes(bot.id)} onChange={event => setPeers(current =>
                      event.target.checked ? [...current, bot.id] : current.filter(id => id !== bot.id))} />
                    <span style={{ fontSize: 12 }}>{bot.name}</span>
                    <span style={{ ...muted, fontSize: 11 }}>{bot.brief || '（无简介）'}</span>
                  </label>
                ))}
            </>
          ) : null}
        </div>

        <div style={{ flex: '0 0 auto', borderTop: border, padding: '10px 20px', display: 'flex',
          alignItems: 'center', gap: 8 }}>
          {error ? <span style={{ color: '#ff7b72', fontSize: 12, flex: 1 }}>{error}</span> : <span style={{ flex: 1 }} />}
          <button style={buttonStyle} onClick={close} disabled={busy}>关闭</button>
          <button style={{ ...buttonStyle, fontWeight: 600 }} onClick={() => void submit()} disabled={busy}>
            {existing ? '保存' : '设为 BOT'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** BOT 面板：待办可以就地回答，BOT 按项目分组，动态按时间倒序。 */
function Panel() {
  const [bots, setBots] = useState<BotRow[]>([])
  const [asks, setAsks] = useState<AskRow[]>([])
  const [events, setEvents] = useState<EventRow[]>([])
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'asks' | 'bots' | 'events'>('bots')

  const load = useCallback(() => {
    setError('')
    void Promise.all([api.list(), api.asks(), api.events()])
      .then(([nextBots, nextAsks, nextEvents]) => {
        setBots(nextBots); setAsks(nextAsks); setEvents(nextEvents)
        botSessions.sync(nextBots)
        // 有待办就自动切过去：那是唯一等人动手的东西。
        if (nextAsks.length > 0) setTab(current => (current === 'asks' ? current : 'asks'))
      })
      .catch(failure => setError(String(failure)))
  }, [])

  useEffect(() => {
    panelRefresh = load
    load()
    return () => { panelRefresh = undefined }
  }, [load])

  const live = bots.filter(bot => bot.live).length
  const tabs: { id: 'asks' | 'bots' | 'events'; label: string; count: number; alert?: boolean }[] = [
    { id: 'asks', label: '待办', count: asks.length, alert: asks.length > 0 },
    { id: 'bots', label: 'BOT', count: live },
    { id: 'events', label: '动态', count: events.length },
  ]
  const empty = (text: string) => <div style={{ ...muted, fontSize: 12, padding: '2px 0' }}>{text}</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', font: '13px/1.6 system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px 8px', flex: '0 0 auto' }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>BOT</span>
        <button style={{ ...buttonStyle, marginLeft: 'auto', padding: '3px 10px' }} onClick={load}>刷新</button>
      </div>

      <div style={{ display: 'flex', gap: 2, padding: '0 16px', borderBottom: border, flex: '0 0 auto' }}>
        {tabs.map(item => {
          const active = tab === item.id
          return (
            <button key={item.id} onClick={() => setTab(item.id)}
              style={{ padding: '7px 12px', border: 'none', background: 'transparent', color: 'inherit',
                cursor: 'pointer', font: 'inherit', fontSize: 12.5, fontWeight: active ? 600 : 400,
                opacity: active ? 1 : .55,
                borderBottom: active ? '2px solid #5B7BFF' : '2px solid transparent', marginBottom: -1 }}>
              {item.label}
              {item.count > 0 ? (
                <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 5px', borderRadius: 8,
                  background: item.alert ? '#5B7BFF' : 'rgba(255,255,255,.14)',
                  color: item.alert ? '#fff' : 'inherit', fontWeight: 600 }}>{item.count}</span>
              ) : null}
            </button>
          )
        })}
      </div>

      {error ? <div style={{ margin: '8px 16px 0', color: '#ff7b72', fontSize: 12 }}>{error}</div> : null}

      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {tab === 'asks' ? (
          asks.length === 0
            ? empty('没有等你决定的事。BOT 用 bot_ask 提问时会出现在这里。')
            : asks.map(ask => {
              const answer = async (value: string) => {
                if (!value.trim()) return
                try { await api.answer(ask.id, value.trim()); load() } catch (failure) { setError(String(failure)) }
              }
              return (
                <div key={ask.id} style={{ padding: '10px 12px', borderRadius: 8, border, marginBottom: 8,
                  background: 'rgba(255,255,255,.04)', borderLeft: '3px solid #5B7BFF' }}>
                  <div style={{ ...muted, fontSize: 11, marginBottom: 4 }}>{ask.botName}</div>
                  <div style={{ marginBottom: 8 }}>{ask.question}</div>
                  {ask.options.length ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                      {ask.options.map(option => (
                        <button key={option} style={{ ...buttonStyle, padding: '3px 10px' }}
                          onClick={() => void answer(option)}>{option}</button>
                      ))}
                    </div>
                  ) : null}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input style={{ ...fieldStyle, margin: 0, flex: 1, fontSize: 12 }} placeholder="或者自己写一个回答"
                      value={draft[ask.id] ?? ''}
                      onChange={event => setDraft(current => ({ ...current, [ask.id]: event.target.value }))}
                      onKeyDown={event => { if (event.key === 'Enter') void answer(draft[ask.id] ?? '') }} />
                    <button style={buttonStyle} onClick={() => void answer(draft[ask.id] ?? '')}>回复</button>
                  </div>
                </div>
              )
            })
        ) : null}

        {tab === 'bots' ? (
          bots.length === 0
            ? empty('还没有 BOT。点会话标题栏右上角的「+ BOT」。')
            : groupByProject(bots).map(([project, members]) => (
              <div key={project} style={{ marginBottom: 14 }}>
                <div style={{ ...muted, fontSize: 11, margin: '0 0 6px', letterSpacing: '.04em' }}>
                  {project || '（未分组）'}
                </div>
                {members.map(bot => (
                  <div key={bot.id} style={{ padding: '8px 10px', borderRadius: 8, border, marginBottom: 4,
                    background: 'rgba(255,255,255,.03)', cursor: 'pointer', opacity: bot.live ? 1 : .55 }}
                    onClick={() => openDialog?.({ sessionId: bot.sessionId, title: bot.name })}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                      <span style={{ fontWeight: 600 }}>{bot.name}</span>
                      {!bot.live ? <span style={{ ...muted, fontSize: 11 }}>已归档</span> : null}
                      <span style={{ ...muted, fontSize: 11, marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                        记忆 {bot.memoryBytes}B{bot.peers.length ? ` · 协作 ${bot.peers.length}` : ''}
                      </span>
                    </div>
                    <div style={{ ...muted, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {bot.brief || '（无简介）'}
                    </div>
                  </div>
                ))}
              </div>
            ))
        ) : null}

        {tab === 'events' ? (
          events.length === 0
            ? empty('还没有记录。派活、上报、提问、换段都会记在这里。')
            : events.map(event => (
              <div key={event.id} style={{ display: 'flex', gap: 8, padding: '4px 2px', alignItems: 'baseline' }}>
                <span style={{ ...muted, fontSize: 11, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }}>
                  {new Date(event.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span style={{ fontSize: 12, wordBreak: 'break-word' }}>{event.text}</span>
              </div>
            ))
        ) : null}
      </div>
    </div>
  )
}

const PANEL_ID = 'dsh-session-bot'

export const inject = ['slots', 'sessions']

export function apply(ctx: Context): void {
  const sessions = ctx.get('sessions') as SessionsLike | undefined

  // 会话标题栏右上角：BOT 按钮。
  if (sessions) {
    ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
      { name: 'conversation.session.header.utilities', id: 'session-bot-header', order: 50 },
      () => <HeaderBotButton sessions={sessions} />,
    ))
  }

  // 会话行首的小徽章：认出哪些会话已经是 BOT。
  ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register(
    { name: 'sidebar.session.row.leading', id: 'session-bot-badge', order: 50 },
    (props: { sessionId: string }) => <BotBadge sessionId={props.sessionId} />,
  ))
  // 只在页面加载和认领之后各拉一次，不做轮询。
  void refreshBotSessions()

  // 侧栏图标 → 主面板。
  ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: PANEL_ID, inject: () => ({}) },
    () => <Panel />,
  ))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: PANEL_ID, order: 11, label: () => 'BOT' },
    BadgeIcon,
  ))

  // 对话框挂在浮层，避免被滚动容器裁掉。
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'session-bot-dialog', order: 100 },
    () => <Dialog />,
  ))
}
