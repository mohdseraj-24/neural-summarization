// Test helpers: an isolated app (own temp folder, own database) + a fake OpenAI-compatible LLM server.
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createApp, createContext } from '../src/app.js'
import { MongoStore } from '../src/store/mongo.js'
import { createMemoryStore } from './memoryStore.js'

export const TEXT =
  'Large language models can write fluent summaries of long documents. ' +
  'They read the whole text and produce new sentences that keep the key ideas. ' +
  'This saves time for students, researchers and busy professionals every day.'

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)))
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()) })

export function writeEnv(envFile, vars, encoding = 'utf8') {
  const text = Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
  if (encoding === 'utf16le') fs.writeFileSync(envFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]))
  else if (encoding === 'utf8-bom') fs.writeFileSync(envFile, '\uFEFF' + text)
  else fs.writeFileSync(envFile, text)
}

/** Starts the real app on a random port. `env` is written to a temp .env file (hot-reloaded on every request). */
/** Which database the tests use:
 *   default                 in-memory store (no setup needed)
 *   MONGODB_TEST_URI=...    a real MongoDB (fresh throw-away database per app, dropped afterwards)
 *   opts.mongo = {...}      real MongoStore with explicit settings, e.g. {} (not configured) or { uri: 'mongodb://127.0.0.1:1' } (down)  */
export const usingRealMongo = Boolean(process.env.MONGODB_TEST_URI)

function makeStore(opts) {
  if (opts.mongo) {
    const cfg = { uri: '', dbName: 'neuralsum_test', timeoutMs: 600, ...opts.mongo }
    return { store: new MongoStore(() => cfg), drop: false }
  }
  if (usingRealMongo) {
    const dbName = `neuralsum_test_${crypto.randomBytes(5).toString('hex')}`
    const store = new MongoStore(() => ({ uri: process.env.MONGODB_TEST_URI, dbName, timeoutMs: 5000 }))
    return { store, drop: true }
  }
  return { store: createMemoryStore(), drop: false }
}

export async function launch(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neuralsum-'))
  const envFile = path.join(dir, '.env')
  if (opts.env && Object.keys(opts.env).length) writeEnv(envFile, opts.env)
  const { store, drop } = makeStore(opts)
  const ctx = createContext({ envFile, dataDir: path.join(dir, 'data'), processEnv: {}, pbkdf2Iterations: opts.iterations ?? 1000, clientDist: opts.clientDist ?? null, store })
  const server = await new Promise(resolve => {
    const s = createApp(ctx).listen(0, '127.0.0.1', () => resolve(s))
  })
  const base = `http://127.0.0.1:${server.address().port}`

  async function api(method, url, { body, token, headers = {}, raw } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers }
  }
  const signup = async (email = 'a@example.com', password = 'password123', name = 'Alice') =>
    (await api('POST', '/api/auth/signup', { body: { name, email, password } }))

  return {
    ctx, envFile, dir, base, api, signup,
    setEnv: (vars, enc) => writeEnv(envFile, vars, enc),
    async close() {
      await close(server)
      if (drop) await store.run(({ db }) => db.dropDatabase()).catch(() => {})
      await store.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Fake LLM provider. handler(req) -> { status, body } | Promise. Records every request in `.requests`. */
export async function fakeLLM(handler) {
  const requests = []
  const server = http.createServer((req, res) => {
    let data = ''
    req.on('data', c => (data += c))
    req.on('end', async () => {
      let body = null
      try { body = JSON.parse(data) } catch { /* GET */ }
      const record = { method: req.method, url: req.url, headers: req.headers, body }
      requests.push(record)
      try {
        const r = await handler(record)
        res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json' })
        res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}))
      } catch {
        res.destroy()
      }
    })
  })
  await listen(server)
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => close(server) }
}

export const okReply = (content = 'A short AI summary.') => ({ status: 200, body: { choices: [{ message: { content } }] } })
