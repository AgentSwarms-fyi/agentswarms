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
ARG VITE_SUPABASE_PROJECT_ID
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_ADMIN_EMAIL
ENV VITE_SUPABASE_PROJECT_ID=$VITE_SUPABASE_PROJECT_ID \
    VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY \
    VITE_ADMIN_EMAIL=$VITE_ADMIN_EMAIL \
    NODE_ENV=production

# Produces a Node SSR build — the only build target (see vite.config.ts).
RUN npm run build

EXPOSE 8080

# `vite preview` serves the built TanStack Start server bundle on Node
# (client assets + SSR + all /api routes).
CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0", "--port", "8080", "--strictPort"]
