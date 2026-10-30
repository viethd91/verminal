import { promises as fs, createReadStream } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { diffLines } from 'diff'
import { readText } from './files'

export interface SessionInfo {
  id: string
  title: string
  modified: number
}

export interface Usage {
  model: string
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  contextTokens: number
  contextWindow: number
  costUsd: number
}

// USD per million tokens: [input, output, cache read]. Cache writes are 1.25x input (5m) or 2x (1h).
const PRICES: [string, number, number, number][] = [
  ['fable-5', 10, 50, 0.25],
  ['mythos-5', 10, 50, 0.25],
  ['opus-5-5', 4, 20, 0.2],
  ['opus-5', 5, 25, 0.5],
  ['opus-4', 5, 25, 0.5],
  ['sonnet-5', 2, 10, 0.2],
  ['sonnet-4', 3, 15, 0.3],
  ['haiku-5', 0.1, 0.5, 0.01],
  ['haiku-4', 1, 5, 0.1]
]

export function projectDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
}

function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const block = content.find((b) => b?.type === 'text')
    return block?.text
  }
  return undefined
}

/** First prompt the human typed, skipping command wrappers and tool results. */
export function sessionTitle(jsonl: string): string | undefined {
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"type":"user"')) continue
    try {
      const entry = JSON.parse(line)
      if (entry.type !== 'user' || entry.isMeta) continue
      const text = textOf(entry.message?.content)?.trim()
      if (text && !text.startsWith('<')) return text.slice(0, 200)
    } catch {
      // last line may be truncated by the partial read
    }
  }
  return undefined
}

export async function listSessions(cwd: string): Promise<SessionInfo[]> {
  const dir = projectDir(cwd)
  let names: string[]
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.jsonl'))
  } catch {
    return []
  }
  const sessions = await Promise.all(
    names.map(async (name) => {
      const file = join(dir, name)
      const stat = await fs.stat(file)
      const head = await readHead(file, 256 * 1024)
      const title = sessionTitle(head)
      return title ? { id: name.slice(0, -6), title, modified: stat.mtimeMs } : undefined
    })
  )
  return sessions
    .filter((s): s is SessionInfo => !!s)
    .sort((a, b) => b.modified - a.modified)
    .slice(0, 50)
}

function readHead(file: string, bytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    createReadStream(file, { encoding: 'utf8', start: 0, end: bytes - 1 })
      .on('data', (d) => (data += d))
      .on('end', () => resolve(data))
      .on('error', reject)
  })
}

export function computeUsage(jsonl: string): Usage | undefined {
  const seen = new Set<string>()
  const u: Usage = {
    model: '',
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    contextTokens: 0,
    contextWindow: 0,
    costUsd: 0
  }
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"usage"')) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const msg = entry.message
    if (entry.type !== 'assistant' || !msg?.usage || msg.model === '<synthetic>') continue
    if (msg.id && seen.has(msg.id)) continue
    seen.add(msg.id)

    const usage = msg.usage
    const input = usage.input_tokens ?? 0
    const output = usage.output_tokens ?? 0
    const read = usage.cache_read_input_tokens ?? 0
    const write = usage.cache_creation_input_tokens ?? 0
    const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0

    const [, pIn, pOut, pRead] = PRICES.find(([key]) => msg.model.includes(key)) ?? PRICES[2]
    u.costUsd +=
      (input * pIn + output * pOut + read * pRead + (write - write1h) * pIn * 1.25 + write1h * pIn * 2) /
      1e6

    u.model = msg.model
    u.input += input
    u.output += output
    u.cacheRead += read
    u.cacheWrite += write
    if (!entry.isSidechain) u.contextTokens = input + read + write
  }
  if (!u.model) return undefined
  u.contextWindow = u.model.includes('haiku-4') ? 200_000 : 1_000_000
  return u
}

export async function readUsage(transcriptPath: string): Promise<Usage | undefined> {
  try {
    return computeUsage(await fs.readFile(transcriptPath, 'utf8'))
  } catch {
    return undefined
  }
}

/** Marks a folder as trusted in Claude Code's global config so the trust dialog is skipped there. */
export async function trustFolder(dir: string): Promise<void> {
  const file = join(homedir(), '.claude.json')
  const config = JSON.parse(await fs.readFile(file, 'utf8').catch(() => '{}'))
  const key = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  config.projects ??= {}
  if (config.projects[key]?.hasTrustDialogAccepted) return
  config.projects[key] = { ...config.projects[key], hasTrustDialogAccepted: true }
  const tmp = `${file}.verminal-${process.pid}`
  await fs.writeFile(tmp, JSON.stringify(config, null, 2))
  await fs.rename(tmp, file)
}

