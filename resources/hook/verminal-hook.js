// Claude Code hook / statusline command: forwards the payload to the Verminal pane that launched Claude.
// With --statusline it also runs the user's own statusline command (if any) and prints its output.
const net = require('net')
const { spawnSync } = require('child_process')

const pipe = process.env.VERMINAL_PIPE
const pane = process.env.VERMINAL_PANE_ID
const statusline = process.argv.includes('--statusline')

let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  if (statusline && process.env.VERMINAL_USER_STATUSLINE) {
    const r = spawnSync(process.env.VERMINAL_USER_STATUSLINE, { input, shell: true, encoding: 'utf8' })
    process.stdout.write(r.stdout ?? '')
  }
  let event
  try {
    event = JSON.parse(input)
  } catch {
    process.exit(0)
  }
  if (!pipe || !pane) process.exit(0)
  if (statusline) event.hook_event_name = 'StatusLine'
  const sock = net.connect(pipe, () => sock.end(JSON.stringify({ pane, event })))
  sock.on('error', () => process.exit(0))
  sock.on('close', () => process.exit(0))
  setTimeout(() => process.exit(0), 1000)
})
