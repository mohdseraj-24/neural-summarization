// OpenAI-compatible chat client (Groq by default; NVIDIA and xAI Grok also work).
// Plain HTTPS call to POST {baseUrl}/chat/completions with a Bearer token, using Node's built-in fetch.
import { PROVIDERS } from './config.js'

export class LLMError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'LLMError'
    this.status = status
  }
}

export function buildMessages(text, maxSentences) {
  const system =
    'You are an expert abstractive text summarizer. Read the document and write a concise, ' +
    'faithful summary in your own words instead of copying long passages. ' +
    `Use at most ${maxSentences} sentence${maxSentences !== 1 ? 's' : ''}. ` +
    'Reply in the same language as the document. Do not add facts, opinions, headings, ' +
    "bullet points or a preamble such as 'Here is the summary'. Output only the summary text."
  return [
    { role: 'system', content: system },
    { role: 'user', content: `Summarize this document:\n\n${text}` },
  ]
}

/** Pull a readable error message out of the provider's error body (never leaks the key). */
function upstreamMessage(bodyText, apiKey) {
  let msg = ''
  try {
    const body = JSON.parse(bodyText)
    const err = body && typeof body === 'object' && !Array.isArray(body) ? (body.error ?? body) : body
    msg = err && typeof err === 'object' ? String(err.message || err.error || err.detail || '') : String(err ?? '')
  } catch {
    msg = bodyText || ''
  }
  msg = msg.split(/\s+/).filter(Boolean).join(' ').slice(0, 300)
  if (apiKey) msg = msg.split(apiKey).join('***')
  return msg
}

function isModelError(status, bodyText, s) {
  if (status === 404) return true
  return status === 400 && /model/i.test(upstreamMessage(bodyText, s.apiKey))
}

function mapHttpError(status, bodyText, s) {
  const detail = upstreamMessage(bodyText, s.apiKey)
  let text
  if (status === 401) {
    text = `${s.label} rejected the API key (401). Check that the key in server/.env is copied fully, has no extra characters, and has not been deleted or expired.`
  } else if (status === 403) {
    const p = PROVIDERS[s.provider]
    text = `${s.label} denied access (403). The key may lack permission, or the account has no access/credits. Create a fresh key at ${p.console}. ${p.hint403}`
  } else if (status === 413) {
    text = `The text is too large for your ${s.label} plan's token limit on model '${s.model}'. Try a shorter text.`
  } else if (status === 404 || (status === 400 && /model/i.test(detail))) {
    text = `Model '${s.model}' was not found or is not available for this key. Set LLM_MODEL in server/.env to a model your account can use (run \`npm run check-api\` to list them).`
  } else if (status === 429) {
    return new LLMError(429, `${s.label} rate limit or quota reached (429). Wait a bit, or check your plan/credits.` + (detail ? ` Details: ${detail}` : ''))
  } else if (status >= 500) {
    text = `${s.label} is having problems right now (${status}). Try again in a moment.`
  } else {
    text = `${s.label} returned an error (${status}).`
  }
  if (detail) text += ` Details: ${detail}`
  return new LLMError(502, text)
}

const CONNECT_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']

function networkError(e, s) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return new LLMError(504, `${s.label} took longer than ${Math.round(s.timeout)}s to answer. Try a shorter text, a faster model, or raise LLM_TIMEOUT in server/.env.`)
  }
  const code = e?.cause?.code || e?.code
  if (CONNECT_CODES.includes(code)) {
    let host = s.baseUrl
    try { host = new URL(s.baseUrl).host } catch { /* keep raw */ }
    return new LLMError(502, `Could not connect to ${host}. Check your internet connection, VPN/firewall and LLM_BASE_URL.`)
  }
  return new LLMError(502, `Network error while contacting ${s.label}: ${code || e?.name || 'Error'}`)
}

async function request(s, path, init) {
  try {
    const res = await fetch(`${s.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(s.timeout * 1000) })
    return { status: res.status, bodyText: await res.text() }
  } catch (e) {
    throw networkError(e, s)
  }
}

function postChat(s, text, maxSentences) {
  const body = { model: s.model, messages: buildMessages(text, maxSentences), stream: false }
  if (s.temperature != null) body.temperature = s.temperature
  return request(s, '/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function listModels(s) {
  const { status, bodyText } = await request(s, '/models', { headers: { Authorization: `Bearer ${s.apiKey}` } })
  if (status !== 200) throw mapHttpError(status, bodyText, s)
  try {
    return JSON.parse(bodyText).data.map(m => m.id).filter(Boolean).sort()
  } catch {
    return []
  }
}

/** If the default model was retired, pick another one the account can use (only when LLM_MODEL is unset). */
async function pickFallbackModel(s) {
  let available
  try { available = new Set(await listModels(s)) } catch { return null }
  return PROVIDERS[s.provider].fallbackModels.find(m => m !== s.model && available.has(m)) ?? null
}

function cleanContent(content) {
  if (Array.isArray(content)) content = content.map(p => (p && typeof p === 'object' ? p.text || '' : '')).join('')
  return String(content ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '') // some models print their reasoning
    .replace(/^\s*<think>[\s\S]*$/i, '')
    .trim()
}

/** Returns { summary, model } where model is the model actually used. */
export async function summarizeWithModel(s, text, maxSentences) {
  if (!s.configured) throw new LLMError(500, 'No API key configured. Add GROQ_API_KEY to server/.env')

  let res = await postChat(s, text, maxSentences)
  if (res.status !== 200 && !s.modelExplicit && isModelError(res.status, res.bodyText, s)) {
    const alt = await pickFallbackModel(s)
    if (alt) {
      s = { ...s, model: alt }
      res = await postChat(s, text, maxSentences)
    }
  }
  if (res.status !== 200) throw mapHttpError(res.status, res.bodyText, s)

  let content
  try {
    content = JSON.parse(res.bodyText).choices[0].message.content
  } catch {
    throw new LLMError(502, `${s.label} returned an unexpected response format.`)
  }
  const summary = cleanContent(content)
  if (!summary) throw new LLMError(502, `${s.label} returned an empty summary. Try again or use another model.`)
  return { summary, model: s.model }
}
