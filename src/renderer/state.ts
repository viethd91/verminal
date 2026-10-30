import { create } from 'zustand'
import type { Api } from '../preload'

declare global {
  interface Window {
    api: Api
  }
}
export const api = window.api

export type Status = 'shell' | 'idle' | 'running' | 'waiting' | 'done'

export interface Pane {
  id: string
  cwd: string
  status: Status
  sessionId?: string
  transcriptPath?: string
  tool?: string
  initCmd?: string
  /** Bumped on every Claude hook event so sidebar panels can refresh. */
  tick: number
  view: 'terminal' | 'chat'
  /** Percent of the context window in use, reported by Claude's statusline. */
  context?: number
}

export interface Limit {
  pct: number
  resetsAt?: number
}

export type PanelId = 'files' | 'sidebar'

/** Docked panels take space beside the tabs; unpinned panels collapse to a strip and slide over the tabs on hover. */
export interface PanelLayout {
  pinned: boolean
  collapsed: boolean
  width: number
}

export type Theme = 'dark' | 'light' | 'system'

export type Node =
  | { type: 'pane'; id: string }
  | { type: 'split'; id: string; dir: 'h' | 'v'; ratio: number; a: Node; b: Node }

export interface Tab {
  id: string
  root: Node
  activePane: string
}

interface State {
  tabs: Tab[]
  activeTab: string
  panes: Record<string, Pane>
  recent: string[]
  sidebar: boolean
  files: boolean
  composer: boolean
  /** File open in the viewer; with a transcript it is compared against its content before the session. */
  viewer: { path: string; transcriptPath?: string } | null
  /** The file in the viewer has unsaved edits; the viewer stays on it until they are saved or discarded. */
  viewerDirty: boolean
  search: boolean
  /** Plan usage limits (account-wide), from the most recent statusline report of any pane. */
  limits: { fiveHour?: Limit; week?: Limit }
  panels: Record<PanelId, PanelLayout>
  theme: Theme
  /** Syntax highlighting language of the file in the viewer; 'auto' detects it from the file extension. */
  language: string
  zoom: number
  newTab(cwd?: string, initCmd?: string): void
  /** Focuses a pane already in the folder, preferring one running Claude; otherwise opens a Claude tab there. */
  openProject(dir: string): void
  /**
   * Resumes a session, or starts a new one without an id, in a pane of the folder, preferring the active one:
   * a ready Claude switches with /resume or /clear, a shell starts Claude. A new tab is opened only when every
   * pane there is busy.
   */
  openSession(dir: string, sessionId?: string): void
  split(dir: 'h' | 'v'): void
  closePane(id: string): void
  focusPane(id: string): void
  setActiveTab(id: string): void
  setRatio(splitId: string, ratio: number): void
  setCwd(id: string, cwd: string): void
  claudeEvent(id: string, ev: Record<string, any>): void
  /** Claude fires no hook when a turn is interrupted, so the pane is marked ready when Esc interrupts it. */
  interrupted(id: string): void
  toggle(key: 'sidebar' | 'files' | 'composer' | 'search', value?: boolean): void
  openViewer(viewer: State['viewer']): void
  toggleView(id: string): void
  setPanel(id: PanelId, patch: Partial<PanelLayout>): void
}

const uid = (): string => Math.random().toString(36).slice(2, 10)
const home = (): string => api.sys.home

export function panesOf(node: Node): string[] {
  return node.type === 'pane' ? [node.id] : [...panesOf(node.a), ...panesOf(node.b)]
}

function replaceNode(node: Node, id: string, fn: (n: Node) => Node | null): Node | null {
  if (node.type === 'pane') return node.id === id ? fn(node) : node
  if (node.id === id) return fn(node)
  const a = replaceNode(node.a, id, fn)
  const b = replaceNode(node.b, id, fn)
  if (!a) return b
  if (!b) return a
  return { ...node, a, b }
}

export function activeTab(s: State): Tab | undefined {
  return s.tabs.find((t) => t.id === s.activeTab)
}

