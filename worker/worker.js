/**
 * Habla sync — a tiny key/value store for the family's progress.
 *
 * GET  /<secret-key>  -> the stored progress JSON (or an empty shell)
 * PUT  /<secret-key>  -> replace the stored progress JSON
 *
 * The secret key is the path itself: a long random string you invent
 * (e.g. `openssl rand -hex 16`). Anyone with the full URL can read and
 * write, so treat the URL like a shared family password.
 */
export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    const key = new URL(req.url).pathname.slice(1);
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) {
      return new Response('bad key', { status: 400, headers: cors });
    }

    if (req.method === 'GET') {
      const v = await env.HABLA.get(key);
      return new Response(v || '{"profiles":{}}', {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    if (req.method === 'PUT') {
      const body = await req.text();
      if (body.length > 500_000) return new Response('too big', { status: 413, headers: cors });
      try { JSON.parse(body); } catch { return new Response('not json', { status: 400, headers: cors }); }
      await env.HABLA.put(key, body);
      return new Response('ok', { headers: cors });
    }

    return new Response('method not allowed', { status: 405, headers: cors });
  },
};
