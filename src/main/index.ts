import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, shell } from 'electron'
import { execFile } from 'child_process'
import { mkdirSync, statSync, writeFileSync } from 'fs'
import { homedir, release, tmpdir } from 'os'
import { join } from 'path'
import * as pty from './pty'
import * as files from './files'
import { fileBefore, listSessions, readTranscript, readUsage, sessionChanges, trustFolder } from './claude'
import { startHookServer, writeHooksSettings } from './hooks'
import { loadState, saveState } from './store'

const resDir = app.isPackaged ? join(process.resourcesPath, 'res') : join(app.getAppPath(), 'resources')
const pipe = `\\\\.\\pipe\\verminal-${process.pid}`
const hooksFile = join(app.getPath('userData'), 'hooks.json')

const TITLEBAR_HEIGHT = 30

let win: BrowserWindow
let quitting = false

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Folder passed on the command line, e.g. by the Explorer "Open with Verminal" menu. */
function folderArg(argv: string[]): string | undefined {
  return argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-') && isDir(a))
}

let initialFolder = folderArg(process.argv)

/** Adds "Open with Verminal" to the Explorer menu of folders and folder backgrounds (current user only). */
function registerExplorerMenu(): void {
  const exe = process.env.PORTABLE_EXECUTABLE_FILE ?? process.execPath
  for (const base of ['Directory', 'Directory\\Background']) {
    const key = `HKCU\\Software\\Classes\\${base}\\shell\\Verminal`
    execFile('reg', ['add', key, '/ve', '/d', 'Open with Verminal', '/f'])
    execFile('reg', ['add', key, '/v', 'Icon', '/d', exe, '/f'])
    execFile('reg', ['add', `${key}\\command`, '/ve', '/d', `"${exe}" "%V"`, '/f'])
  }
}

function send(channel: string, ...args: unknown[]): void {
  if (!win.isDestroyed()) win.webContents.send(channel, ...args)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#14161b',
    title: 'Verminal',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1b1e25', symbolColor: '#d8dae0', height: TITLEBAR_HEIGHT },
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  win.on('focus', () => win.flashFrame(false))
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault()
    if (/^https?:/.test(url)) shell.openExternal(url)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

function registerIpc(): void {
  ipcMain.handle('pty:spawn', (_e, opts: pty.SpawnOptions) =>
    pty.spawn(
      opts,
      (data) => send('pty:data', opts.id, data),
      (code) => send('pty:exit', opts.id, code)
    )
  )
  ipcMain.on('pty:write', (_e, id: string, data: string) => pty.write(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => pty.resize(id, cols, rows))
  ipcMain.on('pty:kill', (_e, id: string) => pty.kill(id))

  ipcMain.handle('state:load', () => loadState())
  ipcMain.handle('state:save', (_e, state: unknown) => saveState(state))

  ipcMain.handle('clipboard:saveImage', async () => {
    for (const item of await clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'))
      if (!type) continue
      const blob = (await item.getType(type)) as Blob
      const dir = join(tmpdir(), 'verminal')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `paste-${Date.now()}.${type.split('/')[1].replace('jpeg', 'jpg')}`)
      writeFileSync(file, Buffer.from(await blob.arrayBuffer()))
      return file
    }
    return null
  })
  ipcMain.on('clipboard:writeText', (_e, text: string) => clipboard.writeText(text))

  ipcMain.on('notify', (_e, paneId: string, title: string, body: string) => {
    if (!win.isFocused()) win.flashFrame(true)
    const n = new Notification({ title, body })
    n.on('click', () => {
      win.show()
      win.focus()
      send('pane:focus', paneId)
    })
    n.show()
  })

  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (r.canceled) return null
    await trustFolder(r.filePaths[0]).catch(() => {})
    return r.filePaths[0]
  })
  ipcMain.handle('app:initialFolder', async () => {
    const dir = initialFolder
    initialFolder = undefined
    if (dir) await trustFolder(dir).catch(() => {})
    return dir ?? null
  })

  ipcMain.handle('git:branch', (_e, cwd: string) => files.branch(cwd))
  ipcMain.handle('fs:list', (_e, dir: string) => files.listDir(dir))
  ipcMain.handle('fs:read', (_e, path: string) => files.readText(path))
  ipcMain.handle('fs:write', (_e, path: string, text: string) => files.writeText(path, text))
  ipcMain.handle('claude:changes', (_e, transcriptPath: string) => sessionChanges(transcriptPath))
  ipcMain.handle('claude:fileBefore', (_e, transcriptPath: string, path: string) => fileBefore(transcriptPath, path))
  ipcMain.handle('claude:sessions', (_e, cwd: string) => listSessions(cwd))
  ipcMain.handle('claude:usage', (_e, transcriptPath: string) => readUsage(transcriptPath))
  ipcMain.handle('claude:transcript', (_e, transcriptPath: string) => readTranscript(transcriptPath))

  ipcMain.on('devtools', () => win.webContents.toggleDevTools())
  ipcMain.on('theme', (_e, colors: { bg: string; bar: string; fg: string }) => {
    win.setBackgroundColor(colors.bg)
    win.setTitleBarOverlay({ color: colors.bar, symbolColor: colors.fg, height: TITLEBAR_HEIGHT })
  })
  ipcMain.on('sys:info', (e) => (e.returnValue = { osBuild: Number(release().split('.')[2]), home: homedir() }))
}

app.setAppUserModelId('com.verminal.app')
Menu.setApplicationMenu(null)

if (!app.requestSingleInstanceLock()) app.quit()

app.on('second-instance', async (_e, argv) => {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.focus()
  const dir = folderArg(argv)
  if (!dir) return
  await trustFolder(dir).catch(() => {})
  send('open-folder', dir)
})

app.whenReady().then(() => {
  writeHooksSettings(hooksFile, resDir)
  pty.initPty({ resDir, pipe, hooksFile })
  startHookServer(pipe, (paneId, event) => {
    if (!quitting) send('claude:event', paneId, event)
  })
  registerIpc()
  createWindow()
  if (app.isPackaged) registerExplorerMenu()
})

app.on('before-quit', () => {
  quitting = true
  pty.killAll()
})
app.on('window-all-closed', () => app.quit())
