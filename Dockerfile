# AgentSwarms — the app image (Node).
#
# One image for every environment (R469). Nothing about an install is baked
# in: the browser's settings are read when the server STARTS, from PUBLIC_*
# (or VITE_*) in its environment, and handed to the page (R464,
# src/lib/publicConfig.ts). Server-side secrets (service-role key, provider
# keys, SMTP) are read at runtime too. So the image a release publishes
# (ghcr.io/agentswarms-fyi/agentswarms) is the same one Compose builds here:
#
#   docker compose up --build
#
# Two stages. The first installs everything and builds; the second keeps only
# what the server runs: the built bundle, the server's own modules and the
# production dependencies. No source tree, no dev dependencies (Vite,
# TypeScript, ESLint, Playwright), no npm. Before R469 all of that shipped.
#
# The base is pinned by digest (R406, VA-25). The bare tag had frozen on
# whatever this host first pulled, two months old, with nothing to say so.
# Dependabot proposes the next digest weekly, and the image-scan workflow
# reads what it brings. Both stages use the same one: the native modules
# (DuckDB) built in the first must run in the second.

# ── build ────────────────────────────────────────────────────────────────────
FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS build

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY . .

# A Node SSR build, the only build target (see vite.config.ts). No VITE_*
# here: whatever the bundle would have inlined comes from the server's
# environment at runtime instead.
ENV NODE_ENV=production
RUN npm run build

# Drop the dev dependencies, and prove nothing the server imports went with
# them: a runtime import of a dev-only package would otherwise pass the build
# and fail the first request that reaches it (scripts/check-runtime-imports).
RUN node scripts/check-runtime-imports.mjs --record /tmp/runtime-imports.json \
 && npm prune --omit=dev \
 && node scripts/check-runtime-imports.mjs --verify /tmp/runtime-imports.json

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

WORKDIR /app
ENV NODE_ENV=production

# A CA certificate bundle. node:22-slim ships none — Node carries its own
# root store, so every fetch() the app makes worked and nothing noticed — but
# DuckDB's httpfs is native OpenSSL and needs the system bundle. Without it
# every HTTPS request from the lakehouse engine fails with "Problem with the
# SSL CA cert (path? access rights?)": reading any cloud bucket (S3, GCS,
# Azure over https — the local MinIO is plain http, which is how this hid),
# and installing an extension once httpfs is loaded. Verified in the image:
# read_csv over https failed before, works after.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

# npm is a build tool here: nothing in the running container calls it, and the
# copy the base image bundles carried this image's critical CVE (its own tar)
# and most of its fixable highs (R406, VA-25).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# What the server runs, and nothing else. Owned by root and only read: the
# server writes nowhere under /app.
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server.mjs /app/serverCompression.mjs /app/serverDrain.mjs /app/serverGuards.mjs /app/serverSecurityHeaders.mjs /app/serverWorkers.mjs ./
COPY --from=build /app/scripts/bake-duckdb-extensions.mjs ./scripts/

# Which release this is. The release workflow passes the tag and commit; a
# local build says "dev". In a file, not the environment (R470): Compose hands
# the app the whole .env, whose AGENTSWARMS_VERSION says which release to RUN,
# and an environment variable here would be overwritten by it, so a checkout
# built under a release's name would claim to be that release. Monitoring
# reads this file; /api/health, which anyone can call, does not say.
ARG AGENTSWARMS_VERSION=dev
ARG AGENTSWARMS_REVISION=
RUN printf '{"version":"%s","revision":"%s"}\n' "$AGENTSWARMS_VERSION" "$AGENTSWARMS_REVISION" > /app/release.json

EXPOSE 8080

# Drop root.
#
# The one path the app WRITES is the egress allow-list directory, which compose
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
