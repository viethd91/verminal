import { useEffect, useState } from 'react'
import { Action, api, useStore } from './state'

const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

const SHORTCUTS: [string, string][] = [
  ['Ctrl+Shift+K', 'New Claude tab'],
  ['Ctrl+Shift+T', 'New shell tab'],
  ['Ctrl+Shift+D / E', 'Split right / down'],
  ['Ctrl+Shift+J', 'Jump to waiting Claude'],
  ['Ctrl+Shift+U', 'Chat / terminal view'],
  ['Ctrl+Shift+P', 'Prompt composer'],
  ['Ctrl+Shift+O / B', 'Files / Project panel'],
  ['Ctrl+= / - / 0', 'Zoom']
]

const level = (pct: number): string => (pct >= 80 ? 'hot' : pct >= 50 ? 'warm' : '')

/** Start page shown when no tab is open. */
export function Home({ run }: { run: (action: Action) => void }): React.JSX.Element {
  const recent = useStore((s) => s.recent)
  const limits = useStore((s) => s.limits)
  const newTab = useStore((s) => s.newTab)
  const [branches, setBranches] = useState<Record<string, string | undefined>>({})
  const [last, setLast] = useState<{ cwd: string; id: string; title: string }>()

  useEffect(() => {
    Promise.all(recent.map(async (dir) => [dir, await api.gitBranch(dir)] as const)).then((r) =>
      setBranches(Object.fromEntries(r))
    )
  }, [recent])

  useEffect(() => {
    const cwd = recent[0]
    if (!cwd) return setLast(undefined)
    api.sessions(cwd).then(([s]) => setLast(s && { cwd, id: s.id, title: s.title }))
  }, [recent[0]])

  const forget = (dir: string): void => useStore.setState({ recent: recent.filter((r) => r !== dir) })

  return (
    <div className="home">
      <div className="home-inner">
        <div className="home-hero">
          <h1>Verminal</h1>
          <p>A terminal built for Claude Code</p>
        </div>
        <div className="home-grid">
          <div>
            <h2>Start</h2>
            <div className="home-actions">
              <button className="home-action primary" onClick={() => run('openFolder')}>
                Open Folder…<span>Start Claude in a folder</span>
              </button>
              {last && (
                <button className="home-action" onClick={() => newTab(last.cwd, `claude --resume ${last.id}`)}>
                  Continue last session<span>{`${basename(last.cwd)} · ${last.title}`}</span>
                </button>
              )}
              <button className="home-action" onClick={() => newTab(api.sys.home, 'claude')}>
                New Claude Tab<span>In your home folder</span>
              </button>
              <button className="home-action" onClick={() => newTab(api.sys.home)}>
                New Shell Tab<span>PowerShell in your home folder</span>
              </button>
            </div>

            <h2>Recent Projects</h2>
            {!recent.length && <div className="muted">Folders you open Claude in show up here.</div>}
            {recent.map((dir) => (
              <div key={dir} className="home-recent" title={dir} onClick={() => newTab(dir, 'claude')}>
                <span className="home-recent-name">{basename(dir)}</span>
                {branches[dir] && <span className="badge">{branches[dir]}</span>}
                <span className="home-recent-path">{dir}</span>
                <button
                  className="link"
                  title="Open a shell here"
                  onClick={(e) => {
                    e.stopPropagation()
                    newTab(dir)
                  }}
                >
                  Shell
                </button>
                <button
                  className="link home-forget"
                  title="Remove from recent"
                  onClick={(e) => {
                    e.stopPropagation()
                    forget(dir)
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <div>
            <h2>Plan Usage</h2>
            {(
              [
                ['5-hour', limits.fiveHour],
                ['Weekly', limits.week]
              ] as const
            ).map(([label, l]) => (
              <div key={label} className="home-usage">
                <div className="kv">
                  <span>{label}</span>
                  <span className={l ? level(l.pct) : ''}>{l ? `${Math.round(l.pct)}%` : '—'}</span>
                </div>
                <div className="meter">
                  {l && <div className={level(l.pct)} style={{ width: `${Math.min(100, l.pct)}%` }} />}
                </div>
                {l?.resetsAt && <div className="home-reset">Resets {new Date(l.resetsAt * 1000).toLocaleString()}</div>}
              </div>
            ))}

            <h2>Shortcuts</h2>
            {SHORTCUTS.map(([keys, label]) => (
              <div key={keys} className="kv">
                <span>{label}</span>
                <kbd>{keys}</kbd>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
