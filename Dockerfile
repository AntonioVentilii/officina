FROM oven/bun:1.3.14-alpine
RUN apk add --no-cache su-exec
WORKDIR /app

COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/github/package.json packages/github/
COPY packages/runner/package.json packages/runner/
COPY packages/engine/package.json packages/engine/
COPY apps/api/package.json apps/api/
RUN bun install --frozen-lockfile --production

COPY packages packages
COPY apps apps
COPY agents agents
COPY docker/entrypoint.sh /usr/local/bin/officina-entrypoint

EXPOSE 8080
# The entrypoint starts as root only to open up the Fly identity socket, then runs the server as `bun`.
ENTRYPOINT ["officina-entrypoint"]
CMD ["bun", "apps/api/src/main.ts"]
