// Run `npm run check-db` to test your MongoDB connection BEFORE starting the app.
// It uses the exact same code and server/.env settings as the app.
import fs from 'node:fs'
import { envValue } from '../src/config.js'
import { defaultPaths } from '../src/paths.js'
import { createMongoStoreFromEnv } from '../src/store/mongo.js'

const { envFile } = defaultPaths()
const store = createMongoStoreFromEnv(envValue, envFile)
const cfg = store.getConfig()

// show where it connects, never the password
const mask = uri => uri.replace(/\/\/([^:@/]+):([^@]*)@/, '//$1:****@')
console.log(`.env file : ${envFile} (${fs.existsSync(envFile) ? 'found' : 'NOT FOUND'})`)
console.log(`Database  : ${cfg.dbName}`)
console.log(`URI       : ${cfg.uri ? mask(cfg.uri) : '(not set)'}`)

if (!cfg.uri) {
  console.log('\nFAIL: MONGODB_URI is not set.')
  console.log('  -> Put it in server/.env like:  MONGODB_URI=mongodb+srv://user:password@cluster0.xxxxx.mongodb.net/')
  process.exit(1)
}
console.log('\nConnecting (this can take a few seconds)...')
try {
  const r = await store.ping()
  console.log(`\nOK! MongoDB works. Database '${r.dbName}' has ${r.users} user(s) and ${r.history} saved summaries.`)
  await store.close()
} catch (e) {
  console.log(`\nFAIL: ${e.message}`)
  await store.close()
  process.exit(1)
}
