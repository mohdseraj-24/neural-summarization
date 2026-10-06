// Small admin tool (there is no email-based password reset). From the project folder:
//   npm run users -- list
//   npm run users -- reset-password you@example.com     (asks for the new password)
//   npm run users -- delete you@example.com
import readline from 'node:readline'
import { hashPassword } from '../src/auth.js'
import { envValue } from '../src/config.js'
import { defaultPaths } from '../src/paths.js'
import { createMongoStoreFromEnv } from '../src/store/mongo.js'

const USAGE = `Usage:
  npm run users -- list
  npm run users -- reset-password you@example.com
  npm run users -- delete you@example.com`

// Password prompt without echo (typed characters stay hidden). Also works when the password is piped in.
let lineReader
function prompt(question) {
  if (!process.stdin.isTTY) {
    lineReader ??= readline.createInterface({ input: process.stdin })[Symbol.asyncIterator]()
    return lineReader.next().then(r => r.value ?? '')
  }
  return new Promise(resolve => {
    process.stdout.write(question)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    let value = ''
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          process.stdin.setRawMode(false)
          process.stdin.pause()
          process.stdin.off('data', onData)
          process.stdout.write('\n')
          return resolve(value)
        }
        if (ch === '\u0003') process.exit(130)
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else value += ch
      }
    }
    process.stdin.on('data', onData)
  })
}

const { envFile } = defaultPaths()
const store = createMongoStoreFromEnv(envValue, envFile)
const [cmd, emailArg] = process.argv.slice(2)
let code = 0

try {
  if (!store.isConfigured()) {
    console.log('MONGODB_URI is not set in server/.env, so there are no accounts to manage yet.')
    code = 1
  } else if (cmd === 'list') {
    const users = await store.listUsers()
    if (!users.length) console.log('No users yet.')
    for (const u of users) console.log(`${u.id}  ${u.email.padEnd(35)} ${u.name}  (created ${u.created_at})`)
  } else if ((cmd === 'reset-password' || cmd === 'delete') && emailArg) {
    const email = emailArg.trim().toLowerCase()
    if (!(await store.getUserByEmail(email))) {
      console.log(`No user with email ${email}`)
      code = 1
    } else if (cmd === 'delete') {
      await store.deleteUser(email)
      console.log(`Deleted ${email} and their history.`)
    } else {
      const pw = await prompt('New password (min 8 chars): ')
      if ([...pw].length < 8 || [...pw].length > 128) {
        console.log('Password must be 8-128 characters.')
        code = 1
      } else if ((await prompt('Repeat password: ')) !== pw) {
        console.log('Passwords do not match.')
        code = 1
      } else {
        await store.setPasswordHash(email, await hashPassword(pw, 600_000))
        console.log(`Password updated for ${email}.`)
      }
    }
  } else {
    console.log(USAGE)
    code = 1
  }
} catch (e) {
  console.log(`FAIL: ${e.message}`)
  code = 1
}
await store.close()
process.exit(code)
