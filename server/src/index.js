import { existsSync } from 'node:fs'
import path from 'node:path'
import { createApp, createContext } from './app.js'
import { envValue, getSettings } from './config.js'
import { defaultPaths } from './paths.js'

const paths = defaultPaths()
const ctx = createContext(paths)
const app = createApp(ctx)

const port = Number(envValue(paths.envFile, 'PORT') || 8000)
// Hosting platforms (Render, Railway...) set PORT and need the server reachable from outside the machine.
const host = envValue(paths.envFile, 'HOST') || (process.env.PORT ? '0.0.0.0' : '127.0.0.1')
const servesWebsite = existsSync(path.join(paths.clientDist, 'index.html'))

const server = app.listen(port, host, err => {
  if (err) return // Express 5 also passes startup errors here; they are handled by the 'error' listener below
  const s = getSettings(paths.envFile)
  console.log(`\n[NeuralSum] Server running at http://localhost:${port}`)
  console.log(
    s.configured
      ? `[NeuralSum] API key found -> ${s.label}, model '${s.model}'`
      : '[NeuralSum] No API key found in server/.env -> running in DEMO mode (extractive summary).',
  )
  console.log(
    ctx.store.isConfigured()
      ? '[NeuralSum] MongoDB configured -> login and saved history enabled (checking connection...)'
      : '[NeuralSum] No MONGODB_URI in server/.env -> guests only (login and saved history are disabled).',
  )
  if (ctx.store.isConfigured()) {
    ctx.store.ping().then(
      r => console.log(`[NeuralSum] MongoDB connected: database '${r.dbName}' (${r.users} users)`),
      e => console.error(`[NeuralSum] MongoDB problem: ${e.message}`),
    )
  }
  console.log(
    servesWebsite
      ? `[NeuralSum] Website is served by this server: open http://localhost:${port}`
      : '[NeuralSum] Website (dev mode): http://localhost:5173  (started by `npm run dev`)',
  )
})

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[NeuralSum] Port ${port} is already in use. Close the other program using it, or set PORT=<another number> in server/.env.`)
  } else {
    console.error('[NeuralSum] Server error:', err)
  }
  process.exit(1)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close()
    ctx.store.close().finally(() => process.exit(0))
  })
}
