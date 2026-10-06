// MongoDB storage (users + per-user summary history) using the official `mongodb` driver.
// Works with MongoDB Atlas (free M0 cluster) or any MongoDB server.
//
// Settings come from server/.env and are re-read on every call, so editing MONGODB_URI needs no restart:
//   MONGODB_URI=mongodb+srv://user:password@cluster0.xxxxx.mongodb.net/
//   MONGODB_DB=neuralsum            (optional, default "neuralsum")
//
// Without MONGODB_URI the site still works for guests; only login/history are switched off (HTTP 503 + a clear message).
import { MongoClient, ObjectId } from 'mongodb'
import { DuplicateEmailError, HttpError } from '../errors.js'

const NOT_CONFIGURED =
  'Accounts are not set up on this server yet. The site owner needs to add MONGODB_URI to server/.env (see the README, "MongoDB setup").'

const isoDate = d => (d instanceof Date ? d : new Date(d)).toISOString()

function toObjectId(id) {
  return typeof id === 'string' && /^[0-9a-f]{24}$/i.test(id) ? new ObjectId(id) : null
}

const userOut = u => u && ({
  id: String(u._id),
  name: u.name,
  email: u.email,
  password_hash: u.passwordHash,
  created_at: isoDate(u.createdAt),
})

const historyOut = h => ({
  id: String(h._id),
  input_preview: h.inputPreview,
  summary: h.summary,
  words: h.words,
  model: h.model,
  created_at: isoDate(h.createdAt),
})

/** Turn driver errors into short messages a beginner can act on. Never includes the URI/password. */
function translate(err) {
  if (err instanceof HttpError || err instanceof DuplicateEmailError) return err
  const name = err?.name || ''
  const msg = String(err?.message || '')
  if (/auth/i.test(msg) && (err?.code === 18 || err?.code === 8000 || /authentication failed|bad auth|auth error/i.test(msg))) {
    return new HttpError(503, 'MongoDB rejected the username or password in MONGODB_URI. Check them, and URL-encode special characters in the password (for example @ becomes %40).')
  }
  if (name === 'MongoServerSelectionError' || name === 'MongoNetworkError' || name === 'MongoNetworkTimeoutError' || /ENOTFOUND|ECONNREFUSED|querySrv|getaddrinfo/i.test(msg)) {
    return new HttpError(503, 'Cannot reach the database. Check MONGODB_URI and your internet connection. On MongoDB Atlas also open Network Access and allow your IP address (or 0.0.0.0/0).')
  }
  if (name === 'MongoParseError' || name === 'MongoAPIError' || name === 'MongoInvalidArgumentError' || /invalid (scheme|connection string)|URI/i.test(msg)) {
    return new HttpError(503, 'MONGODB_URI is not valid. It should look like mongodb+srv://user:password@cluster0.xxxxx.mongodb.net/')
  }
  console.error('[NeuralSum] Database error:', err)
  return new HttpError(503, `Database error (${name || 'unknown'}). Check the server console.`)
}

export class MongoStore {
  /** @param getConfig () => ({ uri, dbName, timeoutMs }) called on every operation (hot reload of .env) */
  constructor(getConfig) {
    this.getConfig = getConfig
    this.client = null
    this.ready = null // Promise of { users, history } for the current config
    this.key = null
  }

  isConfigured() {
    return Boolean(this.getConfig().uri)
  }

