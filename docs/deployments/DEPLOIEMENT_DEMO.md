# Demo: a public instance, read-only

[← All deployment guides](README.md)

A BackOS instance open to the Internet, with a **read-only `demo` account**, to show the project to a client, an investor or a recruiter without ever putting real data at risk.

| At a glance        |                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| **Best for**       | Presentations and client demos                                                                    |
| **Reachable from** | The Internet: `https://<DEMO_DOMAIN>`, with an automatic Let's Encrypt certificate                |
| **You will need**  | A domain name, ports **80 and 443** reachable from the Internet, Docker and Docker Compose        |
| **Data**           | Its own database, completely separate from production                                            |

**On this page:** [How it protects you](#how-it-protects-you) · [Before you start](#before-you-start) · [Step by step](#step-by-step) · [Daily use](#daily-use) · [Troubleshooting](#troubleshooting) · [Good to know](#good-to-know) · [Combine it](#combine-it-with-other-modes)

---

## How it protects you

- **Read-only account.** The `demo` account only has `*_READ` permissions: it can never create, edit, delete or trigger a backend generation. On top of that, a global guard on the server **refuses every write request** made by the account whose e-mail is `DEMO_WORKEMAIL` (except logging out and renewing the session), even on routes without a dedicated permission.
- **Nothing can bypass the guard silently.** `DEMO_WORKEMAIL` is **mandatory** in `.env.demo`: without it, `docker compose` refuses to start the demo stack.
- **No access to Docker.** The demo container has no `DOCKER_HOST` and no `docker-socket-proxy` on the network it shares with Traefik. Even if someone found a code-execution flaw in that container, no technical path leads to the host's Docker API.
- **Separate database.** The demo has its own PostgreSQL (with its own volume) and its own Redis. Nothing is shared with production.
- **No accidental exposure.** Traefik only routes containers explicitly labelled `traefik.enable=true` (`exposedbydefault=false`). Its dashboard is disabled.

> [!NOTE]
> The read-only guard applies to the **`demo` account only**. The stack also creates an **owner** account (like every stack), which can write: it is how you prepare what the visitors will see (see [step 5](#5-prepare-what-visitors-will-see)).

---

## Before you start

You need three things:

1. **A domain name** (or sub-domain) pointing to the public IP of your server. A free sub-domain such as DuckDNS is fine, even if your public IP changes: see [Create a dynamic DNS account](DEPLOIEMENT_WIREGUARD.md#1-create-a-dynamic-dns-account-duckdns).
2. **Ports 80 and 443 reachable from the Internet.** If the server sits behind a home router, forward both ports to it. Let's Encrypt needs them to issue the certificate (HTTP-01 challenge).
3. **Docker and Docker Compose** installed. Check with `docker --version` and `docker compose version`.

> [!WARNING]
> **Behind CGNAT?** Some Internet providers share one public IP between several homes (CGNAT). Port forwarding is then impossible without contacting your provider. Quick test: temporarily forward port 80, then check it from outside with <https://canyouseeme.org>.

You also need:

- The project on the server: see [Get the project](../../README.md#4-get-the-project-on-your-machine).
- Your secrets: see [Generate your secrets](README.md#generate-your-secrets).
- A **folder for generated projects**, created beforehand, with an absolute path (for example `/srv/backos/generated-demo`). The demo mounts it at the same path in its container; the setting is `GENERATED_PROJECTS_HOST_PATH`. The demo never generates anything, so the folder stays empty. On **Windows with Docker Desktop**, use a Linux-style path like this one, not a `C:\…` path (it cannot be mounted at an identical path inside a container).

---

## Step by step

### 1. Create your settings file

From the project folder:

```bash
cp .env.demo.example .env.demo
```

Fill in every `REPLACE_ME…` and `REPLACE_WITH…`:

| Setting                                          | What to put                                                                                                                             |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `PROJECT_NAME`                                   | Short name. If Production runs on the same server, it must be the **same** in both files (they share one Traefik network)               |
| `DEMO_DOMAIN`                                    | The domain of the demo, without `https://`                                                                                              |
| `ACME_EMAIL`                                     | The e-mail address Let's Encrypt uses for expiry notices                                                                                |
| `CORS_ORIGIN`, `FRONTEND_URL`                    | `https://` + your demo domain                                                                                                           |
| `POSTGRES_PASSWORD`, `POSTGRES_PROVISIONING_PASSWORD`, `POSTGRES_APP_PASSWORD`, `REDIS_PASSWORD` | Strong random values. `REDIS_PASSWORD` needs at least 16 characters            |
| `ENCRYPTION_KEY`, `JWT_SECRET`                   | The secrets you generated. **Different** from production's                                                                             |
| `SMTP_*`                                         | A real mail server (invitations and one-time codes go through it)                                                                       |
| `OWNER_*`                                        | The owner account created on the first start                                                                                            |
| `GENERATED_PROJECTS_HOST_PATH`                   | The folder you created                                                                                                                  |
| **`DEMO_WORKEMAIL`**                             | **Mandatory.** The e-mail of the read-only demo account                                                                                 |
| `DEMO_USERNAME`, `DEMO_FIRSTNAME`, `DEMO_LASTNAME` | Name of the demo account (default: `demo` / `Demo` / `Account`)                                                                      |
| **`DEMO_TOTP_SECRET`**                           | **Mandatory.** A fixed base32 secret that generates the demo account's sign-in codes. It is **public by design**. Generate one with `head -c 20 /dev/urandom \| base32` (Linux/macOS), or any TOTP tool |

### 2. Start the demo

`edge` (the shared Traefik) must run **before** the demo. Pick **one** of the two ways below, and keep using it: they start the stacks under different Docker Compose project names, so they must not be mixed (see [Drive each stack with one tool only](README.md#drive-each-stack-with-one-tool-only)).

**Way A: by hand. Needs only `.env.demo`.** The right choice for a server that only hosts the demo.

```bash
# a. the shared edge stack (Traefik alone)
docker compose -p backos-edge -f deploy/docker-compose.edge.yml --env-file .env.demo up -d --remove-orphans

# b. the demo stack
docker compose -p backos-demo -f deploy/docker-compose.demo.yml --env-file .env.demo up -d --build
```

**Way B: with the shortcut.** Starts `edge` first, then `demo`. It is also what the [CI/CD](CI_CD.md) pipeline uses.

```bash
make up-demo
```

⚠️ `edge` **always reads `.env.production`**, so Way B needs that file to exist, even if you never run Production. For a demo-only server, create it with just these two lines (the same `PROJECT_NAME` as in `.env.demo`, and your e-mail):

```ini
PROJECT_NAME=myproject
ACME_EMAIL=admin@example.com
```

Without it, `make up-demo` stops with *Required environment file '.env.production' is missing*.

The first start builds the image and applies the migrations and seeds by itself.

> [!NOTE]
> **One `edge` for everything.** `edge` (Traefik) is shared. If you also run Production on the same server, do **not** start a second one: follow [Demo + Production](combines/DEPLOIEMENT_COMBINE_DEMO_PRODUCTION.md).

### 3. Check the TLS certificate

Do this **before** sharing the link. Traefik logs only warnings and errors, so a successful certificate request is **silent**: check for the absence of errors, then test the site.

```bash
docker logs <PROJECT_NAME>-edge-traefik --tail 50
curl -I https://<DEMO_DOMAIN>/api/health
```

✅ No certificate (ACME) error in the logs, and the `curl` answer is `HTTP/2 200`. Then open `https://<DEMO_DOMAIN>/api/health` in a browser and check for the padlock. The first certificate can take a minute.

### 4. Get the demo credentials

> [!NOTE]
> `https://<DEMO_DOMAIN>` is the demo's **API**: it has no web page of its own. Visitors use it through a BackOS front end configured to call `https://<DEMO_DOMAIN>/api`.

The demo account signs in with its **e-mail or username** and a **6-digit code**. The code comes from an authenticator app (or any TOTP tool) set up with `DEMO_TOTP_SECRET`, which is in your `.env.demo`. Because that secret is public by design, anyone you give it to can sign in to the demo: give it to the person you are presenting to.

### 5. Prepare what visitors will see

Starting the stack creates the demo **account and role** (idempotent: it is checked again at every start). It does **not** load sample business data. A read-only account on an empty instance shows very little, so before a presentation:

1. Read the owner's activation details (written once to a file in the API container, not in the logs):

   ```bash
   docker exec <PROJECT_NAME>-demo-orchestrator cat /app/owner-activation.txt
   docker exec <PROJECT_NAME>-demo-orchestrator rm  /app/owner-activation.txt
   ```

   The link starts with `FRONTEND_URL` and is valid for 48 hours.
2. Sign in with the **owner** account and create the platforms and data you want to show.
3. Sign in with the **demo** account and check what a visitor sees.

---

## Daily use

| I want to…                              | Way A (by hand)                                                                              | Way B (shortcut)                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------- |
| Start the demo before a presentation    | Both commands of step 2                                                                      | `make up-demo`                      |
| Switch it off when it is not used       | `docker compose -p backos-demo -f deploy/docker-compose.demo.yml --env-file .env.demo down`  | `./scripts/stack.sh down demo`      |
| Check the state                         | `docker ps --filter "name=<PROJECT_NAME>-"`                                                  | `make ps`                           |
| Follow the demo logs                    | `docker logs -f <PROJECT_NAME>-demo-orchestrator`                                            | `make logs-demo`                    |
| Erase the demo and start over           | The `down` command above, with `-v` added                                                    | `./scripts/stack.sh nuke demo` (or `make nuke-demo`) |

**Switching off the demo** frees resources and reduces the attack surface you expose. Leave `edge` running if you plan to restart the demo later: Traefik is light and its certificate stays valid.

---

## Troubleshooting

| Symptom                                                        | Cause and fix                                                                                                                                                           |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker compose` refuses to start the demo stack: *DEMO_WORKEMAIL must be set* | `DEMO_WORKEMAIL` is missing in `.env.demo`. It is mandatory.                                                                                    |
| *POSTGRES_APP_USER must be set* (or `…_PASSWORD`)              | The two `POSTGRES_APP_*` lines are missing in `.env.demo`.                                                                                                              |
| `make up-demo`: *Required environment file '.env.production' is missing* | `edge` reads `.env.production`. Create it (step 2, Way B) or use Way A.                                                                     |
| *network … declared as external, but could not be found*       | `edge` is not running, or its `PROJECT_NAME` differs from the one in `.env.demo`. Start `edge` first, with the same `PROJECT_NAME`.                                      |
| The demo container stops right after starting                  | A setting is missing or invalid. Check `docker logs <PROJECT_NAME>-demo-orchestrator`. Typical causes: `DEMO_TOTP_SECRET` or `DEMO_WORKEMAIL` empty, `ENCRYPTION_KEY` not 64 hexadecimal characters, `REDIS_PASSWORD` under 16 characters. |
| No certificate, or a browser warning                           | The domain does not point to your public IP yet, or ports 80/443 are not reachable. Check the DNS record, the router forwarding, and the Traefik logs (step 3).        |
| It works from your network but not from outside                | Port forwarding is missing, or you are behind CGNAT (see the warning above).                                                                                            |
| The visitor cannot create or generate anything                 | This is the expected behaviour: the account is read-only, and the demo container has no Docker access.                                                                  |
| I need to show a write action live                             | The demo account cannot. Use your own work account on your own instance ([Local](DEPLOIEMENT_LOCAL.md), [LAN](DEPLOIEMENT_LAN.md) or Production), and drive the screen yourself. |

---

## Good to know

**Advantages**

- A clean setup: nothing to fear if someone abuses the demo account (read-only) or looks at real data (separate database).
- A demo container with no Docker access: even an application flaw opens no path to the rest of the server.
- Automatic TLS: no manual certificate handling.

**Limits**

- Needs a real domain name and truly reachable ports 80/443. Impossible behind CGNAT without a workaround: see [LAN + Demo + WireGuard](combines/DEPLOIEMENT_COMBINE_LAN_DEMO_WIREGUARD.md) for that precise case.
- Read-only only: it cannot show write actions live.
- The demo has no sample data of its own: you prepare it with the owner account (step 5).

---

## Combine it with other modes

- **+ Production, same server**: both behind the same Traefik. → [Demo + Production](combines/DEPLOIEMENT_COMBINE_DEMO_PRODUCTION.md)
- **+ LAN + WireGuard, one PC**: when the server has no other role than hosting the demo *and* your private instance. → [LAN + Demo + WireGuard](combines/DEPLOIEMENT_COMBINE_LAN_DEMO_WIREGUARD.md)
