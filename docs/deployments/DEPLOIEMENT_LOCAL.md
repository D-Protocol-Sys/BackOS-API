# Local: a stable BackOS on your own computer

[← All deployment guides](README.md)

A stable BackOS that runs **entirely in Docker containers** on your own computer: no domain, no certificate, nothing to install except Docker. The BackOS API runs from a **built image**, like in production, and keeps running until you stop it.

> [!IMPORTANT]
> **Local is not Development.** Here the API is a container built from the project, and a code change needs a rebuild. If you want to **change BackOS's code** with hot reload, follow [Development](DEPLOIEMENT_DEV.md) instead. See [Dev, Local or LAN?](README.md#4-dev-local-or-lan).

| At a glance        |                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| **Best for**       | Using BackOS on your own computer, as a stable tool                                                                   |
| **Reachable from** | `http://localhost:<LOCAL_PORT>` (4803 by default). The port is published on **all interfaces**, so other devices of your network can also use `http://<your-LAN-IP>:<LOCAL_PORT>` |
| **You will need**  | Git and Docker. Nothing else                                                                                          |
| **Best on**        | Linux and macOS. On Windows, prefer [LAN](DEPLOIEMENT_LAN.md), which is designed around Docker Desktop paths          |
| **Security**       | Same hardened image as Demo and Production, but **plain HTTP** (no TLS)                                               |

