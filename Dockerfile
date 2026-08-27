# syntax=docker/dockerfile:1

# ─── build ───────────────────────────────────────────────────────────────────
# A separate stage so the TypeScript sources, dev dependencies and test files
# never reach the published image.
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Copy manifests first: this layer is cached until a dependency actually
# changes, so ordinary source edits skip the install entirely.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Reinstall with production dependencies only. `npm ci --omit=dev` on the
# existing tree prunes rather than re-resolving.
RUN npm ci --omit=dev && npm cache clean --force

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# tini reaps zombies and forwards signals, so SIGTERM reaches Node and the
# graceful shutdown path — draining in-flight replies — actually runs.
RUN apt-get update \
 && apt-get install --no-install-recommends -y tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/concierge.db

WORKDIR /app

# node:22 already provides an unprivileged `node` user (uid 1000).
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node public ./public
COPY --chown=node:node kb ./kb

# SQLite lives on a mounted volume; without one the database is lost on redeploy.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3000

# Uses the readiness endpoint, which also checks the database is reachable —
# a liveness-only check would report healthy with a broken database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
