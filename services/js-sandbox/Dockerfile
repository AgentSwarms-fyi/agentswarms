# AgentSwarms JS sandbox — runs user-authored Function/component snippets for
# HEADLESS swarm runs, isolated from the app process (which holds the
# service-role key and provider credentials).
#
# No dependencies on purpose: the whole service is two files on the Node
# standard library, so there is no third-party code in the process that
# executes user snippets.
FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY server.mjs worker.mjs ./
# node:22-slim ships a non-root `node` user at uid 1000 — reuse it (the same
# reason the notebook gateway does: useradd -u 1000 collides).
USER node
EXPOSE 8091
# The container is additionally run with a read-only root filesystem, all
# capabilities dropped, no-new-privileges and NO EGRESS — see the `js-sandbox`
# service in docker-compose.yml, which is where those are enforced.
CMD ["node", "server.mjs"]
