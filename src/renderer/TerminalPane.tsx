import { useEffect, useRef, useState } from 'react'
import { ITheme, Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { api, matchShortcut, Pane, useStore } from './state'
import { ChatView } from './ChatView'

interface Instance {
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  el: HTMLDivElement
}

// Terminals outlive their React components so that re-parenting a pane (splitting, closing a sibling) keeps its buffer.
const instances = new Map<string, Instance>()

api.pty.onData((id, data) => instances.get(id)?.term.write(data))
api.pty.onExit((id) => {
  if (!instances.has(id)) return
  useStore.getState().closePane(id)
  instances.get(id)?.term.dispose()
  instances.delete(id)
})

export function pasteTo(id: string, text: string): void {
  instances.get(id)?.term.paste(text)
}

/** Focuses the pane's input: the terminal, or the chat box when the pane is in chat view. */
export function focusTerm(id: string): void {
  if (useStore.getState().panes[id]?.view === 'chat')
    document.querySelector<HTMLTextAreaElement>(`[data-chat-input="${id}"]`)?.focus()
  else instances.get(id)?.term.focus()
}

const TERMINAL_THEMES: Record<'dark' | 'light', ITheme> = {
  dark: {
    background: '#14161b',
    foreground: '#d8dae0',
    cursor: '#e8a87c',
    selectionBackground: '#3a4152',
    black: '#1c1f26',
    brightBlack: '#5c6370'
  },
  light: {
    background: '#fafafa',
    foreground: '#24292f',
    cursor: '#c2662d',
    cursorAccent: '#fafafa',
    selectionBackground: '#c8d7f0',
    black: '#24292f',
    red: '#cf222e',
    green: '#116329',
    yellow: '#7d4e00',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#1a7f37',
    brightYellow: '#633c01',
    brightBlue: '#218bff',
    brightMagenta: '#a475f9',
    brightCyan: '#3192aa',
    brightWhite: '#8c959f'
  }
}

export function setTerminalTheme(theme: 'dark' | 'light'): void {
  for (const { term } of instances.values()) term.options.theme = TERMINAL_THEMES[theme]
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i

function dropText(paths: string[], cwd: string): string {
  return paths
    .map((p) => {
      const quoted = p.includes(' ') ? `"${p}"` : p
      if (IMAGE_EXT.test(p)) return quoted
      const base = cwd.replace(/[\\/]+$/, '') + '\\'
      const rel = p.toLowerCase().startsWith(base.toLowerCase()) ? p.slice(base.length) : p
      return '@' + rel.replace(/\\/g, '/')
    })
    .join(' ')
}

function createInstance(pane: Pane): Instance {
  const term = new Terminal({
    fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
    fontSize: 14,
    lineHeight: 1.1,
    cursorBlink: true,
    scrollback: 20000,
    allowProposedApi: true,
    windowsPty: { backend: 'conpty', buildNumber: api.sys.osBuild },
    theme: TERMINAL_THEMES[document.documentElement.dataset.theme === 'light' ? 'light' : 'dark']
  })
  const fit = new FitAddon()
  const search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri)))
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'

  const id = pane.id
  term.onData((d) => api.pty.write(id, d))
  term.onResize(({ cols, rows }) => api.pty.resize(id, cols, rows))
  term.onBell(() => {
    const s = useStore.getState()
    const tab = s.tabs.find((t) => t.id === s.activeTab)
    if (tab?.activePane !== id || !document.hasFocus()) api.notify(id, 'Bell', s.panes[id]?.cwd ?? '')
  })
  term.parser.registerOscHandler(9, (data) => {
    if (!data.startsWith('9;')) return false
    useStore.getState().setCwd(id, data.slice(2).replace(/^"|"$/g, ''))
    return true
  })

  term.attachCustomKeyEventHandler((e) => {
    if (matchShortcut(e)) return false
    if (e.type !== 'keydown') return true
    if (e.key === 'Escape' && useStore.getState().panes[id]?.status === 'running') useStore.getState().interrupted(id)
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      api.pty.write(id, '\x1b\r')
      return false
    }
    // let the browser fire a paste event, handled by xterm (text) or our capture listener (images)
    if (e.ctrlKey && e.key.toLowerCase() === 'v') return false
    if (e.ctrlKey && e.key.toLowerCase() === 'c' && (e.shiftKey || term.hasSelection())) {
      if (term.hasSelection()) api.writeText(term.getSelection())
      term.clearSelection()
      return false
    }
    return true
  })

  const el = document.createElement('div')
  el.className = 'xterm-host'
  el.addEventListener(
    'paste',
    (e) => {
      const hasImage = [...(e.clipboardData?.items ?? [])].some((i) => i.type.startsWith('image/'))
      if (!hasImage) return
      e.preventDefault()
      e.stopPropagation()
      api.saveClipboardImage().then((file) => file && term.paste(file))
    },
    true
  )
  el.addEventListener('dragover', (e) => e.preventDefault())
  el.addEventListener('drop', (e) => {
    e.preventDefault()
    const paths = [...(e.dataTransfer?.files ?? [])].map((f) => api.pathForFile(f)).filter(Boolean)
    if (paths.length) term.paste(dropText(paths, useStore.getState().panes[id]?.cwd ?? '') + ' ')
    term.focus()
  })
  return { term, fit, search, el }
}

