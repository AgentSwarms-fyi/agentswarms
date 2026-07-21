# Production deployment

> Part of the [AgentSwarms docs](../README.md#documentation).

There are two supported targets. **Docker (Node) is the primary path.**

## Docker (recommended)

The repo ships a `Dockerfile` + `docker-compose.yml`. With your `.env`
filled in (step 4) and migrations applied (step 3.2):

```bash
docker compose up --build
# → http://localhost:8080
```

How it works: the `VITE_*` values are inlined into the client bundle at
image build time (compose passes them as build args from your `.env`);
everything else — service-role key, provider keys, SMTP — is read at
runtime from the environment. The container builds a plain Node SSR bundle
(`DEPLOY_TARGET=node` skips the Cloudflare plugin) and serves it with
`vite preview` on port 8080. Any Docker host works: a VPS, Kubernetes,
Fly.io, Railway, Render.

To rebuild after changing `VITE_*` values, run
`docker compose up --build` again (they're baked at build time).

## Cloudflare Workers (secondary)

The repo also keeps a Workers config (`wrangler.jsonc`); the default
`npm run build` (without `DEPLOY_TARGET=node`) produces a Workers build.

```bash
npm run build
npx wrangler deploy
```

Set your secrets first (`npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY`,
etc. — every non-`VITE_` variable in `.env.example`). Note that the SMTP
mailer option doesn't run on Workers (no raw TCP for nodemailer) — use
`RESEND_API_KEY` there instead.

## Bare Node (no Docker)

```bash
DEPLOY_TARGET=node npm run build
npm run preview -- --host 0.0.0.0 --port 8080
```

On native Windows PowerShell/cmd (no WSL, no Git Bash), see the workaround
in the Windows prerequisites section above — the build script's inline
`NODE_OPTIONS=...` syntax needs a POSIX-compatible shell.

