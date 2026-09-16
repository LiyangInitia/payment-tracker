# Payment Request Tracker

A self-hosted replacement for the Claude Artifact + cloud routine that used to
sync this from Gmail. Same job, three free services instead of a recurring
Claude agent session:

- **GitHub Actions** — runs `scripts/gmail-sync.mjs` every 30 minutes. Plain
  Node script, no LLM involved, reads Gmail via the Gmail API and writes only
  the rows that changed to Supabase.
- **Supabase** — Postgres table (`payment_requests`) + auth, free tier.
- **Vercel** — hosts the static dashboard (`src/`), free tier.

## One-time setup

### 1. Supabase project
1. Create a project at supabase.com (or reuse an existing org — a second free
   project is fine, this data is unrelated to `zoho-stock-dashboard`).
2. Run the migration: SQL editor → paste `supabase/migrations/0001_init.sql` → Run.
3. Authentication → Users → **Add user** → `liyang@initia.sg` with a password.
   This is the only account the RLS policies in the migration allow to read or
   write `payment_requests`.
4. Project Settings → API → copy the **Project URL**, **anon public** key, and
   **service_role** key (the last one is secret — never put it in `VITE_*` or
   in the frontend).

### 2. Google Cloud — Gmail API access
1. console.cloud.google.com → new (or existing) project → **APIs & Services →
   Library** → enable **Gmail API**.
2. **APIs & Services → Credentials → Create Credentials → OAuth client ID** →
   type **Desktop app**. Note the client ID and secret.
   - If prompted, configure the OAuth consent screen first: **External**,
     add `liyang@initia.sg` as a test user, scope
     `https://www.googleapis.com/auth/gmail.readonly`.
3. Get a refresh token (one-time, doesn't expire unless revoked):
   ```
   cd payment-tracker
   GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... node scripts/get-refresh-token.mjs
   ```
   Open the printed URL, sign in as `liyang@initia.sg`, approve. The refresh
   token prints in the terminal.

### 3. GitHub repo + Actions secrets
1. Push this project to a new GitHub repo (public or private — a private repo
   is fine too; at 48 runs/day × well under a minute each, this stays far
   under the 2,000 free Actions minutes/month even on a private repo).
2. Repo → **Settings → Secrets and variables → Actions** → add:
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (from step 1.4)
   - `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` (from step 2)
3. The workflow (`.github/workflows/sync.yml`) starts running on its own schedule
   once these are in place, or trigger it manually from the Actions tab
   (workflow_dispatch) to test.

### 4. Vercel
1. Import this repo as a new Vercel project (framework auto-detects as Vite).
2. Project Settings → Environment Variables → add `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_ANON_KEY` (the **anon** key, not service_role).
3. Deploy. Sign in at the deployed URL with the Supabase user from step 1.3.

### 5. Retire the Claude routine
Once a few sync cycles have run cleanly and the numbers look right, delete the
`Payment Request Tracker — Gmail sync` routine at
https://claude.ai/code/routines so it stops firing (routines can only be
deleted from that page, not via the API). You can leave the old Claude
Artifact in place as a read-only historical snapshot, or just stop opening it.

## Local development

```
npm install
cp .env.example .env.local   # fill in VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
npm run dev
```

To test the sync script locally, copy the non-`VITE_` vars from `.env.example`
into a `.env` (or export them) and run `npm run sync`.

## Notes on fidelity vs. the old routine

The original routine's prompt had many small rules refined over time (50%
deposit/balance pairs, OCBC's two different sender addresses, near-miss
breadcrumbs, etc.) — `scripts/gmail-sync.mjs` reimplements the core logic
(intent+amount detection, loose-vendor dedup, OCBC advice matching, Accounts
slip fallback) as plain regex/string matching rather than an LLM reading the
email. That means:

- It's deterministic and free to run as often as you like.
- Edge cases the original prompt handled by "understanding" an unusually
  worded email (e.g. an amount written out in words, an oddly phrased
  disregard note) may need the regexes in `gmail-sync.mjs` extended over time
  — treat the first few weeks as a shakeout period and check the `notes`
  column for `(verify: ...)` flags the way you would have with the original.
- The "entity" field defaults to Initia International on new rows since it
  wasn't reliably parseable from the email body in the original prompt either
  (it relied on the LLM's broader context) — same manual correction step as
  before, just via the dashboard's edit form instead of the artifact's.