export function activePane(s: State): Pane | undefined {
  const tab = activeTab(s)
  return tab && s.panes[tab.activePane]
}

const pathKey = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase()

function panesIn(s: State, dir: string): Pane[] {
  return s.tabs
    .flatMap((t) => panesOf(t.root))
    .map((id) => s.panes[id])
    .filter((p) => pathKey(p.cwd) === pathKey(dir))
}

function newPane(cwd: string, initCmd?: string): Pane {
  return { id: uid(), cwd, status: 'shell', initCmd, tick: 0, view: 'terminal' }
}

export const useStore = create<State>((set, get) => ({
  tabs: [],
  activeTab: '',
  panes: {},
  recent: [],
  sidebar: true,
  files: true,
  composer: false,
  viewer: null,
  viewerDirty: false,
  search: false,
  limits: {},
  panels: {
    files: { pinned: true, collapsed: false, width: 260 },
    sidebar: { pinned: true, collapsed: false, width: 290 }
  },
  theme: 'dark',
  language: 'auto',
  zoom: 1,

  newTab(cwd, initCmd) {
    const pane = newPane(cwd ?? activePane(get())?.cwd ?? home(), initCmd)
    const tab: Tab = { id: uid(), root: { type: 'pane', id: pane.id }, activePane: pane.id }
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTab: tab.id,
      panes: { ...s.panes, [pane.id]: pane },
      recent: cwd && initCmd ? [cwd, ...s.recent.filter((r) => r !== cwd)].slice(0, 15) : s.recent
    }))
  },

  openProject(dir) {
    const s = get()
    const inDir = panesIn(s, dir)
    const pane = inDir.find((p) => p.status !== 'shell') ?? inDir[0]
    if (pane) s.focusPane(pane.id)
    else s.newTab(dir, 'claude')
  },

  openSession(dir, sessionId) {
    const s = get()
    const inDir = panesIn(s, dir)
    const open = sessionId && inDir.find((p) => p.sessionId === sessionId)
    const free = [activePane(s), ...inDir].find(
      (p) => p && inDir.includes(p) && p.status !== 'running' && p.status !== 'waiting'
    )
    const pane = open || free
    const claude = sessionId ? `claude --resume ${sessionId}` : 'claude'
    if (!pane) return s.newTab(dir, claude)
    s.focusPane(pane.id)
    if (pane === open) return
    if (pane.status === 'shell') api.pty.write(pane.id, `${claude}\r`)
    else {
      api.pty.write(pane.id, sessionId ? `/resume ${sessionId}` : '/clear')
      // let the slash command menu settle before submitting
      setTimeout(() => api.pty.write(pane.id, '\r'), 150)
    }
  },

  split(dir) {
    const s = get()
    const tab = activeTab(s)
    if (!tab) return
    const pane = newPane(s.panes[tab.activePane]?.cwd ?? home())
    const root = replaceNode(tab.root, tab.activePane, (n) => ({
      type: 'split',
      id: uid(),
      dir,
      ratio: 50,
      a: n,
      b: { type: 'pane', id: pane.id }
    }))!
    set({
      tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, root, activePane: pane.id } : t)),
      panes: { ...s.panes, [pane.id]: pane }
    })
  },

  closePane(id) {
    const s = get()
    const tab = s.tabs.find((t) => panesOf(t.root).includes(id))
    if (!tab) return
    api.pty.kill(id)
    const panes = { ...s.panes }
    delete panes[id]
    const root = replaceNode(tab.root, id, () => null)
    if (!root) {
      const tabs = s.tabs.filter((t) => t.id !== tab.id)
      const idx = s.tabs.indexOf(tab)
      set({
        tabs,
        panes,
        activeTab: s.activeTab === tab.id ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? '') : s.activeTab
      })
      return
    }
    const activePane = tab.activePane === id ? panesOf(root)[0] : tab.activePane
    set({ tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, root, activePane } : t)), panes })
  },

  focusPane(id) {
    const s = get()
    const tab = s.tabs.find((t) => panesOf(t.root).includes(id))
    if (!tab) return
    const pane = s.panes[id]
    set({
      activeTab: tab.id,
      tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, activePane: id } : t)),
      panes: pane.status === 'done' ? { ...s.panes, [id]: { ...pane, status: 'idle' } } : s.panes
    })
  },

  setActiveTab(id) {
    const tab = get().tabs.find((t) => t.id === id)
    if (tab) get().focusPane(tab.activePane)
  },

  setRatio(splitId, ratio) {
    set((s) => ({
      tabs: s.tabs.map((t) => ({
        ...t,
        root: replaceNode(t.root, splitId, (n) => ({ ...n, ratio }) as Node)!
      }))
    }))
  },

  setCwd(id, cwd) {
    set((s) => (s.panes[id] && s.panes[id].cwd !== cwd ? { panes: { ...s.panes, [id]: { ...s.panes[id], cwd } } } : s))
  },

  interrupted(id) {
    set((s) => ({ panes: { ...s.panes, [id]: { ...s.panes[id], status: 'idle', tool: undefined } } }))
  },

  claudeEvent(id, ev) {
    const s = get()
    const pane = s.panes[id]
    if (!pane) return
    if (ev.hook_event_name === 'StatusLine') {
      const limit = (l?: { used_percentage?: number; resets_at?: number }): Limit | undefined =>
        l?.used_percentage == null ? undefined : { pct: l.used_percentage, resetsAt: l.resets_at }
      set({
        panes: { ...s.panes, [id]: { ...pane, context: ev.context_window?.used_percentage ?? pane.context } },
        limits: ev.rate_limits
          ? { fiveHour: limit(ev.rate_limits.five_hour), week: limit(ev.rate_limits.seven_day) }
          : s.limits
      })
      return
    }
    const next: Pane = { ...pane, tick: pane.tick + 1 }
    switch (ev.hook_event_name) {
      case 'SessionStart':
        Object.assign(next, { status: 'idle', sessionId: ev.session_id, transcriptPath: ev.transcript_path })
        if (ev.cwd) next.cwd = ev.cwd
        // a session starting in the pane opens in chat view; later starts (/clear, compaction) keep the current view
        if (pane.status === 'shell') next.view = 'chat'
        break
      case 'SessionEnd':
        Object.assign(next, {
          status: 'shell',
          sessionId: undefined,
          transcriptPath: undefined,
          tool: undefined,
          context: undefined,
          view: 'terminal'
        })
        break
      case 'UserPromptSubmit':
        Object.assign(next, { status: 'running', tool: undefined })
        break
      case 'PreToolUse':
        Object.assign(next, { status: 'running', tool: ev.tool_name })
        break
      case 'PostToolUse':
        next.status = 'running'
        break
      case 'Notification':
        if (ev.notification_type !== 'idle_prompt') next.status = 'waiting'
        break
      case 'Stop':
        Object.assign(next, { status: 'done', tool: undefined })
        break
    }
    const isActive = activePane(s)?.id === id && document.hasFocus()
    if (next.status === 'done' && isActive) next.status = 'idle'
    if (next.status !== pane.status && !isActive && (next.status === 'waiting' || next.status === 'done')) {
      const name = next.cwd.split(/[\\/]/).pop()
      api.notify(
        id,
        next.status === 'waiting' ? `Claude needs you — ${name}` : `Claude finished — ${name}`,
        String(ev.message ?? (next.status === 'done' ? 'Task complete' : 'Waiting for input'))
      )
    }
    const recent =
      ev.hook_event_name === 'SessionStart' && next.cwd
        ? [next.cwd, ...s.recent.filter((r) => r !== next.cwd)].slice(0, 15)
        : s.recent
    set({ panes: { ...s.panes, [id]: next }, recent })
    // Claude writes the turn's final message to the transcript just after the Stop hook; refresh again once it has
    if (ev.hook_event_name === 'Stop') {
      setTimeout(() => {
        const p = get().panes[id]
        if (p) set((st) => ({ panes: { ...st.panes, [id]: { ...p, tick: p.tick + 1 } } }))
      }, 1000)
    }
  },

  toggleView(id) {
    set((s) => ({
      panes: { ...s.panes, [id]: { ...s.panes[id], view: s.panes[id].view === 'chat' ? 'terminal' : 'chat' } }
    }))
  },

  openViewer(viewer) {
    if (get().viewerDirty) return
    set({ viewer, language: 'auto' })
  },

  setPanel(id, patch) {
    set((s) => ({ panels: { ...s.panels, [id]: { ...s.panels[id], ...patch } } }))
  },

  toggle(key, value) {
    set((s) => ({ [key]: value ?? !s[key] }) as Partial<State>)
  }
}))

