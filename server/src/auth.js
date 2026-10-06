// Signup / login with hashed passwords and JWT tokens.
//  - Passwords: PBKDF2-HMAC-SHA256 with a random salt (Node's built-in crypto, runs off the main thread).
//  - Tokens: signed JWT (HS256) sent as `Authorization: Bearer <token>`.
//  - Signing secret: JWT_SECRET from server/.env, or auto-generated once into server/data/jwt_secret.txt.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import express from 'express'
import jwt from 'jsonwebtoken'
import { envValue } from './config.js'
import { DuplicateEmailError, HttpError } from './errors.js'

const pbkdf2 = promisify(crypto.pbkdf2)

export const TOKEN_DAYS = 7
export const MAX_FAILED_LOGINS = 8
const FAIL_WINDOW_MS = 10 * 60 * 1000
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export { HttpError }
const unauthorized = message => new HttpError(401, message)

// ---------------- passwords ----------------
export async function hashPassword(password, iterations) {
  const salt = crypto.randomBytes(16)
  const digest = await pbkdf2(password, salt, iterations, 32, 'sha256')
  return `pbkdf2_sha256$${iterations}$${salt.toString('hex')}$${digest.toString('hex')}`
}

export async function verifyPassword(password, stored) {
  try {
    const [algo, iters, saltHex, digestHex] = String(stored).split('$')
    if (algo !== 'pbkdf2_sha256') return false
    const expected = Buffer.from(digestHex, 'hex')
    const digest = await pbkdf2(password, Buffer.from(saltHex, 'hex'), Number(iters), expected.length, 'sha256')
    return digest.length === expected.length && crypto.timingSafeEqual(digest, expected)
  } catch {
    return false
  }
}

// ---------------- tokens ----------------
export function getSecret(ctx) {
  const configured = envValue(ctx.envFile, 'JWT_SECRET', ctx.processEnv)
  if (configured.length >= 16) return configured
  if (ctx.fileSecret) return ctx.fileSecret
  const file = path.join(ctx.dataDir, 'jwt_secret.txt')
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (existing.length >= 32) return (ctx.fileSecret = existing)
  } catch { /* not created yet */ }
  fs.mkdirSync(ctx.dataDir, { recursive: true })
  const secret = crypto.randomBytes(48).toString('base64url')
  fs.writeFileSync(file, secret, { mode: 0o600 })
  return (ctx.fileSecret = secret)
}

export function createToken(ctx, userId) {
  return jwt.sign({}, getSecret(ctx), { algorithm: 'HS256', subject: String(userId), expiresIn: `${TOKEN_DAYS}d` })
}

async function userFromToken(ctx, token) {
  let payload
  try {
    payload = jwt.verify(token, getSecret(ctx), { algorithms: ['HS256'] })
  } catch (e) {
    if (e?.name === 'TokenExpiredError') throw unauthorized('Your session has expired. Please log in again.')
    throw unauthorized('Invalid login session. Please log in again.')
  }
  const user = await ctx.store.getUser(payload.sub)
  if (!user) throw unauthorized('This account no longer exists. Please sign up again.')
  return user
}

function bearerToken(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')
  return m ? m[1].trim() : null
}

/** Route needs a logged-in user. */
export const requireUser = ctx => async (req, res, next) => {
  const token = bearerToken(req)
  if (!token) throw unauthorized('Please log in to continue.')
  req.user = await userFromToken(ctx, token)
  next()
}

/** Route is free for everyone: req.user is the logged-in user, or null for guests.
 *  A missing, expired or invalid token (or a database outage) simply means "guest": the site stays usable.
 *  req.sessionProblem tells why: 'invalid' (token expired/bad) or 'unavailable' (database down). */
export const optionalUser = ctx => async (req, res, next) => {
  req.user = null
  req.sessionProblem = null
  const token = bearerToken(req)
  if (token) {
    try {
      req.user = await userFromToken(ctx, token)
    } catch (e) {
      req.sessionProblem = e instanceof HttpError && e.status === 401 ? 'invalid' : 'unavailable'
    }
  }
  next()
}

