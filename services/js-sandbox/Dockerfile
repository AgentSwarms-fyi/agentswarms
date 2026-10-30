# AgentSwarms JS sandbox — runs user-authored Function/component snippets for
# HEADLESS swarm runs, isolated from the app process (which holds the
# service-role key and provider credentials).
#
# No dependencies on purpose: the whole service is two files on the Node
# standard library, so there is no third-party code in the process that
# executes user snippets.
# The base is pinned by digest (R406, VA-25). The bare tag had frozen on
# whatever this host first pulled, two months old, with nothing to say so.
# Dependabot proposes the next digest weekly, and the image-scan workflow
# reads what it brings.
FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
WORKDIR /app
COPY package.json ./
COPY server.mjs worker.mjs ./
# npm is a build tool here: nothing in the running container calls it, and the
# copy the base image bundles carried this image's critical CVE (its own tar)
# and most of its fixable highs (R406, VA-25).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
# node:22-slim ships a non-root `node` user at uid 1000 — reuse it (the same
# reason the notebook gateway does: useradd -u 1000 collides).
USER node
EXPOSE 8091
# The container is additionally run with a read-only root filesystem, all
# capabilities dropped, no-new-privileges and NO EGRESS — see the `js-sandbox`
# service in docker-compose.yml, which is where those are enforced.
CMD ["node", "server.mjs"]
