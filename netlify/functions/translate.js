// Translation proxy with two paths:
//  1. Official Google Translate Cloud API (if GOOGLE_TRANSLATE_API_KEY is set)
//  2. Free unofficial Google Translate endpoint (no key required) — default
//
// Both return the same response shape:
//   { data: { translations: [ { translatedText, detectedSourceLanguage? } ] } }

const FREE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

async function officialTranslate(key, q, source, target) {
  const body = { q, target, format: 'text' };
  if (source && source !== 'auto') body.source = source;
  const res = await fetch(
    `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const text = await res.text();
  return { status: res.status, body: text };
}

async function freeTranslate(q, source, target) {
  const params = new URLSearchParams({
    client: 'gtx',
    sl: source || 'auto',
    tl: target,
    dt: 't',
  });
  const formBody = new URLSearchParams({ q });
  const res = await fetch(`${FREE_ENDPOINT}?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody.toString(),
  });
  if (!res.ok) {
    return {
      status: res.status,
      body: JSON.stringify({ error: `Free Google Translate ${res.status}` }),
    };
  }
  const data = await res.json();
  if (!Array.isArray(data?.[0])) {
    return { status: 502, body: JSON.stringify({ error: 'Malformed free-translate response' }) };
  }
  const translatedText = data[0].map((s) => (s?.[0] ?? '')).join('');
  const detectedSourceLanguage = typeof data?.[2] === 'string' ? data[2] : undefined;
  return {
    status: 200,
    body: JSON.stringify({
      data: { translations: [{ translatedText, detectedSourceLanguage }] },
    }),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
  }
  const { q, source, target } = payload;
  if (typeof q !== 'string' || typeof target !== 'string') {
    return { statusCode: 400, body: JSON.stringify({ error: 'Need {q, target, source?}.' }) };
  }
  if (q.length > 5000) {
    return { statusCode: 413, body: JSON.stringify({ error: 'Text too long (max 5000 chars).' }) };
  }

  const key = process.env.GOOGLE_TRANSLATE_API_KEY;

  try {
    const result = key
      ? await officialTranslate(key, q, source, target)
      : await freeTranslate(q, source, target);
    return {
      statusCode: result.status,
      headers: { 'Content-Type': 'application/json' },
      body: result.body,
    };
  } catch (e) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: `Upstream fetch failed: ${String(e)}` }),
    };
  }
};