  async collections() {
    const { uri, dbName, timeoutMs } = this.getConfig()
    if (!uri) throw new HttpError(503, NOT_CONFIGURED)
    if (/[<>]/.test(uri)) {
      throw new HttpError(503, 'MONGODB_URI still contains a placeholder like <db_password>. Replace it (including the < and > characters) with your real database password.')
    }
    if (!/^mongodb(\+srv)?:\/\//i.test(uri)) throw translate({ name: 'MongoParseError', message: 'Invalid scheme' })

    const key = `${uri}|${dbName}`
    if (this.ready && this.key === key) return this.ready
    await this.close()
    this.key = key
    this.ready = this.connect(uri, dbName, timeoutMs).catch(err => {
      this.ready = null
      this.key = null
      throw translate(err)
    })
    return this.ready
  }

  async connect(uri, dbName, timeoutMs) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: timeoutMs, appName: 'neuralsum' })
    this.client = client
    try {
      await client.connect()
      const db = client.db(dbName)
      const users = db.collection('users')
      const history = db.collection('history')
      await Promise.all([
        users.createIndex({ email: 1 }, { unique: true }),
        history.createIndex({ userId: 1, _id: -1 }),
      ])
      return { db, users, history }
    } catch (err) {
      this.client = null
      await client.close().catch(() => {})
      throw err
    }
  }

  async run(fn) {
    try {
      return await fn(await this.collections())
    } catch (err) {
      throw translate(err)
    }
  }

  async close() {
    const c = this.client
    this.client = null
    this.ready = null
    this.key = null
    if (c) await c.close().catch(() => {})
  }

  /** For `npm run check-db`: connects, pings, and returns small facts about the database. */
  async ping() {
    return this.run(async ({ db, users, history }) => {
      await db.command({ ping: 1 })
      return { dbName: db.databaseName, users: await users.countDocuments(), history: await history.countDocuments() }
    })
  }

  // ---------------- users ----------------
  createUser(name, email, passwordHash) {
    return this.run(async ({ users }) => {
      try {
        const r = await users.insertOne({ name, email, passwordHash, createdAt: new Date() })
        return String(r.insertedId)
      } catch (err) {
        if (err?.code === 11000) throw new DuplicateEmailError(email)
        throw err
      }
    })
  }

  getUserByEmail(email) {
    return this.run(async ({ users }) => userOut(await users.findOne({ email })))
  }

  getUser(id) {
    const oid = toObjectId(id)
    if (!oid) return Promise.resolve(null)
    return this.run(async ({ users }) => userOut(await users.findOne({ _id: oid })))
  }

  listUsers() {
    return this.run(async ({ users }) => (await users.find({}).sort({ _id: 1 }).toArray()).map(u => {
      const { password_hash, ...safe } = userOut(u) // eslint-disable-line no-unused-vars
      return safe
    }))
  }

  setPasswordHash(email, hash) {
    return this.run(async ({ users }) => (await users.updateOne({ email }, { $set: { passwordHash: hash } })).matchedCount > 0)
  }

  deleteUser(email) {
    return this.run(async ({ users, history }) => {
      const u = await users.findOne({ email })
      if (!u) return false
      await history.deleteMany({ userId: u._id })
      await users.deleteOne({ _id: u._id })
      return true
    })
  }

  // ---------------- history ----------------
  addHistory(userId, inputText, summary, words, model) {
    const oid = toObjectId(userId)
    if (!oid) return Promise.resolve(null)
    const inputPreview = inputText.split(/\s+/).filter(Boolean).join(' ').slice(0, 200)
    return this.run(async ({ history }) => {
      const r = await history.insertOne({ userId: oid, inputPreview, summary, words, model, createdAt: new Date() })
      return String(r.insertedId)
    })
  }

  listHistory(userId, limit = 50) {
    const oid = toObjectId(userId)
    if (!oid) return Promise.resolve([])
    return this.run(async ({ history }) => (await history.find({ userId: oid }).sort({ _id: -1 }).limit(limit).toArray()).map(historyOut))
  }

  clearHistory(userId) {
    const oid = toObjectId(userId)
    if (!oid) return Promise.resolve(0)
    return this.run(async ({ history }) => (await history.deleteMany({ userId: oid })).deletedCount)
  }
}

/** Store that reads its settings from server/.env (hot-reloaded) and process.env. */
export function createMongoStoreFromEnv(envValue, envFile, processEnv = process.env) {
  return new MongoStore(() => ({
    uri: envValue(envFile, 'MONGODB_URI', processEnv),
    dbName: envValue(envFile, 'MONGODB_DB', processEnv) || 'neuralsum',
    timeoutMs: Number(envValue(envFile, 'MONGODB_TIMEOUT_MS', processEnv)) || 8000,
  }))
}
