import { useEffect, useRef, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import {
  Action,
  activePane,
  activeTab,
  api,
  matchShortcut,
  Node,
  PanelId,
  panesOf,
  restoreState,
  tabStatus,
  useStore
} from './state'
import { focusTerm, setTerminalTheme, TerminalPane } from './TerminalPane'
import { Composer } from './Composer'
import { Sidebar } from './Sidebar'
import { FilesPanel } from './FilesPanel'
import { Viewer } from './Viewer'
import { MenuBar } from './MenuBar'
import { Home } from './Home'

function SplitView({ node }: { node: Node }): React.JSX.Element {
  const setRatio = useStore((s) => s.setRatio)
  if (node.type === 'pane') return <TerminalPane id={node.id} />
  return (
    <Group
      id={node.id}
      orientation={node.dir === 'h' ? 'horizontal' : 'vertical'}
      onLayoutChanged={(layout, meta) => meta.isUserInteraction && setRatio(node.id, layout[`${node.id}-a`])}
    >
      <Panel id={`${node.id}-a`} defaultSize={`${node.ratio}%`} minSize="10%">
        <SplitView node={node.a} />
      </Panel>
      <Separator className={`separator ${node.dir}`} />
      <Panel id={`${node.id}-b`} defaultSize={`${100 - node.ratio}%`} minSize="10%">
        <SplitView node={node.b} />
      </Panel>
    </Group>
  )
}

function TabBar(): React.JSX.Element {
  const tabs = useStore((s) => s.tabs)
  const panes = useStore((s) => s.panes)
  const current = useStore((s) => s.activeTab)
  const { setActiveTab, closePane } = useStore.getState()
  const closeTab = (id: string): void => {
    const tab = tabs.find((t) => t.id === id)
    if (tab) panesOf(tab.root).forEach(closePane)
  }
  return (
    <div className="tabbar">
      {tabs.map((tab) => {
        const cwd = panes[tab.activePane]?.cwd ?? ''
        return (
          <div
            key={tab.id}
            className={`tab ${tab.id === current ? 'active' : ''}`}
            onMouseDown={(e) => (e.button === 1 ? closeTab(tab.id) : setActiveTab(tab.id))}
            title={cwd}
          >
            <span className={`dot ${tabStatus(tab, panes)}`} />
            <span className="tab-title">{cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'shell'}</span>
            {panesOf(tab.root).length > 1 && <span className="tab-count">{panesOf(tab.root).length}</span>}
            <span
              className="tab-close"
              onMouseDown={(e) => {
                e.stopPropagation()
                closeTab(tab.id)
              }}
            >
              ×
            </span>
          </div>
        )
      })}
      <button className="tab-new" title="New Claude tab in this folder (Ctrl+Shift+K)" onClick={() => runAction('newClaudeTab')}>
        +
      </button>
    </div>
  )
}

const PANEL_TITLES: Record<PanelId, string> = { files: 'Files', sidebar: 'Project' }

const Icon = ({ d, className }: { d: string; className?: string }): React.JSX.Element => (
  <svg className={className} viewBox="0 0 16 16" width="14" height="14">
    <path d={d} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const PIN = 'M9.5 2 14 6.5l-1.5.5-2.5 2.5.5 3-1 1-6-6 1-1 3 .5L10 4.5zM5.5 10.5 2 14'
const CHEVRON = { left: 'M10 3 5 8l5 5', right: 'M6 3l5 5-5 5' }
const CLOSE = 'M4 4l8 8M12 4l-8 8'

/** Side panel frame: docked with a resizable width, collapsed to a strip, or unpinned to slide over the tabs on hover. */
function SidePanel({ id, side, children }: { id: PanelId; side: 'left' | 'right'; children: React.ReactNode }) {
  const layout = useStore((s) => s.panels[id])
  const { setPanel, toggle } = useStore.getState()
  const [peek, setPeek] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const title = PANEL_TITLES[id]

  const resize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = layout.width
    const move = (ev: MouseEvent): void => {
      const delta = side === 'left' ? ev.clientX - startX : startX - ev.clientX
      setPanel(id, { width: Math.max(180, Math.min(640, startWidth + delta)) })
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const panel = (
    <aside
      className={`side-panel ${side} ${layout.pinned ? '' : 'floating'}`}
      style={{ width: layout.width }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="panel-head">
        <span className="panel-title">{title}</span>
        {layout.pinned && (
          <button className="panel-btn" title="Collapse" onClick={() => setPanel(id, { collapsed: true })}>
            <Icon d={CHEVRON[side]} />
          </button>
        )}
        <button
          className="panel-btn"
          title={layout.pinned ? 'Unpin (auto-hide)' : 'Pin'}
          onClick={() => {
            setPanel(id, { pinned: !layout.pinned, collapsed: false })
            setPeek(false)
          }}
        >
          <Icon d={PIN} className={layout.pinned ? '' : 'unpinned'} />
        </button>
        <button className="panel-btn" title="Hide" onClick={() => toggle(id, false)}>
          <Icon d={CLOSE} />
        </button>
      </div>
      <div className="panel-body">{children}</div>
      <div className="panel-resizer" onMouseDown={resize} />
    </aside>
  )

  if (layout.pinned && !layout.collapsed) return panel
  return (
    <div
      className={`panel-strip ${side}`}
      onClick={() => (layout.pinned ? setPanel(id, { collapsed: false }) : setPeek(!peek))}
      onMouseEnter={() => {
        if (layout.pinned) return
        clearTimeout(timer.current)
        setPeek(true)
      }}
      onMouseLeave={() => {
        if (!layout.pinned) timer.current = setTimeout(() => setPeek(false), 300)
      }}
    >
      <span className="panel-strip-title" title={layout.pinned ? `Expand ${title}` : undefined}>
        {title}
      </span>
      {peek && !layout.pinned && panel}
    </div>
  )
}

function focusInDirection(dir: 'Left' | 'Right' | 'Up' | 'Down'): void {
  const s = useStore.getState()
  const tab = activeTab(s)
  if (!tab) return
  const rect = (id: string): DOMRect | undefined =>
    document.querySelector(`[data-pane="${id}"]`)?.getBoundingClientRect()
  const from = rect(tab.activePane)
  if (!from) return
  const cx = from.x + from.width / 2
  const cy = from.y + from.height / 2
  let best: { id: string; dist: number } | undefined
  for (const id of panesOf(tab.root)) {
    const r = rect(id)
    if (!r || id === tab.activePane) continue
    const dx = r.x + r.width / 2 - cx
    const dy = r.y + r.height / 2 - cy
    const ok =
      (dir === 'Left' && r.right <= from.left + 1) ||
      (dir === 'Right' && r.left >= from.right - 1) ||
      (dir === 'Up' && r.bottom <= from.top + 1) ||
      (dir === 'Down' && r.top >= from.bottom - 1)
    const dist = Math.hypot(dx, dy)
    if (ok && (!best || dist < best.dist)) best = { id, dist }
  }
  if (best) s.focusPane(best.id)
}

function jumpToWaiting(): void {
  const s = useStore.getState()
  const order = s.tabs.flatMap((t) => panesOf(t.root))
  const current = activePane(s)?.id
  for (const status of ['waiting', 'done'] as const) {
    const candidates = order.filter((id) => s.panes[id]?.status === status)
    if (!candidates.length) continue
    const next = candidates.find((id) => order.indexOf(id) > order.indexOf(current ?? '')) ?? candidates[0]
    s.focusPane(next)
    return
  }
}

function runAction(action: Action): void {
  const s = useStore.getState()
  const cycle = (step: number): void => {
    const i = s.tabs.findIndex((t) => t.id === s.activeTab)
    const next = s.tabs[(i + step + s.tabs.length) % s.tabs.length]
    if (next) s.setActiveTab(next.id)
  }
  switch (action) {
    case 'newTab':
      return s.newTab()
    case 'newClaudeTab':
      return s.newTab(activePane(s)?.cwd ?? api.sys.home, 'claude')
    case 'splitRight':
      return s.split('h')
    case 'splitDown':
      return s.split('v')
    case 'closePane': {
      const pane = activePane(s)
      return pane && s.closePane(pane.id)
    }
    case 'search':
      return s.toggle('search')
    case 'composer':
      return s.toggle('composer')
    case 'sidebar':
      return s.toggle('sidebar')
    case 'files':
      return s.toggle('files')
    case 'toggleView': {
      const pane = activePane(s)
      if (pane && pane.status !== 'shell') s.toggleView(pane.id)
      return
    }
    case 'jumpWaiting':
      return jumpToWaiting()
    case 'devtools':
      return api.toggleDevtools()
    case 'openFolder':
      return void api.pickFolder().then((dir) => dir && s.newTab(dir, 'claude'))
    case 'zoomIn':
      return useStore.setState({ zoom: Math.min(2, Math.round((s.zoom + 0.1) * 10) / 10) })
    case 'zoomOut':
      return useStore.setState({ zoom: Math.max(0.6, Math.round((s.zoom - 0.1) * 10) / 10) })
    case 'zoomReset':
      return useStore.setState({ zoom: 1 })
    case 'nextTab':
      return cycle(1)
    case 'prevTab':
      return cycle(-1)
    case 'focusLeft':
      return focusInDirection('Left')
    case 'focusRight':
      return focusInDirection('Right')
    case 'focusUp':
      return focusInDirection('Up')
    case 'focusDown':
      return focusInDirection('Down')
  }
}

export function App(): React.JSX.Element | null {
  const [ready, setReady] = useState(false)
  const tabs = useStore((s) => s.tabs)
  const current = useStore((s) => s.activeTab)
  const sidebar = useStore((s) => s.sidebar)
  const files = useStore((s) => s.files)
  const viewer = useStore((s) => s.viewer)
  const composer = useStore((s) => s.composer)
  const theme = useStore((s) => s.theme)
  const zoom = useStore((s) => s.zoom)
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  const resolvedTheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme

  useEffect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent): void => setSystemDark(e.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme
    setTerminalTheme(resolvedTheme)
    const css = getComputedStyle(document.documentElement)
    const color = (name: string): string => css.getPropertyValue(name).trim()
    api.setTheme({ bg: color('--bg'), bar: color('--bg-2'), fg: color('--fg') })
  }, [resolvedTheme])

  useEffect(() => api.setZoom(zoom), [zoom])

  useEffect(() => {
    api.initialFolder().then(async (dir) => {
      await restoreState()
      if (dir) useStore.getState().newTab(dir, 'claude')
      setReady(true)
    })
    const offOpen = api.onOpenFolder((dir) => useStore.getState().newTab(dir, 'claude'))
    const offEvent = api.onClaudeEvent((id, ev) => useStore.getState().claudeEvent(id, ev))
    const offFocus = api.onFocusPane((id) => useStore.getState().focusPane(id))
    const onKey = (e: KeyboardEvent): void => {
      const action = matchShortcut(e)
      if (!action) return
      e.preventDefault()
      runAction(action)
    }
    const onWindowFocus = (): void => {
      const pane = activePane(useStore.getState())
      if (pane) {
        useStore.getState().focusPane(pane.id)
        focusTerm(pane.id)
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('focus', onWindowFocus)
    return () => {
      offEvent()
      offFocus()
      offOpen()
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('focus', onWindowFocus)
    }
  }, [])

  if (!ready) return null
  return (
    <div className="app">
      <MenuBar run={runAction} />
      <TabBar />
      <div className="main">
        {files && (
          <SidePanel id="files" side="left">
            <FilesPanel />
          </SidePanel>
        )}
        <div className="tabs-area">
          {tabs.map((tab) => (
            <div key={tab.id} className="tab-content" style={{ display: tab.id === current ? 'flex' : 'none' }}>
              <SplitView node={tab.root} />
            </div>
          ))}
          {!tabs.length && <Home run={runAction} />}
          {viewer && <Viewer {...viewer} />}
        </div>
        {sidebar && (
          <SidePanel id="sidebar" side="right">
            <Sidebar />
          </SidePanel>
        )}
      </div>
      {composer && <Composer />}
    </div>
  )
}
