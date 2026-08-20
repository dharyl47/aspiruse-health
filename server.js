#!/usr/bin/env node
'use strict';

if (process.env.NODE_ENV !== 'production') {
  // Local dev convenience only — Render sets real env vars directly, no .env file involved.
  try { require('dotenv').config(); } catch { /* dotenv not installed, fine in production */ }
}

const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const REQUIRED_ENV = ['PORTAL_USERNAME', 'PORTAL_PASSWORD_HASH', 'SESSION_SECRET'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment variable(s): ${missing.join(', ')}`);
  console.error('See .env.example / README-deploy.md.');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const COOKIE_NAME = 'portal_session';

const DATA_PATH = path.join(__dirname, 'data', 'usecases.json');
let usecaseData = null;
function loadData() {
  if (!usecaseData) usecaseData = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  return usecaseData;
}

// ---------- session token: HMAC-signed, no external session store needed ----------
// Everyone shares one login, so there's only one identity to revoke: bumping
// `sessionEpoch` on logout invalidates every token issued before that moment,
// even ones already handed out to other tabs/devices/copies of the cookie.
// (Relies on the server being one long-running process, which is how Render
// runs a Free/Starter web service — if this ever moves to multiple instances,
// swap this for a shared store like Redis.)
let sessionEpoch = Date.now();

function signSession() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS, since: sessionEpoch })).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const expectedSig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig || '');
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return false;
  try {
    const { exp, since } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof exp !== 'number' || Date.now() >= exp) return false;
    if (since !== sessionEpoch) return false; // revoked by a logout since this token was issued
    return true;
  } catch {
    return false;
  }
}

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!verifySession(token)) return res.status(401).json({ error: 'Not signed in.' });
  next();
}

// tiny cookie parser — avoids pulling in the `cookie-parser` dependency
function parseCookies(req, res, next) {
  const header = req.headers.cookie || '';
  req.cookies = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) req.cookies[key] = decodeURIComponent(val);
  });
  next();
}

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(parseCookies);

app.get('/healthz', (req, res) => res.status(200).send('ok'));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.' },
});

app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Invalid username or password.' });
  }

  // Username isn't secret (it's shared alongside the password), so a plain
  // comparison is fine — bcrypt.compareSync below is what needs to be constant-time,
  // and it is internally.
  const userOk = username === process.env.PORTAL_USERNAME;
  const passOk = bcrypt.compareSync(password, process.env.PORTAL_PASSWORD_HASH);

  if (!userOk || !passOk) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const token = signSession();
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== 'development',
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
  res.status(200).json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  sessionEpoch = Date.now(); // invalidates every outstanding session token, not just this browser's
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.status(200).json({ ok: true });
});

app.get('/api/data', requireAuth, (req, res) => {
  // Chat is entirely gated on whether OPENAI_API_KEY is set — no separate feature
  // flag needed. Tell the client so it can hide the chat icon when it's absent.
  res.status(200).json({ ...loadData(), chatEnabled: Boolean(process.env.OPENAI_API_KEY) });
});

function buildSystemPrompt() {
  const { UC, ALL } = loadData();

  const summaryLines = ALL.map((u) =>
    `- ${u.id} "${u.name}": annual value ${u.valuePending ? 'PENDING' : '$' + u.value.toLocaleString()}, ` +
    `ROM investment $${(u.rom || 0).toLocaleString()}, net ${u.net === null ? 'n/a' : '$' + u.net.toLocaleString()}, ` +
    `payback ${u.payback ? u.payback + ' months' : 'n/a'}, timeline ${u.timeline}, complexity ${u.complexity}, priority ${u.priority}`
  ).join('\n');

  const detailBlocks = UC.map((u) =>
    `### ${u.name} (${u.bvpId})\n` +
    `Area: ${u.area}\n` +
    `Objective: ${u.objective}\n` +
    `Summary: ${u.summary}\n` +
    `Annual value: ${u.valueLabel}, ROM: ${u.romLabel}, net: ${u.netLabel}, payback: ${u.payback ?? 'n/a'} months, timeline: ${u.timeline}, complexity: ${u.complexity}`
  ).join('\n\n');

  return [
    'You are a research assistant embedded in a confidential internal business-value',
    'prioritization portal for Aspirus Health automation use cases. Answer questions',
    'ONLY using the data provided below. If something is not covered by this data,',
    'say so rather than guessing. Be concise, cite specific use case IDs/names and numbers',
    'when relevant, and use dollar/month formatting consistent with the source data.',
    'This data is confidential — do not suggest sharing it outside this portal.',
    '',
    '## All use cases (summary)',
    summaryLines,
    '',
    '## Fully-assessed use cases (detail)',
    detailBlocks,
  ].join('\n');
}

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

app.post('/api/chat', requireAuth, chatLimiter, async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Intentional disabled state (no key set), not a misconfiguration — 503, not 500.
    return res.status(503).json({ error: 'Chat is currently disabled.' });
  }

  const message = ((req.body && req.body.message) || '').toString().trim();
  if (!message) return res.status(400).json({ error: 'Missing "message".' });

  const history = Array.isArray(req.body.history) ? req.body.history.slice(-10) : [];
  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...history
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) })),
    { role: 'user', content: message.slice(0, 4000) },
  ];

  let response;
  try {
    response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.2, max_tokens: 600, messages }),
    });
  } catch (err) {
    console.error('OpenAI request failed', err);
    return res.status(502).json({ error: 'Could not reach the chat service.' });
  }

  if (!response.ok) {
    console.error('OpenAI returned an error', response.status, await response.text());
    return res.status(502).json({ error: 'Chat service returned an error.' });
  }

  const payload = await response.json();
  const reply = payload.choices?.[0]?.message?.content?.trim() || '(no response)';
  res.status(200).json({ reply });
});

// Static assets (page shell, CSS/JS) — contains no confidential data.
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Aspirus portal listening on :${PORT}`);
});
