const ALLOWED_MODELS = new Set([
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.5-flash-preview-tts',
  'gemini-2.5-pro-preview-tts',
]);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) };
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server missing GEMINI_API_KEY env variable.' }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
  }

  const { model, body } = payload;
  if (typeof model !== 'string' || typeof body !== 'object' || body === null) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Body must be { model, body } where body is the Gemini request.' }),
    };
  }
  if (!ALLOWED_MODELS.has(model)) {
    return { statusCode: 400, body: JSON.stringify({ error: `Model not allowed: ${model}` }) };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(key)}`;

  // Free Netlify functions hard-stop at 10s. Bail early at 9s so the client
  // gets a clean status and can fall back to the next model immediately.
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 9000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timeoutId);
    const text = await res.text();
    return {
      statusCode: res.status,
      headers: { 'Content-Type': 'application/json' },
      body: text,
    };
  } catch (e) {
    clearTimeout(timeoutId);
    if (e && e.name === 'AbortError') {
      return {
        statusCode: 408,
        body: JSON.stringify({ error: `Upstream took >9s (${model}) — try a faster model.` }),
      };
    }
    return {
      statusCode: 502,
      body: JSON.stringify({ error: `Upstream fetch failed: ${String(e)}` }),
    };
  }
};
