# syntax=docker/dockerfile:1.7
#
# Production image for the BackOS orchestrator itself (the app that CONTAINS
# generator.controller.ts / docker-runtime-manager.service.ts - not a generated backend).
#
# Adjust the COPY paths below if your repo layout differs - this assumes the standard NestJS
# layout matching generated-project.templates.ts (package.json, prisma/schema.prisma,
# tsconfig.json, nest-cli.json, src/) at the repository root.
#
# NOTE: this image needs the `docker` CLI (not a full Docker daemon - see docker-compose.prod.yml,
# it talks to docker-proxy over TCP, never mounts /var/run/docker.sock) so
# DockerRuntimeManagerService can shell out to `docker build` / `docker run` / `docker network ...`.

FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* .npmrc* pnpm-workspace.yaml* ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json nest-cli.json prisma.config.ts* ./
COPY prisma ./prisma
RUN pnpm exec prisma generate
COPY src ./src
RUN pnpm run build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN corepack enable \
    && addgroup -S app && adduser -S app -G app \
    # Docker CLI ONLY (no dockerd) - talks to DOCKER_HOST (the docker-socket-proxy service, see
    # docker-compose.prod.yml) over plain TCP. This user never touches /var/run/docker.sock and
    # is not in a "docker" group - it has no more host access than the socket proxy grants it.
    && apk add --no-cache docker-cli

ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml* .npmrc* pnpm-workspace.yaml* ./
RUN pnpm install --prod --frozen-lockfile \
    && rm -rf "$(pnpm store path)"
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# Directory generated platforms are scaffolded into. In production this is overshadowed by the
# identity bind mount configured in docker-compose.prod.yml (GENERATED_PROJECTS_HOST_PATH) - see
# that file's comment on the DooD (Docker-outside-of-Docker) path-matching requirement. Created
# here only so the image is self-contained for local `docker run` testing without the mount.
RUN mkdir -p /app/generated && chown app:app /app/generated

USER app
EXPOSE 4803
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:4803/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/main.js"]
