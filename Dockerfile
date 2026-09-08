# AgentSwarms — self-hosted image (Node).
#
# The client bundle needs the VITE_* Supabase values at BUILD time (they are
# inlined by Vite), so pass them as build args — docker-compose.yml wires them
# from your .env automatically. All server-side secrets (service-role key,
# provider keys, SMTP) are read at RUNTIME from the environment.
#
#   docker compose up --build
#
FROM node:22-slim

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY . .

# Client-side (build-time) configuration.
# EVERY VITE_* the code reads must be listed here. Vite substitutes them by
# literal text at BUILD time, so a missing one does not error — it resolves to
# undefined and the setting silently does nothing in the shipped image while
# working perfectly in `npm run dev`. tests/unit/viteBuildArgs pins this.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_ADMIN_EMAIL
ARG VITE_BI_SNAPSHOT_ROWS_CAP
ARG VITE_GA_ID
ARG VITE_GTM_ID
ARG VITE_NOTEBOOK_GATEWAY_PORT
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY \
    VITE_ADMIN_EMAIL=$VITE_ADMIN_EMAIL \
    VITE_BI_SNAPSHOT_ROWS_CAP=$VITE_BI_SNAPSHOT_ROWS_CAP \
    VITE_GA_ID=$VITE_GA_ID \
    VITE_GTM_ID=$VITE_GTM_ID \
    VITE_NOTEBOOK_GATEWAY_PORT=$VITE_NOTEBOOK_GATEWAY_PORT \
    NODE_ENV=production

# Produces a Node SSR build — the only build target (see vite.config.ts).
RUN npm run build

EXPOSE 8080

# A CA certificate bundle. node:22-slim ships none — Node carries its own
# root store, so every fetch() the app makes worked and nothing noticed — but
# DuckDB's httpfs is native OpenSSL and needs the system bundle. Without it
# every HTTPS request from the lakehouse engine fails with "Problem with the
# SSL CA cert (path? access rights?)": reading any cloud bucket (S3, GCS,
# Azure over https — the local MinIO is plain http, which is how this hid),
# and installing an extension once httpfs is loaded. Verified in the image:
# read_csv over https failed before, works after.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

# Drop root. `npm ci` and the build above need to write node_modules and dist,
# so this comes after them; from here the app only reads /app.
#
# The one path it WRITES is the egress allow-list directory, which compose
# mounts from the host. If that mount is not writable by uid 1000 the admin
# save reports "Could not write … Mount the egress config directory writable
# into the app container" and the settings still save — a legible failure
# rather than a silent one. Verified running non-root with a read-only root
# filesystem and a tmpfs /tmp: SSR and every API route work unchanged.
USER node

# DuckDB extensions, installed NOW rather than on the first lakehouse request.
# Measured on a fresh container: that first request spent 3.5 minutes fetching
# ~145 MB of extensions before running a query, and every restart, redeploy
# and new replica paid it again — an air-gapped install could not pay it at
# all. The engine's own INSTALL is a no-op once they are here. Runs as `node`
# because the cache lives under that user's home, which is where the engine
# looks at run time.
RUN node scripts/bake-duckdb-extensions.mjs

# server.mjs serves the built TanStack Start bundle: client assets, SSR and
# every /api route, forking one worker per CPU.
#
# This used to be `vite preview`, which Vite documents as a way to look at a
# production build locally. It worked, but it is a single Node process — one
# core of request handling however large the host — and it pulls the dev
# toolchain into the runtime. Measured on an 8-core box: SSR went from 19 to
# 55 req/s and p50 from 460ms to 127ms just by forking workers.
#
# Set WEB_CONCURRENCY=1 when running many small containers instead (one core
# each), so the workers do not fight over a fractional CPU quota.
CMD ["node", "server.mjs"]
