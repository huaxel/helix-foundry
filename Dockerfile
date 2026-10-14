FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.7.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm build:server
FROM node:24-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.7.0 --activate
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data && chown node:node /data
# util-linux provides `unshare`, which the streaming executor uses to give each
# query its own isolated user+mount namespace (see compose.stream.yaml). Harmless
# for materialize-only deployments.
RUN apt-get update && apt-get install -y --no-install-recommends util-linux \
  && rm -rf /var/lib/apt/lists/*
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 DATA_DIR=/data
EXPOSE 3001
CMD ["node","dist/apps/api/src/server.js"]
