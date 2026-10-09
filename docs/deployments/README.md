# Deployment guides

Start here if you have just [cloned BackOS](../../README.md#4-get-the-project-on-your-machine) and want to run it. This page explains **what can run where**, helps you **pick the right guide**, and gathers the concepts shared by all of them.

**On this page**

1. [Which guide should I follow?](#1-which-guide-should-i-follow)
2. [What runs where](#2-what-runs-where)
3. [The stacks at a glance](#3-the-stacks-at-a-glance)
4. [Dev, Local or LAN?](#4-dev-local-or-lan)
5. [What every guide has in common](#5-what-every-guide-has-in-common)
6. [Command cheat sheet](#6-command-cheat-sheet)
7. [Reference: generated backends settings](#7-reference-generated-backends-settings)
8. [Design notes](#8-design-notes)

---

## 1. Which guide should I follow?

| I want to…                                                       | Follow                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Work on BackOS's code** (hot reload, debugger, Swagger)        | [Development](DEPLOIEMENT_DEV.md)                                               |
| Run a **stable instance on my own computer** (no hot reload)     | [Local](DEPLOIEMENT_LOCAL.md)                                                   |
| Run a stable private instance on a **dedicated PC** (Windows tray icon, home or office network) | [LAN](DEPLOIEMENT_LAN.md)                       |
| Show the project to someone, with no risk for real data          | [Demo](DEPLOIEMENT_DEMO.md)                                                     |
| Put BackOS online for real users                                 | [Production](DEPLOIEMENT_PRODUCTION.md)                                         |
| Reach a private instance from anywhere, without exposing it      | [WireGuard](DEPLOIEMENT_WIREGUARD.md)                                           |
| Run a public demo **and** the real production on one server      | [Demo + Production](combines/DEPLOIEMENT_COMBINE_DEMO_PRODUCTION.md)           |
| Keep production public but lock down admin access                | [Production + WireGuard](combines/DEPLOIEMENT_COMBINE_PRODUCTION_WIREGUARD.md)  |
| Have a private instance **and** a public demo on one PC          | [LAN + Demo + WireGuard](combines/DEPLOIEMENT_COMBINE_LAN_DEMO_WIREGUARD.md)    |
| Automate builds and deployments from GitHub                      | [CI/CD](CI_CD.md)                                                               |

> [!TIP]
> Not sure? If you want to **change the code**, take *Development*. If you just want to **use** BackOS on your computer, take *Local*.

---

## 2. What runs where

BackOS has two kinds of parts: the **BackOS API** (also called *the orchestrator*) with its **PostgreSQL** and **Redis**, and the **generated backends** that BackOS creates for your platforms.

| Part                                      | In **Development**                      | In every **other** mode (Local, LAN, Demo, Production)        |
| ----------------------------------------- | --------------------------------------- | ------------------------------------------------------------- |
| **BackOS API**                            | **On your machine**, started with `pnpm start:dev` (hot reload) | In a Docker container, built from the project's hardened image |
| **PostgreSQL** and **Redis**              | In Docker containers                    | In Docker containers                                          |
| **Traefik** (`edge`)                      | —                                       | One container, shared by the public stacks (Demo, Production) |
| **Generated backends** (one per platform) | One Docker container each, named `backos-gen-<slug>`, started by the API | Same                                    |

What this means for you:

- **Development** needs **Git, Docker, Node.js 22 and pnpm**: the API itself runs on your machine so that it can reload when you save a file.
- **Every other mode** needs **Docker only** (plus Git to download the project): nothing else to install.
- In **all** modes, **you never start a generated backend by hand**. BackOS creates and manages its container when you start the platform from the interface. Each one is isolated: its own container, its own Docker network, and CPU and memory limits (256 MB and 0.5 CPU by default).

---

## 3. The stacks at a glance

Each deployment mode is a separate **Docker Compose stack**. Stacks never share data.

| Stack      | Compose file                         | Env file (in the project root)     | What runs in Docker                      | Exposure                                              | Driven with                         |
| ---------- | ------------------------------------ | ---------------------------------- | ---------------------------------------- | ----------------------------------------------------- | ----------------------------------- |
| **dev**    | `docker-compose.yml` (root)          | `.env` **and** `.env.development`  | PostgreSQL + Redis **only** (API runs on your machine) | PostgreSQL (`5432`) and Redis (`6379`) on `127.0.0.1` only; the API listens on `PORT` (`4803`) like any local Node.js app | `make up-dev` + `pnpm start:dev` |
| **local**  | `deploy/docker-compose.local.yml`    | `.env.local`                       | The whole stack                          | Port `LOCAL_PORT` (default `4803`), **all network interfaces** | `make up-local`            |
| **lan**    | `deploy/docker-compose.lan.yml`      | `.env.lan`                         | The whole stack                          | Port `4803`, **all network interfaces**, never to be forwarded on the router | Windows tray, `.bat` scripts or `docker compose` |
| **edge**   | `deploy/docker-compose.edge.yml`     | `.env.production`                  | Traefik alone (TLS, routing by domain)   | Ports `80` and `443`, public                          | Started by `demo` and `prod`        |
| **demo**   | `deploy/docker-compose.demo.yml`     | `.env.demo`                        | The whole stack, with **no Docker access** | `https://${DEMO_DOMAIN}` through edge               | `make up-demo`                      |
| **prod**   | `deploy/docker-compose.prod.yml`     | `.env.production`                  | The whole stack                          | `https://${PROD_DOMAIN}` through edge                 | `make up-prod`                      |
| *test*     | `deploy/docker-compose.test.yml`     | `.env.test`                        | Throw-away PostgreSQL + Redis            | `127.0.0.1` only                                      | `pnpm test:e2e` (automatic)         |

> [!NOTE]
> The **test** stack is not a place to run BackOS. It is the **ephemeral** infrastructure of the automated end-to-end tests: `pnpm test:e2e` starts it and destroys it at every run (see `test/global-setup-e2e.ts`). It has nothing to do with Demo.

**Why they don't collide on one machine.** `demo` and `prod` share one Traefik but are told apart by **domain name**, not by port. `dev`, `local` and `lan` have no domain and are reachable on their own port: if you run several of them, give each a different port (see [Dev, Local or LAN?](#4-dev-local-or-lan)).

**Docker access.** Only the stacks that can generate backends (`local`, `lan`, `prod`) ship their own **`docker-socket-proxy`**, on a private network. `edge` and `demo` have none and cannot reach another stack's proxy. In `dev`, the API on your machine talks to your own Docker daemon directly.

---

## 4. Dev, Local or LAN?

These three modes are often confused. They are **three different modes**.

|                                   | **Development**                                  | **Local**                                          | **LAN**                                             |
| --------------------------------- | ------------------------------------------------ | -------------------------------------------------- | --------------------------------------------------- |
| **Purpose**                       | Change BackOS's code and see the result at once  | Use a stable BackOS on your own computer           | A stable BackOS on a dedicated PC, for you or a team |
| **BackOS API runs…**              | On your machine (`pnpm start:dev`), reloads on every save | In a container (built image, **no** reload) | In a container (built image, **no** reload)         |
| **Code changes**                  | Applied **instantly**                            | Need a rebuild (`make up-local` again)             | Need a rebuild (`git pull` + `up -d --build`)       |
| **`NODE_ENV`**                    | `development`                                    | `production`                                       | `production`                                        |
| **Swagger docs** (`/api/docs`)    | ✅ Available                                     | ❌ Off (production mode)                           | ❌ Off (production mode)                            |
| **Owner activation details**      | Printed in the terminal                          | Written to a file in the container                 | Written to a file in the container                  |
| **Settings file**                 | `.env` + `.env.development`                      | `.env.local`                                       | `.env.lan`                                          |
| **Port**                          | `PORT` (4803)                                    | `LOCAL_PORT` (4803 by default, configurable)       | `4803` (fixed)                                      |
| **Generated projects stored in**  | A folder of the project (`./generated`)          | A folder **you create** on the host                | A **named Docker volume**                           |
| **Windows tray + `.bat` scripts** | No                                               | No                                                 | **Yes**                                             |
| **Driven with**                   | `make up-dev`, `pnpm start:dev`                  | `make up-local` / `./scripts/stack.sh`             | Tray, `.bat` files or `docker compose` (no `stack.sh`) |
| **Best on**                       | Any system with Node.js and Docker               | Linux, macOS                                       | **Windows** (designed around Docker Desktop)        |

Rules of thumb:

- You are **developing** → **Development**.
- You just want to **use** BackOS on your own computer → **Local**.
- You have a **separate PC acting as a server**, on Windows → **LAN**.

Running two of them at once is possible, but both listen on port `4803` by default. Change `LOCAL_PORT` (Local) or `PORT` (Development) to avoid *address already in use*. LAN has a fixed port.

---

## 5. What every guide has in common

### Settings files

Each guide starts by copying an example file and filling in the placeholders (`REPLACE_ME…`, `change-me…`):

| Stack | Copy this…                   | …to                                      |
| ----- | ---------------------------- | ---------------------------------------- |
| dev   | `.env.development.example`   | **`.env` and `.env.development`** (both) |
| local | `.env.local.example`         | `.env.local`                             |
| lan   | `.env.lan.example`           | `.env.lan`                               |
| demo  | `.env.demo.example`          | `.env.demo`                              |
| prod  | `.env.production.example`    | `.env.production`                        |
| tests | `.env.test.example`          | `.env.test`                              |

> [!IMPORTANT]
> Never commit these files: they hold your secrets. Keep a safe copy of `ENCRYPTION_KEY` and `JWT_SECRET`: if you regenerate them, data that was already encrypted becomes unreadable.

BackOS **validates its settings at startup** and refuses to start with a clear message when one is wrong. Among others: `ENCRYPTION_KEY` must be exactly 64 hexadecimal characters, `JWT_SECRET` at least 32 characters, and `REDIS_PASSWORD` at least 16 characters in the container stacks. Some placeholders are long enough to pass this validation, so **always replace every placeholder** yourself.

### Generate your secrets

| Secret           | Linux, macOS, Git Bash       | Windows PowerShell                                                                                                                          |
| ---------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENCRYPTION_KEY` (64 hex characters) | `openssl rand -hex 32` | `$b = New-Object byte[] 32; (New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($b); ($b \| ForEach-Object { $_.ToString('x2') }) -join ''` |
| `JWT_SECRET`     | `openssl rand -base64 48`    | `$b = New-Object byte[] 48; (New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($b); [Convert]::ToBase64String($b)`        |
| Passwords (PostgreSQL, Redis) | `openssl rand -hex 24` | Same method as `ENCRYPTION_KEY`, with `byte[] 24`                                                                                       |

Use **different** secrets in every stack: never copy the ones of one environment into another.

### Rename the project in one place

`PROJECT_NAME`, at the top of each `.env*` file, drives container names, Docker networks and volumes, Traefik labels, the Redis lock prefix (`SERVER_NAME`) and the issuer shown in authenticator apps.

The only names that do **not** follow it are the **generated backends**: their containers are always `backos-gen-<slug>` and their images `backos-gen/<slug>`.

### First start: the owner account

On the first start with an empty database, BackOS creates the **owner account** from the `OWNER_*` values of your settings file, with the status *invited*. It also creates an **activation link** and a **one-time code**, valid **48 hours**. They are shown **only once**, and **where depends on the mode**:

| Mode                                  | Where to find the activation details                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Development**                       | Printed in the terminal by the seed command                                                 |
| **Local, LAN, Demo, Production**      | Written to a private file (`/app/owner-activation.txt`) **inside the API container**. The logs only tell you the file name. |

For the container stacks, read the file, then **delete it**:

```bash
docker exec <PROJECT_NAME>-<stack>-orchestrator cat /app/owner-activation.txt
docker exec <PROJECT_NAME>-<stack>-orchestrator rm  /app/owner-activation.txt
```

where `<stack>` is `local`, `lan`, `demo` or `prod`. (If you changed `SEED_ACTIVATION_FILE` in your settings file, use that file name.)

> [!WARNING]
> Copy the link and the code right away. The file is written once, at the very first start, and you are asked to delete it. If the 48 hours expire on a brand-new instance, the simplest way out is to erase its data and start again (see the *erase* commands in [§6](#6-command-cheat-sheet)). Never do that on an instance that already holds data.

The activation link is built from `FRONTEND_URL`: it opens the **BackOS web interface** (the front end, a separate application) at that address. Set `FRONTEND_URL` to the address where your users open the front end.

The `demo` stack also creates a second, **read-only** account (see [Demo](DEPLOIEMENT_DEMO.md)).

### Check that an instance is alive

```bash
curl http://localhost:4803/api/health      # replace host and port as needed
```

It answers `200` when healthy and `503` when the instance is degraded. The BackOS API has **no web page of its own**: the web interface is the separate front end. The interactive Swagger docs (`/api/docs`) exist only in **Development**.

### Drive each stack with one tool only

Docker Compose names a *project* after the folder of the compose file, which is `deploy` for every file in `deploy/`. Two stacks started by hand with `docker compose -f deploy/...` would share that name, and since all of them have services called `postgres`, `redis` and `orchestrator`, **one stack would recreate the containers of the other**.

`scripts/stack.sh` avoids this by naming each stack (`<project>-dev`, `-local`, `-prod`, `-demo`, `-edge`). To stay safe:

- **Start, stop and inspect a stack with the same tool every time** (`make` / `stack.sh`, or `docker compose`, or the tray). Do not mix them: a stack started with `stack.sh` is not seen by a hand-typed `docker compose down`.
- When a guide asks you to use `docker compose` by hand for a stack in `deploy/`, it gives you a **`-p <name>`** option. Keep it.
- The **LAN** stack is the one exception: it has no `stack.sh` target, and the tray and the `.bat` scripts start it under the project name `deploy`. Always drive it the way [its guide](DEPLOIEMENT_LAN.md) says.

---

## 6. Command cheat sheet

Run from the repository root. `make` is a shortcut over `./scripts/stack.sh`.

| Goal                                     | Command                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| Start one stack                          | `make up-dev` · `make up-local` · `make up-demo` · `make up-prod`  (or `./scripts/stack.sh up <stack>`) |
| Start several at once                    | `make up` = `edge` + `prod` + `demo` + `dev`. Needs `.env.production`, `.env.demo` **and** `.env`. On a server, prefer starting only what you need. `local` is never part of it. |
| Show the state of the stacks             | `make ps` (edge, prod, demo, dev, local)                                                    |
| Follow the logs of a stack               | `make logs-dev` · `make logs-demo` · `make logs-prod` · `make logs-local`  (or `./scripts/stack.sh logs <stack>`) |
| Stop a stack, **keeping** its data       | `./scripts/stack.sh down <stack>`  (`make down-local`; `make down` stops everything **except** `local`) |
| Stop a stack and **erase** its data      | `./scripts/stack.sh nuke <stack>`  (`make nuke-dev`, `make nuke-demo`). `nuke all` is forbidden; `nuke prod` asks you to type `oui` to confirm. |
| Deploy a published image (prod or demo)  | `./scripts/stack.sh deploy <prod\|demo> <tag>`                                              |
| Roll back to the previous version        | `./scripts/stack.sh rollback <prod\|demo>`                                                  |

`<stack>` is one of `dev`, `local`, `demo`, `prod`, `edge`. The **LAN** stack is not in this list: see [its guide](DEPLOIEMENT_LAN.md).

> [!NOTE]
> `stack.sh up prod` and `stack.sh up demo` start **edge first**, and edge always reads **`.env.production`**. So even a server that only runs the demo needs a `.env.production` file when you use `make up-demo`. See [Demo](DEPLOIEMENT_DEMO.md#2-start-the-demo).

> [!TIP]
> On Linux or macOS, if a script says *permission denied*:
> `chmod +x scripts/stack.sh deploy/entrypoint.sh`

---

## 7. Reference: generated backends settings

Optional variables, to set in the settings file of the stack concerned. The defaults suit a standard setup, **except** for the two "reaching" variables below in `local` and `prod`.

| Variable                               | What it does                                                                                                                                                               | Default                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `GENERATED_BACKEND_API_DOCS_ENABLED`   | Forces the Swagger docs of generated backends **on** (`true`) or **off** (`false`). The *Open API docs* button is greyed out when off.                                      | Follows `NODE_ENV`: on outside `production`, off in `production`    |
| `GENERATED_BACKEND_HOST`               | Address on which a generated backend **publishes** its port on the host.                                                                                                   | `127.0.0.1`                                                         |
| `GENERATED_BACKEND_GATEWAY_HOST`       | Address the API uses to **reach** a generated backend (gateway and health check). Needed when the API runs in a container, where `127.0.0.1` is the container itself.       | Same as `GENERATED_BACKEND_HOST`                                    |
| `GENERATED_BACKEND_AUTO_RESTORE`       | Restarts, after the API boots, the generated backends that were running before a machine or Docker restart (see [After a reboot](#after-a-reboot)).                          | `true`                                                              |
| `GENERATED_BACKEND_UPLOADS_USE_VOLUME` | Stores uploads in a named Docker volume instead of a host folder. Needed when the projects folder is not mounted at the same path in the container and on the host.        | `false` (set to `true` by the LAN stack)                            |
| `GENERATED_BACKEND_BACKOS_URL`         | Address a generated backend uses to call BackOS back (verification of internal logins). No trailing path.                                                                  | `http://host.docker.internal:<PORT>`                                |

Fine-tuning of auto-restore: `GENERATED_BACKEND_RESTORE_DELAY_MS` (5000), `GENERATED_BACKEND_RESTORE_ATTEMPTS` (3), `GENERATED_BACKEND_RESTORE_RETRY_DELAY_MS` (15000).

### Which stack sets what

| Stack  | `GENERATED_BACKEND_GATEWAY_HOST`                  | Uploads of generated backends                  | What you must do                                                |
| ------ | ------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| dev    | not needed (the API is on the host)               | Host folder                                    | Nothing on Windows/macOS. See the Linux note in [Development](DEPLOIEMENT_DEV.md). |
| local  | **not set**                                       | Host folder (same path in container and host)  | **Set it yourself** in `.env.local` (below)                     |
| lan    | `host.docker.internal` (set by the compose file)  | Named volume (`GENERATED_BACKEND_UPLOADS_USE_VOLUME=true`) | Nothing on Windows/macOS. Linux note below.         |
| prod   | **not set**                                       | Host folder (same path in container and host)  | **Set it yourself** in `.env.production` (below)                |
| demo   | not used: the demo has no Docker access          | —                                              | Nothing                                                         |

### Reaching generated backends from a containerized API

Generated backends publish their port on the **host's** `127.0.0.1`. Inside a container, `127.0.0.1` is the container itself, so the API needs another address to reach them.

**Windows and macOS (Docker Desktop)**: add to the settings file of the stack (`.env.local`, or `.env.production`):

```ini
GENERATED_BACKEND_GATEWAY_HOST=host.docker.internal
```

**Linux**: a port bound to `127.0.0.1` cannot be reached from a container, so bind it on the `docker0` address instead, and use that same address to reach it:

```ini
GENERATED_BACKEND_HOST=172.17.0.1
GENERATED_BACKEND_GATEWAY_HOST=172.17.0.1
```

`172.17.0.1` is the usual address of `docker0`: check yours with `ip -4 addr show docker0`. Your firewall must also let container traffic reach that address. This applies to **Local**, **Production** and, on Linux, **LAN**.

> [!WARNING]
> The Linux setup has **not been tested on a real server**. Validate it with a generated backend before relying on it. The first time you generate a backend, check that the API reaches it (each guide tells you how).

If you change `LOCAL_PORT` in Local, also set `GENERATED_BACKEND_BACKOS_URL=http://host.docker.internal:<LOCAL_PORT>`: by default, generated backends call BackOS on port `4803`.

### After a reboot

Generated containers run with `--restart on-failure:5`, so that a crash loop cannot last forever. This policy does **not** restart them after a reboot of the machine or of Docker. The API takes care of it: a few seconds after it starts, it restarts the platforms you left **started** whose container is no longer running (with a few retries if Docker answers late).

It **never** restarts a platform you stopped yourself, nor one already in the *crashed* state. Set `GENERATED_BACKEND_AUTO_RESTORE=false` to turn this off.

### Database network of generated backends

Each generated backend has its own dedicated Docker network, to which the PostgreSQL container is attached under the alias `GENERATED_BACKEND_DOCKER_DB_HOST` (for example `postgres`). The compose files set this for you. If a `…-gen-net-<slug>` network already existed before this behaviour, recreate it once: stop the platform, run `docker network rm <network>`, start it again.

---

## 8. Design notes

**Why the `docker-socket-proxy` lives inside each stack.** It used to be shared in `edge`, on the network where the public demo also sits. Removing `DOCKER_HOST` from the demo was not enough: the proxy (no authentication, `POST=1`) stayed reachable by name from any container on that network. Each stack that needs it (`prod`, `lan`, `local`) now has its own on a private `docker_api` network, named `<project>-prod-docker-proxy`, `<project>-lan-docker-proxy` and `<project>-local-docker-proxy`. If you have scripts of your own that mention the old `<project>-edge-docker-proxy`, update them. The old container is removed automatically at the next `stack.sh up edge` (`--remove-orphans`).

**Why `local` and `lan` both exist.** Both run the same hardened image, behind the same filtered Docker proxy, and both are reachable on a plain-HTTP port without a domain. They differ in how they are meant to be used:

- **`lan`** is built for a **dedicated Windows PC**: the generated projects live in a named Docker volume (no Windows path issues), the API already knows how to reach generated backends through `host.docker.internal`, and the **tray icon and `.bat` scripts** drive it. It is also the stack the combined guides rely on.
- **`local`** is built for **your own computer** (Linux or macOS): configurable port, generated projects in a host folder you choose, driven by `make` / `stack.sh`. It has no tray.

**Why "test" and "demo" are different things.** `deploy/docker-compose.test.yml` provides the **ephemeral** infrastructure of the automated end-to-end tests (`pnpm test:e2e` starts and destroys it on every run). It is not an environment to keep switched on. `docker-compose.demo.yml` was created separately for presentations, and it is the one that runs next to `prod`.

---

## Related documents

- [CI/CD](CI_CD.md): automatic builds, deployments and rollback with GitHub Actions.
- [Tests coverage audit](../TESTS_COVERAGE_AUDIT.md): what is tested and what is not.
- [`src/gateway/GATEWAY_README.md`](../../src/gateway/GATEWAY_README.md): how `/generated/<slug>/...` routing works.
