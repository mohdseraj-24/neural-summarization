import { screen, waitFor, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const DOC = 'Neural networks learn patterns from data. They are used for translation, vision and summarization across many industries today.'
const USER = { id: 1, name: 'Seraj Khan', email: 'seraj@example.com' }
const HEALTH_AI = { status: 'ok', mode: 'ai', api_key_configured: true, provider: 'Groq', model: 'openai/gpt-oss-120b', base_url: 'https://api.groq.com/openai/v1', database_configured: true }
const HEALTH_DEMO = { ...HEALTH_AI, mode: 'demo', api_key_configured: false, provider: null, model: null }
const SAVED_ITEM = { id: 9, input_preview: 'old input', summary: 'Saved earlier summary.', words: 50, model: 'm', created_at: '2026-10-01T10:00:00+00:00' }

const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) })

let calls
async function boot(routes, { token = null } = {}) {
  calls = []
  localStorage.clear()
  if (token) localStorage.setItem('neuralsum_token', token)
  vi.resetModules()
  document.body.innerHTML = '<div id="root"></div>'
  global.fetch = vi.fn((url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body })
    const h = routes[`${opts.method || 'GET'} ${url}`]
    return h ? h(opts) : json({ detail: 'not found' }, 404)
  })
  await import('../src/main.jsx')
  return userEvent.setup()
}
const called = (method, url) => calls.filter(c => c.method === method && c.url === url)
afterEach(() => { cleanup(); document.body.innerHTML = '' })

// Guest defaults (nobody logged in)
const guest = (over = {}) => ({
  'GET /api/health': () => json(HEALTH_AI),
  'POST /api/summarize': () => json({ summary: 'Guest summary text.', mode: 'ai', provider: 'Groq', model: 'openai/gpt-oss-120b', saved: false }),
  ...over,
})
const bootGuest = (over = {}) => boot(guest(over))
// Logged-in defaults (valid token stored)
const bootLoggedIn = (over = {}) => boot({
  'GET /api/auth/me': () => json({ user: USER }),
  'GET /api/history': () => json({ items: [] }),
  ...guest({ 'POST /api/summarize': () => json({ summary: 'Saved summary.', mode: 'ai', model: 'm', saved: true }) }),
  ...over,
}, { token: 'tok123' })

const box = () => screen.getByPlaceholderText(/Paste an article/i)
const generate = () => screen.getByRole('button', { name: /Generate Summary/i })
const openLogin = async user => { await user.click(await screen.findByRole('button', { name: 'Log in / Sign up' })); return screen.findByRole('dialog') }

// ================================================================ free for guests
it('opens straight to the free summarizer: no login screen, login button at bottom of sidebar', async () => {
  await bootGuest()
  expect(await screen.findByPlaceholderText(/Paste an article/i)).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('button', { name: 'Log in / Sign up' })).toBeTruthy()
  expect(screen.getByText('Guest')).toBeTruthy()
})

it('guest can summarize with NO token; history stays local in the tab', async () => {
  const user = await bootGuest()
  await user.type(await screen.findByPlaceholderText(/Paste an article/i), DOC)
  await user.click(generate())
  expect(await screen.findByText('Guest summary text.')).toBeTruthy()
  const post = called('POST', '/api/summarize')[0]
  expect(post.headers.Authorization).toBeUndefined()
  expect(JSON.parse(post.body)).toEqual({ text: DOC, max_sentences: 4 })
  expect(called('GET', '/api/history')).toHaveLength(0)              // never asks the server for history
  await user.click(screen.getByRole('button', { name: 'History' }))
  expect(await screen.findByText('Guest summary text.')).toBeTruthy()
  expect(screen.getByText(/Log in \(bottom-left\) to save your history/)).toBeTruthy()
  await user.click(screen.getByRole('button', { name: /Clear history/i }))
  expect(await screen.findByText(/No summaries yet/)).toBeTruthy()
  expect(called('DELETE', '/api/history')).toHaveLength(0)           // guest clear is local only
})

it('guest hourly-limit message (429) is shown to the user', async () => {
  const user = await bootGuest({ 'POST /api/summarize': () => json({ detail: 'Free limit reached (30 summaries per hour). Log in (bottom-left) to keep going without this limit.' }, 429) })
  await user.type(await screen.findByPlaceholderText(/Paste an article/i), DOC)
  await user.click(generate())
  expect(await within(await screen.findByRole('alert')).findByText(/Free limit reached/)).toBeTruthy()
})

