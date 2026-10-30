import { spawn as spawnPty, IPty } from '@lydell/node-pty'
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { userStatusLine } from './hooks'

export interface SpawnOptions {
  id: string
  cwd: string
  cols: number
  rows: number
  initCmd?: string
}

export interface ShellEnv {
  resDir: string
  pipe: string
  hooksFile: string
}

const ptys = new Map<string, IPty>()

const INHERITED_SESSION_VARS = [
  'CLAUDECODE',
  'AI_AGENT',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN'
]

function findOnPath(name: string, excludeDir?: string): string | undefined {
  try {
    return execFileSync('where', [name], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !(excludeDir && l.toLowerCase().startsWith(excludeDir.toLowerCase())))
  } catch {
    return undefined
  }
}

let shell: string
let realClaude: string | undefined
let baseEnv: ShellEnv

export function initPty(env: ShellEnv): void {
  shell = findOnPath('pwsh.exe') ?? 'powershell.exe'
  // started from a Verminal pane, PATH leads to that Verminal's shim rather than to Claude
  realClaude = process.env.VERMINAL_REAL_CLAUDE || findOnPath('claude', join(env.resDir, 'bin'))
  baseEnv = env
}

export function spawn(
  opts: SpawnOptions,
  onData: (data: string) => void,
  onExit: (code: number) => void
): void {
  const initScript = join(baseEnv.resDir, 'hook', 'init.ps1')
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${join(baseEnv.resDir, 'bin')};${process.env.PATH ?? ''}`,
    VERMINAL_PIPE: baseEnv.pipe,
    VERMINAL_PANE_ID: opts.id,
    VERMINAL_HOOKS: baseEnv.hooksFile,
    VERMINAL_REAL_CLAUDE: realClaude ?? '',
    VERMINAL_INIT_CMD: opts.initCmd ?? '',
    VERMINAL_USER_STATUSLINE: userStatusLine() ?? '',
    TERM_PROGRAM: 'verminal',
    COLORTERM: 'truecolor'
  }
  // Markers of an enclosing Claude Code session (when Verminal itself was started from one) would make
  // Claude in the pane behave as a child session, e.g. without saving transcripts.
  for (const key of INHERITED_SESSION_VARS) delete env[key]
  // run the init script's text rather than the file, so it loads whatever the machine's execution policy is
  const init = `. ([scriptblock]::Create([IO.File]::ReadAllText('${initScript}')))`
  const pty = spawnPty(shell, ['-NoLogo', '-NoExit', '-Command', init], {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: existsSync(opts.cwd) ? opts.cwd : process.env.USERPROFILE,
    env,
    useConpty: true
  })
  ptys.set(opts.id, pty)
  pty.onData(onData)
  pty.onExit(({ exitCode }) => {
    ptys.delete(opts.id)
    onExit(exitCode)
  })
}

export function write(id: string, data: string): void {
  ptys.get(id)?.write(data)
}

export function resize(id: string, cols: number, rows: number): void {
  try {
    ptys.get(id)?.resize(cols, rows)
  } catch {
    // the pty may already have exited
  }
}

export function kill(id: string): void {
  ptys.get(id)?.kill()
  ptys.delete(id)
}

export function killAll(): void {
  for (const id of [...ptys.keys()]) kill(id)
}
