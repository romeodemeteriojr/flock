# Flock: a small scheduling app. Zero npm dependencies, so there is no install step.
# node:sqlite needs Node 22.5 or newer.
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-slim

WORKDIR /app

# Only what the app needs (no tests, docs, .git or data).
COPY package.json CHANGELOG.md ./
COPY bin ./bin
COPY src ./src
COPY web ./web

# The built-in "node" user is not root. It owns /data, where the database lives.
RUN mkdir -p /data && chown node:node /data
USER node

# The server listens on all interfaces by default, so no host setting is needed.
ENV NODE_ENV=production FLOCK_PORT=8080 FLOCK_DB=/data/flock.db FLOCK_SECURE_COOKIES=1

VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Exec form, so SIGTERM reaches the app and it shuts down gracefully.
CMD ["node", "bin/flock.js", "serve"]
