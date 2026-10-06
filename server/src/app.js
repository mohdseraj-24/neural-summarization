import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { authRouter, checkGuestLimit, optionalUser, requireUser } from './auth.js'
import { envValue, getSettings } from './config.js'
import { HttpError } from './errors.js'
import { extractiveSummary } from './extractive.js'
import { LLMError, summarizeWithModel } from './llm.js'
import { createMongoStoreFromEnv } from './store/mongo.js'

export const MIN_CHARS = 40
export const MAX_CHARS = 60_000

/** Everything the app needs, in one object (so tests can create isolated copies). */
export function createContext({ envFile, dataDir, clientDist = null, processEnv = process.env, pbkdf2Iterations = 600_000, store = null }) {
  return {
    envFile,
    dataDir,
    clientDist,
    processEnv,
    pbkdf2Iterations,
    store: store ?? createMongoStoreFromEnv(envValue, envFile, processEnv),
    failedLogins: new Map(),
    guestHits: new Map(),
    fileSecret: null,
  }
}

const DEFAULT_ORIGINS = 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173'

function cors(ctx) {
  return (req, res, next) => {
    const origin = req.headers.origin
    const allowed = (envValue(ctx.envFile, 'CORS_ORIGINS', ctx.processEnv) || DEFAULT_ORIGINS).split(',').map(o => o.trim()).filter(Boolean)
    if (origin && allowed.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type, Authorization')
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  }
}

export function createApp(ctx) {
  const app = express()
  app.disable('x-powered-by')
  // Behind a hosting proxy (Render sets RENDER), use the visitor's real IP from X-Forwarded-For.
  // Not enabled by default: when the server is exposed directly, that header could be faked.
  if (envValue(ctx.envFile, 'TRUST_PROXY', ctx.processEnv) === '1' || ctx.processEnv.RENDER) app.set('trust proxy', 1)
  app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next() })
  app.use(cors(ctx))
  app.use(express.json({ limit: '1mb' }))

  app.get('/api/health', (req, res) => {
    const s = getSettings(ctx.envFile, ctx.processEnv)
    res.json({
      status: 'ok',
      mode: s.configured ? 'ai' : 'demo',
      api_key_configured: s.configured,
      provider: s.configured ? s.label : null,
      model: s.configured ? s.model : null,
      base_url: s.baseUrl,
      database_configured: ctx.store.isConfigured(),
    })
  })

  app.use('/api/auth', authRouter(ctx))

  app.post('/api/summarize', optionalUser(ctx), async (req, res) => {
    const body = req.body ?? {}
    if (typeof body.text !== 'string') throw new HttpError(400, 'Please provide the text to summarize.')
    const maxSentences = body.max_sentences === undefined ? 4 : body.max_sentences
    if (!Number.isInteger(maxSentences) || maxSentences < 1 || maxSentences > 10) {
      throw new HttpError(400, 'max_sentences must be a whole number between 1 and 10.')
    }
    const text = body.text.trim()
    if (text.length < MIN_CHARS) throw new HttpError(400, `Please provide at least ${MIN_CHARS} characters.`)
    if (text.length > MAX_CHARS) {
      throw new HttpError(400, `Text is too long (${text.length.toLocaleString('en-US')} characters). Maximum is ${MAX_CHARS.toLocaleString('en-US')}.`)
    }

    if (!req.user) checkGuestLimit(ctx, req.ip || '?') // free for everyone, with a generous hourly limit for guests

    const s = getSettings(ctx.envFile, ctx.processEnv)
    const started = performance.now()
    let summary, mode, provider, model
    if (s.configured) {
      const r = await summarizeWithModel(s, text, maxSentences)
      summary = r.summary
      ;[mode, provider, model] = ['ai', s.label, r.model]
    } else {
      summary = extractiveSummary(text, maxSentences)
      ;[mode, provider, model] = ['demo', 'Demo (extractive)', 'frequency-based']
    }

    const inputWords = text.split(/\s+/).length
    let saved = false
    if (req.user) { // only logged-in users get history; a database problem must never lose the summary
      try {
        saved = Boolean(await ctx.store.addHistory(req.user.id, text, summary, inputWords, model))
      } catch (e) {
        console.error('[NeuralSum] Could not save history:', e.message)
      }
    }
    res.json({
      saved,
      session_expired: req.sessionProblem === 'invalid',
      summary,
      mode,
      provider,
      model,
      input_words: inputWords,
      summary_words: summary.split(/\s+/).length,
      latency_ms: Math.round((performance.now() - started) * 100) / 100,
    })
  })

  app.get('/api/history', requireUser(ctx), async (req, res) => {
    res.json({ items: await ctx.store.listHistory(req.user.id) })
  })

  app.delete('/api/history', requireUser(ctx), async (req, res) => {
    res.json({ deleted: await ctx.store.clearHistory(req.user.id) })
  })

  app.use('/api', (req, res) => res.status(404).json({ detail: 'Not found' }))

  // Production: after `npm run build`, this same server also serves the website (one process, one port).
  const indexHtml = ctx.clientDist && path.join(ctx.clientDist, 'index.html')
  if (indexHtml && fs.existsSync(indexHtml)) {
    app.use(express.static(ctx.clientDist))
    app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(indexHtml) : next()))
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError || err instanceof LLMError) return res.status(err.status).json({ detail: err.message })
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ detail: 'Invalid JSON in request.' })
    if (err?.type === 'entity.too.large') return res.status(413).json({ detail: 'Request is too large.' })
    console.error('[NeuralSum] Unexpected error:', err)
    res.status(500).json({ detail: 'Internal server error.' })
  })

  return app
}
