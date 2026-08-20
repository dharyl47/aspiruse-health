# Deploying the Aspirus priority portal (Render, Supabase Auth)

A small Express server serves the portal shell (`public/index.html` — layout, CSS,
render logic, no confidential data) and gates the actual use-case data and the
chatbot behind Supabase email/password login.

## What's in here

| Path | Purpose |
|---|---|
| `server.js` | Express app: login/logout via Supabase, session cookies, `/api/data`, `/api/chat` |
| `public/index.html` | The portal page — static, contains no confidential data |
| `data/usecases.json` | The confidential use-case data — server-side only, never in `public/` |
| `scripts/extract-data.js` | Sanity-checks `data/usecases.json` (run after editing it) |
| `render.yaml` | Render Blueprint so the service can be created straight from the repo |
| `supabase/` | Linked Supabase project config (`config.toml`) |

## One-time setup

### 1. Create reviewers in Supabase Auth

In the [Supabase dashboard](https://supabase.com/dashboard/project/ahidtkwulerqmnscnlaa/auth/users) → **Authentication → Users → Add user**. Use each reviewer's email and a password. If sign-in fails with "email not confirmed", either confirm the user or turn off **Confirm email** under Authentication → Providers → Email.

Copy the project URL and **publishable / anon** key from Settings → API. Never put the `service_role` key in this app or in Render.

### 2. Push this folder to a **private** GitHub repo

```bash
git init
git add .
git commit -m "Aspirus priority portal"
gh repo create aspirus-priority-portal --private --source=. --push
# (or create the repo in the GitHub UI, then: git remote add origin ...; git push -u origin main)
```

`data/usecases.json` and `.env.example` are fine to commit — the real secrets
(Supabase keys, OpenAI key) never live in the repo, only in Render's environment
variables. `.gitignore` already excludes `.env`.

### 3. Create the Render service

Easiest: in the [Render Dashboard](https://dashboard.render.com), **New →
Blueprint**, point it at your repo — it reads `render.yaml` and creates the
web service automatically (Free plan, `npm install` build, `npm start` start
command, `/healthz` health check).

(Or manually: **New → Web Service** → connect the repo → Environment: Node →
Build command `npm install` → Start command `npm start`.)

### 4. Set the environment variables

In the service → **Environment**, add:

- `SUPABASE_URL` — e.g. `https://ahidtkwulerqmnscnlaa.supabase.co`
- `SUPABASE_ANON_KEY` — the publishable / anon key
- `OPENAI_API_KEY` — your OpenAI key (optional; chat stays off without it)

Deploy. Your URL is `https://<service-name>.onrender.com`.

### Chat is optional — controlled entirely by `OPENAI_API_KEY`

There's no separate on/off setting for the chat widget: the 💬 icon and
`/api/chat` are only live when `OPENAI_API_KEY` is set in the environment.

- **To disable it**: remove `OPENAI_API_KEY` from the service's Environment
  tab and save. The icon disappears client-side and `/api/chat` returns `503`
  — no code changes, no redeploy of anything but the env var itself.
- **To re-enable it later**: add the same (or a new) key back under
  `OPENAI_API_KEY` and save. Everything turns back on automatically.

## Sharing access with people outside your network

Create a Supabase Auth user for each reviewer, then give them the URL, their
email, and their password — but **not in the same message**. Send the email by
Slack and the password over a different channel (text, phone call, or a
password manager's share feature).

**Log out** ends only that browser's session (the server clears the httpOnly
cookies and revokes the refresh token). To remove someone's access entirely,
delete or ban the user in Supabase Auth.

## Updating the data or the page

Edit `data/usecases.json` directly (it's the source of truth now — the HTML no
longer embeds the data), run `node scripts/extract-data.js` to sanity-check it
parses, edit `public/index.html` for layout/behavior changes, commit, push —
Render redeploys automatically on push if you used the Blueprint/GitHub flow.

## Local testing before you deploy

```bash
cp .env.example .env
# fill in SUPABASE_URL, SUPABASE_ANON_KEY, OPENAI_API_KEY
npm install
npm start
```

Visit `http://localhost:3000` — you should see the login form, and the
dashboard should load after signing in with a Supabase Auth user.

## A note on Render's free tier

The free instance type spins down after ~15 minutes of inactivity; the first
request after that takes 30–50 seconds to wake it back up. Fine for occasional
review use; upgrade to the paid Starter instance if reviewers need it to be
instantly responsive.
