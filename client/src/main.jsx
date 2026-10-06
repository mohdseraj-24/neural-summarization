import React, { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrainCircuit, LayoutDashboard, FileText, History, BarChart3, Settings, ChevronRight, Copy, Check, Sparkles, Clock3, Database, Activity, Menu, X, Trash2, AlertTriangle, LogOut, LogIn } from 'lucide-react'
import './index.css'

// Empty string = same origin (Vite proxy forwards /api to the Node server). Override with VITE_API_URL.
const API = import.meta.env.VITE_API_URL || ''
const nav = [['Dashboard', LayoutDashboard], ['Summarizer', FileText], ['History', History], ['Analytics', BarChart3], ['Model', BrainCircuit], ['Settings', Settings]]
const LENGTHS = [['Short', 2], ['Medium', 4], ['Long', 6]]

const BACKEND_DOWN = 'Cannot reach the server. Open a terminal in the project folder and run: npm run dev'

function errorText(data, status) {
  const d = data && data.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d)) return d.map(x => x.msg).join(' ')
  return `Request failed (${status}).`
}

// Login token is kept in localStorage so you stay logged in after a page refresh.
const TOKEN_KEY = 'neuralsum_token'
const readToken = () => { try { return localStorage.getItem(TOKEN_KEY) } catch { return null } }
const saveToken = t => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY) } catch { /* storage blocked */ } }

