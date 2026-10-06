import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import jwt from 'jsonwebtoken'
import { createToken, guestLimitPerHour, getSecret, hashPassword, MAX_FAILED_LOGINS, verifyPassword } from '../src/auth.js'
import { getSettings } from '../src/config.js'
import { extractiveSummary } from '../src/extractive.js'
import { MAX_CHARS } from '../src/app.js'
import { fakeLLM, launch, okReply, TEXT, usingRealMongo } from './helpers.js'

// Every test registers what it opened here; afterEach shuts it all down.
const cleanups = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()() })
async function app(opts) { const a = await launch(opts); cleanups.push(() => a.close()); return a }
async function llm(handler) { const f = await fakeLLM(handler); cleanups.push(() => f.close()); return f }
/** An app wired to a fake LLM provider with a working key. */
async function withLLM(handler = okReply, extraEnv = {}) {
  const f = await llm(handler)
  const a = await app({ env: { GROQ_API_KEY: 'gsk_test-key-abcdef', LLM_BASE_URL: f.baseUrl, ...extraEnv } })
  return { a, f }
}
async function loggedIn(a, email = 'test@example.com') {
  const r = await a.signup(email)
  return r.json.token
}

describe('health & settings', () => {
  it('demo mode without a key', async () => {
    const a = await app()
    const { status, json } = await a.api('GET', '/api/health')
    assert.equal(status, 200)
    assert.deepEqual([json.status, json.mode, json.api_key_configured], ['ok', 'demo', false])
  })

  it('with a key: shows provider/model but never leaks the key', async () => {
    const a = await app({ env: { GROQ_API_KEY: 'gsk_secret-key-123456' } })
    const r = await a.api('GET', '/api/health')
    assert.equal(r.json.mode, 'ai')
    assert.equal(r.json.provider, 'Groq')
    assert.equal(r.json.model, 'openai/gpt-oss-120b')
    assert.equal(r.json.base_url, 'https://api.groq.com/openai/v1')
    assert.ok(!r.text.includes('secret'))
  })

  it('provider is detected from the key prefix; unknown prefix defaults to Groq', async () => {
    const cases = [
      ['gsk_abcdefghijklmnop', 'Groq', 'https://api.groq.com/openai/v1'],
      ['xai-abcdefghijklmnop', 'xAI Grok', 'https://api.x.ai/v1'],
      ['nvapi-abcdefghijklmnop', 'NVIDIA', 'https://integrate.api.nvidia.com/v1'],
      ['somethingelse123456', 'Groq', 'https://api.groq.com/openai/v1'],
    ]
    for (const [key, label, baseUrl] of cases) {
      const s = getSettings('/nonexistent/.env', { GROQ_API_KEY: key })
      assert.equal(s.label, label, key)
      assert.equal(s.baseUrl, baseUrl, key)
    }
  })

  it('legacy GROK_API_KEY / XAI_API_KEY names still work', () => {
    assert.equal(getSettings('/x/.env', { GROK_API_KEY: 'xai-legacy-key-12345' }).label, 'xAI Grok')
    assert.equal(getSettings('/x/.env', { XAI_API_KEY: 'xai-legacy-key-12345' }).configured, true)
  })

  it('placeholder, empty, quoted and "Bearer " keys are handled', () => {
    assert.equal(getSettings('/x/.env', { GROQ_API_KEY: 'gsk_paste_your_key_here' }).configured, false)
    assert.equal(getSettings('/x/.env', { GROQ_API_KEY: 'paste_your_key_here' }).configured, false)
    assert.equal(getSettings('/x/.env', { GROQ_API_KEY: '' }).configured, false)
    assert.equal(getSettings('/x/.env', { GROQ_API_KEY: '"gsk_quoted-key-1234"' }).apiKey, 'gsk_quoted-key-1234')
    assert.equal(getSettings('/x/.env', { GROQ_API_KEY: 'Bearer gsk_abc-key-12345' }).apiKey, 'gsk_abc-key-12345')
  })

  for (const enc of ['utf8', 'utf8-bom', 'utf16le']) {
    it(`.env is parsed (${enc}) and hot-reloaded without restart`, async () => {
      const a = await app()
      a.setEnv({ GROQ_API_KEY: '"gsk_from-file-999"', LLM_MODEL: 'some/other-model' }, enc)
      let h = (await a.api('GET', '/api/health')).json
      assert.deepEqual([h.mode, h.model, h.provider], ['ai', 'some/other-model', 'Groq'])
      a.setEnv({ GROQ_API_KEY: '' }, enc)
      h = (await a.api('GET', '/api/health')).json
      assert.equal(h.mode, 'demo')
    })
  }

  it('CORS allows the Vite dev origin and not random sites', async () => {
    const a = await app()
    const ok = await a.api('OPTIONS', '/api/summarize', { headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization' } })
    assert.equal(ok.status, 204)
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173')
    const bad = await a.api('GET', '/api/health', { headers: { Origin: 'http://evil.example' } })
    assert.equal(bad.headers.get('access-control-allow-origin'), null)
  })

  it('unknown /api route -> 404 JSON; invalid JSON -> 400', async () => {
    const a = await app()
    assert.deepEqual((await a.api('GET', '/api/nope')).json, { detail: 'Not found' })
    const r = await a.api('POST', '/api/auth/login', { raw: '{bad json', headers: { 'Content-Type': 'application/json' } })
    assert.equal(r.status, 400)
    assert.match(r.json.detail, /Invalid JSON/)
  })
})

describe('summarize (demo mode, no key)', () => {
  it('works for a guest, reports saved=false and stores nothing', async () => {
    const a = await app()
    const r = await a.api('POST', '/api/summarize', { body: { text: TEXT, max_sentences: 2 } })
    assert.equal(r.status, 200)
    assert.equal(r.json.mode, 'demo')
    assert.equal(r.json.saved, false)
    assert.ok(r.json.summary && r.json.summary_words > 0)
    assert.equal(r.json.input_words, TEXT.split(/\s+/).length)
    const token = await loggedIn(a)                     // nothing was stored for anyone
    assert.deepEqual((await a.api('GET', '/api/history', { token })).json.items, [])
  })

  it('validates input', async () => {
    const a = await app()
    const short = await a.api('POST', '/api/summarize', { body: { text: 'too short' } })
    assert.equal(short.status, 400); assert.match(short.json.detail, /at least/)
    const long = await a.api('POST', '/api/summarize', { body: { text: 'a'.repeat(MAX_CHARS + 1) } })
    assert.equal(long.status, 400); assert.match(long.json.detail, /too long/)
    for (const bad of [0, 99, 2.5, '3']) {
      const r = await a.api('POST', '/api/summarize', { body: { text: TEXT, max_sentences: bad } })
      assert.equal(r.status, 400, String(bad)); assert.match(r.json.detail, /max_sentences/)
    }
    assert.equal((await a.api('POST', '/api/summarize', { body: {} })).status, 400)
    assert.equal((await a.api('POST', '/api/summarize', { body: { text: 123 } })).status, 400)
  })

  it('extractive fallback keeps original order, respects the limit, and handles Hindi', () => {
    const text = Array.from({ length: 10 }, (_, i) => `Sentence number ${i} talks about neural summarization models today.`).join(' ')
    const out = extractiveSummary(text, 3)
    const nums = [...out.matchAll(/number (\d+)/g)].map(m => Number(m[1]))
    assert.equal(nums.length, 3)
    assert.deepEqual(nums, [...nums].sort((x, y) => x - y))
    const hindi = 'यह पहला वाक्य है और काफी लंबा है। यह दूसरा वाक्य भी काफी लंबा है। तीसरा वाक्य यहाँ पर लिखा गया है।'
    assert.ok(extractiveSummary(hindi, 1).includes('।'))
  })
})

describe('summarize with an AI provider (fake server)', () => {
  it('success, request shape (url, auth, model, temperature, prompt)', async () => {
    const { a, f } = await withLLM(() => okReply('  A short AI summary.  '))
    const r = await a.api('POST', '/api/summarize', { body: { text: TEXT, max_sentences: 3 } })
    assert.equal(r.status, 200)
    assert.equal(r.json.summary, 'A short AI summary.')
    assert.equal(r.json.mode, 'ai')
    const req = f.requests.at(-1)
    assert.equal(req.url, '/v1/chat/completions')
    assert.equal(req.headers.authorization, 'Bearer gsk_test-key-abcdef')
    assert.equal(req.body.model, 'openai/gpt-oss-120b')
    assert.equal(req.body.temperature, 0.3)
    assert.ok(req.body.messages[1].content.endsWith(TEXT))
    assert.match(req.body.messages[0].content, /at most 3 sentences/)
  })

  const errorCases = [
    [401, { error: 'Incorrect API key provided: gsk_test-key-abcdef' }, 502, /rejected the API key/],
    [403, { detail: 'Authorization failed' }, 502, /denied access/],
    [404, { error: { message: 'model not found' } }, 502, /not found/],
    [413, { error: { message: 'Request too large for model: tokens per minute' } }, 502, /too large/],
    [429, { error: 'slow down' }, 429, /rate limit/],
    [500, { error: 'boom' }, 502, /having problems/],
  ]
  for (const [status, body, expectedStatus, pattern] of errorCases) {
    it(`maps upstream ${status} -> ${expectedStatus}, never echoes the key, saves nothing`, async () => {
      const { a } = await withLLM(() => ({ status, body }), { LLM_MODEL: 'my/model' })
      const token = await loggedIn(a)
      const r = await a.api('POST', '/api/summarize', { body: { text: TEXT }, token })
      assert.equal(r.status, expectedStatus)
      assert.match(r.json.detail, pattern)
      assert.ok(!r.text.includes('gsk_test-key-abcdef'))
      assert.deepEqual((await a.api('GET', '/api/history', { token })).json.items, [])
    })
  }

  it('timeout -> 504, connection refused -> 502', async () => {
    const slow = await llm(() => new Promise(resolve => setTimeout(() => resolve(okReply()), 1500)))
    const a1 = await app({ env: { GROQ_API_KEY: 'gsk_test-key-abcdef', LLM_BASE_URL: slow.baseUrl, LLM_TIMEOUT: '0.3' } })
    const r1 = await a1.api('POST', '/api/summarize', { body: { text: TEXT } })
    assert.equal(r1.status, 504); assert.match(r1.json.detail, /longer than/)

    const dead = await fakeLLM(okReply); const deadUrl = dead.baseUrl; await dead.close()
    const a2 = await app({ env: { GROQ_API_KEY: 'gsk_test-key-abcdef', LLM_BASE_URL: deadUrl } })
    const r2 = await a2.api('POST', '/api/summarize', { body: { text: TEXT } })
    assert.equal(r2.status, 502); assert.match(r2.json.detail, /Could not connect/)
  })

  it('empty / malformed / thinking-only responses are reported; <think> blocks are stripped', async () => {
    const cases = [
      [{ status: 200, body: { choices: [{ message: { content: '' } }] } }, /empty/],
      [{ status: 200, body: { nope: 1 } }, /unexpected/],
      [{ status: 200, body: 'not json at all' }, /unexpected/],
      [{ status: 200, body: { choices: [{ message: { content: '<think>still thinking...' } }] } }, /empty/],
    ]
    for (const [reply, pattern] of cases) {
      const { a } = await withLLM(() => reply)
      const r = await a.api('POST', '/api/summarize', { body: { text: TEXT } })
      assert.equal(r.status, 502); assert.match(r.json.detail, pattern)
    }
    const { a } = await withLLM(() => okReply('<think>hidden reasoning</think>\nFinal clean summary.'))
    assert.equal((await a.api('POST', '/api/summarize', { body: { text: TEXT } })).json.summary, 'Final clean summary.')
  })

  it('content given as an array of parts is joined', async () => {
    const { a } = await withLLM(() => ({ status: 200, body: { choices: [{ message: { content: [{ text: 'Part one. ' }, { text: 'Part two.' }] } }] } }))
    assert.equal((await a.api('POST', '/api/summarize', { body: { text: TEXT } })).json.summary, 'Part one. Part two.')
  })

  it('retired default model falls back to another available model by itself', async () => {
    const used = []
    const { a } = await withLLM(req => {
      if (req.method === 'GET') return { status: 200, body: { data: [{ id: 'qwen/qwen3.6-27b' }, { id: 'whisper-large-v3' }] } }
      used.push(req.body.model)
      if (req.body.model === 'openai/gpt-oss-120b') return { status: 400, body: { error: { message: 'The model `openai/gpt-oss-120b` has been decommissioned', code: 'model_decommissioned' } } }
      return okReply()
    })
    const r = await a.api('POST', '/api/summarize', { body: { text: TEXT } })
    assert.equal(r.status, 200)
    assert.equal(r.json.model, 'qwen/qwen3.6-27b')
    assert.deepEqual(used, ['openai/gpt-oss-120b', 'qwen/qwen3.6-27b'])
  })

  it('an explicit LLM_MODEL is never replaced', async () => {
    const { a } = await withLLM(() => ({ status: 404, body: { error: 'model not found' } }), { LLM_MODEL: 'my/own-model' })
    const r = await a.api('POST', '/api/summarize', { body: { text: TEXT } })
    assert.equal(r.status, 502); assert.match(r.json.detail, /my\/own-model/)
  })
})

describe('signup & login', () => {
  it('signup returns token + user (no password), email normalized, /me works', async () => {
    const a = await app()
    const r = await a.signup('  Alice@Example.COM ')
    assert.equal(r.status, 200)
    assert.equal(r.json.user.email, 'alice@example.com')
    assert.equal(r.json.user.name, 'Alice')
    assert.ok(r.json.token)
    assert.ok(!/password|hash/i.test(r.text))
    const me = await a.api('GET', '/api/auth/me', { token: r.json.token })
    assert.equal(me.json.user.email, 'alice@example.com')
  })

  it('passwords are stored hashed (salted PBKDF2), never plain', async () => {
    const a = await app()
    await a.signup('a@example.com', 'my-secret-pass')
    const stored = (await a.ctx.store.getUserByEmail('a@example.com')).password_hash
    assert.ok(stored.startsWith('pbkdf2_sha256$') && !stored.includes('my-secret-pass'))
    assert.ok(await verifyPassword('my-secret-pass', stored))
    assert.ok(!(await verifyPassword('wrong', stored)))
    assert.notEqual(await hashPassword('x', 1000), await hashPassword('x', 1000))
  })

  it('can verify hashes created by the old Python version (same format)', async () => {
    // pbkdf2_sha256 with 1000 iterations, password "old-python-pass", produced by Python's hashlib.pbkdf2_hmac
    const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    const digest = crypto.pbkdf2Sync('old-python-pass', salt, 1000, 32, 'sha256').toString('hex')
    assert.ok(await verifyPassword('old-python-pass', `pbkdf2_sha256$1000$${salt.toString('hex')}$${digest}`))
  })

  it('signup validation messages', async () => {
    const a = await app()
    const cases = [
      [{ name: '', email: 'a@example.com', password: 'password123' }, /name/],
      [{ name: 'A', email: 'not-an-email', password: 'password123' }, /valid email/],
      [{ name: 'A', email: 'a@example.com', password: 'short' }, /at least 8/],
      [{ name: 'A', email: 'a@example.com', password: 'x'.repeat(200) }, /at most 128/],
      [{ name: 'A'.repeat(80), email: 'a@example.com', password: 'password123' }, /name/],
      [{ email: 'a@example.com', password: 'password123' }, /name/],
    ]
    for (const [body, pattern] of cases) {
      const r = await a.api('POST', '/api/auth/signup', { body })
      assert.equal(r.status, 400, JSON.stringify(body)); assert.match(r.json.detail, pattern)
    }
  })

  it('duplicate email rejected (case-insensitive)', async () => {
    const a = await app()
    assert.equal((await a.signup('a@example.com')).status, 200)
    const r = await a.signup('A@EXAMPLE.com')
    assert.equal(r.status, 409); assert.match(r.json.detail, /already exists/)
  })

  it('login: success, wrong password and unknown email give the same message', async () => {
    const a = await app()
    await a.signup('a@example.com', 'password123')
    const ok = await a.api('POST', '/api/auth/login', { body: { email: 'A@example.com', password: 'password123' } })
    assert.equal(ok.status, 200); assert.ok(ok.json.token)
    const bad = await a.api('POST', '/api/auth/login', { body: { email: 'a@example.com', password: 'nope-nope' } })
    const unknown = await a.api('POST', '/api/auth/login', { body: { email: 'ghost@example.com', password: 'password123' } })
    assert.equal(bad.status, 401); assert.equal(unknown.status, 401)
    assert.equal(bad.json.detail, 'Incorrect email or password.')
    assert.equal(unknown.json.detail, 'Incorrect email or password.')
  })

  it('login is throttled after repeated failures; a success resets the counter', async () => {
    const a = await app()
    await a.signup('a@example.com')
    const attempt = pw => a.api('POST', '/api/auth/login', { body: { email: 'a@example.com', password: pw } })
    for (let i = 0; i < MAX_FAILED_LOGINS - 1; i++) assert.equal((await attempt('bad-password')).status, 401)
    assert.equal((await attempt('password123')).status, 200)   // resets
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) assert.equal((await attempt('bad-password')).status, 401)
    const blocked = await attempt('password123')
    assert.equal(blocked.status, 429); assert.match(blocked.json.detail, /Too many/)
  })
})

describe('tokens & protected routes', () => {
  it('account routes need login; health stays public', async () => {
    const a = await app()
    for (const [m, u] of [['GET', '/api/history'], ['DELETE', '/api/history'], ['GET', '/api/auth/me']]) {
      const r = await a.api(m, u)
      assert.equal(r.status, 401, u); assert.match(r.json.detail, /log in/i)
    }
    assert.equal((await a.api('GET', '/api/health')).status, 200)
  })

  it('tampered, garbage, expired, forged and alg=none tokens are rejected', async () => {
    const a = await app()
    const token = (await a.signup()).json.token
    const me = t => a.api('GET', '/api/auth/me', { token: t })
    assert.equal((await me(token + 'x')).status, 401)
    assert.equal((await me('garbage')).status, 401)
    const secret = getSecret(a.ctx)
    const expired = jwt.sign({}, secret, { algorithm: 'HS256', subject: '1', expiresIn: -5 })
    const r = await me(expired)
    assert.equal(r.status, 401); assert.match(r.json.detail, /expired/)
    assert.equal((await me(jwt.sign({}, 'some-other-secret-value-1234567890', { subject: '1' }))).status, 401)
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
    assert.equal((await me(`${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: '1' })}.`)).status, 401)
  })

  it('token of a deleted user is rejected', async () => {
    const a = await app()
    const token = (await a.signup()).json.token
    await a.ctx.store.deleteUser('a@example.com')
    const r = await a.api('GET', '/api/auth/me', { token })
    assert.equal(r.status, 401); assert.match(r.json.detail, /no longer exists/)
  })

  it('JWT secret is auto-generated, persisted across restarts, and overridable', async () => {
    const a = await app()
    const first = getSecret(a.ctx)
    assert.ok(first.length >= 32)
    a.ctx.fileSecret = null                                  // simulate a restart: must come back from the file
    assert.equal(getSecret(a.ctx), first)
    assert.equal(fs.readFileSync(path.join(a.ctx.dataDir, 'jwt_secret.txt'), 'utf8').trim(), first)
    a.setEnv({ JWT_SECRET: 'my-own-very-long-secret-value' })
    assert.equal(getSecret(a.ctx), 'my-own-very-long-secret-value')
  })
})

describe('free use for guests + per-user history', () => {
  it('invalid token is treated as a guest, not blocked, and flagged as session_expired', async () => {
    const a = await app()
    for (const token of ['garbage', 'a.b.c']) {
      const r = await a.api('POST', '/api/summarize', { body: { text: TEXT }, token })
      assert.equal(r.status, 200); assert.equal(r.json.saved, false); assert.equal(r.json.session_expired, true)
    }
    const guest = await a.api('POST', '/api/summarize', { body: { text: TEXT } })
    assert.equal(guest.json.session_expired, false)
  })

  it('guest hourly limit applies to guests only; invalid input does not use it up', async () => {
    const a = await app({ env: { GUEST_LIMIT_PER_HOUR: '3' } })
    assert.equal((await a.api('POST', '/api/summarize', { body: { text: 'short' } })).status, 400)
    for (let i = 0; i < 3; i++) assert.equal((await a.api('POST', '/api/summarize', { body: { text: TEXT } })).status, 200)
    const r = await a.api('POST', '/api/summarize', { body: { text: TEXT } })
    assert.equal(r.status, 429); assert.match(r.json.detail, /Free limit reached/); assert.match(r.json.detail, /Log in/)
    const token = await loggedIn(a)
    for (let i = 0; i < 5; i++) assert.equal((await a.api('POST', '/api/summarize', { body: { text: TEXT }, token })).status, 200)
  })

  it('guest limit defaults to 30 and 0 means unlimited', async () => {
    const a = await app()
    assert.equal(guestLimitPerHour(a.ctx), 30)
    a.setEnv({ GUEST_LIMIT_PER_HOUR: '0' })
    for (let i = 0; i < 40; i++) assert.equal((await a.api('POST', '/api/summarize', { body: { text: TEXT } })).status, 200)
  })

  it('logged-in summaries are saved (newest first) and reported saved=true', async () => {
    const a = await app()
    const token = await loggedIn(a)
    const r1 = await a.api('POST', '/api/summarize', { body: { text: TEXT, max_sentences: 1 }, token })
    assert.equal(r1.json.saved, true)
    await a.api('POST', '/api/summarize', { body: { text: 'Second request here. ' + TEXT, max_sentences: 2 }, token })
    const items = (await a.api('GET', '/api/history', { token })).json.items
    assert.equal(items.length, 2)
    assert.ok(items[0].input_preview.startsWith('Second request'))          // newest first
    assert.ok(items[1].input_preview.startsWith('Large language models'))
    assert.ok(items[0].id && items[0].id !== items[1].id)
    assert.ok(items[0].summary && items[0].words > 0 && items[0].model === 'frequency-based')
    assert.ok(!Number.isNaN(Date.parse(items[0].created_at)))
  })

  it('history is private per user; clearing only affects your own', async () => {
    const a = await app()
    const t1 = await loggedIn(a, 'u1@example.com'), t2 = await loggedIn(a, 'u2@example.com')
    const sum = token => a.api('POST', '/api/summarize', { body: { text: TEXT }, token })
    await sum(t1); await sum(t1); await sum(t2)
    const count = async t => (await a.api('GET', '/api/history', { token: t })).json.items.length
    assert.deepEqual([await count(t1), await count(t2)], [2, 1])
    assert.equal((await a.api('DELETE', '/api/history', { token: t1 })).json.deleted, 2)
    assert.deepEqual([await count(t1), await count(t2)], [0, 1])
  })

  it('deleting a user removes their history', async () => {
    const a = await app()
    const token = await loggedIn(a)
    await a.api('POST', '/api/summarize', { body: { text: TEXT }, token })
    const uid = (await a.ctx.store.getUserByEmail('test@example.com')).id
    await a.ctx.store.deleteUser('test@example.com')
    assert.deepEqual(await a.ctx.store.listHistory(uid), [])
  })
})

describe('database problems never break the summarizer', () => {
  it('no MONGODB_URI: guests still work, login/signup explain what to do, health says so', async () => {
    const a = await app({ mongo: {} })
    const h = (await a.api('GET', '/api/health')).json
    assert.equal(h.database_configured, false)
    const g = await a.api('POST', '/api/summarize', { body: { text: TEXT } })
    assert.equal(g.status, 200); assert.equal(g.json.saved, false)
    for (const url of ['/api/auth/signup', '/api/auth/login']) {
      const r = await a.api('POST', url, { body: { name: 'A', email: 'a@example.com', password: 'password123' } })
      assert.equal(r.status, 503); assert.match(r.json.detail, /MONGODB_URI/)
    }
  })

  it('database unreachable: clear 503 for login, but a logged-in user can still summarize (as unsaved)', async () => {
    const a = await app({ mongo: { uri: 'mongodb://127.0.0.1:1' } })
    const r = await a.api('POST', '/api/auth/login', { body: { email: 'a@example.com', password: 'password123' } })
    assert.equal(r.status, 503); assert.match(r.json.detail, /Cannot reach the database/)
    assert.ok(!r.text.includes('127.0.0.1:1'))
    const token = createToken(a.ctx, '507f1f77bcf86cd799439011')            // a valid-looking session
    const s = await a.api('POST', '/api/summarize', { body: { text: TEXT }, token })
    assert.equal(s.status, 200); assert.equal(s.json.saved, false); assert.equal(s.json.session_expired, false)
    assert.equal((await a.api('GET', '/api/history', { token })).status, 503)
  })

  it('bad MONGODB_URI values get friendly messages', async () => {
    const cases = [
      ['mongodb+srv://user:<db_password>@cluster0.abc.mongodb.net/', /placeholder like <db_password>/],
      ['http://not-mongo', /not valid/],
      ['just some text', /not valid/],
    ]
    for (const [uri, pattern] of cases) {
      const a = await app({ mongo: { uri } })
      const r = await a.api('POST', '/api/auth/login', { body: { email: 'a@example.com', password: 'password123' } })
      assert.equal(r.status, 503, uri); assert.match(r.json.detail, pattern)
    }
  })
})

describe('behind a hosting proxy (Render)', () => {
  const post = (a, ip) => a.api('POST', '/api/summarize', { body: { text: TEXT }, headers: ip ? { 'X-Forwarded-For': ip } : {} })

  it('with TRUST_PROXY each visitor IP gets its own guest limit', async () => {
    const a = await app({ env: { GUEST_LIMIT_PER_HOUR: '1', TRUST_PROXY: '1' } })
    assert.equal((await post(a, '203.0.113.1')).status, 200)
    assert.equal((await post(a, '203.0.113.2')).status, 200)   // different visitor: not blocked
    assert.equal((await post(a, '203.0.113.1')).status, 429)   // same visitor: blocked
  })

  it('without it, a faked X-Forwarded-For header cannot bypass the limit', async () => {
    const a = await app({ env: { GUEST_LIMIT_PER_HOUR: '1' } })
    assert.equal((await post(a, '203.0.113.1')).status, 200)
    assert.equal((await post(a, '203.0.113.2')).status, 429)
  })
})

describe('serving the built website', () => {
  it('serves index.html and falls back to it for SPA routes, but /api stays JSON', async () => {
    const dist = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'dist-'))
    fs.writeFileSync(path.join(dist, 'index.html'), '<html><body>HELLO-SPA</body></html>')
    cleanups.push(() => fs.rmSync(dist, { recursive: true, force: true }))
    const a = await app({ clientDist: dist })
    assert.match((await a.api('GET', '/')).text, /HELLO-SPA/)
    assert.match((await a.api('GET', '/some/page')).text, /HELLO-SPA/)
    assert.equal((await a.api('GET', '/api/health')).json.status, 'ok')
    assert.equal((await a.api('GET', '/api/missing')).status, 404)
  })
})
