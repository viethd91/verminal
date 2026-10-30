import { useEffect, useState } from 'react'
import { activePane, api, useStore } from './state'

interface Usage {
  model: string
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  contextTokens: number
  contextWindow: number
  costUsd: number
}

const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

function fmtTokens(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n)
}

function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60000)
  if (m < 60) return `${m}m`
  if (m < 60 * 24) return `${Math.round(m / 60)}h`
  return `${Math.round(m / 1440)}d`
}

function Section({
  title,
  children,
  action,
  collapsed
}: {
  title: string
  children: React.ReactNode
  action?: React.ReactNode
  collapsed?: boolean
}) {
  return (
    <details open={!collapsed} className="section">
      <summary>
        <span className="section-title">
          <svg className="chevron" viewBox="0 0 16 16" width="10" height="10">
            <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          {title}
        </span>
        {action}
      </summary>
      <div className="section-body">{children}</div>
    </details>
  )
}

function Projects(): React.JSX.Element {
  const recent = useStore((s) => s.recent)
  const newTab = useStore((s) => s.newTab)
  const openProject = useStore((s) => s.openProject)
  const [branches, setBranches] = useState<Record<string, string | undefined>>({})

  useEffect(() => {
    Promise.all(recent.map(async (dir) => [dir, await api.gitBranch(dir)] as const)).then((r) =>
      setBranches(Object.fromEntries(r))
    )
  }, [recent])

  const open = async (): Promise<void> => {
    const dir = await api.pickFolder()
    if (dir) newTab(dir, 'claude')
  }

  return (
    <Section
      title="Projects"
      action={
        <button
          className="link"
          onClick={(e) => {
            e.preventDefault()
            open()
          }}
        >
          Open…
        </button>
      }
    >
      {!recent.length && <div className="muted">Open a folder to start Claude there.</div>}
      {recent.map((dir) => (
        <div key={dir} className="row" title={dir} onClick={() => openProject(dir)}>
          <span className="row-title">{basename(dir)}</span>
          {branches[dir] && <span className="badge">{branches[dir]}</span>}
        </div>
      ))}
    </Section>
  )
}

function Sessions({ cwd, sessionId, refreshKey }: { cwd: string; sessionId?: string; refreshKey: string | number }) {
  const openSession = useStore((s) => s.openSession)
  const [sessions, setSessions] = useState<{ id: string; title: string; modified: number }[]>([])

  useEffect(() => {
    api.sessions(cwd).then(setSessions)
  }, [cwd, refreshKey])

  return (
    <Section
      title={`Sessions · ${basename(cwd)}`}
      collapsed
      action={
        <button
          className="link"
          title="Start a new Claude session in this folder"
          onClick={(e) => {
            // keep the section from toggling
            e.preventDefault()
            openSession(cwd)
          }}
        >
          New chat
        </button>
      }
    >
      {!sessions.length && <div className="muted">No Claude sessions in this folder.</div>}
      {sessions.map((s) => (
        <div
          key={s.id}
          className={`row ${s.id === sessionId ? 'current' : ''}`}
          title={s.title}
          onClick={() => openSession(cwd, s.id)}
        >
          <span className="row-title">{s.title}</span>
          <span className="muted">{ago(s.modified)}</span>
        </div>
      ))}
    </Section>
  )
}

function UsagePanel({ transcriptPath, refreshKey }: { transcriptPath?: string; refreshKey: string | number }) {
  const [usage, setUsage] = useState<Usage | undefined>()

  useEffect(() => {
    if (!transcriptPath) return setUsage(undefined)
    api.usage(transcriptPath).then(setUsage)
  }, [transcriptPath, refreshKey])

  if (!usage)
    return (
      <Section title="Usage" collapsed>
        <div className="muted">No active Claude session.</div>
      </Section>
    )
  const pct = Math.min(100, (usage.contextTokens / usage.contextWindow) * 100)
  return (
    <Section title="Usage" collapsed>
      <div className="kv">
        <span>Model</span>
        <span>{usage.model.replace(/^claude-/, '')}</span>
      </div>
      <div className="kv">
        <span>Context</span>
        <span>
          {fmtTokens(usage.contextTokens)} / {fmtTokens(usage.contextWindow)}
        </span>
      </div>
      <div className="meter">
        <div className={pct > 80 ? 'hot' : ''} style={{ width: `${pct}%` }} />
      </div>
      <div className="kv">
        <span>Input / Output</span>
        <span>
          {fmtTokens(usage.input)} / {fmtTokens(usage.output)}
        </span>
      </div>
      <div className="kv">
        <span>Cache write / read</span>
        <span>
          {fmtTokens(usage.cacheWrite)} / {fmtTokens(usage.cacheRead)}
        </span>
      </div>
      <div className="kv">
        <span>Est. cost (API rates)</span>
        <span>${usage.costUsd.toFixed(2)}</span>
      </div>
    </Section>
  )
}

export function Sidebar(): React.JSX.Element {
  const pane = useStore(activePane)
  // transcripts are re-read when a turn ends, not on every tool call
  const turnKey = pane?.status === 'running' ? 'running' : (pane?.tick ?? 0)
  return (
    <div className="sidebar">
      <Projects />
      {pane && (
        <>
          <UsagePanel transcriptPath={pane.transcriptPath} refreshKey={turnKey} />
          <Sessions cwd={pane.cwd} sessionId={pane.sessionId} refreshKey={turnKey} />
        </>
      )}
    </div>
  )
}
