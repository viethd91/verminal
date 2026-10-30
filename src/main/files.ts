import { execFile } from 'child_process'
import { promises as fs } from 'fs'

export interface DirEntry {
  name: string
  dir: boolean
}

export function branch(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) =>
    execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, windowsHide: true }, (err, stdout) =>
      resolve(err ? undefined : stdout.trim())
    )
  )
}

export async function listDir(dir: string): Promise<DirEntry[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((e) => e.name !== '.git')
    .map((e) => ({ name: e.name, dir: e.isDirectory() }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
}

const MAX_VIEW_BYTES = 2 * 1024 * 1024

/** Text content of a file with `\n` line endings, or null when it is missing, binary or too large to show. */
export async function readText(path: string): Promise<string | null> {
  try {
    const stat = await fs.stat(path)
    if (stat.size > MAX_VIEW_BYTES) return null
    const text = await fs.readFile(path, 'utf8')
    return text.includes('\0') ? null : text.replace(/\r\n/g, '\n')
  } catch {
    return null
  }
}

/** Writes text given with `\n` line endings, keeping CRLF when the file on disk uses it. */
export async function writeText(path: string, text: string): Promise<void> {
  const current = await fs.readFile(path, 'utf8').catch(() => '')
  await fs.writeFile(path, current.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text)
}
