import { createServer, Server } from 'net'
import { readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type HookEvent = Record<string, unknown> & { hook_event_name: string }

const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop'
]
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse'])

/**
 * Writes the settings file passed to Claude Code via `--settings`: hooks report session activity and the
 * statusline reports context and plan-limit usage. The user's own statusline keeps rendering because the
 * forwarding script runs it (see VERMINAL_USER_STATUSLINE).
 */
export function writeHooksSettings(file: string, resDir: string): void {
  const script = join(resDir, 'hook', 'verminal-hook.js').replace(/\\/g, '/')
  const hook = { type: 'command', command: `node "${script}"`, timeout: 5 }
  const hooks = Object.fromEntries(
    HOOK_EVENTS.map((name) => [
      name,
      [TOOL_EVENTS.has(name) ? { matcher: '*', hooks: [hook] } : { hooks: [hook] }]
    ])
  )
  // Claude only runs the statusline after the first interaction; the interval makes usage show up right away
  const statusLine = { type: 'command', command: `node "${script}" --statusline`, refreshInterval: 10 }
  writeFileSync(file, JSON.stringify({ hooks, statusLine }, null, 2))
}

/** The statusline command from the user's own Claude settings, if any. */
export function userStatusLine(): string | undefined {
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'))
    return settings.statusLine?.type === 'command' ? settings.statusLine.command : undefined
  } catch {
    return undefined
  }
}

export function startHookServer(
  pipe: string,
  onEvent: (paneId: string, event: HookEvent) => void
): Server {
  const server = createServer((sock) => {
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', (d) => (buf += d))
    sock.on('end', () => {
      try {
        const { pane, event } = JSON.parse(buf)
        onEvent(pane, event)
      } catch {
        // ignore malformed messages
      }
    })
    sock.on('error', () => {})
  })
  server.listen(pipe)
  return server
}
