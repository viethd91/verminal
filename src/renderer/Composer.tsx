import { useRef, useState } from 'react'
import { activePane, api, useStore } from './state'
import { focusTerm, pasteTo } from './TerminalPane'

const HISTORY_KEY = 'verminal.composer.history'

function loadHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')
  } catch {
    return []
  }
}

function saveHistory(history: string[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 50)))
  } catch {
    // history is a convenience only
  }
}

/** Multi-line prompt editor; submits the text to the active pane as a single bracketed paste. */
export function Composer(): React.JSX.Element {
  const [text, setText] = useState('')
  const history = useRef(loadHistory())
  const cursor = useRef(-1)
  const pane = useStore(activePane)
  const toggle = useStore((s) => s.toggle)

  const close = (): void => {
    toggle('composer', false)
    if (pane) focusTerm(pane.id)
  }

  const submit = (): void => {
    if (!pane || !text.trim()) return
    pasteTo(pane.id, text)
    setTimeout(() => api.pty.write(pane.id, '\r'), 80)
    history.current = [text, ...history.current.filter((h) => h !== text)]
    saveHistory(history.current)
    setText('')
    close()
  }

  const recall = (step: number): void => {
    const next = cursor.current + step
    if (next < -1 || next >= history.current.length) return
    cursor.current = next
    setText(next === -1 ? '' : history.current[next])
  }

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="composer" onMouseDown={(e) => e.stopPropagation()}>
        <div className="composer-title">Prompt → {pane?.cwd.split(/[\\/]/).pop()}</div>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Write a multi-line prompt…"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.ctrlKey) submit()
            else if (e.key === 'Escape') close()
            else if (e.altKey && e.key === 'ArrowUp') recall(1)
            else if (e.altKey && e.key === 'ArrowDown') recall(-1)
          }}
        />
        <div className="composer-hint">Ctrl+Enter send · Esc close · Alt+↑/↓ history</div>
      </div>
    </div>
  )
}
