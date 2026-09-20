# BackOS - Project Documentation

Single entry point for all project documentation. If you don't know where to start, start here.

## 1. What exactly is this project?

This is **not** a classic business API — it is a **backend generator**.

A user models entities, fields, and relationships through the interface; the `generator` module transforms this model into a real NestJS + Prisma project generated on disk, with its own CRUD routes, its own dedicated PostgreSQL database, and the ability to run either as a native process or as an isolated Docker container.

The `gateway` module then routes public traffic from `/generated/<slug>/...` to the appropriate generated backend.

This is a "meta" system (the backend generates and executes code on behalf of the user), which means it has a larger attack surface than a conventional CRUD application. The architecture takes this into account in several areas (per-platform network isolation, a restricted `docker-socket-proxy`, and dedicated PostgreSQL users for each platform).

## 2. Technology Stack

| Layer                       | Choice                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------- |
| Backend framework           | NestJS 11                                                                              |
| ORM / Database              | Prisma 7 + PostgreSQL 16                                                               |
| Queue / Cache               | BullMQ + Redis 7                                                                       |
| Authentication              | JWT (access + rotating refresh tokens), optional MFA/TOTP                              |
| Public reverse proxy        | Traefik (automatic Let's Encrypt TLS)                                                  |
| Generated backend isolation | Native process OR dedicated Docker container (configurable)                            |
| CI/CD                       | GitHub Actions (lint, build, tests, `pnpm audit`, Gitleaks, Trivy, CodeQL, Dependabot) |

## 3. Module Map (`src/`)

| Domain                    | Folder(s)                                                            | Role                                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication & Security | `auth/`, `common/guards/`, `common/services/` (MFA, TOTP, crypto)    | Login, refresh, brute-force protection, MFA                                                                                                           |
| Authorization             | `permissions/`, `roles/`, `common/constants/permissions.constant.ts` | RBAC, permission ↔ database synchronization                                                                                                           |
| Modeling                  | `entities/`, `fields/`, `relations/`                                 | What the user models for their backend                                                                                                                |
| Generation                | `generator/` (29+ files)                                             | The core of the product: dynamic Prisma schema, generated CRUD, database provisioning, runtime orchestration (native process or Docker), API manifest |
| Platform Lifecycle        | `platforms/`                                                         | Create/archive/restore/permanently delete generated platforms                                                                                         |
| Public Gateway            | `gateway/`                                                           | Routes `/generated/<slug>/...` to the appropriate generated backend — see `src/gateway/GATEWAY_README.md`                                             |
| Management                | `clients/`, `projects/`, `planning/`, `messages/`                    | Business features around platforms (billing, recurring planning, internal messaging)                                                                  |
| Files                     | `files/`                                                             | Uploads with both declared MIME type **and** actual binary signature (magic bytes) validation                                                         |
| Backups                   | `backup/`                                                            | Database dumps and automatic cleanup of unclaimed files                                                                                               |
| Scheduled Cleanup         | `cleanup/`                                                           | Daily task (3:00 AM): expired tokens, expired OTPs, failed generations, and platforms archived for more than 30 days (see §5)                         |
| Audit                     | `audit/`                                                             | Log of sensitive actions                                                                                                                              |
| Email                     | `email/`                                                             | Notifications (invitations, OTPs, alerts)                                                                                                             |

## 4. Security Model — What Has Already Been Verified

Summary of what currently holds true, based on code inspection rather than assumptions:

* **Inputs**: strict global validation (`whitelist`, `forbidNonWhitelisted`); no SQL injection was found (dynamic identifiers are always escaped/truncated); no shell commands are constructed through string concatenation (`execFile`/`spawn` with argument arrays are used throughout).

* **Uploaded files**: both the declared type **and** the actual binary signature are verified before writing; filenames stored on disk are always server-generated UUIDs (never the name provided by the client).

* **Authentication**: single-use refresh-token rotation, account-based brute-force protection (not only IP-based), and constant-time comparison for recovery codes.

* **Multi-tenant isolation**: each generated platform running in Docker has its own network; Docker sockets are never mounted directly into an application container (access is always through `docker-socket-proxy`, with restricted permissions — `EXEC=0`, `SECRETS=0`, `VOLUMES=0`).

* **Built-in security check**: `src/common/route-permission-audit.spec.ts` causes CI to fail if a route is added without explicitly declaring its permission (`@RequirePermissions`, `@Public()`, or a justified entry in `MANUALLY_CHECKED_ROUTES`). **Run this test after adding any route** — it is the project's best automatic safety net.

* **Public demo**: the `demo` account (`prisma/seed-demo.ts`) only has read permissions, and its container has **no** access to the `docker-socket-proxy` (deliberately removed — see `deploy/docker-compose.demo.yml`). Even if code execution were compromised inside this container, there is no technical path to the rest of the host.

**Known unresolved weakness**: test coverage is still low. See `TESTS_COVERAGE_AUDIT.md` for the exact module-by-module status and action plan.

## 5. Platform Archiving and Deletion

`DELETE /platforms/:id` archives the platform (it does not delete anything — it only stops the runtime if it was running).

An archived platform is **automatically and permanently deleted after 30 consecutive days of being archived** (generated files + database record; configurable through `PLATFORM_ARCHIVE_RETENTION_DAYS`) by the scheduled task in `cleanup/`.

Restoring the platform (`PATCH /platforms/:id/restore`) before the deadline cancels the countdown. If it is archived again later, a new 30-day countdown starts from zero.

`DELETE /platforms/:id/permanent` forces the immediate deletion of an already archived platform without waiting for the 30-day retention period.

## 6. Deployment Tooling Status — Important

Read this section before choosing a deployment mode.

After thoroughly reviewing this directory, several real inconsistencies between the tooling (`scripts/stack.sh`, `Makefile`, `.env.*.example` files) and the files actually present were found and fixed:

* **`docker-compose.yml` (root)** was referenced by `scripts/stack.sh` and `.env.development.example` for the `dev` stack, but was missing from the repository. It has been recreated (PostgreSQL + Redis only; the application runs natively through `pnpm run start:dev`, see `DEPLOIEMENT_DEV.md`).

* **`scripts/stack.sh` had no `local` target**, even though `.env.local.example` and the header of `deploy/docker-compose.local.yml` both promised `./scripts/stack.sh up local`. This has been fixed; the target now exists (`up_local` / `down` / `logs` / `nuke`).

* **Two files solve the same problem** ("run the backend privately, without a public domain or TLS") without referencing each other: `deploy/docker-compose.local.yml` (`.env.local`, not connected to a tool used on a daily basis) and `deploy/docker-compose.lan.yml` (`.env.lan`, actually controlled by the Windows tray — `deploy/backend-tray.ps1` / `start-backend.bat`).

  **This guide documents `lan.yml` as the reference path** (see `DEPLOIEMENT_LAN.md`) because it is the only one connected to a tool that is actually used on a daily basis.

  `local.yml` remains functional (and can now be launched through `make up-local`) but is redundant. It should eventually be consolidated or removed once one of the two becomes unnecessary, rather than maintaining both indefinitely in parallel.

## 7. Each Deployment Mode in Detail

| Documentation                      | What it covers                                                                                 | Intended use                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `DEPLOIEMENT_DEV.md`               | Development workstation (hot reload, PostgreSQL/Redis in containers, native application)       | Daily development and coding                                  |
| `DEPLOIEMENT_LAN.md`               | Stable private instance on a local network, controllable through a Windows system-tray icon    | Personal/internal use, no public domain                       |
| `DEPLOIEMENT_DEMO.md`              | Public instance with a read-only account, intended to demonstrate the project to third parties | Presentations, client demos                                   |
| `DEPLOIEMENT_PRODUCTION.md`        | Full public instance for real-world use                                                        | Official deployment                                           |
| `DEPLOIEMENT_WIREGUARD.md`         | Self-hosted encrypted VPN tunnel for remotely accessing a private instance                     | Remote access without public exposure                         |
| `DEPLOIEMENT_INTERNE_TAILSCALE.md` | Alternative to WireGuard that was rejected (third-party dependency)                            | Historical reference explaining why this option was abandoned |

## 8. Combining Multiple Modes into a Single Deployment

| Documentation                                 | Combination                                                    | Use case                                                                                  |
| --------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `DEPLOIEMENT_COMBINE_LAN_DEMO_WIREGUARD.md`   | LAN (+ tray) + Demo + WireGuard, on **a single machine**       | You only have one server PC and want both a protected private instance and a public demo  |
| `DEPLOIEMENT_COMBINE_DEMO_PRODUCTION.md`      | Demo + Production, coexisting behind the same Traefik instance | Run a public demo and the actual production instance on a single server                   |
| `DEPLOIEMENT_COMBINE_PRODUCTION_WIREGUARD.md` | Public Production + admin access through WireGuard             | Keep production public for users while protecting administrative/debug access through VPN |

## 9. Tests

`TESTS_COVERAGE_AUDIT.md` — actual test coverage status, broken down by module, with a prioritized action plan.

## 10. Other Useful Documentation Elsewhere in the Repository

* `src/gateway/GATEWAY_README.md` — how `/generated/<slug>/...` routing works.
