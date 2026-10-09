# Development: work on BackOS's code

[← All deployment guides](README.md)

The mode for **changing BackOS's code**. PostgreSQL and Redis run in Docker, and the **BackOS API runs directly on your machine** in watch mode: save a file and the API reloads by itself.

> [!IMPORTANT]
> **Development is not Local.** In *Development*, the API is **not** in a container. If you only want to **use** BackOS on your computer, with nothing to install except Docker, follow [Local](DEPLOIEMENT_LOCAL.md) instead. See [Dev, Local or LAN?](README.md#4-dev-local-or-lan).

| At a glance        |                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| **Best for**       | Developing BackOS: hot reload, debugger, Swagger docs                                             |
| **Reachable from** | Your machine: `http://localhost:4803` (the value of `PORT`)                                       |
| **You will need**  | Git, Docker, **Node.js 22** and **pnpm**                                                          |
| **Data**           | Kept between restarts (named Docker volume `<PROJECT_NAME>-dev-postgres-data`)                    |

**On this page:** [What runs where](#what-runs-where) · [Before you start](#before-you-start) · [Step by step](#step-by-step) · [Daily use](#daily-use) · [Run the tests](#run-the-tests) · [Troubleshooting](#troubleshooting) · [Good to know](#good-to-know) · [Next steps](#next-steps)

---

## What runs where

```
 Your machine                                   Docker
┌───────────────────────────────┐     ┌───────────────────────────────────────────┐
│  BackOS API                   │     │  <PROJECT_NAME>-dev-postgres  → 127.0.0.1:5432  │
│  `pnpm start:dev`  → :4803    │────▶│  <PROJECT_NAME>-dev-redis     → 127.0.0.1:6379  │
│  (hot reload)                 │     │                                           │
│                               │     │  backos-gen-<slug>   one container per    │
│  talks to your Docker daemon ─┼────▶│  generated backend, started by the API    │
└───────────────────────────────┘     └───────────────────────────────────────────┘
```

| Part                                   | Where it runs                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **BackOS API**                         | **On your machine**, started with `pnpm start:dev`                                                     |
| **PostgreSQL** and **Redis**           | Docker containers, from `docker-compose.yml` at the root of the project (the *dev* stack). Their ports are published on `127.0.0.1` only. |
| **Generated backends** (`backos-gen-<slug>`) | Docker containers started by the API through your own Docker daemon, when you start a platform from the interface. You never start them by hand. |

---

## Before you start

You need four tools. Check each in a terminal: you should get a version number, not an error.

| Tool                                           | Check with           | Install                                                |
| ---------------------------------------------- | -------------------- | ------------------------------------------------------ |
| **Git**                                        | `git --version`      | <https://git-scm.com/downloads>                        |
| **Docker** (Docker Desktop on Windows/macOS)   | `docker --version`   | <https://docs.docker.com/get-docker/>                  |
| **Node.js 22**                                 | `node --version`     | <https://nodejs.org> (the project builds on Node 22)   |
| **pnpm** (version 10)                          | `pnpm --version`     | `corepack enable` (Corepack comes with Node.js), or <https://pnpm.io/installation> |

Then make sure **Docker is running**:

```bash
docker info
```

If this prints an error such as *cannot connect to the Docker daemon*, start Docker Desktop (or the Docker service) and try again.

You also need the project on your machine: see [Get the project](../../README.md#4-get-the-project-on-your-machine).

---

## Step by step

All commands run from the project folder.

### 1. Create your settings files

The dev example file must be copied **twice**:

```bash
cp .env.development.example .env
cp .env .env.development
```

Why two files with the same content:

| File               | Read by                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `.env`             | Docker Compose (container names, PostgreSQL credentials) **and** the Prisma commands (migrations, seed) |
| `.env.development` | The **BackOS API** itself when it starts with `pnpm start:dev` (`NODE_ENV=development`)   |

> [!WARNING]
> Keep the two files **identical**. If they differ, the database is created with one set of values and the API connects with another, and you get *authentication failed* errors. Whenever you edit one, edit the other.

The example values are meant for development, so **it works as it is** (`change-me-dev…` passwords, an all-zero `ENCRYPTION_KEY`). Never reuse them anywhere else. Two things you may want to adjust:

- **E-mails.** The example points to a mail catcher on `localhost:1025`. BackOS starts without one (it only logs an SMTP error), but invitations and one-time codes will not be delivered. To see them, run a catcher such as [Mailpit](https://mailpit.axllent.org): `docker run -d -p 1025:1025 -p 8025:8025 axllent/mailpit`, then read the mails at `http://localhost:8025`.
- **Ports.** If PostgreSQL (`5432`) or Redis (`6379`) already run on your machine, change `POSTGRES_PORT` / `REDIS_PORT` **and** the matching port inside `DATABASE_URL` and `POSTGRES_PROVISIONING_URL`, in both files.

### 2. Start PostgreSQL and Redis

```bash
make up-dev
```

No `make`? This is equivalent:

```bash
./scripts/stack.sh up dev
```

✅ Check it: `docker ps` shows `<PROJECT_NAME>-dev-postgres` and `<PROJECT_NAME>-dev-redis`, both *healthy*. On the very first start, PostgreSQL also creates the two non-superuser roles used by BackOS (provisioning and application).

### 3. Install the dependencies

```bash
pnpm install
pnpm exec prisma generate
```

`prisma generate` creates the typed database client the code needs.

### 4. Create the database tables and the owner account

```bash
pnpm prisma:reset
```

The seed creates the roles, the permissions and the **owner account** from the `OWNER_*` values of your settings file. In development, **the owner's activation link and one-time code are printed right here, in your terminal, once.**

> [!WARNING]
> Copy them right away. They are not shown again. The link starts with `FRONTEND_URL` (`http://localhost:3000` in the example): it opens the BackOS web interface, which is a separate application.

### 5. Start the API

```bash
pnpm start:dev
```

✅ Wait for the line `back-os Backend listening on 4803`. In another terminal:

```bash
curl http://localhost:4803/api/health
```

It answers `200` when healthy. You can also open the interactive API docs: **`http://localhost:4803/api/docs`** (Swagger, available in development only).

### 6. Generate your first backend

From the BackOS web interface (or the API), create a platform and start its generation. When you start the platform, BackOS runs it in its own container:

```bash
docker ps --filter "name=backos-gen-"
```

✅ You should see `backos-gen-<your-slug>`, with a port in the `4100`–`4999` range published on `127.0.0.1`.

---

## Daily use

| I want to…                                      | Do this                                                                                   |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Start working                                   | `make up-dev`, then `pnpm start:dev`                                                      |
| See my code changes                             | Nothing: save the file, the API reloads                                                   |
| Stop the API                                    | `Ctrl+C` in its terminal                                                                  |
| Stop PostgreSQL and Redis, **keeping** my data  | `./scripts/stack.sh down dev`                                                             |
| See the logs of PostgreSQL and Redis            | `make logs-dev`                                                                           |
| Debug with breakpoints                          | `pnpm start:debug` (starts the API with the Node.js inspector, still with hot reload)     |
| Apply a new Prisma migration                    | `pnpm exec prisma migrate deploy`                                                         |
| Start from scratch, **erasing** my data         | `make nuke-dev`, then redo steps 2, 4 and 5                                               |
| Empty the database but keep the containers      | `pnpm prisma:reset` (drops, re-migrates and re-seeds: the owner's activation details are printed again) |

> [!WARNING]
> `make nuke-dev` and `pnpm prisma:reset` delete your development data. The owner's activation details are printed again at the next seed, because it is a fresh start.

> [!NOTE]
> Do not use `pnpm sys:reset` if you start PostgreSQL and Redis with `make up-dev`. It runs a plain `docker compose` that does not see containers started by `stack.sh` (see [Drive each stack with one tool only](README.md#drive-each-stack-with-one-tool-only)). Use `make nuke-dev` instead.

### Stopping does not stop generated backends

The generated backends (`backos-gen-*` containers) belong to Docker, not to the dev stack: they **keep running** after you stop the API or run `down`. To stop them as well:

```bash
# Linux / macOS / Git Bash
docker ps --filter "name=backos-gen-" -q | xargs docker stop
```

```powershell
# Windows PowerShell
docker ps --filter "name=backos-gen-" -q | ForEach-Object { docker stop $_ }
```

When the API starts again, it **automatically restarts** the platforms you had left started. A platform you stopped yourself stays stopped (see [After a reboot](README.md#after-a-reboot)).

---

## Run the tests

| What                       | Command                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| Unit tests                 | `pnpm test` (`pnpm test:cov` for the coverage report)                                                |
| End-to-end tests           | Copy `.env.test.example` to `.env.test`, then `pnpm test:e2e`. It starts its **own throw-away** PostgreSQL and Redis (`deploy/docker-compose.test.yml`) and destroys them afterwards: it never touches your development data. |
| Lint and build             | `pnpm lint` · `pnpm build`                                                                           |

What is covered, and what is not, is detailed in the [tests coverage audit](../TESTS_COVERAGE_AUDIT.md).

---

## Troubleshooting

| Symptom                                                                    | Cause and fix                                                                                                                                       |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Cannot connect to the Docker daemon`                                      | Docker is not running. Start Docker Desktop (or the Docker service).                                                                                |
| `port is already allocated` on `5432` or `6379`                            | A PostgreSQL or Redis already runs on your machine. Stop it, or change `POSTGRES_PORT` / `REDIS_PORT` (see step 1).                                  |
| `Cannot resolve environment variable: DATABASE_URL` (Prisma)               | `.env` is missing. Prisma reads `.env`, not `.env.development` (step 1).                                                                            |
| The API stops at startup with `Config validation error`                    | A value is missing or invalid in **`.env.development`**. The message names the variable. Check it against `.env.development.example`.               |
| `password authentication failed` / `role … does not exist`                 | The two settings files differ, or you changed the PostgreSQL passwords **after** the first start. PostgreSQL creates its roles only when its volume is created: run `make nuke-dev`, then start again. |
| `Cannot find module '…/prisma/generated…'`                                 | The Prisma client was not generated: `pnpm exec prisma generate`.                                                                                   |
| `address already in use` on `4803`                                         | Another program (for example a Local or LAN stack) uses that port. Stop it, or set another `PORT` in both settings files.                           |
| An SMTP error is logged at startup                                         | No mail server answers on `SMTP_HOST:SMTP_PORT`. Harmless unless you need e-mails: start a mail catcher (see step 1).                              |
| I did not copy the owner's activation link                                 | It is printed once, by `pnpm exec prisma db seed`, only when the database has no user yet. Erase the data (`make nuke-dev`) and redo steps 2, 4 and 5. |
| A platform never becomes healthy                                           | Check its logs in the interface, and run `docker ps --filter "name=backos-gen-"` to see whether its container is running. On **Linux**, see below. |

### Linux: generated backends cannot reach the database

By default, a generated backend reaches the dev PostgreSQL through `host.docker.internal`. Docker Desktop (Windows, macOS) makes that work out of the box. On **Linux**, the PostgreSQL port is published on `127.0.0.1` only, which a container cannot reach through the host. Instead, let BackOS attach the PostgreSQL container to each platform's network. In **both** settings files, add (replace `<PROJECT_NAME>`):

```ini
GENERATED_BACKEND_DB_CONTAINER_NAME=<PROJECT_NAME>-dev-postgres
GENERATED_BACKEND_DOCKER_DB_HOST=<PROJECT_NAME>-dev-postgres
```

Restart the API, then stop and start the platform.

> [!WARNING]
> This Linux setup has **not been tested end to end**. Report any difference you find.

---

## Good to know

**Advantages**

- Instant feedback: the API reloads at every save, with Swagger docs and a debugger.
- Nothing is exposed beyond your machine: PostgreSQL and Redis listen on `127.0.0.1` only.
- Coexists with the other stacks (`local`, `lan`, `demo`, `prod`) on the same machine: each has its own Docker network and its own containers. Mind the ports, see [Dev, Local or LAN?](README.md#4-dev-local-or-lan).

**Limits**

- It is **not** production-like: the API runs outside a container, in `development` mode, without TLS. Some bugs only show up in `local`, `demo` or `prod` (production mode, hardened image, strict CORS, HTTPS).
- It is not meant to stay up as a tool: when you close your terminal, the API stops.
- The API talks to **your own Docker daemon** directly, with your user's rights (there is no filtering proxy as in the container stacks). Use it on a machine you trust.

---

## Next steps

- Use BackOS rather than change it: [Local](DEPLOIEMENT_LOCAL.md).
- Understand how everything fits together: [Deployment guides overview](README.md).
- Run a stable private instance on a dedicated PC: [LAN](DEPLOIEMENT_LAN.md).
- Show your work to someone: [Demo](DEPLOIEMENT_DEMO.md).
