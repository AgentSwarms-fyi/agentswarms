# Notebook runtime gateway — authenticated websocket bridge.
FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.mjs ./
RUN useradd -m -u 1000 gateway
USER gateway
EXPOSE 8090
CMD ["node", "index.mjs"]
