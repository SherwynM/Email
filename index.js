// index.js — Gemini proxy (API-key auth + per-user Google OAuth, retry, structured responses)
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fetch = require('node-fetch');

const app = express();

// Behind Render's proxy, so trust first proxy hop (fixes X-Forwarded-For warning)
app.set('trust proxy', 1);

// Basic security headers
app.use(helmet());

// Parse JSON and keep raw body if you ever need it
app.use(
  express.json({
    limit: '200kb',
    verify: (req, res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

const PORT = process.env.PORT || 3000;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const API_KEY_SECRET = process.env.API_KEY_SECRET;

if (!GEMINI_KEY) {
  console.error('GEMINI_API_KEY is required in environment variables.');
  process.exit(1);
}
if (!API_KEY_SECRET) {
  console.error('API_KEY_SECRET is required in environment variables.');
  process.exit(1);
}

// Small helper for delay (used for retry backoff)
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Call Gemini with simple retry on 503
async function callGeminiWithRetry(emailText, maxRetries = 3) {
  const MAX_CHARS = 12000;
  let inputText = emailText || '';
  if (inputText.length > MAX_CHARS) {
    inputText = inputText.slice(0, MAX_CHARS) + '\n\n[TRUNCATED]';
  }

  const payload = {
    contents: [
      {
        parts: [
          {
            text:
              'Summarize the following email into:\n' +
              '• Four short bullet points\n' +
              '• One recruiter-friendly single-sentence summary\n\n' +
              inputText,
          },
        ],
      },
    ],
  };

  const url = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(
    GEMINI_MODEL
  )}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const code = resp.status;
    const textResp = await resp.text();

    // Success
    if (code >= 200 && code < 300) {
      const json = JSON.parse(textResp || '{}');
      const output =
        json.candidates &&
        json.candidates[0] &&
        json.candidates[0].content &&
        json.candidates[0].content.parts &&
        json.candidates[0].content.parts[0].text;

      return (output || '').trim();
    }

    // If 503, keep error and retry with backoff
    if (code === 503 && attempt < maxRetries) {
      console.warn(`Gemini 503 on attempt ${attempt}, retrying...`);
      lastError = new Error(`Gemini API error 503: ${textResp}`);
      await sleep(1000 * attempt); // 1s, then 2s, then 3s...
      continue;
    }

    // Other errors: fail fast
    throw new Error(`Gemini API error ${code}: ${textResp}`);
  }

  // All retries exhausted with 503
  throw lastError || new Error('Gemini API overloaded (503), all retries failed.');
}

/* =====================================================================
   Per-user auth via Google OAuth access token (tokeninfo + cache)
===================================================================== */

const TOKEN_CACHE_TTL_MS = 60 * 1000; // 60s TTL for token verification cache
const tokenCache = new Map(); // token -> { payload, expiry }

// Verify Google OAuth access token by calling tokeninfo endpoint
async function verifyGoogleAccessToken(accessToken) {
  if (!accessToken) throw new Error('No access token');

  const now = Date.now();
  const cached = tokenCache.get(accessToken);
  if (cached && cached.expiry > now) {
    return cached.payload; // { email, sub, user_id, ... }
  }

  const tokenInfoUrl = `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(
    accessToken
  )}`;

  const r = await fetch(tokenInfoUrl);
  if (!r.ok) {
    throw new Error('Invalid Google access token');
  }

  const payload = await r.json();

  // payload may contain: email, user_id, sub, scope, expires_in, audience, etc.
  if (!payload.email && !payload.user_id && !payload.sub) {
    throw new Error('Token verification returned no user identity');
  }

  tokenCache.set(accessToken, {
    payload,
    expiry: now + TOKEN_CACHE_TTL_MS,
  });

  return payload;
}

/* =====================================================================
   Routes
===================================================================== */

// Health-check endpoint
app.get('/health', (req, res) => {
  res.json({ ok: true, model: GEMINI_MODEL });
});

// Main summarize endpoint
app.post('/summarize', async (req, res) => {
  try {
    // 1) Try per-user Authorization first
    let userIdentity = null;
    const authHeader = (req.get('Authorization') || '').trim();

    if (authHeader.toLowerCase().startsWith('bearer ')) {
      const accessToken = authHeader.slice('bearer '.length).trim();
      try {
        const tokenInfo = await verifyGoogleAccessToken(accessToken);
        // Prefer email; fallback to user_id or sub
        userIdentity = tokenInfo.email || tokenInfo.user_id || tokenInfo.sub;
      } catch (err) {
        console.warn('Google token verification failed:', err && err.message);
        userIdentity = null;
      }
    }

    // 2) If no valid per-user token, fall back to API_KEY auth (demo/compat)
    const clientKey = req.get('X-Api-Key') || '';
    if (!userIdentity) {
      if (!clientKey || clientKey !== API_KEY_SECRET) {
        return res
          .status(401)
          .json({ error: 'Unauthorized: invalid API key or access token.' });
      }
    }

    // 3) Validate body
    const body = req.body || {};
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text || !text.trim()) {
      return res
        .status(400)
        .json({ error: 'Missing text field in JSON body.', model: GEMINI_MODEL });
    }

    // 4) Call Gemini with retry + timing
    const start = Date.now();
    const raw = await callGeminiWithRetry(text);
    const tookMs = Date.now() - start;

    // 5) Structured response with model + user info
    return res.json({
      ok: true,
      raw,
      tookMs,
      model: GEMINI_MODEL,
      user: userIdentity || null,
    });
  } catch (err) {
    console.error('Error in /summarize:', err && err.message);

    // Overload case -> 503 for client, with model info
    if (String(err.message || '').includes('503')) {
      return res.status(503).json({
        error: 'Model overloaded',
        detail: 'Gemini reported that the model is overloaded. Please try again shortly.',
        model: GEMINI_MODEL,
      });
    }

    // Generic error
    return res.status(500).json({
      error: 'Internal server error',
      detail: String(err && err.message),
      model: GEMINI_MODEL,
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Gemini proxy server listening on port ${PORT}`);
});
