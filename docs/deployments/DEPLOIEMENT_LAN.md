# LAN: a private instance on a dedicated PC

[← All deployment guides](README.md)

A stable BackOS instance for you or your team, reachable **only from your local network**. No domain name, no certificate, no router configuration. It is designed for a **dedicated Windows PC** acting as a server, and it comes with a **tray icon** and double-click scripts to start and stop it without a terminal.

> [!NOTE]
> Looking for a stable BackOS on **your own computer** (Linux or macOS), driven with `make`? That is [Local](DEPLOIEMENT_LOCAL.md). To **change the code**, see [Development](DEPLOIEMENT_DEV.md). The three differ: see [Dev, Local or LAN?](README.md#4-dev-local-or-lan).

| At a glance        |                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------- |
| **Best for**       | Personal or internal use on a dedicated PC, with no public domain                            |
| **Reachable from** | Any device on the same network: `http://<LAN-IP-of-the-server>:4803`                         |
| **You will need**  | Docker on the machine that acts as the server (Docker Desktop on Windows)                    |
| **Security**       | Same hardened image as Demo and Production, but **plain HTTP** (no TLS)                      |

**On this page:** [What runs](#what-runs) · [Choose how to drive it](#choose-how-to-drive-it) · [Before you start](#before-you-start) · [Step by step](#step-by-step) · [Daily use](#daily-use) · [Troubleshooting](#troubleshooting) · [Good to know](#good-to-know) · [Combine it](#combine-it-with-other-modes)

---

## What runs

One stack, defined in `deploy/docker-compose.lan.yml`, started with the settings file `.env.lan`:

| Container                                   | Role                                                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `<PROJECT_NAME>-lan-orchestrator`           | The **BackOS API**. Its port `4803` is published on **all interfaces** of the PC                                      |
| `<PROJECT_NAME>-lan-postgres`               | BackOS's own database                                                                                                 |
| `<PROJECT_NAME>-lan-redis`                  | Queues and locks (password-protected)                                                                                 |
| `<PROJECT_NAME>-lan-docker-proxy`           | A **filtered** gateway to the Docker daemon, visible only to the API (no `EXEC`, `SECRETS`, `SYSTEM` or `VOLUMES`)    |
| `backos-gen-<slug>`                         | One container **per generated backend**, started by the API when you start a platform                                 |

Your data lives in named volumes: `<PROJECT_NAME>-lan-postgres-data`, `-lan-uploads`, `-lan-backups` and `-lan-generated-projects`.

---

## Choose how to drive it

There is **one** LAN stack. Three tools control it. They run exactly the same containers, with the same level of security.

|                       | **Tray icon**                                              | **Double-click scripts**                              | **Command line**                                        |
| --------------------- | ---------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| Works on              | Windows only                                               | Windows only                                          | Windows, Linux, macOS                                   |
| How you control it    | Right-click an icon in the system tray                     | Double-click a `.bat` file                            | `docker compose` commands                               |
| Best if you…          | …want a permanent status light and a menu                  | …want simple one-shot actions                         | …run on Linux/macOS, or like to script things           |
| Launched with         | **`deploy\backend-tray.vbs`**                              | `deploy\start-backend.bat`, `stop-backend.bat`, `logs-backend.bat`, `status-backend.bat` | `deploy/docker-compose.lan.yml` |

The tray and the scripts are **not** a separate deployment mode: they are graphical shortcuts over `docker compose -f deploy/docker-compose.lan.yml --env-file .env.lan`.

> [!IMPORTANT]
> The LAN stack is **not** managed by `make` or `scripts/stack.sh`: they have no `lan` target. Use the tray, the `.bat` scripts, or the `docker compose` commands below. Pick one and keep using it; they all start the stack under the same Docker Compose project name (`deploy`), so they work together. See [Drive each stack with one tool only](README.md#drive-each-stack-with-one-tool-only).

---

## Before you start

- **Docker** installed and **running** on the machine that will act as the server (Docker Desktop on Windows/macOS). Check with `docker info`.
- The project cloned on that machine: see [Get the project](../../README.md#4-get-the-project-on-your-machine).
- Your secrets: see [Generate your secrets](README.md#generate-your-secrets).
- A mail account for the owner's invitations and one-time codes (see step 1).
- Your server's **local IP address**, which other devices will use:

  | System  | Command                         | Look for                                 |
  | ------- | ------------------------------- | ---------------------------------------- |
  | Windows | `ipconfig`                      | *IPv4 Address*, e.g. `192.168.1.20`      |
  | Linux   | `hostname -I`                   | The first address                        |
  | macOS   | `ipconfig getifaddr en0`        | The address printed                      |

> [!TIP]
> In your router's settings, **reserve a fixed local IP** for the server (look for *DHCP reservation*). Otherwise its address may change after a reboot and the bookmark on your other devices will stop working.

---

## Step by step

### 1. Create your settings file

From the project folder:

```bash
cp .env.lan.example .env.lan
```

On Windows PowerShell: `Copy-Item .env.lan.example .env.lan`.

Open `.env.lan` and replace every `REPLACE_ME…` and `REPLACE_WITH…`:

| Setting                                              | What to put                                                                                                                              |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `PROJECT_NAME`                                       | Short name: it names your containers, networks and volumes                                                                               |
| `FRONTEND_URL`                                       | The address where your users open the BackOS front end. It is used to build activation links and e-mail links                             |
| `CORS_ORIGIN`                                        | `*` is fine here, **only** because the server is never reachable from the Internet                                                       |
| `POSTGRES_PASSWORD`, `POSTGRES_PROVISIONING_PASSWORD`, `POSTGRES_APP_PASSWORD` | Strong random values                                                                           |
| `REDIS_PASSWORD`                                     | A strong random value, **at least 16 characters**                                                                                        |
| `ENCRYPTION_KEY`, `JWT_SECRET`                       | The secrets you generated                                                                                                                |
| `SMTP_*`                                             | A mail server. The example is set for Gmail: create an **app password** (below) and **never** use your real Gmail password               |
| `OWNER_*`                                            | The owner account created automatically on the first start                                                                               |

**Gmail app password.** Turn on 2-step verification on the Google account, then create an app password at <https://myaccount.google.com/apppasswords>. Google shows a 16-character code: that is your `SMTP_PASSWORD`. Any other SMTP provider works too: change `SMTP_HOST`, `SMTP_PORT` and the credentials.

### 2. Start the stack

**With the tray icon (Windows).** Double-click `deploy\backend-tray.vbs`. An icon appears in the system tray (you may need to click the `^` arrow to see it). It shows the state of the stack with a coloured dot: grey = stopped, orange = busy, green = running, red = error. **Right-click it → Start.**

> [!TIP]
> To get the icon back automatically after each Windows login, put a **shortcut** to `backend-tray.vbs` in your Startup folder (press `Win+R`, type `shell:startup`). The icon appears; it does not start the stack by itself, so click *Start* when you need it.

**With the double-click scripts (Windows).** Double-click `deploy\start-backend.bat`.

**With the command line** (any system, from the project folder):

```bash
docker compose -f deploy/docker-compose.lan.yml --env-file .env.lan up -d --build
```

The first start **builds the image** and can take a few minutes. It also applies the database migrations and creates the owner account.

### 3. Get the owner's activation details

In this mode, the API runs in production mode, so the activation link and one-time code are **not** printed in the logs: they are written **once** to a private file inside the API container. The logs only tell you where (`logs-backend.bat`, or the tray's *View logs*).

```bash
docker exec <PROJECT_NAME>-lan-orchestrator cat /app/owner-activation.txt
```

Then delete the file:

```bash
docker exec <PROJECT_NAME>-lan-orchestrator rm /app/owner-activation.txt
```

> [!WARNING]
> Copy the link and the code right away. They are valid for 48 hours. The link starts with `FRONTEND_URL`: it opens the BackOS web interface (a separate application) where you set up your owner account.

### 4. Check that it works

On the server, then from any other device of the same network:

```
http://<LAN-IP-of-the-server>:4803/api/health
```

✅ It answers `200`. (On the server, the tray's *Test … /api/health* entry opens this page for you.)

The API itself has **no web page**: your BackOS front end (for example on PC2) must be configured to call `http://<LAN-IP-of-the-server>:4803`. The interactive Swagger docs exist only in [Development](DEPLOIEMENT_DEV.md): they are off in production mode.

### 5. Check your first generated backend

The API reaches generated backends through `host.docker.internal`. Verify it works **the first time you generate a backend**. Replace `<port>` with the port shown in the platform's panel:

```bash
docker exec <PROJECT_NAME>-lan-orchestrator wget -qO- http://host.docker.internal:<port>/generated-api/health
```

✅ A health response means the gateway can reach that backend.

❌ If it fails, the gateway will not be able to reach it. Report the output of the command rather than working around it by exposing the port to the whole network.

> [!NOTE]
> **Linux server?** The LAN stack is designed around Docker Desktop. On Linux, a port published on `127.0.0.1` cannot be reached from a container: add `GENERATED_BACKEND_HOST=172.17.0.1` to `.env.lan`, and see [Reaching generated backends](README.md#reaching-generated-backends-from-a-containerized-api). This has not been tested on a real server.

---

## Daily use

| I want to…                          | Tray icon                  | Double-click script (in `deploy\`)  | Command line (from the project folder)                                                          |
| ----------------------------------- | -------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| Start                               | Right-click → **Start**    | `start-backend.bat`                 | `docker compose -f deploy/docker-compose.lan.yml --env-file .env.lan up -d --build`             |
| Stop (**keeps** all data)           | Right-click → **Stop**     | `stop-backend.bat`                  | `docker compose -f deploy/docker-compose.lan.yml --env-file .env.lan stop`                      |
| See the logs                        | Right-click → **View logs**| `logs-backend.bat`                  | `docker compose -f deploy/docker-compose.lan.yml --env-file .env.lan logs -f orchestrator`      |
| See the state                       | The coloured dot           | `status-backend.bat`                | `docker compose -f deploy/docker-compose.lan.yml --env-file .env.lan ps`                        |
| Update to a new version             | —                          | `git pull`, then `start-backend.bat`| `git pull`, then the *Start* command above (it rebuilds the image)                              |
| Erase **everything**                | —                          | —                                   | `docker compose -f deploy/docker-compose.lan.yml --env-file .env.lan down -v`                   |

Stopping is a good way to free CPU and RAM on the machine for something else: nothing is uninstalled and your data stays in the named volumes. `stop` keeps the containers; `down` removes them (the data stays too).

> [!WARNING]
> `down -v` deletes the database, the uploads and the backups. The owner's activation details are written again at the next start, since it is a fresh first start.

### Stopping does not stop generated backends

`stop-backend.bat` (or the tray's *Stop*) stops the API, PostgreSQL, Redis and the Docker proxy. The **generated backends (`backos-gen-*` containers) keep running**, because they belong to Docker, not to the stack, and they keep using CPU and RAM. To stop them as well:

```powershell
# Windows PowerShell
docker ps --filter "name=backos-gen-" -q | ForEach-Object { docker stop $_ }
```

```bash
# Linux / macOS
docker ps --filter "name=backos-gen-" -q | xargs docker stop
```

When the stack starts again (or after a reboot), the API **automatically restarts** the backends you had left started. A backend you stopped yourself from the panel stays stopped.

---

## Troubleshooting

| Symptom                                                  | Cause and fix                                                                                                                                                  |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Cannot connect to the Docker daemon`                    | Docker is not running. Start Docker Desktop.                                                                                                                   |
| I double-click `backend-tray.vbs` and nothing seems to happen | The icon is in the tray, possibly hidden behind the `^` arrow. If it never appears, start `deploy\start-backend.bat` instead.                             |
| The icon is red                                          | A container exited. Right-click → **View logs**, or run `status-backend.bat`.                                                                                  |
| The page does not load from another device               | Check that you use the server's **local** IP and port `4803`, and that both devices are on the same network. On Windows, the firewall may block incoming connections on that port: allow it for **private networks** only. |
| The address worked yesterday and not today               | The server's local IP changed. Reserve a fixed IP in your router (see the tip above).                                                                          |
| The API refuses to start                                 | A setting is missing or invalid in `.env.lan`. The logs name it. Typical causes: a `REPLACE_ME…` left, `ENCRYPTION_KEY` not 64 hexadecimal characters, `JWT_SECRET` under 32 characters, `REDIS_PASSWORD` under 16. |
| I did not copy the owner's activation link               | It is in `/app/owner-activation.txt` inside the API container, until you delete it (step 3). If you already deleted it, see the warning in [First start](README.md#first-start-the-owner-account). |
| The step 5 check fails                                   | The gateway cannot reach that backend. Share the command output instead of exposing the port network-wide.                                                     |
| Everything stopped but the PC is still slow              | The generated backends are still running: see [Stopping does not stop generated backends](#stopping-does-not-stop-generated-backends).                          |
| *container name already in use*                          | Another tool started the same stack (for example a `docker compose` command with `-p`). Stop it the way it was started, and stick to one tool.                 |

---

## Good to know

**Advantages**

- No third-party service and no complex network setup: no port forwarding, no domain name.
- Controllable without a command line thanks to the tray and the scripts, so usable by someone who does not know Docker.
- Same hardened image as Production and Demo (`cap_drop: ALL`, non-root, CPU and memory limits). This is not a cut-price environment.

**What the stack does for you**

- It ships its own `docker-socket-proxy`, on a private network with limited rights. Generated backends run in `backos-gen-<slug>` containers, each on its own network, publishing their port on the machine's `127.0.0.1`.
- `generated_projects` is a **named Docker volume**, not a host folder, to avoid Windows path problems. For the same reason, uploads of generated backends go to named volumes (`backos-gen-<slug>-uploads`, via `GENERATED_BACKEND_UPLOADS_USE_VOLUME`).
- It is ready for the [optional public relay](combines/DEPLOIEMENT_COMBINE_LAN_DEMO_WIREGUARD.md#6-optional-expose-one-generated-backend) of one generated backend: it trusts **one** proxy hop (`TRUST_PROXY_HOPS=1`).

**Limits**

- ⚠️ **No TLS, by nature** (no domain, so no certificate). Credentials and tokens travel **in clear text** on the local network. That is acceptable on a trusted home or office network. Never let it slide onto a public Wi-Fi without a tunnel on top: see [WireGuard](DEPLOIEMENT_WIREGUARD.md).
- **Never forward port `4803` on your router.** It would expose your private instance to the Internet.
- Because the stack trusts one proxy hop, a client of your own network could forge the `X-Forwarded-For` header on the administration API (the IP written in audit logs could be falsified). The risk stays inside your local network.
- Stopping the stack does not stop generated backends (see above).
- Not driven by `make` / `stack.sh`.

---

## Combine it with other modes

- **+ WireGuard**: encrypted remote access without ever exposing port `4803` to the Internet. → [WireGuard](DEPLOIEMENT_WIREGUARD.md)
- **+ Demo + WireGuard, on a single machine**: a private instance and a public demo on one PC. → [LAN + Demo + WireGuard](combines/DEPLOIEMENT_COMBINE_LAN_DEMO_WIREGUARD.md)
- **+ Exposing one generated backend** (for example your portfolio's API, with its front end on Vercel): same combined guide, [section 6](combines/DEPLOIEMENT_COMBINE_LAN_DEMO_WIREGUARD.md#6-optional-expose-one-generated-backend). It opens only `/generated/<slug>/`, never the administration API.
