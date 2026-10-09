# syntax=docker/dockerfile:1.7
# ==============================================================================
# MULTI-STAGE DOCKERFILE: ORCHESTRATOR SERVICE
# ==============================================================================
# Purpose: Build optimized, secure, and reproducible Docker images for NestJS.
# Stages:
#   1. base        - Common base layer with Corepack and manifest files.
#   2. development - Hot-reloading environment for local development.
#   3. builder     - Compiles TypeScript into production JavaScript code.
#   4. runtime     - Hardened, non-root runtime image for Prod & Demo.
# ==============================================================================

# Global argument defining Node.js base image version across all stages
ARG NODE_VERSION=22-alpine

# ==============================================================================
# STAGE 1: base
# ==============================================================================
FROM node:${NODE_VERSION} AS base
WORKDIR /app

# Enable Node's Corepack to handle pnpm package manager automatically
RUN corepack enable

# Copy dependency manifests early to leverage Docker layer caching
COPY package.json pnpm-lock.yaml* .npmrc* pnpm-workspace.yaml* ./

# ==============================================================================
# STAGE 2: development
# ==============================================================================
FROM base AS development
ENV NODE_ENV=development

# Fast dependency installation utilizing BuildKit cache mounts for pnpm store
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Copy database schema and generate Prisma Client for TypeScript support
COPY prisma ./prisma
RUN pnpm exec prisma generate

# Setup initialization entrypoint script
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 4803
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["pnpm", "start:dev"]

# ==============================================================================
# STAGE 3: builder
# ==============================================================================
FROM base AS builder

# Install all dependencies (including devDependencies needed for TypeScript compilation)
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Copy NestJS & Prisma configuration files
COPY tsconfig.json tsconfig.build.json nest-cli.json prisma.config.ts* ./
COPY prisma ./prisma
RUN pnpm exec prisma generate

# Copy application source code and compile into JavaScript (dist folder)
COPY src ./src
RUN pnpm run build

# ==============================================================================
# STAGE 4: runtime (Production & Demo)
# ==============================================================================
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

# Security & Operations:
# 1. Create a dedicated non-root group/user ('app').
# 2. Install docker-cli (for proxy communication) and tini (PID 1 process manager).
# 3. OPS FIX: postgresql16-client provides `pg_dump`, required by the backup module
#    (BackupService) - it was missing, so every backup failed with ENOENT in the container.
RUN corepack enable \
    && addgroup -S app && adduser -S app -G app \
    && apk add --no-cache docker-cli tini postgresql16-client

ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml* .npmrc* pnpm-workspace.yaml* ./

# Build arguments specifying precise TypeScript execution tooling for DB seeding
ARG TS_NODE_VERSION=10.9.2
ARG TYPESCRIPT_VERSION=5.7.3

# Install production dependencies only, add seed tooling, and clean pnpm cache
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile \
    && pnpm add --save-prod ts-node@${TS_NODE_VERSION} typescript@${TYPESCRIPT_VERSION} \
    && rm -rf "$(pnpm store path)"

# Copy compiled JavaScript artifacts from the builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY prisma.config.ts* ./

# Configure startup script permissions and assign file ownership to 'app' user
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /app/generated /app/uploads /app/backups && chown -R app:app /app

# Enforce Security Best Practice: Run container as non-root user
USER app

EXPOSE 4803

# Container level healthcheck evaluating application readiness endpoint.
# OPS FIX: the previous command used backticks inside a shell-form CMD (interpreted by /bin/sh as
# command substitution) and the PUBLIC SERVER_URL, so the check never actually tested this
# container. It now probes the local port; /api/health answers 503 when the database is down.
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4803) + '/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Use tini as PID 1 to gracefully capture OS signals (e.g., SIGTERM) and avoid zombie processes
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/src/main.js"]