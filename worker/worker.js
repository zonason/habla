/**
 * Habla sync + content generation.
 *
 * GET  /<secret-key>            -> the stored progress JSON (or an empty shell)
 * PUT  /<secret-key>            -> replace the stored progress JSON
 * POST /<secret-key>/generate   -> Claude generates content for an added weak-spot
 *                                  body: {name, text} -> {why, example, conv, quiz[5]}
 *
 * The secret key is the first path segment: a long random string you invent
 * (e.g. `openssl rand -hex 16`). Anyone with the full URL can read/write,
 * so treat the URL like a shared family password.
 *
 * Secrets: `wrangler secret put ANTHROPIC_API_KEY` enables /generate.
 */
export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    const segs = new URL(req.url).pathname.split('/').filter(Boolean);
    const key = segs[0] || '';
    const op = segs[1] || '';
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) {
      return new Response('bad key', { status: 400, headers: cors });
    }

    if (req.method === 'GET' && !op) {
      const v = await env.HABLA.get(key);
      return new Response(v || '{"profiles":{}}', {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    if (req.method === 'PUT' && !op) {
      const body = await req.text();
      if (body.length > 500_000) return new Response('too big', { status: 413, headers: cors });
      try { JSON.parse(body); } catch { return new Response('not json', { status: 400, headers: cors }); }
      await env.HABLA.put(key, body);
      return new Response('ok', { headers: cors });
    }

    if (req.method === 'POST' && op === 'generate') {
      if (!env.ANTHROPIC_API_KEY) {
        return new Response('generation not configured', { status: 501, headers: cors });
      }
      let body;
      try { body = await req.json(); } catch { return new Response('not json', { status: 400, headers: cors }); }
      const name = String(body.name || '').slice(0, 120);
      const text = String(body.text || '').slice(0, 2000);
      if (!name) return new Response('missing name', { status: 400, headers: cors });

      const prompt = `You are creating content for a Spanish-learning app (Mexican Spanish, learner at A2 level). The learner added a personal weak spot:

Title: ${name}
Learner's own description: ${text}

Return ONLY a JSON object, no markdown fences, with exactly these fields:
{
  "why": "one short English line: what the difficulty is and why it matters",
  "example": "one short Spanish sentence showing correct usage of exactly this",
  "conv": "one or two English sentences instructing a voice tutor how to drill this weak spot in natural conversation",
  "quiz": [
    ["question in Spanish, fill-in-the-blank using ___", ["opt1","opt2","opt3","opt4"], correctIndex, "one-line explanation in English"],
    ... exactly 10 items
  ]
}
Rules: every quiz answer must be unambiguously correct for Mexican Spanish; distractors must be plausible learner mistakes; vary which position (0-3) holds the correct answer across the 10 questions.`;

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 3500,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!r.ok) return new Response('llm error', { status: 502, headers: cors });
      const data = await r.json();
      let txt = (data.content && data.content[0] && data.content[0].text) || '';
      txt = txt.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      let g;
      try { g = JSON.parse(txt); } catch { return new Response('bad llm json', { status: 502, headers: cors }); }
      if (!g || !Array.isArray(g.quiz)) return new Response('bad content', { status: 502, headers: cors });
      g.quiz = g.quiz
        .filter(q => Array.isArray(q) && q.length >= 4 && typeof q[0] === 'string'
          && Array.isArray(q[1]) && q[1].length === 4
          && Number.isInteger(q[2]) && q[2] >= 0 && q[2] < 4 && typeof q[3] === 'string')
        .slice(0, 10);
      if (g.quiz.length !== 10) return new Response('bad quiz', { status: 502, headers: cors });
      return new Response(JSON.stringify({ why: g.why, example: g.example, conv: g.conv, quiz: g.quiz }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    return new Response('method not allowed', { status: 405, headers: cors });
  },
};
