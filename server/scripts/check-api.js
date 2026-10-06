// Run `npm run check-api` to test your API key BEFORE starting the app.
// It uses the exact same code and server/.env settings as the app.
import { getSettings, readEnvFile } from '../src/config.js'
import { LLMError, listModels, summarizeWithModel } from '../src/llm.js'
import { defaultPaths } from '../src/paths.js'
import fs from 'node:fs'

const SAMPLE =
  'Artificial intelligence systems are increasingly used to summarize long documents. ' +
  'Extractive methods copy the most important sentences, while abstractive methods write ' +
  'new sentences that capture the meaning of the source. Modern large language models ' +
  'produce fluent abstractive summaries, which saves readers a lot of time.'

const mask = key => (key.length > 10 ? `${key.slice(0, 4)}...${key.slice(-4)} (${key.length} characters)` : '(too short)')

const { envFile } = defaultPaths()
const s = getSettings(envFile)
console.log(`.env file : ${envFile} (${fs.existsSync(envFile) ? 'found' : 'NOT FOUND'})`)
console.log(`Provider  : ${s.label}`)
console.log(`Base URL  : ${s.baseUrl}`)
console.log(`Model     : ${s.model}`)

if (!s.configured) {
  console.log('\nFAIL: no API key found.')
  console.log('  -> Put your key in server/.env like:  GROQ_API_KEY=gsk_xxxxxxxx')
  if (fs.existsSync(envFile) && Object.keys(readEnvFile(envFile)).length === 0) console.log('  -> The file exists but could not be read. Save it as plain text (UTF-8) with lines like NAME=value.')
  process.exit(1)
}
console.log(`API key   : ${mask(s.apiKey)}\n`)
console.log('Calling the API (this can take a few seconds)...')
try {
  const { summary, model } = await summarizeWithModel(s, SAMPLE, 2)
  console.log(`\nOK! Your key works (model used: ${model}). Sample summary:\n`)
  console.log(summary)
} catch (e) {
  if (!(e instanceof LLMError)) throw e
  console.log(`\nFAIL: ${e.message}`)
  if (e.status === 502 && e.message.includes('not found')) {
    const models = await listModels(s).catch(() => [])
    if (models.length) {
      console.log('\nModels available to your key (put one in LLM_MODEL):')
      for (const m of models) console.log('  -', m)
    }
  }
  process.exit(1)
}
