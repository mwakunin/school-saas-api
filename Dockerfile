# syntax=docker/dockerfile:1

# Node 24: matches CI, and is what the test suite actually runs against.
ARG NODE_VERSION=24-alpine

# --- deps -------------------------------------------------------------------
# Full install (dev included) purely to compile. None of it reaches the final
# image.
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# --- build ------------------------------------------------------------------
FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The compilers are already in node_modules, so this stage needs neither
# corepack nor the network — invoking them directly keeps a package-manager
# download off the critical path. Mirrors the "build" script in package.json:
# tsc emits JS, tsc-alias rewrites the "@/*" paths Node cannot resolve.
RUN ./node_modules/.bin/tsc && ./node_modules/.bin/tsc-alias

# --- production dependencies ------------------------------------------------
# Resolved separately so the runtime image never contains a compiler.
# (`pnpm prune --prod` over the deps tree looks like it would save a round
# trip, but it re-resolves against the registry anyway, so it buys nothing.)
FROM node:${NODE_VERSION} AS prod-deps
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# --- runtime ----------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production

# The database is expected in UTC, and Better Auth's session columns are
# `timestamp` without a zone — so the process must not drift from it.
ENV TZ=UTC

# env.ts requires LOG_LEVEL and gives it no default, which is right for a
# checkout — .env.example sets it — but wrong for an image, which has no .env
# to read. Without this the container exits before serving anything, and every
# command that runs from this image fails the same way, the reconciliation
# sweep included. An operational knob with a sane production value belongs
# with NODE_ENV and TZ above; override it at run time like any other.
ENV LOG_LEVEL=info

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# .sql files are data, not compiled output, so tsc leaves them behind. The
# deploy-time migrator reads them from this path.
COPY src/db/migrations ./src/db/migrations

# Drop root before running anything.
USER node

EXPOSE 9999

# /health checks the database too, so an unreachable DB fails the container
# rather than serving traffic that cannot work.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9999)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations are deliberately NOT run here: with more than one instance they
# would race. Run them as a separate release step, using this same image:
#
#   docker run --rm --env-file .env.production <image> \
#     node ./dist/src/db/migrate.js
#
# Invoked through node, not pnpm — this stage has no package manager, and
# adding one just to launch a script that node can run directly would be
# weight for nothing. `pnpm db:migrate:deploy` is the same command, for
# contexts that do have pnpm.
CMD ["node", "./dist/src/index.js"]
