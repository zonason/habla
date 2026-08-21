/**
 * Habla sync + content generation + radio.
 *
 * GET  /<secret-key>            -> the stored progress JSON (or an empty shell)
 * PUT  /<secret-key>            -> replace the stored progress JSON
 * POST /<secret-key>/generate   -> Claude generates content for an added weak-spot
 *                                  body: {name, text} -> {why, example, conv, quiz[10]}
 * POST /<secret-key>/song       -> ensure a learning song exists for a topic+genre
 *                                  body: {tid, topic, teach, genre}
 *                                  -> {status:'ready', url, title, lyrics} | {status:'pending'} | {status:'failed'}
 *                                  Client polls by re-POSTing every few seconds while pending.
 *
 * The secret key is the first path segment: a long random string you invent
 * (e.g. `openssl rand -hex 16`). Anyone with the full URL can read/write,
 * so treat the URL like a shared family password.
 *
 * Secrets: `wrangler secret put EVOLINK_API_KEY` — one key powers everything:
 *          Claude (via EvoLink's Anthropic-compatible endpoint) and Suno music.
 */

const GENRE_STYLES = {
  acoustic: 'acoustic ballad, gentle nylon-string guitar, very slow tempo, extremely clear enunciated vocals, minimal instrumentation, quiet backing, language-learning song',
  pop:      'soft latin pop, slow tempo, bright very clear vocals, simple clean arrangement, gentle beat',
  corrido:  'mexican corrido, acoustic guitars and bajo sexto, relaxed tempo, clear storytelling vocals, traditional',
  bolero:   'romantic bolero, soft guitar trio, very slow, warm clear vocals, intimate',
  synthwave:'synthwave, retro 80s synth-pop, relaxed tempo, clear prominent vocals mixed up front, spacious airy mix',
  country:  'country ballad, acoustic guitar and gentle pedal steel, slow tempo, very clear storytelling vocals',
};
const NEGATIVE_TAGS = 'fast rap, shouting, heavy metal, distortion, mumbling, autotune, dense mix';

function findAudioUrl(o) {
  let found = null;
  const prefer = ['audio_url', 'audioUrl', 'audio', 'url'];
  (function walk(v) {
    if (found) return;
    if (typeof v === 'string') {
      if (/^https?:\/\/\S+\.(mp3|m4a|wav|ogg)(\?|$)/i.test(v)) found = v;
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const k of prefer) {
        if (typeof v[k] === 'string' && /^https?:\/\//.test(v[k])) { found = v[k]; return; }
      }
      Object.values(v).forEach(walk);
    }
  })(o);
  return found;
}

