// Simple Gemini proxy for Render (API-key auth only)
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fetch = require('node-fetch');

const app = express();

// ✅ Required on Render/Heroku/Cloud Run to trust X-Forwarded-For
app.set('trust proxy', 1);

app.use(helmet());
app.use(express.json({
  limit: '200kb',
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));

// Rate limit (safe because trust proxy is now true)
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 min window
  max: 30,             // limit each IP to 30 requests/min
  standardHeaders: true,
  legacyHeaders: false
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

async function callGemini(emailText) {
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
              inputText
          }
        ]
      }
    ]
  };

  const url = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(
    GEMINI_MODEL
  )}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const code = resp.status;
  const textResp = await resp.text();

  if (code < 200 || code >= 300) {
    throw new Error(`Gemini API error ${code}: ${textResp}`);
  }

  const json = JSON.parse(textResp || '{}');
  const output =
    json.candidates &&
    json.candidates[0] &&
    json.candidates[0].content &&
    json.candidates[0].content.parts &&
    json.candidates[0].content.parts[0].text;

  return (output || '').trim();
}

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/summarize', async (req, res) => {
  try {
    // 1) Simple API key authentication
    const clientKey = req.get('X-Api-Key') || '';
    if (!clientKey || clientKey !== API_KEY_SECRET) {
      return res.status(401).json({ error: 'Unauthorized: invalid API key.' });
    }

    // 2) Validate body
    const body = req.body || {};
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Missing text field in JSON body.' });
    }

    // 3) Call Gemini
    const start = Date.now();
    const raw = await callGemini(text);
    const tookMs = Date.now() - start;

    return res.json({
      ok: true,
      raw,
      tookMs
    });

  } catch (err) {
    console.error('Error in /summarize:', err && err.message);
    return res.status(500).json({
      error: 'Internal server error',
      detail: String(err && err.message)
    });
  }
});

app.listen(PORT, () => {
  console.log(`Gemini proxy server listening on port ${PORT}`);
});
