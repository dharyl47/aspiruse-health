#!/usr/bin/env node
'use strict';

if (process.env.NODE_ENV !== 'production') {
  // Local dev convenience only — Render sets real env vars directly, no .env file involved.
  try { require('dotenv').config(); } catch { /* dotenv not installed, fine in production */ }
}

const path = require('path');
const fs = require('fs');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment variable(s): ${missing.join(', ')}`);
  console.error('See .env.example / README-deploy.md.');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const ACCESS_COOKIE = 'sb-access-token';
const REFRESH_COOKIE = 'sb-refresh-token';
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const DATA_PATH = path.join(__dirname, 'data', 'usecases.json');
let usecaseData = null;
function loadData() {
  if (!usecaseData) usecaseData = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  return usecaseData;
}

function createAnonClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

function cookieBase() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV !== 'development',
    sameSite: 'lax',
    path: '/',
  };
}

function setSessionCookies(res, session) {
  const accessMaxAge = Math.max(60, Number(session.expires_in) || 3600) * 1000;
  res.cookie(ACCESS_COOKIE, session.access_token, { ...cookieBase(), maxAge: accessMaxAge });
  if (session.refresh_token) {
    res.cookie(REFRESH_COOKIE, session.refresh_token, { ...cookieBase(), maxAge: REFRESH_TTL_MS });
  }
}

function clearSessionCookies(res) {
  res.clearCookie(ACCESS_COOKIE, { path: '/' });
  res.clearCookie(REFRESH_COOKIE, { path: '/' });
}

async function requireAuth(req, res, next) {
  try {
    const access = req.cookies && req.cookies[ACCESS_COOKIE];
    const refresh = req.cookies && req.cookies[REFRESH_COOKIE];
    if (!access && !refresh) return res.status(401).json({ error: 'Not signed in.' });

    const supabase = createAnonClient();

    if (access) {
      const { data, error } = await supabase.auth.getUser(access);
      if (!error && data.user) {
        req.user = data.user;
        return next();
      }
    }

    if (!refresh) return res.status(401).json({ error: 'Not signed in.' });

    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refresh });
    if (error || !data.session || !data.user) {
      clearSessionCookies(res);
      return res.status(401).json({ error: 'Not signed in.' });
    }

    setSessionCookies(res, data.session);
    req.user = data.user;
    next();
  } catch (err) {
    console.error('Auth check failed', err);
    return res.status(500).json({ error: 'Authentication failed.' });
  }
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

app.post('/api/login', loginLimiter, async (req, res) => {
  const email = ((req.body && (req.body.email || req.body.username)) || '').toString().trim();
  const password = ((req.body && req.body.password) || '').toString();

  if (!email || !password) {
    return res.status(400).json({ error: 'Invalid email or password.' });
  }
  if (!email.includes('@')) {
    return res.status(400).json({ error: 'Sign in with your email address.' });
  }

  try {
    const supabase = createAnonClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.session) {
      const unconfirmed = /confirm/i.test(error && error.message ? error.message : '');
      return res.status(401).json({
        error: unconfirmed
          ? 'Email not confirmed. Confirm it in Supabase Auth, or disable email confirmations for this project.'
          : 'Invalid email or password.',
      });
    }

    setSessionCookies(res, data.session);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Login failed', err);
    return res.status(502).json({ error: 'Could not reach the sign-in service.' });
  }
});

app.post('/api/logout', async (req, res) => {
  const access = req.cookies && req.cookies[ACCESS_COOKIE];
  const refresh = req.cookies && req.cookies[REFRESH_COOKIE];

  if (access || refresh) {
    try {
      const supabase = createAnonClient();
      if (access && refresh) {
        await supabase.auth.setSession({ access_token: access, refresh_token: refresh });
      }
      await supabase.auth.signOut({ scope: 'local' });
    } catch (err) {
      console.error('Supabase sign-out failed', err);
    }
  }

  clearSessionCookies(res);
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
