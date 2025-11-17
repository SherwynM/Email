// index.js — Gemini proxy (updated to return model and structured responses)
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