async function claudeJson(env, prompt, maxTokens, model) {
  // Claude via EvoLink's Anthropic-compatible endpoint — same key as music generation
  const r = await fetch('https://direct.evolink.ai/v1/messages', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.EVOLINK_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: model || 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) return null;
  const data = await r.json();
  let txt = (data.content && data.content[0] && data.content[0].text) || '';
  txt = txt.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(txt); } catch { return null; }
}
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
      if (!env.EVOLINK_API_KEY) {
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

      const g = await claudeJson(env, prompt, 3500);
      if (!g) return new Response('llm error', { status: 502, headers: cors });
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

    if (req.method === 'POST' && op === 'songs') {
      // song inventory: {tid} -> genres ready for that topic; {genre} -> playable tracks across topics; {} -> counts per genre
      const jcors = { ...cors, 'Content-Type': 'application/json' };
      let body; try { body = await req.json(); } catch { body = {}; }
      const tid = body.tid ? String(body.tid).slice(0, 24) : null;
      const genre = (body.genre && GENRE_STYLES[body.genre]) ? body.genre : null;
      const prefix = 'song:' + key + ':';
      const list = await env.HABLA.list({ prefix: tid ? prefix + tid + ':' : prefix, limit: 1000 });
      const entries = [];
      for (const k of list.keys.slice(0, 60)) {
        const parts = k.name.slice(prefix.length).split(':');
        if (parts.length < 2) continue;
        const v = await env.HABLA.get(k.name, { type: 'json' });
        if (v && v.url) entries.push({ tid: parts[0], genre: parts[1], title: v.title, url: v.url, lyrics: v.lyrics });
      }
      if (tid) return new Response(JSON.stringify({ ready: entries.map(e => e.genre) }), { headers: jcors });
      if (genre) return new Response(JSON.stringify({ tracks: entries.filter(e => e.genre === genre) }), { headers: jcors });
      const counts = {};
      entries.forEach(e => { counts[e.genre] = (counts[e.genre] || 0) + 1; });
      return new Response(JSON.stringify({ counts }), { headers: jcors });
    }

    if (req.method === 'POST' && op === 'song') {
      const jcors = { ...cors, 'Content-Type': 'application/json' };
      if (!env.EVOLINK_API_KEY) {
        return new Response(JSON.stringify({ status: 'unconfigured' }), { status: 501, headers: jcors });
      }
      let body;
      try { body = await req.json(); } catch { return new Response('not json', { status: 400, headers: cors }); }
      const tid = String(body.tid || '').slice(0, 24);
      const topic = String(body.topic || '').slice(0, 120);
      const teach = String(body.teach || '').slice(0, 1200);
      const genre = GENRE_STYLES[body.genre] ? body.genre : 'acoustic';
      if (!tid || !topic) return new Response('missing fields', { status: 400, headers: cors });
      const gkey = `song:${key}:${tid}:${genre}`;
      const evoAuth = { 'Authorization': 'Bearer ' + env.EVOLINK_API_KEY, 'content-type': 'application/json' };

      const cached = await env.HABLA.get(gkey, { type: 'json' });
      if (cached && cached.url) {
        return new Response(JSON.stringify({ status: 'ready', ...cached }), { headers: jcors });
      }
      if (cached && cached.task) {
        const r = await fetch('https://api.evolink.ai/v1/tasks/' + cached.task, { headers: evoAuth });
        const d = r.ok ? await r.json() : null;
        const st = d && (d.status || (d.data && d.data.status));
        const url = d && findAudioUrl(d);
        if (url) {
          const rec = { url, title: cached.title, lyrics: cached.lyrics };
          await env.HABLA.put(gkey, JSON.stringify(rec));
          return new Response(JSON.stringify({ status: 'ready', ...rec }), { headers: jcors });
        }
        if (st === 'failed' || st === 'error') {
          await env.HABLA.delete(gkey);
          return new Response(JSON.stringify({ status: 'failed' }), { headers: jcors });
        }
        return new Response(JSON.stringify({ status: 'pending' }), { headers: jcors });
      }

      // new song: Claude writes bilingual drill lyrics, then Suno (via EvoLink) sings them
      const lyr = await claudeJson(env, `Write song lyrics that TEACH Spanish to an English-speaking A2 learner. Topic: ${topic}.

Teaching content the lyrics must actually drill:
${teach}

STYLE MODEL — follow this pattern precisely. Bilingual drill lyrics: every Spanish form is glossed in English in the same line, forms are walked through systematically, lines rhyme and are short and singable:

[Verse]
Yo hago, I do, I make,
Yo hago un pastel, a cake I bake.
Tú haces, you do, él hace too,
Hacemos, hacen — that's what we do.
Yo hice, I did, tú hiciste it right,
Él hizo, hicimos, hicieron that night.

[Hook]
Hago, digo, doy, pongo, puedo, salgo!
I do, I say, I give, I put, I can, I go!

HARD RULES:
- NEVER pad lines by repeating the topic's name — every line must teach: a real Spanish form or rule from the teaching content, immediately glossed in English.
- Interleave: Spanish first, English meaning right after, in the same line.
- Walk the paradigm systematically (yo/tú/él/nosotros/ellos, or the rule's contrasting cases) with tiny example sentences from everyday Mexican life.
- End with a [Hook] that chains the key forms as a memorable list with English glosses, like the model above.
- Rhyme. Short lines. 24-40 lines total. [Verse]/[Chorus]/[Hook] tags. Mexican Spanish (no vosotros).

Return ONLY JSON, no fences: {"title":"short Spanish title (max 60 chars)","lyrics":"the tagged lyrics with \\n line breaks"}`, 2500, 'claude-sonnet-4-5-20250929');
      if (!lyr || !lyr.lyrics) return new Response(JSON.stringify({ status: 'failed' }), { headers: jcors });

      const gen = await fetch('https://api.evolink.ai/v1/audios/generations', {
        method: 'POST',
        headers: evoAuth,
        body: JSON.stringify({
          model: 'suno-v5-beta',
          custom_mode: true,
          instrumental: false,
          style: GENRE_STYLES[genre],
          title: String(lyr.title || topic).slice(0, 80),
          prompt: String(lyr.lyrics).slice(0, 4900),
          negative_tags: NEGATIVE_TAGS,
        }),
      });
      const gd = await gen.json().catch(() => null);
      const taskId = gen.ok && gd && (gd.id || (gd.data && gd.data.id));
      if (!taskId) {
        const code = gd && gd.error && gd.error.code;
        const reason = code === 'insufficient_quota' ? 'credits' : 'create';
        return new Response(JSON.stringify({ status: 'failed', reason }), { headers: jcors });
      }
      await env.HABLA.put(gkey, JSON.stringify({ task: taskId, title: lyr.title || topic, lyrics: lyr.lyrics }), { expirationTtl: 3600 });
      return new Response(JSON.stringify({ status: 'pending' }), { headers: jcors });
    }

    return new Response('method not allowed', { status: 405, headers: cors });
  },
};