const level = (pct: number): string => (pct >= 80 ? 'hot' : pct >= 50 ? 'warm' : '')

function UsageBar({ pane }: { pane: Pane }): React.JSX.Element | null {
  const limits = useStore((s) => s.limits)
  const items: [string, number | undefined, number | undefined][] = [
    ['Context', pane.context, undefined],
    ['5h', limits.fiveHour?.pct, limits.fiveHour?.resetsAt],
    ['Week', limits.week?.pct, limits.week?.resetsAt]
  ]
  if (pane.status === 'shell') return null
  return (
    <div className="usage-bar">
      {items.map(([label, pct, resetsAt]) => (
        <span
          key={label}
          className="usage-item"
          title={resetsAt ? `Resets ${new Date(resetsAt * 1000).toLocaleString()}` : undefined}
        >
          {label}
          <span className="mini-meter">
            {pct != null && <span className={level(pct)} style={{ width: `${Math.min(100, pct)}%` }} />}
          </span>
          <span className={pct != null ? level(pct) : ''}>{pct != null ? `${Math.round(pct)}%` : '—'}</span>
          {label === 'Context' && (
            <button
              className="usage-compact"
              disabled={pane.status === 'running' || pane.status === 'waiting'}
              title="Run /compact to summarize the conversation and free up context"
              onClick={() => {
                api.pty.write(pane.id, '/compact')
                setTimeout(() => api.pty.write(pane.id, '\r'), 150)
                focusTerm(pane.id)
              }}
            >
              Compact
            </button>
          )}
        </span>
      ))}
    </div>
  )
}

const STATUS_LABEL: Record<string, string> = {
  idle: 'Claude ready',
  running: 'Working',
  waiting: 'Needs you',
  done: 'Done'
}

export function TerminalPane({ id }: { id: string }): React.JSX.Element {
  const pane = useStore((s) => s.panes[id])
  const isActive = useStore((s) => s.tabs.find((t) => t.id === s.activeTab)?.activePane === id)
  const searchOpen = useStore((s) => s.search) && isActive
  const focusPane = useStore((s) => s.focusPane)
  const toggle = useStore((s) => s.toggle)
  const toggleView = useStore((s) => s.toggleView)
  const hostRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    const host = hostRef.current!
    let inst = instances.get(id)
    const fresh = !inst
    if (!inst) {
      inst = createInstance(pane)
      instances.set(id, inst)
    }
    const { term, fit, el } = inst
    host.appendChild(el)
    if (fresh) {
      term.open(el)
      term.textarea?.addEventListener('focus', () => useStore.getState().focusPane(id))
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => webgl.dispose())
        term.loadAddon(webgl)
      } catch {
        // fall back to the DOM renderer
      }
    }
    let frame = 0
    const refit = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (host.offsetWidth > 0 && host.offsetHeight > 0) fit.fit()
      })
    }
    const observer = new ResizeObserver(refit)
    observer.observe(host)
    if (fresh) {
      // spawn right away rather than on the next frame: frames don't run while the window is hidden
      if (host.offsetWidth > 0) fit.fit()
      api.pty.spawn({ id, cwd: pane.cwd, cols: term.cols, rows: term.rows, initCmd: pane.initCmd })
    } else refit()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const view = pane?.view
  useEffect(() => {
    if (isActive) requestAnimationFrame(() => focusTerm(id))
  }, [isActive, id, view])

  if (!pane) return <div />
  const name = pane.cwd.split(/[\\/]/).filter(Boolean).pop() ?? pane.cwd
  const search = (back: boolean): void => {
    const s = instances.get(id)?.search
    if (back) s?.findPrevious(query)
    else s?.findNext(query)
  }

  return (
    <div className={`pane ${isActive ? 'active' : ''}`} data-pane={id} onMouseDown={() => focusPane(id)}>
      <div className="pane-header">
        <span className={`dot ${pane.status}`} />
        <span className="pane-name" title={pane.cwd}>
          {name}
        </span>
        {pane.status !== 'shell' && (
          <span className="pane-status">
            {STATUS_LABEL[pane.status]}
            {pane.tool ? ` · ${pane.tool}` : ''}
          </span>
        )}
        {pane.status !== 'shell' && (
          <button className="view-toggle" title="Toggle chat / terminal view (Ctrl+Shift+U)" onClick={() => toggleView(id)}>
            {pane.view === 'chat' ? 'Terminal' : 'Chat'}
          </button>
        )}
      </div>
      <div className="pane-body" ref={hostRef} style={{ display: pane.view === 'chat' ? 'none' : undefined }} />
      {pane.view === 'chat' && <ChatView pane={pane} />}
      <UsageBar pane={pane} />
      {searchOpen && (
        <div className="search-box">
          <input
            autoFocus
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') search(e.shiftKey)
              if (e.key === 'Escape') {
                toggle('search', false)
                focusTerm(id)
              }
            }}
          />
        </div>
      )}
    </div>
  )
}
