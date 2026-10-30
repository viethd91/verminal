import { app } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const file = (): string => join(app.getPath('userData'), 'state.json')

export function loadState(): unknown {
  try {
    return JSON.parse(readFileSync(file(), 'utf8'))
  } catch {
    return null
  }
}

export function saveState(state: unknown): void {
  writeFileSync(file(), JSON.stringify(state, null, 2))
}