// fetch wrapper: adds the login token, throws Error(message) with .status for any failure.
async function request(path, { method = 'GET', body, token } = {}) {
  let r
  try {
    r = await fetch(API + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new Error(BACKEND_DOWN)
  }
  let data = null
  try { data = await r.json() } catch { /* non-JSON body */ }
  if (!r.ok) { const e = new Error(errorText(data, r.status)); e.status = r.status; throw e }
  return data
}

// Turns /api/health into a label + colour used across the UI.
function engineInfo(h) {
  if (!h) return { label: 'Checking…', tone: 'text-slate-400', dot: 'bg-slate-400', title: 'Connecting' }
  if (!h.ok) return { label: 'Server offline', tone: 'text-red-400', dot: 'bg-red-400', title: 'SERVER OFFLINE' }
  if (h.api_key_configured) return { label: `${h.provider} · ${h.model}`, tone: 'text-emerald-400', dot: 'bg-emerald-400', title: 'MODEL ONLINE' }
  return { label: 'Demo mode · no API key', tone: 'text-amber-400', dot: 'bg-amber-400', title: 'DEMO MODE' }
}

function App({ token, user, checking, notice, onAuth, onLogout }) {
  const [page, setPage] = useState('Dashboard')
  const [text, setText] = useState('')
  const [summary, setSummary] = useState('')
  const [mode, setMode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [history, setHistory] = useState([])
  const [mobile, setMobile] = useState(false)
  const [length, setLength] = useState(4)
  const [health, setHealth] = useState(null)
  const [authOpen, setAuthOpen] = useState(false)
  const [stats, setStats] = useState({ words: 0, compression: 0, time: '—' })

  const words = text.trim() ? text.trim().split(/\s+/).length : 0

  const loadHistory = useCallback(async () => {
    if (!token) return
    try {
      const d = await request('/api/history', { token })
      setHistory(d.items)
    } catch (e) {
      if (e.status === 401) onLogout(e.message)
    }
  }, [token, onLogout])
  // Logged in: history comes from the server. Guest: history lives only in this tab.
  useEffect(() => {
    if (user) loadHistory()
    else setHistory([])
  }, [user, loadHistory])

  const clearHistory = async () => {
    if (!user) { setHistory([]); return }
    try {
      await request('/api/history', { method: 'DELETE', token })
      setHistory([])
    } catch (e) {
      if (e.status === 401) onLogout(e.message)
    }
  }

  const loadHealth = useCallback(async () => {
    try {
      const r = await fetch(API + '/api/health')
      if (!r.ok) throw new Error('bad status')
      setHealth({ ok: true, ...(await r.json()) })
    } catch {
      setHealth({ ok: false })
    }
  }, [])

  useEffect(() => {
    loadHealth()
    const t = setInterval(loadHealth, 15000)
    return () => clearInterval(t)
  }, [loadHealth])

  const summarize = async () => {
    if (!text.trim() || loading) return
    setLoading(true)
    setError('')
    const start = performance.now()
    try {
      const d = await request('/api/summarize', { method: 'POST', token, body: { text, max_sentences: length } })
      const out = d.summary.trim().split(/\s+/).length
      setSummary(d.summary)
      setMode(d.mode)
      setStats({ words, compression: words ? Math.max(0, Math.round((1 - out / words) * 100)) : 0, time: ((performance.now() - start) / 1000).toFixed(2) + 's' })
      if (d.saved) {
        loadHistory()
      } else {
        setHistory(h => [{ id: Date.now(), input_preview: text.trim().slice(0, 200), summary: d.summary, words, model: d.model, created_at: new Date().toISOString() }, ...h].slice(0, 50))
        if (d.session_expired) onLogout('Your session expired. Log in again to save your history.')
      }
      loadHealth()
    } catch (e) {
      setSummary('')
      setError(e.message)
      loadHealth()
    } finally {
      setLoading(false)
    }
  }

  const copy = () => {
    navigator.clipboard?.writeText(summary)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }
  const clear = () => { setText(''); setSummary(''); setError(''); setMode(''); setStats({ words: 0, compression: 0, time: '—' }) }

  const eng = engineInfo(health)

  return <div className="min-h-screen grid-bg">
    <div className="flex">
      <aside className={`${mobile ? 'fixed inset-y-0 left-0 z-30 flex' : 'hidden'} md:static md:z-auto md:flex w-64 min-h-screen flex-col glass border-r border-white/10`}>
        <div className="p-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-blue-600/20 border border-blue-400/30 flex items-center justify-center"><BrainCircuit className="text-blue-400" /></div>
            <div><div className="font-bold tracking-tight">NEURALSUM</div><div className="text-[10px] text-slate-500 tracking-[.22em]">AI LAB</div></div>
          </div>
          {mobile && <X onClick={() => setMobile(false)} />}
        </div>
        <div className="px-3 mt-5 space-y-1">
          {nav.map(([n, I]) => <button key={n} onClick={() => { setPage(n); setMobile(false) }} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm ${page === n ? 'bg-blue-500/10 text-blue-300 border border-blue-400/10' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}><I size={18} />{n}{n === 'Dashboard' && <ChevronRight size={14} className="ml-auto" />}</button>)}
        </div>
        <div className="mt-auto p-5 space-y-3">
          {user ? <div className="rounded-2xl bg-white/[.03] border border-white/10 p-4">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 shrink-0 rounded-full bg-blue-600/20 border border-blue-400/30 flex items-center justify-center text-sm font-semibold text-blue-300">{(user.name || '?').trim().charAt(0).toUpperCase()}</div>
              <div className="min-w-0"><div className="text-sm font-semibold truncate">{user.name}</div><div className="text-[11px] text-slate-500 truncate">{user.email}</div></div>
            </div>
            <button onClick={() => onLogout()} className="mt-3 w-full text-xs text-slate-400 hover:text-white border border-white/10 hover:bg-white/5 rounded-lg py-2 flex items-center justify-center gap-2"><LogOut size={14} /> Log out</button>
          </div> : checking ? <div className="rounded-2xl bg-white/[.03] border border-white/10 p-4 text-xs text-slate-500">Checking login…</div> : <div className="rounded-2xl bg-white/[.03] border border-white/10 p-4">
            <div className="text-sm font-semibold">Guest</div>
            <div className="text-[11px] text-slate-500 mt-1">Free to use. Log in to save your history.</div>
            {notice && <div className="text-[11px] text-amber-300 mt-2">{notice}</div>}
            <button onClick={() => { setAuthOpen(true); setMobile(false) }} className="mt-3 w-full text-xs font-semibold bg-blue-600 hover:bg-blue-500 rounded-lg py-2 flex items-center justify-center gap-2"><LogIn size={14} /> Log in / Sign up</button>
          </div>}
          <div className="rounded-2xl bg-white/[.03] border border-white/10 p-4">
            <div className={`flex items-center gap-2 text-xs font-semibold ${eng.tone}`}><Activity size={15} /> {eng.title}</div>
            <div className="text-[11px] text-slate-500 mt-2 break-words">{eng.label}</div>
          </div>
        </div>
      </aside>
      <main className="flex-1 min-w-0">
        <header className="h-16 border-b border-white/10 flex items-center justify-between px-5 md:px-8 glass sticky top-0 z-20">
          <button className="md:hidden" onClick={() => setMobile(true)}><Menu /></button>
          <div className="text-sm text-slate-400">{page} <span className="mx-2">/</span><span className="text-white">Neural Language Modeling</span></div>
          <div className={`flex items-center gap-2 text-xs ${eng.tone}`}><span className={`h-2 w-2 rounded-full animate-pulse ${eng.dot}`} /> {eng.label}</div>
        </header>
        <div className="p-5 md:p-8 max-w-[1500px] mx-auto">
          {page === 'Dashboard' || page === 'Summarizer' ? <>
            <section className="mb-7">
              <div className="inline-flex items-center gap-2 text-xs text-blue-300 border border-blue-400/20 bg-blue-400/5 rounded-full px-3 py-1.5 mb-4"><Sparkles size={13} /> {health?.ok && health.api_key_configured ? `POWERED BY ${health.provider.toUpperCase()}` : 'NEURAL SUMMARIZATION'}</div>
              <h1 className="text-3xl md:text-5xl font-extrabold tracking-tight">Abstractive Text <span className="text-blue-400">Summarization</span></h1>
              <p className="text-slate-400 mt-3 max-w-2xl">Transform long-form content into concise, human-readable summaries using neural language modeling.</p>
            </section>
            {health?.ok && !health.api_key_configured && <div className="mb-5 flex gap-3 items-start rounded-2xl border border-amber-400/20 bg-amber-400/5 text-amber-200 text-sm p-4"><AlertTriangle size={18} className="mt-0.5 shrink-0" /><div>Demo mode: no API key found, so summaries are simple extractive ones. Add <code className="text-amber-100">GROQ_API_KEY</code> to <code className="text-amber-100">server/.env</code> to get real AI summaries (no restart needed).</div></div>}
            {health && !health.ok && <div className="mb-5 flex gap-3 items-start rounded-2xl border border-red-400/20 bg-red-400/5 text-red-200 text-sm p-4"><AlertTriangle size={18} className="mt-0.5 shrink-0" /><div>{BACKEND_DOWN}</div></div>}
            <div className="grid lg:grid-cols-2 gap-5">
              <Panel title="Original document" icon={<FileText size={17} />} action={<span className="text-xs text-slate-500">{words.toLocaleString()} words</span>}>
                <textarea value={text} onChange={e => setText(e.target.value)} placeholder="Paste an article, research paper, report, or any long-form text here..." className="w-full h-[390px] bg-transparent resize-none text-sm leading-7 text-slate-300 placeholder:text-slate-600" />
                <div className="flex flex-wrap gap-3 justify-between items-center border-t border-white/10 pt-4">
                  <div className="flex items-center gap-4">
                    <button onClick={clear} className="text-xs text-slate-500 hover:text-white flex items-center gap-1"><Trash2 size={14} /> Clear</button>
                    <label className="text-xs text-slate-500 flex items-center gap-2">Length
                      <select value={length} onChange={e => setLength(Number(e.target.value))} className="bg-slate-900 border border-white/10 rounded-lg px-2 py-1 text-slate-300">
                        {LENGTHS.map(([n, v]) => <option key={v} value={v}>{n}</option>)}
                      </select>
                    </label>
                  </div>
                  <button onClick={summarize} disabled={loading || !text.trim()} className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 font-semibold text-sm flex items-center gap-2">{loading ? <><Clock3 size={16} className="animate-spin" /> Generating...</> : <><Sparkles size={16} /> Generate Summary</>}</button>
                </div>
              </Panel>
              <Panel title="AI-generated summary" icon={<Sparkles size={17} />} action={summary && <button onClick={copy} className="text-xs text-slate-400 hover:text-white flex items-center gap-1">{copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}</button>}>
                <div className="h-[390px] overflow-auto text-sm leading-7 text-slate-300">
                  {error ? <div role="alert" className="flex gap-3 items-start rounded-xl border border-red-400/20 bg-red-400/5 text-red-200 p-4"><AlertTriangle size={18} className="mt-1 shrink-0" /><div>{error}</div></div>
                    : summary ? <div><p>{summary}</p>{mode === 'demo' && <p className="mt-4 text-xs text-amber-300">Demo mode (extractive). Add your API key in server/.env for AI-written summaries.</p>}</div>
                    : <div className="h-full flex flex-col items-center justify-center text-center text-slate-600"><BrainCircuit size={42} className="mb-4 opacity-50" /><div className="text-slate-500">Your generated summary will appear here</div><div className="text-xs mt-2">{health?.ok && health.api_key_configured ? `Powered by ${health.provider}` : 'Powered by neural language models'}</div></div>}
                </div>
                <div className="grid grid-cols-3 gap-3 border-t border-white/10 pt-4"><Metric label="Input words" value={stats.words.toLocaleString()} /><Metric label="Compression" value={stats.compression + '%'} /><Metric label="Latency" value={stats.time} /></div>
              </Panel>
            </div>
            <div className="grid md:grid-cols-3 gap-4 mt-5">
              <Info icon={<Database />} title="Provider" value={health === null ? 'Checking…' : !health.ok ? '—' : health.api_key_configured ? health.provider : 'Demo (extractive)'} />
              <Info icon={<BrainCircuit />} title="Model" value={health === null ? 'Checking…' : !health.ok ? '—' : health.api_key_configured ? health.model : 'No API key'} />
              <Info icon={<Activity />} title="Inference" value={health === null ? 'Checking…' : !health.ok ? 'Server offline' : health.api_key_configured ? 'Abstractive · cloud API' : 'Local · extractive'} />
            </div>
          </> : page === 'History' ? <HistoryPage items={history} onClear={clearHistory} loggedIn={!!user} /> : page === 'Analytics' ? <Analytics history={history} health={health} loggedIn={!!user} /> : <ModelPage page={page} health={health} user={user} />}
        </div>
      </main>
    </div>
    {authOpen && <AuthModal notice={notice} onClose={() => setAuthOpen(false)} onAuth={d => { setAuthOpen(false); onAuth(d) }} />}
  </div>
}

function Panel({ title, icon, action, children }) { return <div className="glass rounded-2xl p-5 shadow-2xl shadow-black/20"><div className="flex justify-between items-center mb-4"><div className="flex items-center gap-2 font-semibold">{icon}<span>{title}</span></div>{action}</div>{children}</div> }
function Metric({ label, value }) { return <div><div className="text-[10px] uppercase tracking-wider text-slate-600">{label}</div><div className="text-sm font-semibold mt-1">{value}</div></div> }
function Info({ icon, title, value }) { return <div className="glass rounded-2xl p-4 flex gap-3">{React.cloneElement(icon, { size: 20, className: 'text-blue-400' })}<div><div className="text-xs font-semibold">{title}</div><div className="text-[11px] text-slate-500 mt-1">{value}</div></div></div> }
function HistoryPage({ items, onClear, loggedIn }) {
  return <><div className="flex flex-wrap justify-between items-end gap-3"><div><h2 className="text-3xl font-bold">Summary History</h2><p className="text-slate-500 mt-2 mb-6">{loggedIn ? 'Your last summaries, saved to your account.' : 'Summaries from this tab only. Log in (bottom-left) to save your history.'}</p></div>{items.length > 0 && <button onClick={onClear} className="mb-6 text-xs text-slate-400 hover:text-white border border-white/10 hover:bg-white/5 rounded-lg px-3 py-2 flex items-center gap-2"><Trash2 size={14} /> Clear history</button>}</div>
    <div className="space-y-3">{items.length ? items.map(x => <div className="glass rounded-2xl p-5" key={x.id}><div className="flex justify-between text-xs text-slate-500"><span>{new Date(x.created_at).toLocaleString()}</span><span>{x.words} words</span></div><p className="text-xs mt-3 text-slate-500 line-clamp-1">{x.input_preview}</p><p className="text-sm mt-2 text-slate-300 line-clamp-2">{x.summary}</p></div>) : <div className="glass rounded-2xl p-12 text-center text-slate-600">No summaries yet. Generate one from the Summarizer.</div>}</div></>
}
function Analytics({ history, health, loggedIn }) { const total = history.reduce((a, x) => a + x.words, 0); return <><h2 className="text-3xl font-bold">Analytics</h2><p className="text-slate-500 mt-2 mb-6">{loggedIn ? 'Usage overview for your account (last 50 summaries).' : 'Usage overview for this tab. Log in to keep your history.'}</p><div className="grid md:grid-cols-3 gap-4"><Info icon={<FileText />} title="Documents" value={history.length} /><Info icon={<BarChart3 />} title="Words processed" value={total.toLocaleString()} /><Info icon={<Activity />} title="Model status" value={engineInfo(health).label} /></div></> }
function ModelPage({ page, health, user }) {
  const ok = health?.ok
  return <><h2 className="text-3xl font-bold">{page}</h2><p className="text-slate-500 mt-2 mb-6">NeuralSum AI system configuration (live from the server).</p>
    <div className="glass rounded-2xl p-6 space-y-5">
      <Row k="Account" v={user ? `${user.name} (${user.email})` : 'Guest (not logged in)'} />
      <Row k="Server" v={health === null ? 'Checking…' : ok ? 'Online' : 'Offline'} />
      <Row k="Mode" v={ok ? (health.api_key_configured ? 'AI summaries (cloud API)' : 'Demo (extractive)') : '—'} />
      <Row k="Provider" v={ok && health.api_key_configured ? health.provider : '—'} />
      <Row k="Model" v={ok && health.api_key_configured ? health.model : '—'} />
      <Row k="Database (login & history)" v={ok ? (health.database_configured ? 'MongoDB configured ✓' : 'Not configured: login disabled (add MONGODB_URI to server/.env)') : '—'} />
      <Row k="API key" v={ok ? (health.api_key_configured ? 'Configured ✓' : 'Missing — add GROQ_API_KEY to server/.env') : '—'} />
      <Row k="API base URL" v={ok ? health.base_url : '—'} />
    </div></>
}
function Row({ k, v }) { return <div className="flex justify-between gap-6 border-b border-white/5 pb-4 text-sm"><span className="text-slate-500">{k}</span><span className="font-medium text-right">{v}</span></div> }

function AuthModal({ onAuth, onClose, notice }) {
  const [mode, setMode] = useState('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const signup = mode === 'signup'
  const input = 'w-full rounded-xl bg-slate-900/60 border border-white/10 px-4 py-3 text-sm text-slate-200 placeholder:text-slate-600 focus:border-blue-400/50 outline-none'

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async e => {
    e.preventDefault()
    if (busy) return
    setError('')
    if (signup && password.length < 8) { setError('Password must be at least 8 characters.'); return }
    setBusy(true)
    try {
      const body = signup ? { name, email, password } : { email, password }
      const d = await request(`/api/auth/${mode}`, { method: 'POST', body })
      saveToken(d.token)
      onAuth(d)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return <div className="fixed inset-0 z-50 flex items-center justify-center p-5 bg-black/60 backdrop-blur-sm" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
    <form role="dialog" aria-modal="true" aria-label="Log in or sign up" onSubmit={submit} className="glass rounded-2xl p-7 shadow-2xl shadow-black/40 space-y-4 w-full max-w-md relative bg-slate-950/90">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute top-4 right-4 text-slate-500 hover:text-white"><X size={18} /></button>
      <div><h1 className="text-2xl font-bold">{signup ? 'Create your account' : 'Welcome back'}</h1><p className="text-sm text-slate-500 mt-1">{signup ? 'Sign up to save your summary history.' : 'Log in to save your summary history.'} The summarizer stays free either way.</p></div>
      {notice && !error && <div role="status" className="rounded-xl border border-amber-400/20 bg-amber-400/5 text-amber-200 text-sm p-3">{notice}</div>}
      {error && <div role="alert" className="flex gap-2 items-start rounded-xl border border-red-400/20 bg-red-400/5 text-red-200 text-sm p-3"><AlertTriangle size={16} className="mt-0.5 shrink-0" /><div>{error}</div></div>}
      {signup && <div><label htmlFor="name" className="text-xs text-slate-400">Name</label><input id="name" className={input + ' mt-1'} value={name} onChange={e => setName(e.target.value)} placeholder="Your name" autoComplete="name" required maxLength={60} /></div>}
      <div><label htmlFor="email" className="text-xs text-slate-400">Email</label><input id="email" type="email" className={input + ' mt-1'} value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" required /></div>
      <div><label htmlFor="password" className="text-xs text-slate-400">Password</label><input id="password" type="password" className={input + ' mt-1'} value={password} onChange={e => setPassword(e.target.value)} placeholder={signup ? 'At least 8 characters' : 'Your password'} autoComplete={signup ? 'new-password' : 'current-password'} required maxLength={128} /></div>
      <button type="submit" disabled={busy} className="w-full px-5 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 font-semibold text-sm flex items-center justify-center gap-2">{busy ? <><Clock3 size={16} className="animate-spin" /> Please wait...</> : signup ? 'Sign up' : 'Log in'}</button>
      <div className="text-center text-sm text-slate-500">{signup ? 'Already have an account?' : "Don't have an account?"} <button type="button" onClick={() => { setMode(signup ? 'login' : 'signup'); setError('') }} className="text-blue-400 hover:text-blue-300 font-medium">{signup ? 'Log in' : 'Sign up'}</button></div>
    </form>
  </div>
}

function Root() {
  const [token, setToken] = useState(readToken)
  const [user, setUser] = useState(null)
  const [checking, setChecking] = useState(() => !!readToken())
  const [notice, setNotice] = useState('')

  const logout = useCallback(msg => {
    saveToken(null)
    setToken(null)
    setUser(null)
    setNotice(typeof msg === 'string' ? msg : '')
  }, [])

  // The site is open to everyone. If a saved login exists, quietly check it in the background.
  useEffect(() => {
    if (!token || user) { setChecking(false); return }
    let alive = true
    request('/api/auth/me', { token })
      .then(d => { if (alive) setUser(d.user) })
      .catch(e => { if (alive && e.status === 401) logout(e.message) })
      .finally(() => { if (alive) setChecking(false) })
    return () => { alive = false }
  }, [token, user, logout])

  const onAuth = d => { setNotice(''); setToken(d.token); setUser(d.user) }

  return <App token={token} user={user} checking={checking} notice={notice} onAuth={onAuth} onLogout={logout} />
}

createRoot(document.getElementById('root')).render(<Root />)
