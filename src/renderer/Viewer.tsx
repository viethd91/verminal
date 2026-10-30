import { useEffect, useMemo, useRef, useState } from 'react'
import { diffLines } from 'diff'
import hljs from 'highlight.js/lib/common'
import powershell from 'highlight.js/lib/languages/powershell'
import { basicSetup } from 'codemirror'
import { indentWithTab } from '@codemirror/commands'
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { Compartment } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { api, useStore } from './state'

hljs.registerLanguage('powershell', powershell)

export const LANGUAGES = hljs
  .listLanguages()
  .map((id) => ({ id, name: hljs.getLanguage(id)!.name ?? id }))
  .sort((a, b) => a.name.localeCompare(b.name))

const ALIASES = new Map(LANGUAGES.flatMap(({ id }) => [id, ...(hljs.getLanguage(id)!.aliases ?? [])].map((a) => [a, id])))

export function detectLanguage(path: string): string {
  const name = path.split(/[\\/]/).pop()!.toLowerCase()
  return ALIASES.get(name) ?? ALIASES.get(name.split('.').pop()!) ?? 'plaintext'
}

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function highlight(text: string, language: string): string {
  return hljs.getLanguage(language) && language !== 'plaintext'
    ? hljs.highlight(text, { language, ignoreIllegals: true }).value
    : escapeHtml(text)
}

/** Highlights the whole text, then splits the HTML into lines, re-opening spans that cross line breaks. */
function highlightLines(text: string, language: string): string[] {
  const html = highlight(text, language)
  const open: string[] = []
  const out = html.split('\n').map((line) => {
    const prefix = open.join('')
    for (const [tag] of line.matchAll(/<span[^>]*>|<\/span>/g)) {
      if (tag === '</span>') open.pop()
      else open.push(tag)
    }
    return prefix + line + '</span>'.repeat(open.length)
  })
  if (text === '' || text.endsWith('\n')) out.pop()
  return out
}

interface Row {
  kind: 'same' | 'del' | 'add' | 'mod'
  left?: { n: number; text: string }
  right?: { n: number; text: string }
}

const CONTEXT = 3

function lines(text: string): string[] {
  const out = text.split('\n')
  if (out[out.length - 1] === '') out.pop()
  return out
}

/** Side-by-side rows; a removal directly followed by an addition is paired line by line. */
export function sideBySide(before: string, after: string): Row[] {
  const rows: Row[] = []
  let l = 1
  let r = 1
  const parts = diffLines(before, after, { ignoreNewlineAtEof: true })
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!part.added && !part.removed) {
      for (const text of lines(part.value)) rows.push({ kind: 'same', left: { n: l++, text }, right: { n: r++, text } })
    } else if (part.removed) {
      const removed = lines(part.value)
      const added = parts[i + 1]?.added ? lines(parts[++i].value) : []
      for (let k = 0; k < Math.max(removed.length, added.length); k++) {
        const left = k < removed.length ? { n: l++, text: removed[k] } : undefined
        const right = k < added.length ? { n: r++, text: added[k] } : undefined
        rows.push({ kind: left && right ? 'mod' : left ? 'del' : 'add', left, right })
      }
    } else {
      for (const text of lines(part.value)) rows.push({ kind: 'add', right: { n: r++, text } })
    }
  }
  return rows
}

type Display = { row: Row } | { fold: number; start: number; count: number }

/** Collapses long runs of unchanged rows, keeping a few lines of context around changes. */
function fold(rows: Row[], open: Set<number>): Display[] {
  const out: Display[] = []
  let i = 0
  while (i < rows.length) {
    if (rows[i].kind !== 'same') {
      out.push({ row: rows[i++] })
      continue
    }
    let j = i
    while (j < rows.length && rows[j].kind === 'same') j++
    const head = i === 0 ? 0 : CONTEXT
    const tail = j === rows.length ? 0 : CONTEXT
    if (j - i > head + tail + 2 && !open.has(i)) {
      for (let k = i; k < i + head; k++) out.push({ row: rows[k] })
      out.push({ fold: i, start: i + head, count: j - i - head - tail })
      for (let k = j - tail; k < j; k++) out.push({ row: rows[k] })
    } else for (let k = i; k < j; k++) out.push({ row: rows[k] })
    i = j
  }
  return out
}

const EDITOR_THEME = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--bg)', color: 'var(--fg)', fontSize: '12.5px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: "'Cascadia Mono', Consolas, monospace", lineHeight: '1.5' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--muted)', border: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--bg-2)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent) !important'
  },
  '.cm-panels': { backgroundColor: 'var(--bg-2)', color: 'var(--fg)' },
  '.cm-tooltip': { backgroundColor: 'var(--bg-2)', border: '1px solid var(--border)' }
})

// same colors as the read-only highlighting
const EDITOR_HIGHLIGHT = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--syn-string)' },
  { tag: [t.comment, t.meta], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.heading], color: 'var(--syn-title)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--syn-type)' },
  { tag: [t.attributeName, t.definition(t.propertyName)], color: 'var(--syn-attr)' },
  { tag: [t.tagName, t.special(t.variableName)], color: 'var(--syn-variable)' },
  { tag: [t.standard(t.variableName), t.self], color: 'var(--syn-builtin)' }
])

function editorLanguage(path: string, chosen: string): LanguageDescription | null {
  if (chosen === 'auto') return LanguageDescription.matchFilename(languages, path.split(/[\\/]/).pop()!)
  const name = LANGUAGES.find((l) => l.id === chosen)?.name ?? chosen
  return LanguageDescription.matchLanguageName(languages, name, true)
}

