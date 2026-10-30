import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Markdown, { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatItem } from '../main/claude'
import { api, Pane, useStore } from './state'
import { pasteTo } from './TerminalPane'
import { detectLanguage, highlight } from './Viewer'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
type Block = ChatItem | { kind: 'steps'; key: string; tools: ToolItem[] }

/** Consecutive tool calls are shown together as one block of steps. */
function group(items: ChatItem[]): Block[] {
  const blocks: Block[] = []
  for (const item of items) {
    const last = blocks[blocks.length - 1]
    if (item.kind !== 'tool') blocks.push(item)
    else if (last?.kind === 'steps') last.tools.push(item)
    else blocks.push({ kind: 'steps', key: item.key, tools: [item] })
  }
  return blocks
}

const basename = (p: string): string => p.split(/[\\/]/).pop() ?? p

function toolTarget({ input }: ToolItem): string {
  if (typeof input.file_path === 'string') return basename(input.file_path)
  const value = input.command ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt ?? ''
  return String(value).split('\n')[0].slice(0, 160)
}

function CodeBlock({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLPreElement>(null)
  return (
    <div className="code-block">
      <pre ref={ref}>{children}</pre>
      <button className="code-copy" onClick={() => api.writeText(ref.current?.textContent ?? '')}>
        Copy
      </button>
    </div>
  )
}

const MARKDOWN: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ className, children }) => {
    const language = className?.match(/language-(\S+)/)?.[1]
    if (!language) return <code>{children}</code>
    return <code dangerouslySetInnerHTML={{ __html: highlight(String(children).replace(/\n$/, ''), language) }} />
  }
}

function Diff({ before, after }: { before: string; after: string }): React.JSX.Element {
  return (
    <pre className="step-code">
      {before.split('\n').map((l, i) => (
        <div key={`o${i}`} className="del">
          {l || ' '}
        </div>
      ))}
      {after.split('\n').map((l, i) => (
        <div key={`n${i}`} className="add">
          {l || ' '}
        </div>
      ))}
    </pre>
  )
}

interface Edit {
  old_string: string
  new_string: string
}
const isEdit = (e: unknown): e is Edit =>
  typeof (e as Edit)?.old_string === 'string' && typeof (e as Edit)?.new_string === 'string'

function StepDetails({ tool }: { tool: ToolItem }): React.JSX.Element {
  const { input } = tool
  const path = typeof input.file_path === 'string' ? input.file_path : undefined
  let body: React.ReactNode
  if (isEdit(input)) body = <Diff before={input.old_string} after={input.new_string} />
  else if (Array.isArray(input.edits) && input.edits.every(isEdit))
    body = input.edits.map((e, i) => <Diff key={i} before={e.old_string} after={e.new_string} />)
  else if (typeof input.content === 'string' && path)
    body = (
      <pre
        className="step-code"
        dangerouslySetInnerHTML={{ __html: highlight(input.content.slice(0, 6000), detectLanguage(path)) }}
      />
    )
  else if (typeof input.command === 'string') body = <pre className="step-code">$ {input.command}</pre>
  else if (!path) body = <pre className="step-code">{JSON.stringify(input, null, 2).slice(0, 4000)}</pre>
  return (
    <div className="step-details">
      {path && <div className="step-path">{path}</div>}
      {body}
      {tool.result && <pre className={`step-code result ${tool.isError ? 'error' : ''}`}>{tool.result}</pre>}
    </div>
  )
}

function Step({ tool }: { tool: ToolItem }): React.JSX.Element {
  // details are only rendered once opened; a long session has thousands of steps
  const [open, setOpen] = useState(false)
  return (
    <details className="step" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className={`step-state ${tool.result === undefined ? 'running' : tool.isError ? 'error' : 'ok'}`}>
          {tool.result === undefined ? '' : tool.isError ? '✕' : '✓'}
        </span>
        <span className="step-name" title={tool.name}>
          {tool.name.replace(/^mcp__(.+?)__/, '$1 › ')}
        </span>
        <span className="step-target">{toolTarget(tool)}</span>
      </summary>
      {open && <StepDetails tool={tool} />}
    </details>
  )
}

function Steps({ tools }: { tools: ToolItem[] }): React.JSX.Element {
  return (
    <div className="steps">
      {tools.map((tool) => (
        <Step key={tool.key} tool={tool} />
      ))}
    </div>
  )
}