/** Preferences kept across launches; tabs are not restored, the app starts on the home page or the opened folder. */
interface Persisted {
  recent: string[]
  sidebar: boolean
  files?: boolean
  limits?: State['limits']
  panels?: State['panels']
  theme?: Theme
  zoom?: number
}

export async function restoreState(): Promise<void> {
  const saved = (await api.loadState()) as Persisted | null
  useStore.setState((s) => ({
    recent: saved?.recent ?? [],
    sidebar: saved?.sidebar ?? true,
    files: saved?.files ?? true,
    limits: saved?.limits ?? {},
    panels: { ...s.panels, ...saved?.panels },
    theme: saved?.theme ?? s.theme,
    zoom: saved?.zoom ?? s.zoom
  }))

  let timer: ReturnType<typeof setTimeout>
  useStore.subscribe((s) => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      const data: Persisted = {
        recent: s.recent,
        sidebar: s.sidebar,
        files: s.files,
        limits: s.limits,
        panels: s.panels,
        theme: s.theme,
        zoom: s.zoom
      }
      api.saveState(data)
    }, 500)
  })
}

const STATUS_RANK: Record<Status, number> = { waiting: 4, done: 3, running: 2, idle: 1, shell: 0 }

export function tabStatus(tab: Tab, panes: Record<string, Pane>): Status {
  return panesOf(tab.root)
    .map((id) => panes[id]?.status ?? 'shell')
    .reduce((a, b) => (STATUS_RANK[b] > STATUS_RANK[a] ? b : a), 'shell' as Status)
}

