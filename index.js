require('dotenv').config();
json.candidates &&
json.candidates[0] &&
json.candidates[0].content &&
json.candidates[0].content.parts &&
json.candidates[0].content.parts[0].text;


return (output || '').trim();
}


if (code === 503 && attempt < maxRetries) {
console.warn(`Gemini 503 on attempt ${attempt}, retrying...`);
lastError = new Error(`Gemini API error 503: ${textResp}`);
await sleep(1000 * attempt);
continue;
}


throw new Error(`Gemini API error ${code}: ${textResp}`);
}


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
let raw;
try {
raw = await callGeminiWithRetry(text);
} catch (err) {
console.error('Gemini call failed:', err && err.message);
// If the underlying error mentions 503, surface a 503 with model info
if (String(err.message || '').includes('503')) {
return res.status(503).json({
error: 'Model overloaded',
detail: 'Gemini reported that the model is overloaded. Please try again shortly.',
model: GEMINI_MODEL
});
}
throw err;
}


const tookMs = Date.now() - start;


return res.json({ ok: true, raw, tookMs, model: GEMINI_MODEL });
} catch (err) {
console.error('Error in /summarize:', err && err.message);
return res.status(500).json({ error: 'Internal server error', detail: String(err && err.message) });
}
});


app.listen(PORT, () => {
console.log(`Gemini proxy server listening on port ${PORT}`);
});
