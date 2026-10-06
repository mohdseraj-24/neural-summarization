import fs from 'node:fs'
import { parse } from 'dotenv'

export const PROVIDERS = {
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    // llama-3.3-70b-versatile was retired for Free/Developer plans on 2026-08-16.
    model: 'openai/gpt-oss-120b',
    fallbackModels: ['openai/gpt-oss-120b', 'qwen/qwen3.6-27b', 'openai/gpt-oss-20b'],
    temperature: 0.3,
    console: 'https://console.groq.com/keys',
    hint403: 'Also check that the model is enabled for your project at console.groq.com/settings/limits.',
  },
  nvidia: {
    label: 'NVIDIA',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'meta/llama-3.3-70b-instruct',
    fallbackModels: ['meta/llama-3.3-70b-instruct', 'meta/llama-3.1-70b-instruct'],
    temperature: 0.3,
    console: 'https://build.nvidia.com/settings/api-keys',
    hint403: 'Make sure the key is allowed to call the public API endpoints.',
  },
  xai: {
    label: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-4.7',
    fallbackModels: ['grok-4.7', 'grok-4.20-0309-non-reasoning'],
    temperature: null, // reasoning model: keep the request minimal
    console: 'https://console.x.ai',
    hint403: 'Check that your xAI team has credits.',
  },
}

// First non-empty one wins. GROQ_API_KEY is the main one; the others are accepted for convenience.
export const KEY_VARS = ['GROQ_API_KEY', 'LLM_API_KEY', 'NVIDIA_API_KEY', 'NGC_API_KEY', 'GROK_API_KEY', 'XAI_API_KEY']
const PLACEHOLDER = /^(gsk_|nvapi-|xai-)?(your|paste|put|insert|replace|changeme|example)/i

/** Parse server/.env. Handles UTF-8, UTF-8 with BOM and UTF-16 (Windows Notepad / PowerShell `>`). */
export function readEnvFile(envFile) {
  let raw
  try { raw = fs.readFileSync(envFile) } catch { return {} }
  let text
  if (raw[0] === 0xff && raw[1] === 0xfe) {
    text = raw.subarray(2).toString('utf16le')
  } else if (raw[0] === 0xfe && raw[1] === 0xff) {
    const b = Buffer.from(raw.subarray(2))
    text = b.subarray(0, b.length - (b.length % 2)).swap16().toString('utf16le')
  } else {
    text = raw.toString('utf8')
  }
  return parse(text.replace(/^\uFEFF/, ''))
}

/** Value of one setting: .env file wins over shell variables, so a stale shell variable can't hide the key you pasted. */
export function envValue(envFile, name, processEnv = process.env) {
  return String(readEnvFile(envFile)[name] || processEnv[name] || '').trim()
}

export function cleanKey(value) {
  let key = String(value ?? '').trim().replace(/^["']+|["']+$/g, '').trim()
  key = key.replace(/^bearer\s+/i, '').trim()
  return PLACEHOLDER.test(key) ? '' : key
}

/** Read on every request, so editing and saving .env takes effect without restarting the server. */
export function getSettings(envFile, processEnv = process.env) {
  const file = readEnvFile(envFile)
  const env = (...names) => {
    for (const n of names) {
      const v = String(file[n] || processEnv[n] || '').trim()
      if (v) return v
    }
    return ''
  }

  let apiKey = ''
  for (const v of KEY_VARS) {
    apiKey = cleanKey(env(v))
    if (apiKey) break
  }

  let provider = env('LLM_PROVIDER', 'GROK_PROVIDER').toLowerCase()
  if (!PROVIDERS[provider]) {
    if (apiKey.startsWith('nvapi-')) provider = 'nvidia'
    else if (apiKey.startsWith('xai-')) provider = 'xai'
    else provider = 'groq' // gsk_... keys (and the default)
  }
  const defaults = PROVIDERS[provider]

  let timeout = parseFloat(env('LLM_TIMEOUT', 'GROQ_TIMEOUT', 'NVIDIA_TIMEOUT', 'GROK_TIMEOUT') || '120')
  if (!Number.isFinite(timeout) || timeout <= 0) timeout = 120

  const chosenModel = env('LLM_MODEL', 'GROQ_MODEL', 'NVIDIA_MODEL', 'GROK_MODEL')
  return {
    apiKey,
    configured: Boolean(apiKey),
    provider,
    label: defaults.label,
    baseUrl: (env('LLM_BASE_URL', 'GROQ_BASE_URL', 'NVIDIA_BASE_URL', 'GROK_BASE_URL') || defaults.baseUrl).replace(/\/+$/, ''),
    model: chosenModel || defaults.model,
    modelExplicit: Boolean(chosenModel),
    timeout,
    temperature: defaults.temperature,
  }
}