/** Editable view of a whole file; Ctrl+S saves. */
function Editor({ path, text }: { path: string; text: string }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const saved = useRef(text)
  const language = useRef(new Compartment())
  const chosen = useStore((s) => s.language)
  const dirty = useStore((s) => s.viewerDirty)

  const save = async (): Promise<void> => {
    const current = view.current!.state.doc.toString()
    await api.writeFile(path, current)
    saved.current = current
    useStore.setState({ viewerDirty: view.current!.state.doc.toString() !== current })
  }
  const discard = (): void => {
    view.current!.dispatch({ changes: { from: 0, to: view.current!.state.doc.length, insert: saved.current } })
  }

  useEffect(() => {
    view.current = new EditorView({
      parent: host.current!,
      doc: text,
      extensions: [
        basicSetup,
        keymap.of([indentWithTab, { key: 'Mod-s', preventDefault: true, run: () => (save(), true) }]),
        EDITOR_THEME,
        syntaxHighlighting(EDITOR_HIGHLIGHT),
        language.current.of([]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) useStore.setState({ viewerDirty: u.state.doc.toString() !== saved.current })
        })
      ]
    })
    return () => {
      view.current!.destroy()
      useStore.setState({ viewerDirty: false })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const description = editorLanguage(path, chosen)
    if (!description) return view.current!.dispatch({ effects: language.current.reconfigure([]) })
    description.load().then((support) => view.current?.dispatch({ effects: language.current.reconfigure(support) }))
  }, [path, chosen])

  return (
    <>
      {dirty && (
        <div className="editor-bar">
          Unsaved changes
          <button className="link" onClick={save}>
            Save (Ctrl+S)
          </button>
          <button className="link" onClick={discard}>
            Discard
          </button>
        </div>
      )}
      <div className="editor" ref={host} />
    </>
  )
}

function Side({ n, html, kind }: { n?: number; html?: string; kind: Row['kind'] }): React.JSX.Element {
  return (
    <>
      <span className="ln">{n ?? ''}</span>
      <span className={`code ${n ? kind : 'empty'}`} dangerouslySetInnerHTML={{ __html: html ?? '' }} />
    </>
  )
}

/** File view in place of the tabs: an editor, or for files changed in the session a comparison with their content before it. */
export function Viewer({ path, transcriptPath }: { path: string; transcriptPath?: string }): React.JSX.Element {
  const close = (): void => useStore.getState().openViewer(null)
  const [content, setContent] = useState<{ before?: string; after: string | null } | null>(null)
  const [open, setOpen] = useState<Set<number>>(new Set())
  const chosen = useStore((s) => s.language)
  const dirty = useStore((s) => s.viewerDirty)
  const language = chosen === 'auto' ? detectLanguage(path) : chosen

  useEffect(() => {
    setContent(null)
    setOpen(new Set())
    Promise.all([api.readFile(path), transcriptPath ? api.fileBefore(transcriptPath, path) : undefined]).then(
      ([after, before]) => setContent({ before, after })
    )
  }, [path, transcriptPath])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // keys the editor handled, such as Esc closing its search panel, don't close the view
      if (e.key === 'Escape' && !e.defaultPrevented) close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const rows = useMemo(
    () => (content?.before !== undefined ? sideBySide(content.before, content.after ?? '') : null),
    [content]
  )
  const html = useMemo(
    () =>
      content?.before === undefined ? null : {
        before: highlightLines(content.before, language),
        after: highlightLines(content.after ?? '', language)
      },
    [content, language]
  )
  const added = rows?.filter((r) => r.right && r.kind !== 'same').length ?? 0
  const removed = rows?.filter((r) => r.left && r.kind !== 'same').length ?? 0

  return (
    <div className="viewer">
      <div className="viewer-head">
        <span className="viewer-path">{path}</span>
        <span className="viewer-mode">{LANGUAGES.find((l) => l.id === language)?.name ?? language}</span>
        {rows && (
          <span className="viewer-mode">
            Before session ↔ Now <span className="stat-add">+{added}</span> <span className="stat-del">−{removed}</span>
          </span>
        )}
        <button
          className="link"
          disabled={dirty}
          title={dirty ? 'Save or discard the changes first' : 'Close (Esc)'}
          onClick={close}
        >
          ×
        </button>
      </div>
      <div className="viewer-body">
        {!content && <div className="muted">Loading…</div>}
        {content && !rows && content.after === null && (
          <div className="muted">This file can't be displayed (missing, binary or larger than 2 MB).</div>
        )}
        {content && !rows && content.after !== null && <Editor key={path} path={path} text={content.after} />}
        {rows && (
          <div className="code-grid double">
            {fold(rows, open).map((d, i) =>
              'fold' in d ? (
                <div key={`f${d.fold}`} className="fold" onClick={() => setOpen(new Set(open).add(d.fold))}>
                  ⋯ {d.count} unchanged lines
                </div>
              ) : (
                <div key={i} className="code-row">
                  <Side
                    n={d.row.left?.n}
                    html={d.row.left && html?.before[d.row.left.n - 1]}
                    kind={d.row.kind === 'mod' ? 'del' : d.row.kind}
                  />
                  <Side
                    n={d.row.right?.n}
                    html={d.row.right && html?.after[d.row.right.n - 1]}
                    kind={d.row.kind === 'mod' ? 'add' : d.row.kind}
                  />
                </div>
              )
            )}
          </div>
        )}
      </div>
    </div>
  )
}
