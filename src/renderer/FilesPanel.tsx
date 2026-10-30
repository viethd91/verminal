import { useCallback, useEffect, useState } from 'react'
import type { SessionChange } from '../main/claude'
import type { DirEntry } from '../main/files'
import { activePane, api, Pane, useStore } from './state'
import { focusTerm, pasteTo } from './TerminalPane'

const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p
const join = (dir: string, name: string): string => dir.replace(/[\\/]+$/, '') + '\\' + name
const samePath = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

function relative(path: string, root: string): string {
  const base = root.replace(/[\\/]+$/, '') + '\\'
  return path.toLowerCase().startsWith(base.toLowerCase()) ? path.slice(base.length) : path
}

function mention(pane: Pane, path: string): void {
  pasteTo(pane.id, `@${relative(path, pane.cwd).replace(/\\/g, '/')} `)
  focusTerm(pane.id)
}

/** Changes grouped by folder relative to the pane's folder, folders ordered by their most recent change. */
function byFolder(changes: SessionChange[], root: string): [string, SessionChange[]][] {
  const groups = new Map<string, SessionChange[]>()
  for (const c of changes) {
    const rel = relative(c.path, root)
    const dir = rel.slice(0, -basename(c.path).length).replace(/[\\/]+$/, '').replace(/\\/g, '/')
    groups.set(dir, [...(groups.get(dir) ?? []), c])
  }
  return [...groups]
}

function Changes({ pane, changes }: { pane: Pane; changes: SessionChange[] }): React.JSX.Element {
  const openViewer = useStore((s) => s.openViewer)
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const toggle = (dir: string): void => {
    const next = new Set(closed)
    if (!next.delete(dir)) next.add(dir)
    setClosed(next)
  }
  return (
    <details open className="section">
      <summary>Changes{changes.length ? ` · ${changes.length}` : ''}</summary>
      <div className="section-body">
        {!pane.transcriptPath && <div className="muted">No Claude session in this pane.</div>}
        {pane.transcriptPath && !changes.length && <div className="muted">Claude hasn't changed any files yet.</div>}
        {byFolder(changes, pane.cwd).map(([dir, files]) => (
          <div key={dir}>
            <div className="change-folder" title={dir || pane.cwd} onClick={() => toggle(dir)}>
              <span className="tree-icon">{closed.has(dir) ? '▸' : '▾'}</span>
              <span className="row-title">{dir || basename(pane.cwd)}</span>
              <span className="muted">{files.length}</span>
            </div>
            {!closed.has(dir) &&
              files.map((c) => (
                <div
                  key={c.path}
                  className="row change-file"
                  title={c.path}
                  onClick={() => openViewer({ path: c.path, transcriptPath: pane.transcriptPath })}
                >
                  <span className={`git-status ${c.created ? 's-A' : 's-M'}`}>{c.created ? 'A' : 'M'}</span>
                  <span className="row-title">{basename(c.path)}</span>
                  <span className="stat-add">+{c.added}</span>
                  <span className="stat-del">−{c.removed}</span>
                </div>
              ))}
          </div>
        ))}
      </div>
    </details>
  )
}

function Explorer({ pane, changes }: { pane: Pane; changes: SessionChange[] }): React.JSX.Element {
  const openViewer = useStore((s) => s.openViewer)
  const root = pane.cwd
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [children, setChildren] = useState<Record<string, DirEntry[]>>({})

  const load = useCallback(async (dirs: string[]) => {
    const loaded = await Promise.all(dirs.map(async (d) => [d, await api.listDir(d)] as const))
    setChildren((c) => ({ ...c, ...Object.fromEntries(loaded) }))
  }, [])

  useEffect(() => {
    setExpanded(new Set())
    setChildren({})
    load([root])
  }, [root, load])

  // pick up files Claude creates or deletes
  useEffect(() => {
    load([root, ...expanded])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.tick])

  const toggle = (dir: string): void => {
    const next = new Set(expanded)
    if (next.has(dir)) next.delete(dir)
    else {
      next.add(dir)
      load([dir])
    }
    setExpanded(next)
  }

  const open = (path: string): void => {
    const changed = changes.some((c) => samePath(c.path, path))
    openViewer({ path, transcriptPath: changed ? pane.transcriptPath : undefined })
  }

  const renderDir = (dir: string, depth: number): React.ReactNode =>
    (children[dir] ?? []).map((entry) => {
      const path = join(dir, entry.name)
      const changed = !entry.dir && changes.some((c) => samePath(c.path, path))
      return (
        <div key={path}>
          <div
            className={`tree-row ${changed ? 'changed' : ''}`}
            style={{ paddingLeft: 8 + depth * 12 }}
            title={path}
            onClick={() => (entry.dir ? toggle(path) : open(path))}
          >
            <span className="tree-icon">{entry.dir ? (expanded.has(path) ? '▾' : '▸') : ''}</span>
            <span className="row-title">{entry.name}</span>
            <button
              className="tree-mention"
              title="Insert @mention into the terminal"
              onClick={(e) => {
                e.stopPropagation()
                mention(pane, path)
              }}
            >
              @
            </button>
          </div>
          {entry.dir && expanded.has(path) && renderDir(path, depth + 1)}
        </div>
      )
    })

  return (
    <details open className="section explorer">
      <summary>
        {basename(root)}
        <button className="link" title="Refresh" onClick={() => load([root, ...expanded])}>
          ↻
        </button>
      </summary>
      <div className="tree">{renderDir(root, 0)}</div>
    </details>
  )
}

export function FilesPanel(): React.JSX.Element {
  const pane = useStore(activePane)
  const [changes, setChanges] = useState<SessionChange[]>([])

  useEffect(() => {
    if (!pane?.transcriptPath) return setChanges([])
    api.sessionChanges(pane.transcriptPath).then(setChanges)
  }, [pane?.transcriptPath, pane?.tick])

  return (
    <div className="files-panel">
      {!pane && <div className="muted files-empty">Open a tab to see its files.</div>}
      {pane && (
        <>
          <Changes pane={pane} changes={changes} />
          <Explorer pane={pane} changes={changes} />
        </>
      )}
    </div>
  )
}