export type ChatItem =
  | { kind: 'user' | 'assistant'; key: string; text: string }
  /** Something that happened in the session rather than a message: a slash command, an interruption, a compaction. */
  | { kind: 'event'; key: string; text: string }
  | { kind: 'tool'; key: string; id: string; name: string; input: Record<string, unknown>; result?: string; isError?: boolean }

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content.map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : '')).join('\n')
  return ''
}

/** Main-thread conversation of a transcript, flattened into chat items (most recent `limit` items). */
export function parseTranscript(jsonl: string, limit = 400): ChatItem[] {
  const items: ChatItem[] = []
  const tools = new Map<string, Extract<ChatItem, { kind: 'tool' }>>()
  for (const line of jsonl.split('\n')) {
    if (!line.startsWith('{')) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.isSidechain || entry.isMeta || (entry.type !== 'user' && entry.type !== 'assistant')) continue
    if (entry.isCompactSummary) {
      items.push({ kind: 'event', key: entry.uuid, text: 'Conversation compacted' })
      continue
    }
    const content = entry.message?.content
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
    blocks.forEach((b: Record<string, any>, i: number) => {
      const key = `${entry.uuid}-${i}`
      if (b.type === 'text' && b.text?.trim()) {
        let text: string = b.text.trim()
        if (entry.type === 'user') {
          const command = text.match(/<command-name>(.*?)<\/command-name>/)?.[1]
          if (command) return items.push({ kind: 'event', key, text: command })
          if (text.startsWith('[Request interrupted by user')) return items.push({ kind: 'event', key, text: 'Interrupted' })
          text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
          if (!text || text.startsWith('<')) return
        }
        items.push({ kind: entry.type, key, text })
      } else if (b.type === 'tool_use') {
        const tool = { kind: 'tool' as const, key, id: b.id, name: b.name, input: b.input ?? {} }
        tools.set(b.id, tool)
        items.push(tool)
      } else if (b.type === 'tool_result') {
        const tool = tools.get(b.tool_use_id)
        if (tool) {
          tool.result = resultText(b.content).slice(0, 4000)
          tool.isError = !!b.is_error
        }
      } else if (b.type === 'image' && entry.type === 'user') {
        items.push({ kind: 'user', key, text: '[image]' })
      }
    })
  }
  return items.slice(-limit)
}

export async function readTranscript(transcriptPath: string): Promise<ChatItem[]> {
  try {
    return parseTranscript(await fs.readFile(transcriptPath, 'utf8'))
  } catch {
    return []
  }
}

export interface SessionChange {
  path: string
  created: boolean
  added: number
  removed: number
}

/** Files Claude edited or wrote in the session, with their content before the session's first change. */
export function collectChanges(jsonl: string): Map<string, { before: string | null; order: number }> {
  const changes = new Map<string, { before: string | null; order: number }>()
  let order = 0
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"originalFile"')) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const r = entry.toolUseResult
    if (entry.isSidechain || typeof r?.filePath !== 'string' || !('originalFile' in r)) continue
    const prev = changes.get(r.filePath)
    const before = prev ? prev.before : (r.originalFile?.replace(/\r\n/g, '\n') ?? null)
    changes.set(r.filePath, { before, order: order++ })
  }
  return changes
}

export async function sessionChanges(transcriptPath: string): Promise<SessionChange[]> {
  const jsonl = await fs.readFile(transcriptPath, 'utf8').catch(() => '')
  const changes = [...collectChanges(jsonl)].sort((a, b) => b[1].order - a[1].order)
  return Promise.all(
    changes.map(async ([path, { before }]) => {
      let added = 0
      let removed = 0
      for (const part of diffLines(before ?? '', (await readText(path)) ?? '', { ignoreNewlineAtEof: true })) {
        if (part.added) added += part.count ?? 0
        if (part.removed) removed += part.count ?? 0
      }
      return { path, created: before === null, added, removed }
    })
  )
}

export async function fileBefore(transcriptPath: string, path: string): Promise<string> {
  const jsonl = await fs.readFile(transcriptPath, 'utf8').catch(() => '')
  return collectChanges(jsonl).get(path)?.before ?? ''
}
