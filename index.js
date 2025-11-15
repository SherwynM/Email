// Simple Gemini proxy for Render (HMAC auth only)

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fetch = require('node-fetch');
const crypto = require('crypto');

const app = express();
app.use(helmet());
app.use(express.json({ limit: '200kb' })); // limit body size

// Rate limiting to avoid abuse
const limiter = rateLimit({
  windowMs: 60 * 1000,    // 1 minute
  max: 30,                // 30 requests/min per IP
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

const PORT = process.env.PORT || 3000;
const GEMINI_KEY = process.env.GEMINI_API_KEY;   // required
const SHARED_SECRET = process.env.SHARED_SECRET; // required
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

if (!GEMINI_KEY) {
  console.error('GEMINI_API_KEY is required in environment variables.');
  process.exit(1);
}
if (!SHARED_SECRET) {
  console.error('SHARED_SECRET is required in environment variables.');
  process.exit(1);
}

// Compute HMAC-SHA256 and return base64 string
function computeHmacBase64(payloadJson, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payloadJson, 'utf8');
  return hmac.digest('base64');
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

// Simple health check
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// Main endpoint the Apps Script will call
app.post('/summarize', async (req, res) => {
  try {
    // 1) Read the body exactly as Apps Script sent it
    const body = req.body || {};
    const text = typeof body.text === 'string' ? body.text : '';

    // For validation we can still use trim, but NOT for HMAC payload
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Missing text field in JSON body.' });
    }

    // 2) Build the EXACT SAME JSON string for HMAC as Apps Script
    const payloadJson = JSON.stringify({ text: String(text || '') });

    // 3) Read signature from header
    const signatureHeader = req.get('X-AppsScript-Signature') || '';
    if (!signatureHeader) {
      return res.status(401).json({ error: 'Missing X-AppsScript-Signature header.' });
    }

    // 4) Compute expected signature
    const computed = computeHmacBase64(payloadJson, SHARED_SECRET);

    // 🔍 DEBUG LOGS (these are the ones you asked about)
    console.log('payloadJson:', payloadJson);
    console.log('headerSig:', signatureHeader);
    console.log('computedSig:', computed);

    const a = Buffer.from(computed);
    const b = Buffer.from(signatureHeader);

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Invalid signature.' });
    }

    // 5) HMAC is valid → call Gemini
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