export type Action =
  | 'newTab'
  | 'newClaudeTab'
  | 'splitRight'
  | 'splitDown'
  | 'closePane'
  | 'search'
  | 'jumpWaiting'
  | 'composer'
  | 'sidebar'
  | 'devtools'
  | 'nextTab'
  | 'prevTab'
  | 'focusLeft'
  | 'focusRight'
  | 'focusUp'
  | 'focusDown'
  | 'toggleView'
  | 'files'
  | 'openFolder'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'

const CTRL_SHIFT: Record<string, Action> = {
  T: 'newTab',
  K: 'newClaudeTab',
  D: 'splitRight',
  E: 'splitDown',
  W: 'closePane',
  F: 'search',
  J: 'jumpWaiting',
  P: 'composer',
  B: 'sidebar',
  U: 'toggleView',
  O: 'files',
  I: 'devtools'
}
const CTRL_ALT: Record<string, Action> = {
  ArrowLeft: 'focusLeft',
  ArrowRight: 'focusRight',
  ArrowUp: 'focusUp',
  ArrowDown: 'focusDown'
}

const CTRL: Record<string, Action> = { '=': 'zoomIn', '+': 'zoomIn', '-': 'zoomOut', '0': 'zoomReset' }

export function matchShortcut(e: KeyboardEvent): Action | null {
  if (e.ctrlKey && e.key === 'Tab') return e.shiftKey ? 'prevTab' : 'nextTab'
  if (e.ctrlKey && !e.shiftKey && !e.altKey) return CTRL[e.key] ?? null
  if (e.ctrlKey && e.shiftKey && !e.altKey) return CTRL_SHIFT[e.key.toUpperCase()] ?? null
  if (e.ctrlKey && e.altKey && !e.shiftKey) return CTRL_ALT[e.key] ?? null
  return null
}
