# NeuralSum AI (Node.js + MongoDB)

Free text summarizer. **Node.js + Express** server, **React + Vite + Tailwind** website, **MongoDB** for accounts and history.
Summaries are written by the **Groq API** (console.groq.com). Without an API key the site still runs in a simple
*demo mode* (extractive summary). Without MongoDB the site works for guests; only login and saved history are off.
NVIDIA (`nvapi-...`) and xAI Grok (`xai-...`) keys also work: the provider is detected from the key prefix.

You need **Node.js 22.13 or newer** (LTS from <https://nodejs.org>). No Python needed.

## 1. Install (once)
Run in the folder that contains `package.json` (the project root, not `server`):
```bash
npm install
```

## 2. Add your Groq API key
1. Create a key at <https://console.groq.com/keys> (starts with `gsk_`; Groq shows it only once).
2. Create `server/.env` (copy `server/.env.example`) and paste the key:
   ```
   GROQ_API_KEY=gsk_your-real-key
   ```
   No quotes, no spaces around `=`. The file must be named exactly `.env` (not `.env.txt`).
3. Test it: `npm run check-api` (prints `OK! Your key works`, or the exact reason it failed).

Editing `server/.env` later needs no restart. Never share or commit it (it is in `.gitignore`).

## 3. MongoDB setup (for login + saved history)
Skip this step if you only want the free guest summarizer.
1. Go to <https://www.mongodb.com/atlas>, sign up, and create a **free cluster (M0)**.
2. **Database Access** > Add Database User: pick a username and a simple password (letters and numbers avoid URL-encoding problems).
3. **Network Access** > Add IP Address: *Add Current IP* for local use. For hosting on Render (free plan has no fixed IP) use `0.0.0.0/0`.
4. **Connect** > **Drivers** > copy the connection string. Replace `<db_password>` (including the `< >`) with your password.
5. Paste it into `server/.env`:
   ```
   MONGODB_URI=mongodb+srv://myuser:mypassword@cluster0.abcde.mongodb.net/
   ```
6. Test it: `npm run check-db` (prints `OK! MongoDB works`, or the exact reason it failed).

Collections (`users`, `history`) and their indexes are created automatically. The database name is `neuralsum` (change with `MONGODB_DB`).
A local MongoDB also works: `MONGODB_URI=mongodb://127.0.0.1:27017`.

## 4. Run
**Development** (server + website together, auto-reload): `npm run dev`, then open <http://localhost:5173>. Stop with `Ctrl + C`.

**Production** (one process, one port): `npm run build`, then `npm start`, then open <http://localhost:8000>.

**In the background** (after `npm run build`):
- Windows PowerShell: `Start-Process -WindowStyle Hidden -FilePath npm.cmd -ArgumentList "start" -RedirectStandardOutput server.log -RedirectStandardError server.err`
  Stop: `netstat -ano | findstr :8000` then `taskkill /PID <number> /F`
- macOS / Linux: `nohup npm start > server.log 2>&1 &`   Stop: `pkill -f "src/start.js"`

The sidebar shows live status: green = AI connected, amber = demo mode (no key), red = server not running.
The Settings page shows whether the API key and the database are configured.

## Free to use + optional login
The summarizer is **free for everyone, no login needed**. Login is optional: **Log in / Sign up** is at the **bottom-left of the sidebar**.

| | Guest | Logged in |
|---|---|---|
| Summarize | Yes (30 per hour) | Yes, no limit |
| History | Only in the open tab | Saved to your account (MongoDB), on any device |

- Sign up needs a name, email and a password of at least 8 characters. Sessions last 7 days.
- Passwords are stored only as salted PBKDF2 hashes. If MongoDB is down, summaries still work; they are just not saved.
- The token-signing secret comes from `JWT_SECRET`, or is generated into `server/data/jwt_secret.txt` (keep it private, it is git-ignored).
- 8 wrong passwords within 10 minutes temporarily block that email.
- No email-based reset. Admin tool (from the project folder):
  ```bash
  npm run users -- list
  npm run users -- reset-password you@example.com
  npm run users -- delete you@example.com
  ```
- Accounts from the old SQLite version are **not** migrated: those users must sign up again.

## Deploy (GitHub, Render, Vercel)

### 1) Push to GitHub
Run inside the `neural-summarization` folder (the folder with `package.json` must be the repo root).
Keep the project **outside OneDrive** (for example `C:\projects\`): OneDrive can corrupt `.git` and slows down `node_modules`.
```bash
git init
git add .
git status        # CHECK: server/.env, node_modules and server/data must NOT be listed
git commit -m "NeuralSum AI"
git branch -M main
git remote add origin https://github.com/<your-name>/<repo>.git
git push -u origin main
```
`.gitignore` blocks `.env`, `node_modules`, `dist` and `server/data`. If a key or the Mongo password was ever committed, rotate it (new Groq key, new MongoDB user password).

### 2) Render (recommended: one service runs the server and the website)
1. Render > **New > Blueprint** > pick your GitHub repo (it reads `render.yaml`).
   Or **New > Web Service**: Build `npm install --include=dev && npm run build`, Start `npm start`.
2. Paste `GROQ_API_KEY` and `MONGODB_URI` when asked. `JWT_SECRET` is generated for you.
3. In MongoDB Atlas > Network Access allow `0.0.0.0/0` (Render free has no fixed IP).
4. Open the `https://....onrender.com` link (HTTPS is automatic).

Free plan notes: the service sleeps after 15 minutes without visitors (the first request afterwards is slow) and its disk is temporary.
That no longer loses accounts, because they live in MongoDB. Keep `JWT_SECRET` set so login sessions survive restarts.

### 3) Vercel
Vercel runs short-lived serverless functions with a read-only disk, so it is a poor home for this long-running Express server.
- Best: host only the **website** on Vercel (Root Directory `client`, Build `npm run build`, Output `dist`), set `VITE_API_URL=https://<your-render-app>.onrender.com`,
  and on Render set `CORS_ORIGINS=https://<your-vercel-app>.vercel.app`.
- Or skip Vercel and use only Render (simpler, no CORS setup).

## Settings (all optional, in `server/.env`)
| Variable | Default | Purpose |
|---|---|---|
| `GROQ_API_KEY` | – | Your AI key (`NVIDIA_API_KEY` / `GROK_API_KEY` also accepted) |
| `MONGODB_URI` | – | MongoDB connection string. Without it: guests only |
| `MONGODB_DB` | `neuralsum` | Database name |
| `LLM_MODEL` | `openai/gpt-oss-120b` | Any chat model from console.groq.com/docs/models. If unset and the default is ever retired, another available model is picked automatically |
| `LLM_BASE_URL` | `https://api.groq.com/openai/v1` | API endpoint (auto-selected from the key prefix) |
| `LLM_TIMEOUT` | `120` | Seconds to wait for the AI |
| `GUEST_LIMIT_PER_HOUR` | `30` | Free summaries per hour for visitors who are not logged in (`0` = unlimited) |
| `JWT_SECRET` | auto | Secret used to sign login tokens |
| `PORT` / `HOST` | `8000` / `127.0.0.1` | Where the server listens. On hosting platforms (they set `PORT`) it listens on all interfaces automatically |
| `TRUST_PROXY` | auto on Render | Set `1` behind a proxy/load balancer so each visitor gets their own IP for the guest limit |
| `CORS_ORIGINS` | localhost:5173 | Allowed website origins (only if the site is hosted elsewhere) |

## Troubleshooting
| Message | Fix |
|---|---|
| `needs Node.js 22.13 or newer` | Install the LTS version from nodejs.org |
| `Cannot find package 'express'` | Run `npm install` in the project root (not inside `server`) |
| Demo mode banner / "no API key found" | `server/.env` missing, wrong folder/name, or the key line is empty |
| `rejected the API key (401)` | Key copied incompletely, has spaces/quotes, or was deleted. Create a new one |
| `denied access (403)` | Key/model not allowed. Create a fresh key; check console.groq.com/settings/limits |
| `Accounts are not set up on this server yet` | Add `MONGODB_URI` to `server/.env` (section 3) |
| `still contains a placeholder like <db_password>` | Replace `<db_password>` (with the `< >`) by your real password |
| `MongoDB rejected the username or password` | Check them; URL-encode special characters (`@` = `%40`) |
| `Cannot reach the database` | Check internet; in Atlas > Network Access allow your IP (or `0.0.0.0/0`) |
| `too large for your plan's token limit` | Free-tier per-minute token limit. Use a shorter text |
| `rate limit (429)` | Free tier limit. Wait a little and try again |
| `Cannot reach the server` (in the website) | Server not running. Run `npm run dev` |
| `Port 8000 is already in use` | Close the other program, or `PORT=8001` in `server/.env` (dev proxy expects 8000) |
| `Free limit reached` | Guests get 30 summaries/hour. Log in, or raise `GUEST_LIMIT_PER_HOUR` |
| `session has expired` | Click **Log in / Sign up** (bottom-left) and log in again |

## Tests
```bash
npm test
```
Runs the server tests (fake AI server + in-memory database: no key, internet or MongoDB needed) and the website tests (Vitest).
To run the server tests against a real MongoDB too: `MONGODB_TEST_URI=mongodb://127.0.0.1:27017 npm test` (uses throw-away databases).

## Project layout
```
server/   Express API
  src/    app.js (routes) · auth.js (login) · store/mongo.js (MongoDB) · llm.js (Groq/AI calls)
          config.js (.env) · extractive.js (demo mode) · errors.js · start.js / index.js
  scripts/ check-api.js · check-db.js · manage-users.js      test/ server tests
client/   React website (src/main.jsx) + tests
render.yaml   Render Blueprint
```
