# ironvim — standalone deploy

Four files, no build step: `index.html`, `manifest.json`, `icon.svg`, `sw.js`.

## Local development

Start the Vite development server with:

```sh
npm run dev
```

Vite allows `jalapeno.local` as a development host, so the app is available at
`http://jalapeno.local:5173` when that hostname resolves to your machine.

## Fastest: Netlify Drop (no account required to try, free account to keep the link)
1. Go to https://app.netlify.com/drop
2. Drag the whole folder onto the page.
3. You get a live `https://random-name.netlify.app` URL immediately.
4. (Optional) Create a free Netlify account to claim the site permanently and rename it.

## GitHub Pages (free, tied to a GitHub repo)
1. Create a new GitHub repo, push these 4 files to it.
2. Repo Settings → Pages → Source: "Deploy from branch" → `main` / `root`.
3. Your site is live at `https://<username>.github.io/ironvim/`.

## Vercel (free)

The project is a static site with no build step. The included `Makefile` uses
the Vercel CLI through `npx`, so a global install is not required.

```sh
# Confirm the Vercel account and available team scopes.
make vercel-whoami
make vercel-teams

# Create and link the project on the first deployment.
make vercel-init

# Deploy a preview.
make deploy

# Publish the current directory to production.
make deploy-prod
```

The defaults target the `floresjs-projects` scope and the `ironvim` project.
Override them when needed:

```sh
make deploy-prod VERCEL_SCOPE=my-team VERCEL_PROJECT=my-project
```

The equivalent direct commands are:

```sh
npx --yes vercel@latest whoami
npx --yes vercel@latest teams ls
npx --yes vercel@latest --yes --scope floresjs-projects --name ironvim
npx --yes vercel@latest --yes --scope floresjs-projects --prod
```

The production site is available at `https://ironvim.vercel.app`.

All three give you HTTPS automatically, which is required for "Add to Home Screen" to behave like an app.

### Supabase magic-link redirects

In Supabase, open **Authentication → URL Configuration** and set:

- **Site URL:** `https://ironvim.vercel.app`
- **Additional Redirect URLs:**
  - `https://ironvim.vercel.app`
  - `http://jalapeno.local:5173`
  - `http://localhost:5173`

The production app explicitly requests `https://ironvim.vercel.app` when sending
a magic link. If Supabase still redirects to `localhost:3000`, replace the
project's Site URL and remove the stale localhost URL from the email template or
redirect configuration.

## Installing on your phone
- **iPhone:** open the URL in Safari → Share icon → "Add to Home Screen."
- **Android:** open the URL in Chrome → ⋮ menu → "Add to Home screen" / "Install app."

It'll launch full-screen without browser chrome, and your log/settings persist in the phone's local storage between visits.

## Notes / limitations
- Data is stored per-device (`localStorage`), not synced across phone/laptop. If you want cross-device sync later, that needs a small backend (e.g. a free Supabase project) — happy to wire that up if you want it.
- The app loads React from a CDN on first visit and caches it for offline use after that; the very first load needs a network connection.
- Clearing your phone browser's site data / "Clear all data" will wipe your logged workouts — there's no cloud backup by default.

## Cloud sync (Supabase)

The log is local-first: `localStorage` is the read path and the offline write buffer, and
Supabase is a sync target behind it. Without an account — or with sync unconfigured — the app
behaves exactly as it does offline.

### One-time setup

1. Create a Supabase project. Copy the project URL and the **publishable** key
   (`sb_publishable_…`) from Project Settings → API. The legacy `anon` JWT is deprecated.
2. Apply `supabase/migrations/0001_init.sql` (dashboard SQL editor is fine). It creates the
   `logs` table, enables RLS with per-user policies, and adds the `revision` bump trigger.
3. Fill in `supabase-config.js`. **This file is public on purpose** — it ships in the page
   source. The security boundary is Row Level Security, not secrecy of the key. Verify RLS is
   on before deploying.
4. Auth → Providers → Email: enable email.
5. Auth → Email Templates → **Magic Link**: replace the body with the token, or no code is
   ever sent:
   ```html
   <h2>ironvim sign-in code</h2>
   <p>{{ .Token }}</p>
   ```
   Codes rather than links, because a magic link opens in Safari — outside the installed PWA.

### Signing in

ACCOUNT panel → email → 6-digit code. Once per device; the session refreshes itself after that.

> Supabase's built-in email sender allows **2 emails per hour**. Mistype the code twice and you
> wait an hour. Configure custom SMTP (e.g. Resend) to lift the cap — no client changes needed.

### Conflicts

Each device tracks the `revision` its text is based on. If the cloud moved on, the push is
rejected rather than applied, and you choose: **keep mine**, **use cloud**, or **keep both** —
which appends the cloud copy under a `=== cloud copy … ===` marker. That marker doesn't parse
as an exercise, so it shows up as its own session in PARSED SESSIONS, visible and editable.
Nothing is ever silently overwritten.

## Tests

`make test` — parser/grammar regressions, the sync state machine against a stubbed PostgREST
client, and a jsdom mount of the real UI. No browser or network required.
