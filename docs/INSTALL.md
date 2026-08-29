# Installation guide

> Part of the [AgentSwarms docs](../README.md#documentation).

A complete local setup on **macOS**, **Linux**, and **Windows** — installing
dependencies, standing up your own Supabase project (database, auth,
storage), configuring environment variables, and running the app.

## 1. Prerequisites

| Requirement                                   | Version              | Why                                                                                                               |
| --------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Node.js**                                   | `20.19+` or `22.12+` | Required by Vite 7. Older Node 18 will fail to start the dev server.                                              |
| **npm** (bundled with Node) or **Bun** `1.1+` | —                    | Either works — both `package-lock.json` and `bun.lock` are committed. Use one consistently.                       |
| **Git**                                       | any recent           | to clone the repo                                                                                                 |
| **A Supabase account**                        | free tier is enough  | [supabase.com](https://supabase.com) — this is your database, auth, and file storage                              |
| **Supabase CLI**                              | `2.x`                | _(recommended, not strictly required)_ — the fastest way to apply the project's ~60 SQL migrations in one command |

Optional, but needed for a fully working app:

| Optional                                                                  | Why                                                                                                                                                       |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenRouter API key** ([openrouter.ai/keys](https://openrouter.ai/keys)) | Without it, nobody can chat with an agent until they add their own provider key under `/integrations`. With it, the app works zero-config for every user. |
| **OpenAI API key** ([platform.openai.com](https://platform.openai.com))   | Powers Knowledge Base embeddings (RAG / vector search). Without it, KB search silently falls back to keyword search.                                      |

#### macOS

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

#### Linux (Ubuntu/Debian; adapt package manager for other distros)

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

#### Windows

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

## 2. Clone and install

```bash
git clone https://github.com/AgentSwarms-fyi/agentswarms.git
cd agentswarms
npm install     # or: bun install
```

If you plan to contribute, fork it on GitHub first and clone your fork instead
— the rest of this guide is identical either way.

## 3. Set up Supabase (the database, auth, and storage layer)

There are two ways to get a Supabase backend. **Option A** (a free hosted
project on supabase.com) is the fastest and what the rest of this section
walks through. **Option B** runs Supabase on your own machine with Docker —
no account, nothing leaves your infrastructure, and a script does every step
for you.

### Option B — self-hosted Supabase (Docker, no account needed)

One command deploys the **entire solution**: it downloads and starts the
official Supabase Docker stack (Postgres, Auth, Storage, Realtime, the API
gateway and Studio), generates every secret and key, applies the schema,
creates your admin user, writes everything into the app's `.env`
automatically, and then installs and starts the app itself:

```bash
git clone https://github.com/AgentSwarms-fyi/agentswarms.git
cd agentswarms
bash scripts/setup-selfhosted.sh --all     # → app on :8080, Supabase on :8000
```

Prompts for your admin email and password (or pass them non-interactively):

```bash
ADMIN_EMAIL=you@corp.com ADMIN_PASSWORD='a-strong-one' bash scripts/setup-selfhosted.sh --all
```

What the script does, in order — each step is the automated version of the
manual walkthrough in
[DEPLOYMENT.md § Self-hosted Supabase](./DEPLOYMENT.md#self-hosted-supabase-complete-data-residency):

| Step                 | What happens                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Download & run**   | Clones the official `supabase/docker` stack into `supabase-docker/` (git-ignored) and starts it. First run pulls ~2 GB of images.                                                                      |
| **Generate secrets** | Postgres password, `JWT_SECRET`, and the `ANON` / `SERVICE_ROLE` API keys **signed from that secret** (HS256, locally — nothing leaves your machine), plus the Studio dashboard login and vault keys.  |
| **Wait properly**    | Waits for the auth service to answer **and for the storage service to finish its own boot migrations** — pushing the schema too early fails three migrations (see DEPLOYMENT.md § "Apply the schema"). |
| **Extensions**       | Ensures the five required Postgres extensions exist (`vector`, `pg_net`, `pg_cron`, `pgmq`, `supabase_vault`).                                                                                         |
| **Schema**           | Applies all migrations with `npx supabase db push --db-url ...` pointed at your own database.                                                                                                          |
| **Admin user**       | Creates your account via the auth admin API, email pre-confirmed, and sets it as `ADMIN_EMAIL` — the instance's bootstrap superadmin.                                                                  |
| **Wire the app**     | Writes `SUPABASE_URL`, both keys, the `VITE_` copies, `ADMIN_EMAIL`/`VITE_ADMIN_EMAIL` and `SITE_URL` into `.env` — nothing to copy by hand.                                                           |
| **Install & start**  | Hands over to `scripts/setup.sh` (same flags: `--all`, `--dev`, `--docgen`, ...) which installs dependencies, generates the remaining app secrets, and brings the stack up.                            |

Notes worth knowing before you run it:

- **Where things end up.** App: `http://localhost:8080`. Supabase API (Kong):
  `http://localhost:8000` — that URL and the generated keys are what landed in
  your `.env`. Supabase Studio: `http://localhost:8000` (user `supabase`,
  password in `supabase-docker/docker/.env`).
- **No "organisation/project" step.** Self-hosted Supabase has no dashboard
  org/project concept — the whole stack **is** one project. Where the hosted
  flow says "create a project and copy its keys", the script generates those
  keys and wires them in.
- **Re-running is safe.** An existing `supabase-docker/docker/.env` is reused,
  never regenerated — regenerating `JWT_SECRET` would invalidate every issued
  key. To start truly fresh: `cd supabase-docker/docker && docker compose down -v`,
  then delete the directory.
- **Windows:** run the script in **WSL** or **Git Bash** with Docker Desktop
  running.
- **Sizing:** budget roughly **+2 vCPU / +4 GB RAM / +20 GB disk** for the
  Supabase stack on top of the app's own requirements.
- **Before production:** TLS in front of both origins, keep Studio and
  Postgres off the public network, and back up Postgres **and**
  `PROVIDER_CREDS_SECRET` (a restored database cannot decrypt stored
  credentials without it). The full checklist is in
  [DEPLOYMENT.md § "Before you call it production"](./DEPLOYMENT.md#self-hosted-supabase-complete-data-residency).

If you used Option B, the script has already done everything in §3.1–§3.2 and
§4's Supabase values — skip ahead to [§4](#4-configure-environment-variables)
only if you want to add optional keys (model providers, email, search), then
continue at [§5](#5-run-the-app).

### Option A — hosted Supabase project (free tier)

#### 3.1 Create a project

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) → **New project**.
2. Pick an organization, name, database password (save it — you'll need it
   when linking the CLI), and region. Wait ~2 minutes for provisioning.
3. Once it's ready, go to **Project Settings → API Keys** (older projects:
   **Settings → API**) and note down four values — you'll need them in
   step 4:
   - **Project URL** (e.g. `https://xxxxx.supabase.co`)
   - **Project ID** (the `xxxxx` part of the URL — also shown as
     "Reference ID" under Project Settings → General)
   - **Publishable key** — starts with `sb_publishable_...` (on older
     projects this is the `anon` key, a long `eyJ...` JWT). Safe to expose
     to browsers.
   - **Secret key** — either the **legacy `service_role` JWT** (a long
     `eyJ...` string under the "Legacy API keys" tab — the most reliable
     choice) or a new-style `sb_secret_...` key. Click "Reveal" and copy it
     in full. Keep it secret — it bypasses row-level security.

   > ⚠️ **Don't mix the last two up** when filling `.env` in step 4. The
   > publishable key goes in `SUPABASE_PUBLISHABLE_KEY` **and** the `VITE_`
   > copies; the secret key goes **only** in `SUPABASE_SERVICE_ROLE_KEY`.
   > Swapping them is the #1 cause of an **"Invalid API key"** error at
   > signup.

#### 3.2 Apply the database schema (migrations)

The repo ships ~60 SQL migrations under `supabase/migrations/` that create
every table, RLS policy, Postgres function/trigger, index, and the
`avatars` storage bucket. They also enable the Postgres extensions the app
needs: `vector` (pgvector, for Knowledge Base embeddings), `pg_cron`,
`pg_net`, `pgmq`, and `supabase_vault` — all available on Supabase's hosted
free tier, no manual extension setup required.

**Recommended: Supabase CLI**

```bash
npx supabase login
npx supabase link --project-ref <your-project-id>   # the Project ID from 3.1
npx supabase db push                                 # applies all migrations, in order
```

`supabase link` records which remote project you're targeting (under the
git-ignored `supabase/.temp/` directory) — don't skip it, or `db push`
won't know where to push. The `project_id` in `supabase/config.toml` is
just a local name for the CLI; it ships pre-filled (`"agentswarms"`) and
you don't need to change it.

**Alternative: manual, via the SQL Editor** (works but tedious for ~60
files) — in the Supabase Dashboard, open **SQL Editor**, and run each file
under `supabase/migrations/` **in filename order** (the leading timestamp
is the sort key — oldest first). Paste each file's contents and run it
before moving to the next.

#### 3.3 Configure Auth settings

In the Dashboard, go to **Authentication → URL Configuration**:

- **Site URL**: `http://localhost:8080` (the default `vite dev` port — check
  your terminal output in step 5, it'll tell you if a different port got
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

> **Social login.** The "Continue with Google/Apple" buttons on `/login` use
> Supabase Auth's native `signInWithOAuth`. They work as soon as you enable
> the matching provider (with its client ID/secret) in your Supabase project
> under **Authentication → Providers**; until then they return a
> "provider is not enabled" error. **Email/password signup and login work
> fully out of the box.**

## 4. Configure environment variables

Copy the example file and fill it in:

```bash
cp .env.example .env
```

Open `.env` and fill in the values you collected in step 3.1 — every field
is documented inline in the file. In short:

- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY` —
  from step 3.1. These are read by server-side code (API routes, server
  functions).
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` — **the same two
  public values again**, just `VITE_`-prefixed. Vite only inlines
  `VITE_`-prefixed vars into the browser bundle, so the client-side Supabase
  client needs its own copy. (Never put the service role key behind a
  `VITE_` prefix — that would ship a database-bypassing secret to every
  visitor's browser.)

  > The **Project ID** from step 3.1 is not an environment variable. It is
  > passed straight to the CLI as `supabase link --project-ref <id>` in step
  > 3.3, which records it under `supabase/.temp/`. Nothing at runtime reads
  > it.

- `OPENROUTER_API_KEY` — optional but recommended; makes the app usable
  with zero per-user setup. Get one at
  [openrouter.ai/keys](https://openrouter.ai/keys).
- `OPENROUTER_DEFAULT_MODEL`, `OPENROUTER_BASE_URL` — optional overrides,
  sensible defaults are pre-filled.
- `OPENAI_API_KEY` — optional; only needed if you want Knowledge Base (RAG)
  document search to use real vector embeddings instead of keyword search.
- `FIRECRAWL_API_KEY` — optional; powers the agent `web_search` / `web_browse`
  tools workspace-wide. See [Web search & browsing](#web-search--browsing-optional)
  below for exactly what works with and without it.
- `ADMIN_EMAIL` + `VITE_ADMIN_EMAIL` — the one account email allowed to
  access the instance admin dashboard. Set both to the address you'll sign
  up with.

`.env` is git-ignored — never commit it.

**Outbound transactional email (optional).** Welcome emails, budget alerts,
BI alerts, scheduled reports, approval requests and the contact form send
through whichever transport you configure: `RESEND_API_KEY`
([resend.com](https://resend.com)), or
`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS` (any SMTP provider). Set
`EMAIL_FROM` and `SITE_URL` alongside either. **With neither configured, sends
are skipped and logged** (see the `email_send_log` table) — the app works fine
without email, so it's safe to skip this entirely for local dev. Auth emails
(confirmation, password reset) are unaffected — Supabase sends those itself
(step 3.3).

#### Setting up Resend with your own domain

`RESEND_API_KEY` on its own is **not enough**. Resend will only send from an
address on a domain you have verified, so both halves matter:

1. **Create the API key** — Resend dashboard → _API Keys_ → _Create_. Copy it
   into `RESEND_API_KEY`. It starts `re_`.
2. **Add your domain** — _Domains_ → _Add Domain_, e.g. `your-company.com`
   (a subdomain like `mail.your-company.com` is fine and keeps your main
   domain's reputation separate).
3. **Add the DNS records Resend shows you** — an MX record and TXT records for
   SPF and DKIM — at your DNS host, then press _Verify_. Propagation is usually
   minutes.
4. **Set `EMAIL_FROM` to an address on that domain**, in the form
   `AgentSwarms <noreply@your-company.com>`. The display name is optional but
   worth setting; the address must be on the verified domain.

```bash
RESEND_API_KEY="re_..."
EMAIL_FROM="AgentSwarms <noreply@your-company.com>"
SITE_URL="https://your-domain.com"
```

> [!IMPORTANT]
> **Two failure modes that look like nothing is wrong.**
>
> **Leaving `EMAIL_FROM` empty** falls back to `AgentSwarms
<noreply@example.com>`, which Resend rejects — every app email fails while the
> app carries on normally. The rejection is recorded in `email_send_log`, which
> is the first place to look when nobody is receiving mail.
>
> **Before a domain is verified**, Resend allows only `onboarding@resend.dev` as
> the sender, and delivers only to the email address that owns the Resend
> account. That is enough to smoke-test the templates and useless for real
> users — mail to anyone else is accepted by the API and never arrives.

`SITE_URL` matters more than it looks: every link in every email is built from
it. Leave it at `http://localhost:8080` in production and your users get emails
pointing at their own machine.

### Web search & browsing (optional)

Agents can be given two web tools in the agent editor (**Build → Agents → edit
→ Tools**): `web_search` (search the web) and `web_browse` (fetch one page as
clean markdown). How well they work depends on whether a key is configured —
**no key is required to start**, but the free fallback is limited:

| Setup                                                        | `web_search`                                                                                                                                           | `web_browse`                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| **No key** (default)                                         | Works, but falls back to DuckDuckGo's free Instant Answer API — only entity summaries + a few related topics, so thin/often empty for ordinary queries | Works via the **built-in fetcher** — server-rendered pages only, no JavaScript |
| **Firecrawl connector** (Integrations page → **Web Search**) | Real web search via [Firecrawl](https://firecrawl.dev) for every agent — key stored encrypted, no restart                                              | Full-page reads via Firecrawl                                                  |
| **`FIRECRAWL_API_KEY` in `.env`** (workspace-wide)           | Same as above, set via env instead of the UI                                                                                                           | Full-page reads via Firecrawl                                                  |
| **Per-agent key** (agent editor, no `.env` change)           | Bring your own **Brave / SerpAPI / Tavily** key                                                                                                        | Bring your own **ScrapingBee** or custom **Firecrawl** key                     |

#### The built-in fetcher (no key needed)

`web_browse` and **adding a URL to a knowledge base** both work without any key.
The built-in fetcher requests the page through the same SSRF guard described
below, strips navigation, headers, footers and cookie banners, and converts what
is left to markdown — including tables, which stay tables rather than being
flattened into prose.

**It does not run JavaScript.** That is the whole difference between it and
Firecrawl. A server-rendered page — documentation, a blog post, a licence, a
GitHub README, an RFC — converts cleanly. A client-rendered single-page app
returns its empty shell, because the text was never in the HTML the server sent.
When that happens the fetcher does not pretend: the result is marked `thin` and
carries a note saying the page is probably JavaScript-rendered and that Firecrawl
can read it. Knowledge-base ingestion refuses such a page outright rather than
saving a document that answers nothing.

Other limits worth knowing: 8 MiB per page, a 20-second timeout, HTML and plain
text only (a PDF or Office URL is refused rather than mangled), and no crawling
— one URL per call, no link-following.

So if web search "isn't really searching," that's the DuckDuckGo fallback — and
that is a category difference, not a quality one. The Instant Answer API returns
encyclopedia-style entries for recognised entities and has no ranked web results
at all, which is why ordinary queries come back empty however they are phrased.

Easiest fix: open **Integrations → Web Search**, paste a Firecrawl key (from
[firecrawl.dev](https://firecrawl.dev)) and click **Validate & Save** — it takes
effect immediately, no restart. You can also set `FIRECRAWL_API_KEY` in `.env`,
or give one agent its own key in the agent editor. Resolution order for the
built-in Firecrawl path is: per-agent key → `FIRECRAWL_API_KEY` → the
Integrations connector.

Every URL fetched by `web_browse` is chosen by the model — including by the
built-in fetcher — so it's routed through
the same SSRF guard as swarm HTTP nodes and connector tests: cloud instance
metadata / link-local addresses are always refused, and you can block all
private/internal targets with `BLOCK_PRIVATE_NETWORK_FETCH=true` (recommended
for public embeds / untrusted multi-tenant installs).

## 5. Run the app

```bash
npm run dev
# or: bun run dev
```

Vite will print the local URL (default `http://localhost:8080`, or the
next free port if that one's taken — match this to the Auth **Site
URL**/**Redirect URLs** you set in step 3.3 if it differs). Open it in a
browser.

## 6. Verify it's working

1. **Sign up** with an email/password at `/login`. You should either land
   straight in the app (if email confirmation is off) or see a "check your
   email" prompt — the confirmation email comes from Supabase's default
   mailer per step 3.3.
2. Go to **Agents** and create one (or pick one of the seeded sample
   agents), then open it in **Build → Agent Chat** and send a message. If
   `OPENROUTER_API_KEY` is set, this should work immediately with no further
   configuration.
3. Open **Knowledge Base**, create one, and upload a document. If
   `OPENAI_API_KEY` is set, it gets embedded for vector search; otherwise it
   still works via keyword search.
4. Open **Swarms** and load one of the built-in templates to confirm the
   visual canvas and multi-agent execution work end-to-end.

Product documentation for every feature ships inside the app at `/docs`.

## 7. Optional services (and how to start all of them)

The core stack is one container: the app. Three more services are optional
profiles, off unless you ask for them — and until now this guide only mentioned
one of the three.

| Service                     | Profile     | What you lose without it                                                                           |
| --------------------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| Document renderer           | `docgen`    | Deep-mode exports fall back to the in-browser builder (no native charts/tables)                    |
| JS sandbox                  | `sandbox`   | Function and custom-component nodes work on the canvas but fail in deployed / scheduled swarm runs |
| Developer-workspace runtime | `notebooks` | Notebooks run in the browser (Lite) only — no real CPython, no `pip install`                       |

**Start everything:**

```bash
bash scripts/setup.sh --all
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -All
```

Or with Compose directly:

```bash
docker compose --profile all up -d --build
```

Why they are opt-in rather than always on: the renderer image carries
LibreOffice (large), and the notebook runtime mounts the Docker socket into a
least-privilege proxy so it can start kernel containers. Neither is wrong to
run — both ship hardened — but they should be a decision, not a surprise.

**Confirm what is actually running:** sign in as the admin and open
**Observability → Monitoring**. It lists every service with its status and
response time. Optional services you chose not to start appear as "Not running"
in grey rather than as failures.

## 8. Optional: the Developer-workspace server runtime

The **Developer workspace** (`/notebooks`) runs notebooks on **secure server
kernels** — real CPython that can `pip install` and run the _real_ frameworks
(LangChain, LlamaIndex, LangGraph). It's off by default; a notebook shows a
short "runtime required" panel until an admin turns it on. To enable it:

1. Start the runtime services (one command, no env editing):
   ```bash
   docker compose --profile notebooks up -d --build
   ```
2. Sign in as the admin and open **Admin → Developer runtime** (in the sidebar).
   Flip **Enable server runtime** on — that's it. The app generates its own
   signing secret and defaults every internal URL to the compose service names.
   Optionally tune limits/egress or restrict access to specific users/groups,
   and hit **Run preflight** to confirm everything is reachable.
3. Open a notebook — a **Lite / Server** switch appears in the header. Switch to
   **Server** and run `import langchain`.

The first `--build` is slow (it installs the frameworks into the kernel image).
Everything is optional and off by default: instances that never run that command
are completely unaffected.

**Verify the install.** Rather than clicking around to find out whether it
works, run the end-to-end check — it validates the whole chain (socket-proxy,
kernel image, network, hardened kernel boot, Jupyter serving, the gateway
executing a real cell, and a kernel calling the platform back) and prints a
pass/fail report:

```bash
bash deploy/notebooks/test/verify-runtime.sh
```

Security model, hardening, scaling, and the full test procedure are in
[DEVELOPER_WORKSPACE_RUNTIME.md](./DEVELOPER_WORKSPACE_RUNTIME.md). The runtime
is **off by default**; instances that don't enable it are unaffected.

If any of these fail, check your terminal's `vite dev` output and the
browser console first — most first-run issues trace back to a missing/typo'd
env var or a migration that didn't apply (re-run `supabase db push` if you
suspect the latter; it's safe to re-run, already-applied migrations are
skipped).

## Troubleshooting first-run errors

**`npm run build` fails on Windows with `'NODE_OPTIONS' is not recognized as an
internal or external command`.** The build script sets a memory limit using the
POSIX `VAR=value command` form, which `cmd.exe` doesn't understand. Run it from
Git Bash or WSL, or set the variable first in your shell:

```bash
set NODE_OPTIONS=--max-old-space-size=6144 && npx vite build --sourcemap false
```

Docker builds are unaffected — the image builds on Linux.

**"Invalid API key" when signing up or logging in.** The publishable and
secret keys are swapped (or one was truncated when copying) in `.env`.
`SUPABASE_PUBLISHABLE_KEY` and both `VITE_SUPABASE_*_KEY` vars must hold
the `sb_publishable_...` (or legacy `anon`) key — the secret key belongs
**only** in `SUPABASE_SERVICE_ROLE_KEY`. You can verify a key without the
app:

```bash
curl -H "apikey: YOUR_PUBLISHABLE_KEY" https://YOUR_PROJECT_ID.supabase.co/auth/v1/health
# HTTP 200 → key is valid for this project
```

Remember to restart `npm run dev` after editing `.env`.

**Server-side features fail with 401 / "Invalid API key" even though the
publishable key works.** Your `SUPABASE_SERVICE_ROLE_KEY` is bad — commonly
a truncated copy (they're easy to cut off), a key copied from a
_different_ Supabase project's dashboard, or a new-style `sb_secret_...`
key that has been rolled. The reliable fix: in **Project Settings → API
Keys → Legacy API keys**, copy the **`service_role` JWT** (a ~200+
character `eyJ...` string) and use that as `SUPABASE_SERVICE_ROLE_KEY` —
and double-check the dashboard URL contains _your_ project ref before
copying.

**`Missing required field in config: project_id` from `supabase db push`.**
`supabase/config.toml` must contain a non-empty `project_id`. It ships
pre-filled with `"agentswarms"` (the value is just a local label — your
real project is selected by `supabase link`); restore it if it got blanked.

**`failed to parse environment file: .env (unexpected character ...)`.**
Your editor saved `.env` with a UTF-8 BOM (byte-order mark), which the
Supabase CLI can't parse. Re-save it as plain UTF-8 **without** BOM — in
VS Code: click the encoding in the status bar → "Save with Encoding" →
"UTF-8". (On Windows, `Set-Content -Encoding utf8` in Windows PowerShell
5.x writes a BOM — use an editor or PowerShell 7+ instead.)

**"PROVIDER_CREDS_SECRET is not configured" when saving a warehouse
connection, secret, or Data Catalog source.** Stored credentials are
AES-256-GCM encrypted with a key derived from the `PROVIDER_CREDS_SECRET`
env var, and it has no default. Add any long random string to `.env`
(e.g. `openssl rand -hex 32`) and restart `npm run dev`. Rotating the
value later invalidates previously saved credentials — re-enter them.

**"Unsupported provider: lovable_ai" when messaging an agent.** Your
database schema predates the `20260719000000_fix_new_user_seed_provider`
migration (the signup trigger used to seed sample agents on a provider
that only exists on the hosted platform). Run `npx supabase db push` —
it updates the trigger and repairs already-created agents.

**Changes to `.env` not taking effect.** Vite bakes `VITE_*` values into
the bundle when the dev server starts. Stop it (Ctrl+C), run
`npm run dev` again, and hard-refresh the browser (Ctrl+Shift+R).
