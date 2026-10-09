# LAN + Demo + WireGuard on a single server PC

[← All deployment guides](../README.md) · [Combined deployments](../README.md#1-which-guide-should-i-follow)

One machine that serves **both** a protected private instance and a public demo, with encrypted remote access to the private part. The private part is **never exposed directly to the Internet**.

> If you only have one machine available as a server, this is the reference deployment.

| At a glance        |                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| **Best for**       | One server PC: your own private instance **and** a public demo to show people                              |
| **Public**         | Ports `80/443` (the demo only) and `51820/UDP` (WireGuard)                                                 |
| **Private**        | The LAN stack (port `4803`): only from your local network, or through the tunnel                           |
| **You will need**  | Docker, a domain name for the demo, a router where you can forward ports                                   |
| **Read first**     | [LAN](../DEPLOIEMENT_LAN.md), [Demo](../DEPLOIEMENT_DEMO.md) and [WireGuard](../DEPLOIEMENT_WIREGUARD.md) — this page shows how to make them live together |

**On this page:** [The setup](#the-setup) · [1. Prerequisites](#1-prerequisites-on-pc1) · [2. LAN stack](#2-lan-stack-and-windows-tray-your-private-part) · [3. Demo stack](#3-public-demo-stack-hardened) · [4. WireGuard](#4-wireguard-your-remote-access-to-the-lan-stack) · [5. Router](#5-router-firewall-the-one-step-that-protects-everything) · [6. Expose a generated backend](#6-optional-expose-one-generated-backend) · [7. PC2](#7-pc2-the-front-end) · [Security](#security-model-at-a-glance) · [Checklist](#checklist-before-showing-the-demo-to-someone)

---

## The setup

Two machines are involved. **PC1** hosts the whole back end, and you can switch its stacks off and on at will. **PC2** only runs the front end, like a regular desktop app.

> [!NOTE]
> **PC2 is optional.** With a single machine, PC1 plays both roles: skip [section 7](#7-pc2-the-front-end).

```
                                   Internet
                                      │
                     ┌────────────────┴────────────────┐
                     │                                 │
              Port 80/443                        Port 51820/UDP
        (forwarded by the router)          (forwarded by the router)
                     │                                 │
                     ▼                                 ▼
              ┌─────────────┐                    ┌─────────────┐
              │   Traefik   │                    │  WireGuard  │
              │ (auto TLS)  │                    │   server    │
              └──────┬──────┘                    └──────┬──────┘
                     │                                  │
                     ▼                                  ▼
          ┌────────────────────┐              encrypted tunnel, as if
          │   DEMO stack (3)   │              the client were on the LAN
          │  own PostgreSQL/   │                        │
          │  Redis/API         │                        ▼
          │  read-only demo    │              ┌─────────────────────────┐
          │  account           │              │  LAN stack (2), driven  │
          │  NO Docker access  │              │  by the Windows tray    │
          └────────────────────┘              │  port 4803, NEVER       │
                                              │  exposed to the router  │
                                              └─────────────────────────┘
══════════════════════════════════  PC1 (server)  ═══════════════════════
                                    PC2 (workstation)
              PC2 reaches PC1 through:
              - its local IP, if both are on the same LAN
              - the WireGuard tunnel, if PC2 is elsewhere
              The front end (an icon on PC2's desktop) sends its requests to
              PC1's back end. No business logic runs on PC2.
```

### The golden rule

> [!IMPORTANT]
> **PC1's router forwards only two ports:** `80/443` (Traefik, for the demo only) and `51820/UDP` (WireGuard). The LAN stack's port (**`4803`**) is **never** forwarded. This single rule is what keeps the private part private, even though PC1 also acts as a public front for the demo.

### Two stacks on one PC: keep their Docker names apart

The LAN stack, driven by the tray or the `.bat` scripts, runs under the Docker Compose project name `deploy`. The demo and `edge` use the **same compose folder** (`deploy/`) and the same service names (`postgres`, `redis`, `orchestrator`). Started by hand **without a project name**, the demo would take the LAN stack's containers for its own and **recreate them**. That is why every demo and `edge` command in this guide carries a `-p` option (`backos-demo`, `backos-edge`). Keep it, and never start the demo or `edge` without it.

> [!WARNING]
> If you already started these stacks without `-p` (for example from an older version of this guide), stop them with the **same commands you used to start them**, then restart them as shown here.

---

## 1. Prerequisites on PC1

- **Docker Desktop** installed and **running**.
- **The project cloned** on PC1: see [Get the project](../../../README.md#4-get-the-project-on-your-machine).
- **A domain name** pointing to PC1's public IP, for the demo (Let's Encrypt TLS). A free DuckDNS sub-domain is fine: see [Create a dynamic DNS account](../DEPLOIEMENT_WIREGUARD.md#1-create-a-dynamic-dns-account-duckdns). The same mechanism serves both uses: following a public IP that changes.
- **Not behind CGNAT.** Some providers share one public IP between several homes. Port forwarding for the demo is then impossible without contacting your provider. Quick test: temporarily forward port 80 and check it from outside with <https://canyouseeme.org>.
- Your secrets, **different for the LAN stack and the demo**: see [Generate your secrets](../README.md#generate-your-secrets).

---

## 2. LAN stack and Windows tray (your private part)

This is your only real working instance: the one you sign in to with your work account. The Windows tray and the `.bat` scripts are only graphical shortcuts over the LAN stack's `docker compose` (same hardened containers, same isolation).

```powershell
Copy-Item .env.lan.example .env.lan
# Fill in the REPLACE_ME… values in .env.lan (secrets, PROJECT_NAME, FRONTEND_URL, SMTP, OWNER_*…)
```

Then start it, with the tray or the scripts, as explained in the [LAN guide](../DEPLOIEMENT_LAN.md#2-start-the-stack):

- **Tray icon:** double-click `deploy\backend-tray.vbs`, then right-click the icon → **Start**.
- **Or script:** double-click `deploy\start-backend.bat`.

The tray lets you start, stop, view the logs and see the state with no command to type. It is the button to use when you want to free PC1's resources for something else: **switching off the LAN stack does not touch the Demo stack**. They are independent.

The stack ships its own `docker-socket-proxy` (private network, limited rights), which lets your instance generate and run backends in `backos-gen-<slug>` containers. Do the reachability check described in [LAN, step 5](../DEPLOIEMENT_LAN.md#5-check-your-first-generated-backend) when you generate your first backend. The owner's activation details are in a file inside the API container, not in the logs: see [LAN, step 3](../DEPLOIEMENT_LAN.md#3-get-the-owners-activation-details).

> [!NOTE]
> **No port of this stack is forwarded on the router.** It is never directly reachable from the Internet: only from the local network, or through WireGuard (section 4). The one possible exception is the optional relay of `/generated/*` by Traefik (section 6), which does not open port `4803` itself.

For all the details (command-line alternative, daily use), see the [LAN guide](../DEPLOIEMENT_LAN.md).

---

## 3. Public demo stack (hardened)

A completely separate instance: its own database, its own containers, and a **read-only `demo` account** created automatically.

**The demo container deliberately has no access to Docker.** The `docker-socket-proxy`, which lets your real instance create containers to generate backends, was removed from its configuration. The demo account can never trigger a generation anyway (read-only permissions), so that access would be of no use and would only enlarge the attack surface if the demo container were ever compromised. The proxy is no longer in the `edge` stack either: each stack that needs it (here, the LAN stack) has its own on a private network, out of the demo's reach.

From the project folder:

```powershell
Copy-Item .env.demo.example .env.demo
# Fill in the REPLACE_ME… values: DEMO_DOMAIN, ACME_EMAIL, secrets, DEMO_WORKEMAIL,
# DEMO_TOTP_SECRET, SMTP, OWNER_*, and the folder setting below.
```

`PROJECT_NAME` may be the same as in `.env.lan` or different: container names already differ (`…-lan-…`, `…-demo-…`).

**`GENERATED_PROJECTS_HOST_PATH`:** the demo never generates anything, but its compose file still mounts this folder at the same path inside the container, so the setting must be a valid path. On Windows with Docker Desktop, use a **Linux-style** path such as `/srv/backos/generated-demo` (Docker creates it inside its own virtual machine; it stays empty), and **not** a `C:\…` path, which cannot be mounted at an identical path inside a container.

Start Traefik (`edge`), then the demo, both with the demo settings file:

```powershell
docker compose -p backos-edge -f deploy/docker-compose.edge.yml --env-file .env.demo up -d --remove-orphans
docker compose -p backos-demo -f deploy/docker-compose.demo.yml --env-file .env.demo up -d --build
```

> [!NOTE]
> This is "Way A" of the [Demo guide](../DEPLOIEMENT_DEMO.md#2-start-the-demo), which needs only `.env.demo`. The `make up-demo` shortcut would also work, but it requires an extra `.env.production` file just for Traefik. Do not mix the two ways.

**Check that the TLS certificate was issued** before sharing the link. Traefik only logs warnings and errors, so a success is silent: look for the absence of errors, then test the site.

```powershell
docker logs <PROJECT_NAME>-edge-traefik --tail 50
curl.exe -I https://<DEMO_DOMAIN>/api/health
```

✅ No certificate (ACME) error, and the answer is `HTTP/2 200`.

**The demo account's credentials** (to give to the person you are presenting to) are its e-mail or username (`DEMO_WORKEMAIL` / `DEMO_USERNAME`) and a 6-digit code generated from `DEMO_TOTP_SECRET`, all from `.env.demo`. The stack re-creates the account and its read-only role at every start; it does **not** load sample data. Prepare what visitors will see with the **owner** account of the demo, whose activation details are in `/app/owner-activation.txt` inside the demo API container: see [Demo, step 5](../DEPLOIEMENT_DEMO.md#5-prepare-what-visitors-will-see).

> [!NOTE]
> `https://<DEMO_DOMAIN>` is the demo's **API**. Visitors use it through a BackOS front end configured to call `https://<DEMO_DOMAIN>/api`.

**Switch the demo off** when no presentation is planned:

```powershell
docker compose -p backos-demo -f deploy/docker-compose.demo.yml --env-file .env.demo down
```

Leave `edge` running if you plan to restart the demo later: it is Traefik, light, and its TLS certificate stays valid.

For all the details, see the [Demo guide](../DEPLOIEMENT_DEMO.md).

---

## 4. WireGuard: your remote access to the LAN stack

Follow the [WireGuard guide](../DEPLOIEMENT_WIREGUARD.md) for the full setup (DuckDNS, key generation, server and client configuration), using its **Windows** steps.

One point to remember for this combined deployment: **generate a WireGuard key pair for yourself only** (and one per device you use, never a shared key). It is the only entry point to PC1 other than the demo, so keep it strictly personal.

Once the tunnel is up on PC2 (or your phone…), you reach PC1's LAN stack through its private WireGuard IP (for example `10.8.0.1:4803`), exactly as if you were on the same network. If it does not answer, check that the Windows firewall lets port `4803` in on the WireGuard network (see the [WireGuard troubleshooting](../DEPLOIEMENT_WIREGUARD.md#troubleshooting)).

---

## 5. Router firewall: the one step that protects everything

In your router's administration page, set up port forwarding to redirect **only**:

| External port | Protocol | To  | Why                                           |
| ------------- | -------- | --- | --------------------------------------------- |
| `80`          | TCP      | PC1 | HTTP → HTTPS redirect (Traefik, demo)         |
| `443`         | TCP      | PC1 | TLS (Traefik, demo)                           |
| `51820`       | UDP      | PC1 | WireGuard                                     |

> [!WARNING]
> **Never forward port `4803`**. It is the LAN stack's port: it must be reachable only from the local network or through the WireGuard tunnel.

**Turn off UPnP** on the router if the option exists. Some software uses it to forward a port by itself without you seeing it, which could expose `4803` by accident, with no explicit action on your part.

---

## 6. (Optional) Expose one generated backend

**Use case:** you generate your **portfolio's backend** with BackOS, and its front end is hosted elsewhere (Vercel, Netlify…). The visitors are strangers on the Internet: they are not in your WireGuard tunnel and cannot reach the LAN stack. Traefik can relay **only** `https://<api>/generated/<slug>/...` to the gateway of your LAN stack, which forwards it to the right backend.

```
Visitor (Vercel front) ── HTTPS ──> Traefik (80/443) ──> host.docker.internal:4803
                                     only /generated/ is relayed         │
                                                                         ▼
                                                   gateway of the LAN API
                                                                         ▼
                                                   generated backend (127.0.0.1:<port>)
```

### Set it up

1. **A second domain name** for the API (for example a second DuckDNS name pointing to the same public IP as the demo). Traefik issues one certificate per name.
2. Copy `deploy/traefik-generated-gateway.example.yml` to `deploy/traefik-dynamic/` (for example as `generated-gateway.yml`) and replace `api.REPLACE_ME.duckdns.org` with your API domain. If Traefik does not pick it up (file watching is unreliable with folders mounted under Docker Desktop on Windows), restart it: `docker restart <PROJECT_NAME>-edge-traefik`.
3. In BackOS, open the portfolio's platform and fill in its **URL** field with the front end's address (for example `https://my-portfolio.vercel.app`). That URL, together with BackOS's own front-end address (`FRONTEND_URL`), forms the list of **allowed CORS origins** of the generated backend.
4. In the Vercel front end, the API URL becomes `https://<api-domain>/generated/<slug>`. **HTTPS is mandatory**: a Vercel page cannot call `http://` without the browser blocking it.
5. Generate (or regenerate) the platform, then start it from BackOS.

### Check it

- `https://<api-domain>/api/health` must answer **404**: the administration API is **not** routed.
- `https://<api-domain>/generated/<slug>/...` must answer from the generated backend.

### Good to know

- **PC1 must be on, and the LAN stack started.** If you switch it off with the tray, the portfolio loses its API: the gateway answers "Not found".
- **Never route `/api`** (the administration API), nor a `Host` without `PathPrefix(/generated/)`: that would expose your private instance to the Internet.
- The gateway **limits each IP to 120 requests per minute** and only routes platforms that are **started**. The generated backend keeps its own authentication: its users are its own.
- The LAN stack trusts **one** proxy hop (`TRUST_PROXY_HOPS=1`) so that the limit applies to each visitor, not to Traefik as a whole.
- The backend's **Swagger docs are off in production** (the default): do not enable them on a public route.
- Images served from `uploads` may be blocked when displayed with `<img>` from another site: generated backends send `Cross-Origin-Resource-Policy: same-origin` by default (`helmet`).

---

## 7. PC2: the front end

PC2 only runs the front-end application (an icon on the desktop). Set its API URL to PC1:

| Where PC2 is                    | API URL to use                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------- |
| On the **same local network**   | PC1's local address, for example `http://192.168.1.x:4803`                       |
| **Elsewhere**                   | PC1's WireGuard address, for example `http://10.8.0.1:4803`, once the tunnel of [section 4](#4-wireguard-your-remote-access-to-the-lan-stack) is up on PC2 |

**Demo or work mode** depends only on the **account you sign in with** from this front end: the `demo` account's credentials (section 3) for a safe read-only tour of the **demo** instance, your work account's credentials for the real instance. The two instances are different back ends: the demo's address is `https://<DEMO_DOMAIN>`, the real one is PC1's LAN address. The role attached to the account decides the permissions, on the back-end side.

---

## Security model at a glance

| Component                                | Exposed to the Internet?                                    | If compromised, the real impact                                                                                                              |
| ---------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Demo stack (containers)                  | Yes, through Traefik                                        | Demo data only (already public by design). **No Docker access**, so no technical path to the rest of PC1.                                    |
| Traefik / edge                           | Yes (80/443)                                                | A reverse proxy only: holds no secret of the LAN stack.                                                                                      |
| WireGuard                                | Yes (51820/UDP), but just an encrypted meeting point        | Nothing without a client's private key.                                                                                                      |
| LAN stack (your private part)            | **No, never directly**                                      | Reachable only through the local network or a valid WireGuard tunnel.                                                                        |
| `/generated/*` route (optional, section 6) | Yes, through Traefik, if you enable it                    | Each exposed generated backend is public by design; the administration API is never routed. The backend keeps its own authentication.        |
| PC2 (front end)                          | No                                                          | No persistent data, no server secret.                                                                                                        |

---

## Checklist before showing the demo to someone

- [ ] `docker logs <PROJECT_NAME>-edge-traefik` shows no certificate error, and `https://<DEMO_DOMAIN>/api/health` answers `200`.
- [ ] A test sign-in with the `demo` account works, and the data you prepared is visible.
- [ ] Checked on the router: only `80`, `443` and `51820/UDP` are forwarded to PC1.
- [ ] UPnP is turned off on the router.
- [ ] The LAN stack is still reachable only locally or through WireGuard (no open port `4803`).
- [ ] If you enabled the `/generated/*` route (section 6): `https://<api-domain>/api/health` answers 404.

---

## Related guides

- [LAN](../DEPLOIEMENT_LAN.md) · [Demo](../DEPLOIEMENT_DEMO.md) · [WireGuard](../DEPLOIEMENT_WIREGUARD.md) · [Overview of the deployment guides](../README.md)
