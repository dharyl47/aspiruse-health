# Deploying the Aspirus priority portal (Render, shared login)

A small Express server serves the portal shell (`public/index.html` — layout, CSS,
render logic, no confidential data) and gates the actual use-case data and the
chatbot behind a single shared username/password, so it can be shared with
reviewers outside your network without individual accounts.

## What's in here

| Path | Purpose |
|---|---|
| `server.js` | Express app: login/logout, session cookies, `/api/data`, `/api/chat` |
| `public/index.html` | The portal page — static, contains no confidential data |
| `data/usecases.json` | The confidential use-case data — server-side only, never in `public/` |
| `scripts/hash-password.js` | Run locally to turn a chosen password into a bcrypt hash |
| `scripts/extract-data.js` | Sanity-checks `data/usecases.json` (run after editing it) |
| `render.yaml` | Render Blueprint so the service can be created straight from the repo |

## One-time setup

### 1. Choose a password and hash it locally

```bash
npm install
node scripts/hash-password.js
```

This prompts for a password (input hidden, never written to disk) and prints a
bcrypt hash. Pick something long and random — this is the one secret standing
between the internet and this data, so treat it like a real credential, not a
throwaway. **Save the raw password yourself** (e.g. in a password manager) —
only the hash goes into Render.

### 2. Generate a session-signing secret

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Push this folder to a **private** GitHub repo

```bash
git init
git add .
git commit -m "Aspirus priority portal"
gh repo create aspirus-priority-portal --private --source=. --push
# (or create the repo in the GitHub UI, then: git remote add origin ...; git push -u origin main)
```

`data/usecases.json` and `.env.example` are fine to commit — the real secrets
(password hash, session secret, OpenAI key) never live in the repo, only in
Render's environment variables. `.gitignore` already excludes `.env`.

### 4. Create the Render service

Easiest: in the [Render Dashboard](https://dashboard.render.com), **New →
Blueprint**, point it at your repo — it reads `render.yaml` and creates the
web service automatically (Free plan, `npm install` build, `npm start` start
command, `/healthz` health check).

(Or manually: **New → Web Service** → connect the repo → Environment: Node →
Build command `npm install` → Start command `npm start`.)

### 5. Set the environment variables

In the service → **Environment**, add:

- `PORTAL_USERNAME` — the username you'll share
- `PORTAL_PASSWORD_HASH` — the bcrypt hash from step 1
- `SESSION_SECRET` — the random string from step 2
- `OPENAI_API_KEY` — your OpenAI key

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

Give them the URL, the username, and the password — but **not in the same
message**. Send the username by email/Slack and the password over a different
channel (text, phone call, or a password manager's share feature). This is the
standard mitigation for the main weakness of a shared credential: if one
channel is compromised, the whole login isn't.

**Tradeoffs of a single shared credential, so you know what you're accepting:**
- No per-person audit trail — you can't tell who's asking the chatbot what.
- No selective revocation — removing one person's access means changing the
  password for everyone (see below).
- If it leaks, it's a full compromise of the confidential data until rotated.

An 8-hour session (already configured) limits how long a copied/forwarded
cookie stays valid even if a session leaks. Because everyone shares one login,
clicking **Log out** signs out *everyone's* active session, not just yours —
there's only one identity to log out of.

## Rotating or revoking the password

Re-run `node scripts/hash-password.js` with a new password, update
`PORTAL_PASSWORD_HASH` in Render's Environment tab, and it takes effect
immediately on the next deploy/restart — the old password stops working for
everyone at once (including anyone still logged in past their 8-hour session).

## Updating the data or the page

Edit `data/usecases.json` directly (it's the source of truth now — the HTML no
longer embeds the data), run `node scripts/extract-data.js` to sanity-check it
parses, edit `public/index.html` for layout/behavior changes, commit, push —
Render redeploys automatically on push if you used the Blueprint/GitHub flow.

## Local testing before you deploy

```bash
cp .env.example .env
# fill in PORTAL_USERNAME, PORTAL_PASSWORD_HASH (from step 1), SESSION_SECRET, OPENAI_API_KEY
npm install
npm start
```

Visit `http://localhost:3000` — you should see the login form, and the
dashboard should load after signing in.

## A note on Render's free tier

The free instance type spins down after ~15 minutes of inactivity; the first
request after that takes 30–50 seconds to wake it back up. Fine for occasional
review use; upgrade to the paid Starter instance if reviewers need it to be
instantly responsive.