// ================================================================ login modal
it('sidebar button opens the login modal; Close button and Escape close it', async () => {
  const user = await bootGuest()
  let dlg = await openLogin(user)
  expect(within(dlg).getByRole('button', { name: 'Log in' })).toBeTruthy()
  await user.click(within(dlg).getByRole('button', { name: 'Close' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  await openLogin(user)
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('login success: modal closes, user card appears, typed text is kept, history switches to server', async () => {
  const user = await bootGuest({
    'POST /api/auth/login': () => json({ token: 'tok-abc', user: USER }),
    'GET /api/history': () => json({ items: [SAVED_ITEM] }),
  })
  await user.type(await screen.findByPlaceholderText(/Paste an article/i), DOC)
  const dlg = await openLogin(user)
  await user.type(within(dlg).getByLabelText('Email'), 'seraj@example.com')
  await user.type(within(dlg).getByLabelText('Password'), 'password123')
  await user.click(within(dlg).getByRole('button', { name: 'Log in' }))
  expect(await screen.findByText('Seraj Khan')).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Log in / Sign up' })).toBeNull()
  expect(box().value).toBe(DOC)                                       // work in progress is not lost
  expect(localStorage.getItem('neuralsum_token')).toBe('tok-abc')
  expect(JSON.parse(called('POST', '/api/auth/login')[0].body)).toEqual({ email: 'seraj@example.com', password: 'password123' })
  await waitFor(() => expect(called('GET', '/api/history')[0].headers.Authorization).toBe('Bearer tok-abc'))
  await user.click(screen.getByRole('button', { name: 'History' }))
  expect(await screen.findByText('Saved earlier summary.')).toBeTruthy()
})

it('login failure shows the server message inside the modal and stays a guest', async () => {
  const user = await bootGuest({ 'POST /api/auth/login': () => json({ detail: 'Incorrect email or password.' }, 401) })
  const dlg = await openLogin(user)
  await user.type(within(dlg).getByLabelText('Email'), 'a@b.co')
  await user.type(within(dlg).getByLabelText('Password'), 'wrongpass1')
  await user.click(within(dlg).getByRole('button', { name: 'Log in' }))
  expect(await within(dlg).findByText('Incorrect email or password.')).toBeTruthy()
  expect(localStorage.getItem('neuralsum_token')).toBeNull()
  expect(screen.getByText('Guest')).toBeTruthy()
})

it('login while backend is down tells how to start it', async () => {
  const user = await bootGuest()
  const dlg = await openLogin(user)
  global.fetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')))
  await user.type(within(dlg).getByLabelText('Email'), 'a@b.co')
  await user.type(within(dlg).getByLabelText('Password'), 'password123')
  await user.click(within(dlg).getByRole('button', { name: 'Log in' }))
  expect(await within(dlg).findByText(/npm run dev/)).toBeTruthy()
})

it('signup: blocks short passwords locally, then creates the account and logs in', async () => {
  const user = await bootGuest({
    'POST /api/auth/signup': () => json({ token: 'tok-new', user: USER }),
    'GET /api/history': () => json({ items: [] }),
  })
  const dlg = await openLogin(user)
  await user.click(within(dlg).getByRole('button', { name: 'Sign up' }))          // toggle link
  await user.type(within(dlg).getByLabelText('Name'), 'Seraj Khan')
  await user.type(within(dlg).getByLabelText('Email'), 'seraj@example.com')
  await user.type(within(dlg).getByLabelText('Password'), 'short')
  await user.click(within(dlg).getByRole('button', { name: 'Sign up' }))
  expect(await within(dlg).findByText('Password must be at least 8 characters.')).toBeTruthy()
  expect(called('POST', '/api/auth/signup')).toHaveLength(0)
  await user.clear(within(dlg).getByLabelText('Password'))
  await user.type(within(dlg).getByLabelText('Password'), 'longenough1')
  await user.click(within(dlg).getByRole('button', { name: 'Sign up' }))
  expect(await screen.findByText('seraj@example.com')).toBeTruthy()
  expect(JSON.parse(called('POST', '/api/auth/signup')[0].body)).toEqual({ name: 'Seraj Khan', email: 'seraj@example.com', password: 'longenough1' })
  expect(localStorage.getItem('neuralsum_token')).toBe('tok-new')
})

it('signup shows "email already exists" from the server', async () => {
  const user = await bootGuest({ 'POST /api/auth/signup': () => json({ detail: 'An account with this email already exists. Try logging in.' }, 409) })
  const dlg = await openLogin(user)
  await user.click(within(dlg).getByRole('button', { name: 'Sign up' }))
  await user.type(within(dlg).getByLabelText('Name'), 'A')
  await user.type(within(dlg).getByLabelText('Email'), 'a@b.co')
  await user.type(within(dlg).getByLabelText('Password'), 'password123')
  await user.click(within(dlg).getByRole('button', { name: 'Sign up' }))
  expect(await within(dlg).findByText(/already exists/)).toBeTruthy()
})

// ================================================================ sessions
it('auto-login on refresh when a valid token is stored (site was usable meanwhile)', async () => {
  await bootLoggedIn()
  expect(await screen.findByText('Seraj Khan')).toBeTruthy()
  expect(called('GET', '/api/auth/me')[0].headers.Authorization).toBe('Bearer tok123')
  expect(screen.queryByRole('button', { name: 'Log in / Sign up' })).toBeNull()
})

it('expired stored token -> still usable as guest, notice in sidebar, token removed', async () => {
  const user = await boot(guest({ 'GET /api/auth/me': () => json({ detail: 'Your session has expired. Please log in again.' }, 401) }), { token: 'old' })
  expect(await screen.findByText('Your session has expired. Please log in again.')).toBeTruthy()
  expect(localStorage.getItem('neuralsum_token')).toBeNull()
  expect(box()).toBeTruthy()
  await user.type(box(), DOC)
  await user.click(generate())
  expect(await screen.findByText('Guest summary text.')).toBeTruthy()
})

it('logout goes back to guest mode (site stays open) and clears the token', async () => {
  const user = await bootLoggedIn()
  await user.click(await screen.findByRole('button', { name: /Log out/i }))
  expect(await screen.findByRole('button', { name: 'Log in / Sign up' })).toBeTruthy()
  expect(localStorage.getItem('neuralsum_token')).toBeNull()
  expect(box()).toBeTruthy()
  expect(screen.queryByText('Seraj Khan')).toBeNull()
})

it('session expiring mid-use: summary still shown, user is logged out with a notice', async () => {
  const user = await bootLoggedIn({ 'POST /api/summarize': () => json({ summary: 'Unsaved summary.', mode: 'ai', model: 'm', saved: false, session_expired: true }) })
  await user.type(await screen.findByPlaceholderText(/Paste an article/i), DOC)
  await user.click(generate())
  expect(await screen.findByText('Unsaved summary.')).toBeTruthy()
  expect(await screen.findByText(/session expired/i)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Log in / Sign up' })).toBeTruthy()
})

it('database problem (saved=false but session still valid): user stays logged in, summary kept locally', async () => {
  const user = await bootLoggedIn({ 'POST /api/summarize': () => json({ summary: 'Not saved because DB is down.', mode: 'ai', model: 'm', saved: false, session_expired: false }) })
  await user.type(await screen.findByPlaceholderText(/Paste an article/i), DOC)
  await user.click(generate())
  expect(await screen.findByText('Not saved because DB is down.')).toBeTruthy()
  expect(screen.getByText('Seraj Khan')).toBeTruthy()                       // still logged in
  expect(screen.queryByText(/session expired/i)).toBeNull()
  await user.click(screen.getByRole('button', { name: 'History' }))
  expect(await screen.findByText('Not saved because DB is down.')).toBeTruthy()
})

it('login when accounts are not set up shows the server explanation', async () => {
  const user = await bootGuest({ 'POST /api/auth/login': () => json({ detail: 'Accounts are not set up on this server yet. The site owner needs to add MONGODB_URI to server/.env (see the README, "MongoDB setup").' }, 503) })
  const dlg = await openLogin(user)
  await user.type(within(dlg).getByLabelText('Email'), 'a@b.co')
  await user.type(within(dlg).getByLabelText('Password'), 'password123')
  await user.click(within(dlg).getByRole('button', { name: 'Log in' }))
  expect(await within(dlg).findByText(/MONGODB_URI/)).toBeTruthy()
})

it('settings page shows the database status', async () => {
  const user = await bootGuest({ 'GET /api/health': () => json({ ...HEALTH_AI, database_configured: false }) })
  await user.click(await screen.findByRole('button', { name: 'Settings' }))
  expect(screen.getByText(/Not configured: login disabled/)).toBeTruthy()
})

// ================================================================ logged-in summarizer
it('logged in: token sent, summary saved on server, history/analytics/settings, clear via server', async () => {
  let items = []
  const user = await bootLoggedIn({
    'POST /api/summarize': () => { items = [{ ...SAVED_ITEM, id: 1, summary: 'AI summary from Groq.', words: 18 }]; return json({ summary: 'AI summary from Groq.', mode: 'ai', model: 'm', saved: true }) },
    'GET /api/history': () => json({ items }),
    'DELETE /api/history': () => { items = []; return json({ deleted: 1 }) },
  })
  await screen.findAllByText(/Groq · openai\/gpt-oss-120b/)
  expect(generate().disabled).toBe(true)
  await user.type(box(), DOC)
  expect(screen.getByText(/18 words/)).toBeTruthy()
  await user.click(generate())
  expect(await screen.findByText('AI summary from Groq.')).toBeTruthy()
  const post = called('POST', '/api/summarize')[0]
  expect(post.headers.Authorization).toBe('Bearer tok123')
  expect(screen.getByText('78%')).toBeTruthy()
  const spy = vi.spyOn(navigator.clipboard, 'writeText')
  await user.click(screen.getByRole('button', { name: /Copy/i }))
  expect(spy).toHaveBeenCalledWith('AI summary from Groq.')
  await user.click(screen.getByRole('button', { name: 'History' }))
  expect(await screen.findByText('AI summary from Groq.')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Analytics' }))
  expect(screen.getByText('Words processed')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Settings' }))
  expect(screen.getByText('Seraj Khan (seraj@example.com)')).toBeTruthy()
  expect(screen.getByText('Configured ✓')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'History' }))
  await user.click(screen.getByRole('button', { name: /Clear history/i }))
  expect(await screen.findByText(/No summaries yet/)).toBeTruthy()
  expect(called('DELETE', '/api/history')[0].headers.Authorization).toBe('Bearer tok123')
})

// ================================================================ summarizer behaviour (guest)
it('guest settings page shows "Guest (not logged in)"', async () => {
  const user = await bootGuest()
  await user.click(await screen.findByRole('button', { name: 'Settings' }))
  expect(screen.getByText('Guest (not logged in)')).toBeTruthy()
})

it('demo-mode banner + extractive note; Clear resets the editor', async () => {
  const user = await bootGuest({ 'GET /api/health': () => json(HEALTH_DEMO), 'POST /api/summarize': () => json({ summary: 'Demo summary text.', mode: 'demo', saved: false }) })
  expect(await screen.findByText(/no API key found/i)).toBeTruthy()
  await user.type(box(), DOC)
  await user.click(generate())
  await screen.findByText('Demo summary text.')
  expect(screen.getByText(/Demo mode \(extractive\)/)).toBeTruthy()
  await user.click(screen.getByRole('button', { name: /^Clear$/ }))
  expect(box().value).toBe('')
})

it('length selector is sent as max_sentences', async () => {
  const user = await bootGuest()
  await user.selectOptions(await screen.findByRole('combobox'), 'Long')
  await user.type(box(), DOC)
  await user.click(generate())
  await screen.findByText('Guest summary text.')
  expect(JSON.parse(called('POST', '/api/summarize')[0].body).max_sentences).toBe(6)
})

it('shows real API error messages (e.g. bad Groq key) and no Copy button', async () => {
  const user = await bootGuest({ 'POST /api/summarize': () => json({ detail: 'Groq rejected the API key (401). Check the key.' }, 502) })
  await user.type(await screen.findByPlaceholderText(/Paste an article/i), DOC)
  await user.click(generate())
  expect(await within(await screen.findByRole('alert')).findByText(/Groq rejected the API key/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Copy/i })).toBeNull()
})

it('shows backend-offline banner when health fails', async () => {
  await bootGuest({ 'GET /api/health': () => Promise.reject(new TypeError('Failed to fetch')) })
  expect(await screen.findByText(/npm run dev/)).toBeTruthy()
})
