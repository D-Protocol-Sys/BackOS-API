# Production

[← All deployment guides](README.md)

The official instance: public, with real users and real data. It is the **most hardened** stack of the project.

| At a glance        |                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| **Best for**       | Real-world use                                                                                          |
| **Reachable from** | The Internet: `https://<PROD_DOMAIN>`, automatic Let's Encrypt certificate, HTTP forced to HTTPS        |
| **You will need**  | A domain name, ports **80 and 443** reachable, a server with Docker and Docker Compose, kept up to date |
| **Data**           | Its own database, on an internal network with **no published port**                                     |

**On this page:** [What protects it](#what-protects-it) · [Before you start](#before-you-start) · [Step by step](#step-by-step) · [Updating](#updating-your-production) · [Generated backends in production](#generated-backends-in-production) · [Troubleshooting](#troubleshooting) · [Before real data](#before-you-put-real-data-in) · [Combine it](#combine-it-with-other-modes)

---

## What protects it

- **Traefik**: explicit routing only (`exposedbydefault=false`), automatic Let's Encrypt TLS, forced HTTP→HTTPS redirect, dashboard disabled.
- **`docker-socket-proxy`**: the real Docker socket is **never** mounted in an application container. The proxy is part of the prod stack (`<PROJECT_NAME>-prod-docker-proxy`), on a private `docker_api` network that neither `edge` nor the demo can see. The API reaches it through `DOCKER_HOST=tcp://docker-proxy:2375`, with deliberately limited rights: `CONTAINERS`, `IMAGES`, `BUILD`, `NETWORKS` and `POST` are on (needed to create containers for generated platforms), but `EXEC`, `SECRETS`, `SYSTEM` and `VOLUMES` are off.
- **`cap_drop: ALL` and `no-new-privileges:true`** on the API container: even after a code-execution flaw, the attacker inherits a process with the fewest kernel capabilities possible.
- **PostgreSQL and Redis** on an `internal` network with **no port exposed** outside Docker, so invisible even to a scan of the server. Redis is also password-protected.
- **Migrations and owner account** are applied automatically on the first start (`deploy/entrypoint.sh`).
- **One trusted proxy hop** (`TRUST_PROXY_HOPS=1`): the API trusts Traefik, and only Traefik, to tell it the real client IP.

---

## Before you start

- A **domain name** pointing to your server's public IP.
- Ports **80 and 443** forwarded to the server and truly reachable.
- A **server with Docker and Docker Compose**, kept **up to date**. It is a public server: it must receive the operating system's security patches like any exposed server.
- The project on the server: see [Get the project](../../README.md#4-get-the-project-on-your-machine).
- Your secrets: see [Generate your secrets](README.md#generate-your-secrets).
- A **folder for generated projects**, created beforehand, with an absolute path (for example `/srv/backos/generated-prod`). The API mounts it at the **same path** in its container; the setting is `GENERATED_PROJECTS_HOST_PATH`.

---

## Step by step

### 1. Create your settings file

```bash
cp .env.production.example .env.production
```

Fill in every `REPLACE_ME…` and `REPLACE_WITH…`:

- `PROJECT_NAME`, `PROD_DOMAIN` (without `https://`) and `ACME_EMAIL` (used by Let's Encrypt for expiry notices).
- `CORS_ORIGIN` and `FRONTEND_URL`: the address of your BackOS front end.
- **All** the secrets: `ENCRYPTION_KEY` (64 hexadecimal characters) and `JWT_SECRET`, plus every password (`POSTGRES_PASSWORD`, `POSTGRES_PROVISIONING_PASSWORD`, `POSTGRES_APP_PASSWORD`, `REDIS_PASSWORD` with **at least 16 characters**). See [Generate your secrets](README.md#generate-your-secrets).
- A **real SMTP server** (not a mail catcher), so invitations and one-time codes actually reach people.
- `OWNER_*`: the owner account created on the first start.
- `GENERATED_PROJECTS_HOST_PATH`: the folder you created.
- The settings for generated backends: see [Generated backends in production](#generated-backends-in-production). **Do this now**, before the first start.

> [!IMPORTANT]
> Keep a safe copy of `.env.production`. If you lose or regenerate `ENCRYPTION_KEY`, data that was already encrypted can no longer be read.

### 2. Start the stack

`edge` first, then `prod`: `edge` is a dependency, and the command below starts both in the right order.

```bash
make up-prod
```

No `make`? This is equivalent:

```bash
./scripts/stack.sh up prod
```

The image is **built from the code on the server**. This is the way for a first installation, or when you do not use the CI/CD pipeline.

### 3. Get the owner's activation details

Production runs in production mode, so the owner's activation link and one-time code are **not** printed in the logs. At the very first start they are written **once** to a private file inside the API container (the logs only say where):

```bash
docker exec <PROJECT_NAME>-prod-orchestrator cat /app/owner-activation.txt
docker exec <PROJECT_NAME>-prod-orchestrator rm  /app/owner-activation.txt
```

> [!WARNING]
> Copy the link and the code right away, then delete the file (second command). They are valid for 48 hours. The link starts with `FRONTEND_URL`: it opens the BackOS web interface where you set up the owner account.

### 4. Check the state

```bash
make ps
```

Then open `https://<PROD_DOMAIN>/api/health` and check the padlock: it answers `200` when everything is fine. Traefik logs only warnings and errors, so a successful certificate request is silent: if the site does not answer over HTTPS, read `docker logs <PROJECT_NAME>-edge-traefik --tail 50`.

---

## Updating your production

You have two ways. Pick the one that matches how you work.

|                           | **Manual, from the server's code**                  | **Automatic, with the CI/CD pipeline**                                  |
| ------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| What runs                 | An image **built on the server**                    | The **published image**, already scanned and signed — not rebuilt       |
| How                       | `git pull`, then `make up-prod`                     | Push a `vX.Y.Z` tag, or `./scripts/stack.sh deploy prod X.Y.Z`          |
| Rollback if it fails      | Manual                                              | Automatic, to the previous version (`./scripts/stack.sh rollback prod`) |
| Setup needed              | None                                                | GitHub secrets and an `environment: production` with reviewers          |

Production is deployed by the pipeline **only on a `vX.Y.Z` tag** (or manually), through a GitHub *environment* that requires a human approval: nobody reaches production without an explicit validation, even with a green pipeline. Everything about it — secrets, how it works, rollback limits — is in the **[CI/CD guide](CI_CD.md)**.

> [!WARNING]
> A rollback restores the **old image**, not the old database schema. Before any migration that **drops or renames** a column, take a backup.

---

## Generated backends in production

In production, BackOS runs in a container, and the generated backends are **other containers** that publish their port on the host. Two things follow.

### The API must be told how to reach them

Add to `.env.production` **before** generating any backend:

```ini
# Windows / macOS (Docker Desktop)
GENERATED_BACKEND_GATEWAY_HOST=host.docker.internal

# Linux (use these two lines instead)
GENERATED_BACKEND_HOST=172.17.0.1
GENERATED_BACKEND_GATEWAY_HOST=172.17.0.1
```

On Linux, `172.17.0.1` is the usual address of `docker0`: check yours with `ip -4 addr show docker0`, and make sure your firewall lets container traffic reach it. Without these settings, the API looks for the backend on its own `127.0.0.1` and never finds it. Details: [Reaching generated backends](README.md#reaching-generated-backends-from-a-containerized-api).

> [!WARNING]
> This has **not been tested on a real server**. The first time you generate a backend, check that it becomes healthy (the platform shows as running) before relying on it.

### Backends that call BackOS back

A generated backend verifies *internal logins* by calling BackOS. By default it uses `http://host.docker.internal:4803`, but in production the API's port is **not published** on the host (only Traefik is). If you use internal logins, point generated backends to the public address instead:

```ini
GENERATED_BACKEND_BACKOS_URL=https://<PROD_DOMAIN>
```

### Other points

- **Swagger docs are off by default** for generated backends in production (`NODE_ENV=production`): they would expose all of a platform's routes through the public gateway. The *Open API docs* button is then greyed out. To enable them anyway: `GENERATED_BACKEND_API_DOCS_ENABLED=true` in `.env.production`.
- Other settings: [Generated backends settings](README.md#7-reference-generated-backends-settings).

---

## Troubleshooting

| Symptom                                           | Cause and fix                                                                                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| No certificate, or a browser warning              | The domain does not point to your public IP, or ports 80/443 are not reachable. Check the DNS record and the Traefik logs: `docker logs <PROJECT_NAME>-edge-traefik --tail 50`. |
| The site does not answer                          | Run `make ps` to see which container is down, then `make logs-prod`.                                                                               |
| The API container stops right after starting      | A setting is missing or invalid; the logs name it (`make logs-prod`). Typical causes: `ENCRYPTION_KEY` not 64 hexadecimal characters, `JWT_SECRET` under 32 characters, `REDIS_PASSWORD` under 16. |
| `POSTGRES_APP_USER must be set` (or `…_PASSWORD`) | The two `POSTGRES_APP_*` lines are missing in `.env.production`.                                                                                    |
| `permission denied` on `stack.sh` or `entrypoint.sh` | `chmod +x scripts/stack.sh deploy/entrypoint.sh`.                                                                                               |
| I did not copy the owner's activation link        | It is in `/app/owner-activation.txt` inside the API container, until you delete it (step 3). If you already deleted it, see the warning in [First start](README.md#first-start-the-owner-account). |
| Invitations and one-time codes are not delivered  | The SMTP settings are wrong, or still point to a development mail catcher. Fix them in `.env.production`.                                          |
| A generated backend never becomes healthy         | The API cannot reach it: check `GENERATED_BACKEND_GATEWAY_HOST` (and, on Linux, `GENERATED_BACKEND_HOST` and your firewall). See [Generated backends in production](#generated-backends-in-production). |

---

## Before you put real data in

> [!WARNING]
> **Test coverage is still low** (see the [tests coverage audit](../TESTS_COVERAGE_AUDIT.md)). That means a real risk of silent regressions as the product evolves, whatever the quality of the infrastructure itself.

Before your first real `make up-prod`, make sure the checks of the [CI](CI_CD.md) (lint, build, unit and end-to-end tests) are **green** on the exact commit you are about to deploy. If you do not use the CI, run these checks on another machine first: a deployment target should not be the place where you discover a failing build.

**What you get in return:** a hardening level above average for this kind of project, reproducible and traceable deployments (signed image, SBOM, provenance attestation), and no security regression reaching production without a human validation.

---

## Combine it with other modes

- **+ Demo, same server**: the standard case, already supported by `scripts/stack.sh`. → [Demo + Production](combines/DEPLOIEMENT_COMBINE_DEMO_PRODUCTION.md)
- **+ WireGuard for admin access**: keep production public for users, but protect SSH and the database behind a VPN. → [Production + WireGuard](combines/DEPLOIEMENT_COMBINE_PRODUCTION_WIREGUARD.md)
