import { useEffect, useRef, useState } from 'react'
import { Action, activePane, Theme, useStore } from './state'
import { detectLanguage, LANGUAGES } from './Viewer'

type Item =
  | { label: string; shortcut?: string; checked?: boolean; disabled?: boolean; run?: () => void; submenu?: Item[] }
  | 'separator'

const languageName = (id: string): string => LANGUAGES.find((l) => l.id === id)?.name ?? id

function MenuList({ items, close, sub }: { items: Item[]; close: () => void; sub?: boolean }): React.JSX.Element {
  return (
    <div className={`menu-list ${sub ? 'sub' : ''}`}>
      {items.map((item, i) =>
        item === 'separator' ? (
          <div key={i} className="menu-sep" />
        ) : (
          <div
            key={i}
            className={`menu-item ${item.disabled ? 'disabled' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation()
              if (item.disabled || item.submenu) return
              close()
              item.run?.()
            }}
          >
            <span className="menu-check">{item.checked ? '✓' : ''}</span>
            <span className="menu-label">{item.label}</span>
            <span className="menu-shortcut">{item.submenu ? '›' : item.shortcut}</span>
            {item.submenu && <MenuList items={item.submenu} close={close} sub />}
          </div>
        )
      )}
    </div>
  )
}

/** Application menu in the custom title bar. */
export function MenuBar({ run }: { run: (action: Action) => void }): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const recent = useStore((s) => s.recent)
  const files = useStore((s) => s.files)
  const sidebar = useStore((s) => s.sidebar)
  const theme = useStore((s) => s.theme)
  const language = useStore((s) => s.language)
  const viewer = useStore((s) => s.viewer)
  const cwd = useStore((s) => activePane(s)?.cwd)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(null)
    }
    const onBlur = (): void => setOpen(null)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onBlur)
    }
  }, [open])

  const { openProject, toggle } = useStore.getState()
  const setTheme = (t: Theme) => () => useStore.setState({ theme: t })
  const setLanguage = (id: string) => () => useStore.setState({ language: id })

  const menus: [string, Item[]][] = [
    [
      'File',
      [
        { label: 'New Claude Tab', shortcut: 'Ctrl+Shift+K', run: () => run('newClaudeTab') },
        { label: 'New Shell Tab', shortcut: 'Ctrl+Shift+T', run: () => run('newTab') },
        'separator',
        { label: 'Open Folder…', run: () => run('openFolder') },
        {
          label: 'Open Recent',
          submenu: recent.length
            ? recent.map((dir) => ({ label: dir, run: () => openProject(dir) }))
            : [{ label: 'No recent folders', disabled: true }]
        },
        'separator',
        { label: 'Close Pane', shortcut: 'Ctrl+Shift+W', run: () => run('closePane') },
        { label: 'Exit', run: () => window.close() }
      ]
    ],
    [
      'View',
      [
        { label: 'Files Panel', shortcut: 'Ctrl+Shift+O', checked: files, run: () => toggle('files') },
        { label: 'Project Panel', shortcut: 'Ctrl+Shift+B', checked: sidebar, run: () => toggle('sidebar') },
        'separator',
        { label: 'Toggle Chat / Terminal', shortcut: 'Ctrl+Shift+U', run: () => run('toggleView') },
        { label: 'Composer', shortcut: 'Ctrl+Shift+P', run: () => run('composer') },
        { label: 'Find', shortcut: 'Ctrl+Shift+F', run: () => run('search') },
        'separator',
        { label: 'Zoom In', shortcut: 'Ctrl+=', run: () => run('zoomIn') },
        { label: 'Zoom Out', shortcut: 'Ctrl+-', run: () => run('zoomOut') },
        { label: 'Reset Zoom', shortcut: 'Ctrl+0', run: () => run('zoomReset') },
        'separator',
        { label: 'Developer Tools', shortcut: 'Ctrl+Shift+I', run: () => run('devtools') }
      ]
    ],
    [
      'Terminal',
      [
        { label: 'Split Right', shortcut: 'Ctrl+Shift+D', run: () => run('splitRight') },
        { label: 'Split Down', shortcut: 'Ctrl+Shift+E', run: () => run('splitDown') },
        'separator',
        { label: 'Next Tab', shortcut: 'Ctrl+Tab', run: () => run('nextTab') },
        { label: 'Previous Tab', shortcut: 'Ctrl+Shift+Tab', run: () => run('prevTab') },
        { label: 'Jump to Waiting Claude', shortcut: 'Ctrl+Shift+J', run: () => run('jumpWaiting') }
      ]
    ],
    [
      'Language',
      [
        {
          label: viewer ? `Auto Detect (${languageName(detectLanguage(viewer.path))})` : 'Open a file to choose its language',
          checked: !!viewer && language === 'auto',
          disabled: !viewer,
          run: setLanguage('auto')
        },
        'separator',
        ...LANGUAGES.map((l) => ({
          label: l.name,
          checked: !!viewer && language === l.id,
          disabled: !viewer,
          run: setLanguage(l.id)
        }))
      ]
    ],
    [
      'Theme',
      [
        { label: 'Dark', checked: theme === 'dark', run: setTheme('dark') },
        { label: 'Light', checked: theme === 'light', run: setTheme('light') },
        { label: 'Follow System', checked: theme === 'system', run: setTheme('system') }
      ]
    ]
  ]

  return (
    <div className="menubar" ref={ref}>
      <span className="menubar-app">Verminal</span>
      {menus.map(([name, items]) => (
        <div key={name} className="menu">
          <button
            className={`menu-title ${open === name ? 'open' : ''}`}
            onMouseDown={(e) => {
              e.preventDefault()
              setOpen(open === name ? null : name)
            }}
            onMouseEnter={() => open && setOpen(name)}
          >
            {name}
          </button>
          {open === name && <MenuList items={items} close={() => setOpen(null)} />}
        </div>
      ))}
      <span className="menubar-path">{cwd}</span>
    </div>
  )
}
