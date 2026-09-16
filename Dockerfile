FROM oven/bun:1.3.14-alpine
WORKDIR /app

COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/github/package.json packages/github/
COPY apps/api/package.json apps/api/
RUN bun install --frozen-lockfile --production

COPY packages packages
COPY apps apps

USER bun
EXPOSE 8080
CMD ["bun", "apps/api/src/main.ts"]
