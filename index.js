// Simple Gemini proxy for Render (API-key auth only)
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fetch = require('node-fetch');

const app = express();

app.set('trust proxy', 1);

app.use(helmet());
app.use(express.json({
  limit: '200kb',
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
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

// small helper for delay
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// call Gemini with simple retry on 503
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
              inputText
          }
        ]
      }
    ]
  };

  const url = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(
    GEMINI_MODEL
  )}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const code = resp.status;
    const textResp = await resp.text();

    // success
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

    // if 503, store error & retry after short delay
    if (code === 503 && attempt < maxRetries) {
      console.warn(`Gemini 503 on attempt ${attempt}, retrying...`);
      lastError = new Error(`Gemini API error 503: ${textResp}`);
      await sleep(1000 * attempt); // backoff: 1s, 2s, ...
      continue;
    }

    // other errors: throw immediately
    throw new Error(`Gemini API error ${code}: ${textResp}`);
  }

  // all retries failed with 503
  throw lastError || new Error('Gemini API overloaded (503), all retries failed.');
}

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/summarize', async (req, res) => {
  try {
    const clientKey = req.get('X-Api-Key') || '';
    if (!clientKey || clientKey !== API_KEY_SECRET) {
      return res.status(401).json({ error: 'Unauthorized: invalid API key.' });
    }

    const body = req.body || {};
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Missing text field in JSON body.' });
    }

    const start = Date.now();
    const raw = await callGeminiWithRetry(text);
    const tookMs = Date.now() - start;

    return res.json({ ok: true, raw, tookMs });

  } catch (err) {
    console.error('Error in /summarize:', err && err.message);

    // If this was a 503 overload case, surface a nicer message
    if (String(err.message || '').includes('503')) {
      return res.status(503).json({
        error: 'Model overloaded',
        detail: 'Gemini reported that the model is overloaded. Please try again shortly.'
      });
    }

    return res.status(500).json({
      error: 'Internal server error',
      detail: String(err && err.message)
    });
  }
});

app.listen(PORT, () => {
  console.log(`Gemini proxy server listening on port ${PORT}`);
});