/** The pane's Claude session rendered as a chat, read from its transcript; prompts go to the same session. */
export function ChatView({ pane }: { pane: Pane }): React.JSX.Element {
  const [items, setItems] = useState<ChatItem[]>([])
  const [text, setText] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  /** Index into the prompt history shown in the input, or -1 while editing a new message. */
  const [recalled, setRecalled] = useState(-1)
  const draft = useRef('')
  const stick = useRef(true)
  const toggleView = useStore((s) => s.toggleView)
  const interrupted = useStore((s) => s.interrupted)

  useEffect(() => {
    if (!pane.transcriptPath) return
    const load = (): void => {
      api.transcript(pane.transcriptPath!).then(setItems)
    }
    load()
    // text blocks land in the transcript between hook events, so poll while a turn is running
    const timer = pane.status === 'running' ? setInterval(load, 1500) : undefined
    return () => clearInterval(timer)
  }, [pane.transcriptPath, pane.tick, pane.status])

  useLayoutEffect(() => {
    const el = listRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [items])

  // the input grows with its text up to its max height
  useLayoutEffect(() => {
    const el = inputRef.current!
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }, [text])

  const send = (): void => {
    if (!text.trim()) return
    pasteTo(pane.id, text)
    setTimeout(() => api.pty.write(pane.id, '\r'), 80)
    setText('')
    setRecalled(-1)
    stick.current = true
  }

  // Up and Down at the edges of the input step through earlier prompts of the session, newest first
  const history = items.flatMap((i) => (i.kind === 'user' && i.text !== '[image]' ? [i.text] : [])).reverse()
  const recall = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const el = e.currentTarget
    const step =
      e.key === 'ArrowUp' && !el.value.slice(0, el.selectionStart).includes('\n')
        ? 1
        : e.key === 'ArrowDown' && recalled >= 0 && !el.value.slice(el.selectionEnd).includes('\n')
          ? -1
          : 0
    const next = recalled + step
    if (!step || next >= history.length) return
    e.preventDefault()
    if (recalled < 0) draft.current = text
    setRecalled(next)
    setText(next < 0 ? draft.current : history[next])
  }

  return (
    <div
      className="chat"
      onKeyDown={(e) => {
        // Esc interrupts Claude, as it does in the terminal. An interrupted prompt goes back into
        // Claude's input in the terminal, where it would prefix the next message, so it is cleared.
        if (e.key !== 'Escape' || pane.status !== 'running') return
        api.pty.write(pane.id, '\x1b')
        setTimeout(() => api.pty.write(pane.id, '\x03'), 500)
        interrupted(pane.id)
      }}
    >
      <div
        className="chat-list"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        <div className="chat-column">
          {!items.length && <div className="muted chat-empty">No messages yet.</div>}
          {group(items).map((block) => {
            if (block.kind === 'steps') return <Steps key={block.key} tools={block.tools} />
            if (block.kind === 'event')
              return (
                <div key={block.key} className="chat-event">
                  <span>{block.text}</span>
                </div>
              )
            if (block.kind === 'user')
              return (
                <div key={block.key} className="chat-msg user">
                  {block.text}
                </div>
              )
            if (block.kind === 'assistant')
              return (
                <div key={block.key} className="chat-msg assistant">
                  <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN}>
                    {block.text}
                  </Markdown>
                </div>
              )
            return null
          })}
          {pane.status === 'running' && (
            <div className="chat-working">
              <span className="dot running" /> Working{pane.tool ? ` · ${pane.tool}` : ''}… <span>(Esc to interrupt)</span>
            </div>
          )}
        </div>
      </div>
      {pane.status === 'waiting' && (
        <div className="chat-banner">
          Claude is asking for your input in the terminal.
          <button className="link" onClick={() => toggleView(pane.id)}>
            Open terminal (Ctrl+Shift+U)
          </button>
        </div>
      )}
      <div className="chat-composer">
        <textarea
          ref={inputRef}
          className="chat-input"
          rows={1}
          data-chat-input={pane.id}
          value={text}
          placeholder="Message Claude… (Enter to send, Shift+Enter for a new line)"
          onChange={(e) => {
            setText(e.target.value)
            setRecalled(-1)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
              e.preventDefault()
              send()
            } else recall(e)
          }}
        />
      </div>
    </div>
  )
}
