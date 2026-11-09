# Notebook runtime gateway — authenticated websocket bridge.
# The base is pinned by digest (R406, VA-25). The bare tag had frozen on
# whatever this host first pulled, two months old, with nothing to say so.
# Dependabot proposes the next digest weekly, and the image-scan workflow
# reads what it brings.
FROM node:22-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.mjs kernels.mjs ./
# npm is a build tool here: nothing in the running container calls it, and the
# copy the base image bundles carried this image's critical CVE (its own tar)
# and most of its fixable highs (R406, VA-25).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
# node:22-slim already ships a non-root `node` user at uid 1000 — reuse it
# rather than creating one (useradd -u 1000 fails: "UID 1000 is not unique").
USER node
EXPOSE 8090
CMD ["node", "index.mjs"]
