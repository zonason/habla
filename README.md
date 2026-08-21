# Habla 🎙️

A one-tap launcher for Spanish voice-tutoring sessions with ChatGPT.
31 curriculum topics (A2/B1 → B2, Mexican Spanish) plus your own custom
weak-spot topics, per-person profiles, progress tracking, and mastery quizzes.

The app is a single static file: [`index.html`](index.html), served with GitHub Pages.

## How progress is stored

- **Always**: in each phone's browser storage (per device, per profile).
- **Optionally synced** across devices via a tiny Cloudflare Worker
  (free tier) in [`worker/`](worker/). Until the Worker is set up, the app
  simply works device-locally.

## Setting up sync (one time, ~5 minutes)

1. Create a free account at https://dash.cloudflare.com (no card needed).
2. Install Node and Wrangler, then log in:

   ```bash
   brew install node
   npm install -g wrangler
   wrangler login
   ```

3. Create the storage namespace and deploy, from the `worker/` folder:

   ```bash
   cd worker
   wrangler kv namespace create HABLA
   # copy the printed id into wrangler.toml (replacing REPLACE_WITH_KV_NAMESPACE_ID)
   wrangler deploy
   ```

   Wrangler prints your Worker URL, e.g. `https://habla-sync.<your-subdomain>.workers.dev`.

   **Optional — AI content generation for Added Items**: give the Worker an
   Anthropic API key (get one at https://console.anthropic.com) so that adding
   a weak spot in the app auto-generates its description, example, tutor
   instructions, and a real 5-question quiz:

   ```bash
   wrangler secret put ANTHROPIC_API_KEY
   ```

   (paste the key when prompted; it is stored encrypted on Cloudflare, never in git)

   **Optional — Radio (AI learning songs)**: the EvoLink key enables `/song`
   (Claude writes rhyming topic lyrics, Suno sings them). Ethan's key is in the
   macOS Keychain; deploy it with:

   ```bash
   security find-generic-password -a habla -s evolink-api-key -w | wrangler secret put EVOLINK_API_KEY
   ```

4. Invent a long random family key (this is effectively the password —
   anyone with the full URL can read/write the progress data):

   ```bash
   openssl rand -hex 16
   ```

5. On **each phone**, open the app, scroll to the footer, tap
   **Configurar sincronización**, and paste:

   ```
   https://habla-sync.<your-subdomain>.workers.dev/<your-random-key>
   ```

   Same URL on every device. Done — everyone's profiles now merge and sync.

## Development

No build step. Edit `index.html`, push to `main`, GitHub Pages redeploys.