**On this page:** [What runs](#what-runs) · [Before you start](#before-you-start) · [Step by step](#step-by-step) · [Daily use](#daily-use) · [Move to another machine](#move-to-another-machine) · [Troubleshooting](#troubleshooting) · [Good to know](#good-to-know) · [Next steps](#next-steps)

---

## What runs

Everything lives in Docker containers, started by one stack (`local`, defined in `deploy/docker-compose.local.yml`):

| Container                                   | Role                                                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `<PROJECT_NAME>-local-orchestrator`         | The **BackOS API**: it models, generates and drives the generated backends                                            |
| `<PROJECT_NAME>-local-postgres`             | BackOS's own database                                                                                                 |
| `<PROJECT_NAME>-local-redis`                | Queues and locks (password-protected)                                                                                 |
| `<PROJECT_NAME>-local-docker-proxy`         | A **filtered** gateway to your Docker daemon, visible only to the API (no `EXEC`, `SECRETS`, `SYSTEM` or `VOLUMES`)   |
| `backos-gen-<slug>`                         | One container **per generated backend**, started by the API when you start a platform from the interface              |

You never start a generated backend yourself: BackOS creates and manages its container.

---

## Before you start

- **Git** and **Docker** installed. Check them: `git --version`, `docker --version`.
- **Docker running**: `docker info` must print information, not an error such as *cannot connect to the Docker daemon*. Start Docker Desktop (or the Docker service) if needed.
- The project on your machine: see [Get the project](../../README.md#4-get-the-project-on-your-machine).
- Your secrets: see [Generate your secrets](README.md#generate-your-secrets). Keep a safe copy of `ENCRYPTION_KEY` and `JWT_SECRET`.

### Create the folder for generated projects

BackOS writes the code of the backends it generates in a folder of your machine. **Create it first**, with an **absolute path**:

```bash
# Linux or macOS
mkdir -p ~/backos-generated && echo "$HOME/backos-generated"
```

On macOS, keep the folder under your home folder: Docker Desktop shares it by default. Keep the printed path: you will put it in your settings file. The folder is mounted at the **same path** in the API container and on the host, which the generator needs to start generated containers.

---

## Step by step

All commands run from the project folder.

### 1. Create your settings file

```bash
cp .env.local.example .env.local
```

Open `.env.local` and fill in every `REPLACE_ME…`. The comments in the file say what each value is for. The important ones:

| Setting                                              | What to put                                                                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `PROJECT_NAME`                                       | Short name: it names your containers, networks and volumes                                                                                 |
| `LOCAL_PORT`                                         | The port you use in your browser. Change it if `4803` is taken. The API always listens on `4803` **inside** its container                  |
| `ENCRYPTION_KEY`, `JWT_SECRET`                       | The secrets you generated                                                                                                                  |
| `POSTGRES_PASSWORD`, `POSTGRES_APP_PASSWORD`, `REDIS_PASSWORD` | Strong random values. `REDIS_PASSWORD` needs at least 16 characters                                                              |
| **`POSTGRES_PROVISIONING_PASSWORD`**                 | ⚠️ **Not in the example file, but required.** Add this line yourself (a strong random value). Without it, PostgreSQL refuses to initialise |
| `SMTP_*`                                             | A mail server, because invitations and one-time codes go through it. A free option for a first try: <https://ethereal.email> (a fake inbox you read in a browser) |
| `OWNER_*`                                            | The owner account created automatically on the first start                                                                                 |
| `GENERATED_PROJECTS_HOST_PATH` and `GENERATED_PROJECTS_ROOT` | The folder you created above, **the same absolute path on both lines**                                                             |
| `FRONTEND_URL`, `CORS_ORIGIN`                        | Where your BackOS front end is served (used to build activation links). `CORS_ORIGIN=*` is acceptable for a single machine                  |

You may leave the `DATABASE_URL` and `POSTGRES_PROVISIONING_URL` lines of the example as they are: the compose file builds the real ones from your other values.

**Add one more setting**, so that the API can reach the generated backends it starts (see [Reaching generated backends](README.md#reaching-generated-backends-from-a-containerized-api)):

```ini
# Windows / macOS (Docker Desktop)
GENERATED_BACKEND_GATEWAY_HOST=host.docker.internal

# Linux (use these two lines instead)
GENERATED_BACKEND_HOST=172.17.0.1
GENERATED_BACKEND_GATEWAY_HOST=172.17.0.1
```

If you changed `LOCAL_PORT`, also add `GENERATED_BACKEND_BACKOS_URL=http://host.docker.internal:<LOCAL_PORT>`.

### 2. Start BackOS

```bash
make up-local
```

No `make`? This is equivalent:

```bash
./scripts/stack.sh up local
```

The first start **builds the image**, which can take a few minutes. The container then applies the database migrations and creates the owner account by itself.

### 3. Get the owner's activation details

In this mode, the API runs in production mode, so the activation link and one-time code are **not** printed in the logs: they are written **once** to a private file inside the API container. The logs only tell you where.

```bash
docker exec <PROJECT_NAME>-local-orchestrator cat /app/owner-activation.txt
```

Then delete the file:

```bash
docker exec <PROJECT_NAME>-local-orchestrator rm /app/owner-activation.txt
```

> [!WARNING]
> Copy the link and the code right away. They are valid for 48 hours. The link starts with `FRONTEND_URL`: it opens the BackOS web interface (a separate application) where you set up your owner account.

### 4. Check that it works

```bash
curl http://localhost:<LOCAL_PORT>/api/health
```

✅ It answers `200`. The API itself has **no web page**: use the BackOS front end, configured to call `http://localhost:<LOCAL_PORT>/api`. (The interactive Swagger docs exist only in [Development](DEPLOIEMENT_DEV.md): they are off in production mode.)

### 5. Generate your first backend

In the interface, create a platform and start its generation. When it finishes and you start the platform, BackOS runs it in its own container:

```bash
docker ps --filter "name=backos-gen-"
```

✅ You should see `backos-gen-<your-slug>`, with a port in the `4100`–`4999` range published on the host.

Then check that the API **reaches** that backend. Replace `<port>` with the port shown in the platform's panel, and `<gateway-host>` with the value of `GENERATED_BACKEND_GATEWAY_HOST`:

```bash
docker exec <PROJECT_NAME>-local-orchestrator wget -qO- http://<gateway-host>:<port>/generated-api/health
```

✅ A health response means the gateway can reach that backend.
❌ If it fails, re-check the `GENERATED_BACKEND_*` settings of step 1, then restart the stack and the platform.

---

## Daily use

| I want to…                                  | Do this                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Start BackOS                                | `make up-local`                                                                           |
| See the logs                                | `make logs-local` (`Ctrl+C` to leave: BackOS keeps running)                               |
| See the state                               | `make ps`                                                                                 |
| Stop it, **keeping** my data                | `make down-local`                                                                         |
| Update to a new version                     | `git pull`, then `make up-local` (it rebuilds the image)                                  |
| Apply a change I made in the code           | `make up-local` (it rebuilds the image)                                                   |
| Start from scratch, **erasing** my data     | `./scripts/stack.sh nuke local`, then `make up-local`                                     |

Stopping and restarting is safe: your data lives in named Docker volumes and is kept. Stopping is a good way to free CPU and RAM for something else.

> [!WARNING]
> `nuke local` deletes the database, the uploads and the backups. The owner's activation details are written again at the next start, since it is a fresh first start.

### Stopping does not stop generated backends

The generated backends (`backos-gen-*` containers) belong to Docker, not to the stack: they **keep running** after `down`, and keep using CPU and RAM. To stop them as well:

```bash
# Linux / macOS
docker ps --filter "name=backos-gen-" -q | xargs docker stop
```

When BackOS starts again, it **automatically restarts** the platforms you had left started. A platform you stopped yourself stays stopped (see [After a reboot](README.md#after-a-reboot)).

---

## Move to another machine

Nothing specific to redo:

1. Copy (or `git clone`) the project to the other machine.
2. **Copy your `.env.local`.** It holds your generated secrets: **do not regenerate them**, or you lose access to the data that was already encrypted.
3. Create the generated-projects folder there, and update its path in `.env.local`.
4. Run `make up-local`.

Your database does not travel with the file: volumes stay on the machine where they were created.

---

## Troubleshooting

| Symptom                                                                  | Cause and fix                                                                                                                                        |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Cannot connect to the Docker daemon`                                    | Docker is not running. Start Docker Desktop (or the Docker service).                                                                                 |
| PostgreSQL stops with `POSTGRES_PROVISIONING_PASSWORD is not set`        | Add that line to `.env.local` (see step 1). The first initialisation failed, so erase the half-created volume: `./scripts/stack.sh nuke local`, then `make up-local`. |
| The orchestrator stops right after starting                              | A setting is missing or invalid. The logs name it: `docker logs <PROJECT_NAME>-local-orchestrator`. Typical causes: `ENCRYPTION_KEY` not 64 hexadecimal characters, `JWT_SECRET` under 32 characters, `REDIS_PASSWORD` under 16. |
| `port is already allocated` / `address already in use`                   | Another program already uses that port. Stop it, or change `LOCAL_PORT` in `.env.local`.                                                             |
| `mounts denied` / *path is not shared* (macOS)                           | The generated-projects folder is outside the folders Docker Desktop shares. Create it under your home folder and update both paths in `.env.local`.  |
| `permission denied` when generating a backend                            | The API runs as a non-root user inside its container, and cannot write in your folder. Find its ids with `docker exec <PROJECT_NAME>-local-orchestrator id`, then give it the folder: `sudo chown -R <uid>:<gid> <your-folder>`. |
| A platform starts but never becomes healthy; the step 5 check fails      | The API cannot reach the generated backend. Check `GENERATED_BACKEND_GATEWAY_HOST` (and, on Linux, `GENERATED_BACKEND_HOST` and your firewall), then restart.  |
| `make: command not found`                                                | Use `./scripts/stack.sh up local` instead. On Linux/macOS, add the execute permission first: `chmod +x scripts/stack.sh deploy/entrypoint.sh`.        |
| `permission denied` on `stack.sh` or `entrypoint.sh`                     | `chmod +x scripts/stack.sh deploy/entrypoint.sh`.                                                                                                    |
| I did not copy the owner's activation link                               | It is in the file `/app/owner-activation.txt` of the API container, until you delete it (step 3). If you already deleted it, see the warning in [First start](README.md#first-start-the-owner-account). |
| *container name already in use*                                          | The stack was started with another tool (a hand-typed `docker compose`). Stop it the way you started it, then use `make` only. See [Drive each stack with one tool only](README.md#drive-each-stack-with-one-tool-only). |

---

## Good to know

**Advantages**

- Docker is the only thing to install, and one command starts everything.
- Same hardened image as Demo and Production (`cap_drop: ALL`, non-root, `no-new-privileges`). This is not a cut-price environment.
- The Docker daemon is reached through a **filtered proxy**, not through the raw Docker socket.
- Coexists with the other stacks on the same machine: each has its own Docker network and containers, named after `PROJECT_NAME`.

**Limits**

- ⚠️ **No TLS, by nature** (no domain, so no certificate). The port is published on all interfaces: any device of your network can reach it, and credentials travel in clear text on that network. Fine on a trusted home network; do not use it on a public Wi-Fi. For remote access, use [WireGuard](DEPLOIEMENT_WIREGUARD.md).
- A code change needs a rebuild (`make up-local`). For hot reload, use [Development](DEPLOIEMENT_DEV.md).
- No Swagger docs (production mode).
- Stopping the stack does not stop generated backends (see above).

---

## Next steps

- Change the code instead: [Development](DEPLOIEMENT_DEV.md).
- Run a stable private instance on a dedicated Windows PC, with a tray icon: [LAN](DEPLOIEMENT_LAN.md).
- Understand how everything fits together: [Deployment guides overview](README.md).
