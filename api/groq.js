/* =====================================================================
   GigGuard — serverless Groq proxy (Vercel function, route: /api/groq)
   ---------------------------------------------------------------------
   The browser POSTs the SAME body it would send to Groq, but WITHOUT any
   key. This function adds `Authorization: Bearer <GROQ_API_KEY>` from the
   server environment and forwards to Groq, then streams the JSON straight
   back. The key lives only in the Vercel env var — never in the client,
   never in the repo, never in a network request the browser can see.

   Env vars:
     GROQ_API_KEY     (required)  — the Groq inference key
     ALLOWED_ORIGINS  (optional)  — comma-separated origins allowed to call
                                    this proxy. If unset, all origins are
                                    allowed (fine for a public demo).
   ===================================================================== */
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

function allowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

function applyCors(req, res) {
  const allow = allowedOrigins();
  const origin = req.headers.origin || '';
  if (allow.length === 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (allow.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  applyCors(req, res);

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const key = process.env.GROQ_API_KEY;
  if (!key) { res.status(500).json({ error: 'AI not configured: GROQ_API_KEY is missing' }); return; }

  // Optional origin lock (only enforced when ALLOWED_ORIGINS is configured).
  const allow = allowedOrigins();
  if (allow.length > 0) {
    const origin = req.headers.origin || '';
    if (origin && !allow.includes(origin)) { res.status(403).json({ error: 'Origin not allowed' }); return; }
  }

  // Vercel auto-parses JSON bodies, but accept a raw string too.
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json({ error: 'messages[] is required' }); return;
  }
  // Abuse caps: bound conversation length and output size.
  if (body.messages.length > 40) { res.status(400).json({ error: 'too many messages' }); return; }

  const payload = {
    model: typeof body.model === 'string' ? body.model : DEFAULT_MODEL,
    messages: body.messages,
    max_tokens: Math.min(Number(body.max_tokens) || 1024, 2048),
    temperature: body.temperature != null ? Number(body.temperature) : 0.3,
  };
  if (body.response_format) payload.response_format = body.response_format;

  try {
    const upstream = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/json');
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: 'Upstream error', detail: String((e && e.message) || e) });
  }
};