export const publicUser = u => ({ id: u.id, name: u.name, email: u.email })

// ---------------- free-use limit for guests (protects your API key quota) ----------------
export function guestLimitPerHour(ctx) {
  const raw = envValue(ctx.envFile, 'GUEST_LIMIT_PER_HOUR', ctx.processEnv)
  const n = parseInt(raw, 10)
  return raw && Number.isFinite(n) ? Math.max(0, n) : 30
}

/** Throws 429 when a not-logged-in visitor used up the free summaries for this hour. 0 = unlimited. */
export function checkGuestLimit(ctx, ip) {
  const limit = guestLimitPerHour(ctx)
  if (limit === 0) return
  const t = Date.now()
  const recent = (ctx.guestHits.get(ip) || []).filter(x => t - x < 3600_000)
  if (recent.length >= limit) {
    ctx.guestHits.set(ip, recent)
    throw new HttpError(429, `Free limit reached (${limit} summaries per hour). Log in (bottom-left) to keep going without this limit.`)
  }
  recent.push(t)
  ctx.guestHits.set(ip, recent)
}

// ---------------- routes ----------------
function checkThrottle(ctx, key) {
  const t = Date.now()
  const recent = (ctx.failedLogins.get(key) || []).filter(x => t - x < FAIL_WINDOW_MS)
  ctx.failedLogins.set(key, recent)
  if (recent.length >= MAX_FAILED_LOGINS) {
    throw new HttpError(429, 'Too many failed login attempts. Please wait a few minutes and try again.')
  }
}

export function authRouter(ctx) {
  const router = express.Router()
  let dummyHash // used so unknown emails take as long as wrong passwords (no user enumeration by timing)

  const needAccounts = () => {
    if (!ctx.store.isConfigured()) {
      throw new HttpError(503, 'Accounts are not set up on this server yet. The site owner needs to add MONGODB_URI to server/.env (see the README, "MongoDB setup").')
    }
  }

  router.post('/signup', async (req, res) => {
    needAccounts()
    const body = req.body ?? {}
    const name = String(body.name ?? '').split(/\s+/).filter(Boolean).join(' ')
    const email = String(body.email ?? '').trim().toLowerCase()
    const password = typeof body.password === 'string' ? body.password : ''
    if (!name || name.length > 60) throw new HttpError(400, 'Please enter your name (up to 60 characters).')
    if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, 'Please enter a valid email address.')
    if ([...password].length < 8) throw new HttpError(400, 'Password must be at least 8 characters.')
    if ([...password].length > 128) throw new HttpError(400, 'Password must be at most 128 characters.')

    let userId
    try {
      userId = await ctx.store.createUser(name, email, await hashPassword(password, ctx.pbkdf2Iterations))
    } catch (e) {
      if (e instanceof DuplicateEmailError) throw new HttpError(409, 'An account with this email already exists. Try logging in.')
      throw e
    }
    res.json({ token: createToken(ctx, userId), user: publicUser(await ctx.store.getUser(userId)) })
  })

  router.post('/login', async (req, res) => {
    needAccounts()
    const body = req.body ?? {}
    const email = String(body.email ?? '').trim().toLowerCase()
    const password = typeof body.password === 'string' ? body.password : ''
    const key = `${req.ip}|${email}`
    checkThrottle(ctx, key)

    const user = await ctx.store.getUserByEmail(email)
    dummyHash ??= await hashPassword('dummy-password-for-timing', ctx.pbkdf2Iterations)
    const ok = (await verifyPassword(password, user ? user.password_hash : dummyHash)) && user !== null
    if (!ok) {
      ctx.failedLogins.set(key, [...(ctx.failedLogins.get(key) || []), Date.now()])
      throw new HttpError(401, 'Incorrect email or password.')
    }
    ctx.failedLogins.delete(key)
    res.json({ token: createToken(ctx, user.id), user: publicUser(user) })
  })

  router.get('/me', requireUser(ctx), (req, res) => {
    res.json({ user: publicUser(req.user) })
  })

  return router
}
