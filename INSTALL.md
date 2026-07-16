# AgentSwarms — Installation Guide

This guide walks through a complete local setup on **macOS**, **Linux**, and
**Windows** — installing dependencies, standing up your own Supabase
project (database, auth, storage), configuring environment variables, and
running the app.

AgentSwarms is a TanStack Start (React 19) app backed by Supabase
(Postgres + Auth + Storage), deployed to Cloudflare Workers. There is no
separate backend to install — Supabase _is_ the backend, and you run it as a
hosted (free-tier) project rather than installing Postgres yourself.

---

## 1. Prerequisites

| Requirement                                   | Version              | Why                                                                                                               |
| --------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Node.js**                                   | `20.19+` or `22.12+` | Required by Vite 7. Older Node 18 will fail to start the dev server.                                              |
| **npm** (bundled with Node) or **Bun** `1.1+` | —                    | Either works — both `package-lock.json` and `bun.lock` are committed. Use one consistently.                       |
| **Git**                                       | any recent           | to clone the repo                                                                                                 |
| **A Supabase account**                        | free tier is enough  | [supabase.com](https://supabase.com) — this is your database, auth, and file storage                              |
| **Supabase CLI**                              | `2.x`                | _(recommended, not strictly required)_ — the fastest way to apply the project's ~59 SQL migrations in one command |

Optional, but needed for a fully working app:

| Optional                                                                  | Why                                                                                                                                                       |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenRouter API key** ([openrouter.ai/keys](https://openrouter.ai/keys)) | Without it, nobody can chat with an agent until they add their own provider key under `/integrations`. With it, the app works zero-config for every user. |
| **OpenAI API key** ([platform.openai.com](https://platform.openai.com))   | Powers Knowledge Base embeddings (RAG / vector search). Without it, KB search silently falls back to keyword search.                                      |

### macOS

```bash
# Node (via nvm — recommended over the system/Homebrew Node so you can pin versions)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.zshrc   # or ~/.bashrc / ~/.bash_profile
nvm install 22
nvm use 22

# Git (skip if `git --version` already works — ships with Xcode Command Line Tools)
xcode-select --install

# Supabase CLI
brew install supabase/tap/supabase

# Bun (optional, only if you prefer it over npm)
curl -fsSL https://bun.sh/install | bash
```

### Linux (Ubuntu/Debian; adapt package manager for other distros)

```bash
# Node (via nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22
nvm use 22

# Git
sudo apt update && sudo apt install -y git

# Supabase CLI — a global `npm install -g supabase` is explicitly unsupported
# by Supabase, so use one of these instead:
#   Option A — Homebrew (works on Linux too, not just macOS):
brew install supabase/tap/supabase
#   Option B — no install needed, invoke on demand via npx:
#     npx supabase login
#     npx supabase link --project-ref <your-project-id>
#     npx supabase db push
#   Option C — grab the current Linux binary from the releases page and put
#   it on your PATH: https://github.com/supabase/cli/releases (look for the
#   linux_amd64 or linux_arm64 asset matching your CPU architecture).

# Bun (optional)
curl -fsSL https://bun.sh/install | bash
```

### Windows

**Use WSL2 (Windows Subsystem for Linux) — strongly recommended.** The
project's `build`/`build:dev` npm scripts set an env var inline
(`NODE_OPTIONS=--max-old-space-size=6144 vite build ...`), which is POSIX
shell syntax that **plain `cmd.exe` and native PowerShell cannot run
as-is**. `npm run dev` (the command you'll use day-to-day) doesn't have this
problem, but you'll hit it the first time you try `npm run build`. WSL2
sidesteps this entirely by giving you a real Linux shell, and it's also
generally the smoother path for Node tooling on Windows.

```powershell
# In an elevated PowerShell:
wsl --install -d Ubuntu
```

Reboot if prompted, open the **Ubuntu** app from the Start menu, create your
Linux user, then follow the **Linux** instructions above verbatim inside
that WSL shell. Clone the repo and run everything (`npm install`, `npm run
dev`, etc.) from within WSL, not from Windows PowerShell.

**If you'd rather stay on native Windows** (no WSL): install Node from
[nodejs.org](https://nodejs.org) (LTS ≥20.19) and Git from
[git-scm.com](https://git-scm.com), use **Git Bash** as your terminal (it
understands the POSIX env-var syntax above), and install the Supabase CLI
via `scoop install supabase` ([scoop.sh](https://scoop.sh)) or by
downloading the Windows binary from the
[Supabase CLI releases page](https://github.com/supabase/cli/releases). If
you use plain PowerShell instead of Git Bash, `npm run build` will fail
until you run it as:

```powershell
$env:NODE_OPTIONS="--max-old-space-size=6144"; npx vite build --sourcemap false
```

---

## 2. Clone the repo

```bash
git clone <your-fork-or-repo-url> agentswarms
cd agentswarms
```

## 3. Install dependencies

```bash
npm install
# or, if you prefer Bun:
bun install
```

---

## 4. Set up Supabase (the database, auth, and storage layer)

### 4.1 Create a project

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) → **New project**.
2. Pick an organization, name, database password (save it somewhere — you
   won't need it for this app directly, but Supabase asks), and region.
   Wait ~2 minutes for provisioning.
3. Once it's ready, go to **Settings → API** and note down three values —
   you'll need them in step 6:
   - **Project URL** (e.g. `https://xxxxx.supabase.co`)
   - **Project ID** (the `xxxxx` part of the URL)
   - **`anon` / `publishable` key**
   - **`service_role` key** (Settings → API → also under "Project API keys" —
     keep this one secret, it bypasses row-level security)

### 4.2 Apply the database schema (migrations)

The repo ships ~59 SQL migrations under `supabase/migrations/` that create
every table, RLS policy, Postgres function/trigger, index, and the
`avatars` storage bucket. They also enable the Postgres extensions the app
needs: `vector` (pgvector, for Knowledge Base embeddings), `pg_cron`,
`pg_net`, `pgmq`, and `supabase_vault` — all available on Supabase's hosted
free tier, no manual extension setup required.

**Recommended: Supabase CLI**

```bash
supabase login
supabase link --project-ref <your-project-id>   # the Project ID from 4.1
supabase db push                                 # applies all migrations, in order
```

`supabase link` rewrites `supabase/config.toml`'s `project_id` to point at
_your_ project — don't skip it, or `db push` will try to push to the
original project this repo was developed against.

**Alternative: manual, via the SQL Editor** (works but tedious for 59
files) — in the Supabase Dashboard, open **SQL Editor**, and run each file
under `supabase/migrations/` **in filename order** (the leading timestamp
is the sort key — oldest first). Paste each file's contents and run it
before moving to the next.

### 4.3 Configure Auth settings

In the Dashboard, go to **Authentication → URL Configuration**:

- **Site URL**: `http://localhost:8080` (the default `vite dev` port — check
  your terminal output in step 7, it'll tell you if a different port got
  picked because 8080 was busy)
- **Redirect URLs**: add `http://localhost:8080/**`

This makes email confirmation links and password-reset links redirect back
to your local dev server instead of failing or 404ing.

**Email delivery**: leave Supabase's **default built-in email sending**
enabled (Authentication → Emails) — it works out of the box for
confirmation and password-reset emails with no extra config, just rate-limited
for low volume, which is fine for development. If you want production-grade
delivery later, configure custom SMTP under **Authentication → Emails →
SMTP Settings**.

> **⚠️ Known limitation — social login.** The "Continue with Google/Apple"
> buttons on `/login` call a proprietary Lovable-platform SDK
> (`@lovable.dev/cloud-auth-js`, see `src/integrations/lovable/index.ts`)
> that relays OAuth through Lovable's own hosted service — it will **not**
> work in a self-hosted deployment. **Email/password signup and login work
> fully out of the box** (they go through plain Supabase Auth). If you want
> social login, you'd need to replace that file's OAuth call with Supabase's
> native `supabase.auth.signInWithOAuth({ provider: "google", ... })` and
> configure the provider under Authentication → Providers — not covered by
> this guide.

---

## 5. Configure environment variables

Copy the example file and fill it in:

```bash
cp .env.example .env
```

Open `.env` and fill in the values you collected in step 4.1 — every field
is documented inline in the file. In short:

- `SUPABASE_PROJECT_ID`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY` — from Settings → API (step 4.1). These are
  read by server-side code (API routes, server functions).
- `VITE_SUPABASE_PROJECT_ID`, `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_PUBLISHABLE_KEY` — **the same three public values again**,
  just `VITE_`-prefixed. Vite only inlines `VITE_`-prefixed vars into the
  browser bundle, so the client-side Supabase client needs its own copy.
  (Never put the service role key behind a `VITE_` prefix — that would ship
  a database-bypassing secret to every visitor's browser.)
- `OPENROUTER_API_KEY` — optional but recommended; makes the app usable
  with zero per-user setup. Get one at
  [openrouter.ai/keys](https://openrouter.ai/keys).
- `OPENROUTER_DEFAULT_MODEL`, `OPENROUTER_BASE_URL` — optional overrides,
  sensible defaults are pre-filled.
- `OPENAI_API_KEY` — optional; only needed if you want Knowledge Base (RAG)
  document search to use real vector embeddings instead of keyword search.
`ADMIN_EMAIL` — required for access admin dashboard of this app.(Only provided email id can able to access admin dashboard when login with that email)


`.env` is git-ignored — never commit it.

---

## 6. Run the app

```bash
npm run dev
# or: bun run dev
```

Vite will print the local URL (default `http://localhost:8080`, or the
next free port if that one's taken — match this to the Auth **Site
URL**/**Redirect URLs** you set in step 4.3 if it differs). Open it in a
browser.

## 7. Verify it's working

1. **Sign up** with an email/password at `/login`. You should either land
   straight in the app (if email confirmation is off) or see a "check your
   email" prompt — the confirmation email comes from Supabase's default
   mailer per step 4.3.
2. Go to **Agents** and create one (or pick one of the seeded sample
   agents), then open it in the **Playground** and send a message. If
   `OPENROUTER_API_KEY` is set, this should work immediately with no further
   configuration.
3. Open **Knowledge Base**, create one, and upload a document. If
   `OPENAI_API_KEY` is set, it gets embedded for vector search; otherwise it
   still works via keyword search.
4. Open **Swarms** and load one of the built-in templates to confirm the
   visual canvas and multi-agent execution work end-to-end.

If any of these fail, check your terminal's `vite dev` output and the
browser console first — most first-run issues trace back to a missing/typo'd
env var or a migration that didn't apply (re-run `supabase db push` if you
suspect the latter; it's safe to re-run, already-applied migrations are
skipped).

---

## 8. Production build (optional)

```bash
npm run build      # or: bun run build
npm run preview    # serve the production build locally to sanity-check it
```

On native Windows PowerShell/cmd (no WSL, no Git Bash), see the workaround
in the Windows prerequisites section above — the build script's inline
`NODE_OPTIONS=...` syntax needs a POSIX-compatible shell.

The deploy target is **Cloudflare Workers** (see `wrangler.jsonc`). Actual
deployment (`wrangler deploy`, Cloudflare account setup, secrets binding) is
outside the scope of this local-setup guide.

## Don't know about this app

**([Read offical docs](https://agentswarms.fyi/docs))**

This will help you more if you wants to understand app basic working. (Know about UI)


---
