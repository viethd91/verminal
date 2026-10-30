import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron'
import type { ChatItem, SessionChange } from '../main/claude'
import type { DirEntry } from '../main/files'

function listen<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const handler = (_e: unknown, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  sys: ipcRenderer.sendSync('sys:info') as { osBuild: number; home: string },
  pty: {
    spawn: (opts: { id: string; cwd: string; cols: number; rows: number; initCmd?: string }) =>
      ipcRenderer.invoke('pty:spawn', opts),
    write: (id: string, data: string) => ipcRenderer.send('pty:write', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id: string) => ipcRenderer.send('pty:kill', id),
    onData: (cb: (id: string, data: string) => void) => listen('pty:data', cb),
    onExit: (cb: (id: string, code: number) => void) => listen('pty:exit', cb)
  },
  onClaudeEvent: (cb: (paneId: string, event: Record<string, any>) => void) => listen('claude:event', cb),
  onFocusPane: (cb: (paneId: string) => void) => listen('pane:focus', cb),
  onOpenFolder: (cb: (dir: string) => void) => listen('open-folder', cb),
  initialFolder: (): Promise<string | null> => ipcRenderer.invoke('app:initialFolder'),
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state: unknown) => ipcRenderer.invoke('state:save', state),
  saveClipboardImage: (): Promise<string | null> => ipcRenderer.invoke('clipboard:saveImage'),
  writeText: (text: string) => ipcRenderer.send('clipboard:writeText', text),
  notify: (paneId: string, title: string, body: string) => ipcRenderer.send('notify', paneId, title, body),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickFolder'),
  gitBranch: (cwd: string): Promise<string | undefined> => ipcRenderer.invoke('git:branch', cwd),
  listDir: (dir: string): Promise<DirEntry[]> => ipcRenderer.invoke('fs:list', dir),
  readFile: (path: string): Promise<string | null> => ipcRenderer.invoke('fs:read', path),
  writeFile: (path: string, text: string): Promise<void> => ipcRenderer.invoke('fs:write', path, text),
  sessionChanges: (transcriptPath: string): Promise<SessionChange[]> => ipcRenderer.invoke('claude:changes', transcriptPath),
  fileBefore: (transcriptPath: string, path: string): Promise<string> =>
    ipcRenderer.invoke('claude:fileBefore', transcriptPath, path),
  sessions: (cwd: string): Promise<{ id: string; title: string; modified: number }[]> =>
    ipcRenderer.invoke('claude:sessions', cwd),
  usage: (transcriptPath: string) => ipcRenderer.invoke('claude:usage', transcriptPath),
  transcript: (transcriptPath: string): Promise<ChatItem[]> => ipcRenderer.invoke('claude:transcript', transcriptPath),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  toggleDevtools: () => ipcRenderer.send('devtools'),
  setTheme: (colors: { bg: string; bar: string; fg: string }) => ipcRenderer.send('theme', colors),
  setZoom: (factor: number) => webFrame.setZoomFactor(factor)
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
