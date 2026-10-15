// Run only inside run-demo's protected environment. Retain demo lifecycle
// diagnostics, never request headers, cookies, payloads or tail credentials.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const [worker, output] = process.argv.slice(2)
if (!worker || !output || process.env.CLOUDFLARE_ACCOUNT_ID !== 'b20c0ca9cab0c2b70e13d7cf724b89bd') throw Error('RunEditRun demo tail configuration required')
const base = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${worker}/tails`
const headers = { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' }
const response = await fetch(base, { method: 'POST', headers, body: '{}' })
const result = await response.json()
if (!result.success) throw Error(`Demo tail creation failed: HTTP ${response.status}`)
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, '')
const { id, url } = result.result
let socket
try {
  socket = new WebSocket(url, 'trace-v1')
  socket.binaryType = 'arraybuffer'
  socket.addEventListener('message', event => {
    try {
      const trace = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data))
      for (const log of trace.logs ?? []) for (const message of log.message ?? []) {
        if (typeof message !== 'string' || !message.startsWith('{')) continue
        const row = JSON.parse(message)
        if (/^demo_/.test(row.event)) appendFileSync(output, JSON.stringify(row) + '\n')
      }
    } catch { /* Heartbeats and provider control messages contain no demo records. */ }
  })
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(Error('Demo tail connection failed')), { once: true })
  })
  writeFileSync(output + '.ready', new Date().toISOString() + '\n')
  console.log('Demo lifecycle tail connected')
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 25 * 60 * 1000)
    process.once('SIGTERM', () => { clearTimeout(timer); resolve() })
    process.once('SIGINT', () => { clearTimeout(timer); resolve() })
  })
} finally {
  socket?.close()
  const removed = await fetch(`${base}/${id}`, { method: 'DELETE', headers })
  if (!removed.ok) throw Error(`Demo tail removal failed: HTTP ${removed.status}`)
  console.log('Demo lifecycle tail removed')
}
