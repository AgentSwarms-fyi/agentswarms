# Notebook runtime gateway — authenticated websocket bridge.
FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.mjs ./
# node:22-slim already ships a non-root `node` user at uid 1000 — reuse it
# rather than creating one (useradd -u 1000 fails: "UID 1000 is not unique").
USER node
EXPOSE 8090
CMD ["node", "index.mjs"]
