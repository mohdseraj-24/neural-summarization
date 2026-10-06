// In-memory store with the same behaviour as MongoStore. Lets `npm test` run without any database.
import crypto from 'node:crypto'
import { DuplicateEmailError } from '../src/errors.js'

const id = () => crypto.randomBytes(12).toString('hex')

export function createMemoryStore() {
  const users = []
  const history = []
  return {
    users, history, // exposed for assertions
    isConfigured: () => true,
    async createUser(name, email, passwordHash) {
      if (users.some(u => u.email === email)) throw new DuplicateEmailError(email)
      const u = { id: id(), name, email, password_hash: passwordHash, created_at: new Date().toISOString() }
      users.push(u)
      return u.id
    },
    getUserByEmail: async email => users.find(u => u.email === email) ?? null,
    getUser: async uid => users.find(u => u.id === uid) ?? null,
    listUsers: async () => users.map(({ password_hash, ...u }) => u),
    async setPasswordHash(email, hash) { const u = users.find(x => x.email === email); if (u) u.password_hash = hash; return Boolean(u) },
    async deleteUser(email) {
      const i = users.findIndex(u => u.email === email)
      if (i < 0) return false
      const [u] = users.splice(i, 1)
      for (let k = history.length - 1; k >= 0; k--) if (history[k].userId === u.id) history.splice(k, 1)
      return true
    },
    async addHistory(userId, inputText, summary, words, model) {
      const h = { id: id(), userId, input_preview: inputText.split(/\s+/).filter(Boolean).join(' ').slice(0, 200), summary, words, model, created_at: new Date().toISOString() }
      history.push(h)
      return h.id
    },
    listHistory: async (userId, limit = 50) => history.filter(h => h.userId === userId).reverse().slice(0, limit).map(({ userId: _u, ...h }) => h),
    async clearHistory(userId) {
      let n = 0
      for (let k = history.length - 1; k >= 0; k--) if (history[k].userId === userId) { history.splice(k, 1); n++ }
      return n
    },
    close: async () => {},
  }
}
