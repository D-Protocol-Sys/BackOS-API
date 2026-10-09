# Tailscale (alternative not chosen)

[← All deployment guides](README.md)

> [!WARNING]
> **This is not the recommended guide.** After weighing how much autonomy we wanted (depending on as few third-party services as possible), the project chose **plain WireGuard, with no managed service**. The active guide is **[WireGuard](DEPLOIEMENT_WIREGUARD.md)**.
>
> This page is kept as a reference, in case you reconsider Tailscale or Headscale one day: **easier to use, at the price of an external dependency**.

| At a glance               |                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| **Scenario**              | BackOS API (the [Local](DEPLOIEMENT_LOCAL.md) stack) + front end on **one machine**, no public domain, reachable from any device on your Tailscale network (a *tailnet*) |
| **Compared to WireGuard** | Simpler (no port forwarding, no manual keys, built-in HTTPS), but relies on a third party    |
| **Status**                | ⚠️ **Not tested end to end** (no access to a real Tailscale network when this was written). Follow it step by step and report any difference. |

**On this page:** [How it works](#how-it-works) · [1. Install Tailscale](#1-install-tailscale) · [2. Start the back end](#2-start-the-back-end) · [3. Start the front end](#3-start-the-front-end) · [4. Optional HTTPS](#4-optional-https-to-install-the-web-app-pwa) · [5. Stop and restart](#5-stop-and-restart) · [6. Move to another machine](#6-move-to-another-machine)

---

## How it works

```
                     ┌───────────────────────────────────┐
                     │   Your server machine             │
                     │                                   │
   Tailscale  ───────┼──▶ front end (port 3000)          │
   (from anywhere)   │    back end  (port 4803, or       │
                     │               your LOCAL_PORT)    │
                     │    PostgreSQL, Redis (internal)   │
                     └───────────────────────────────────┘
```

Each device that needs access (your laptop, your phone, a future colleague) installs the Tailscale client and joins your tailnet. **No port forwarding, no certificate to manage by hand, no public exposure.**

---

## 1. Install Tailscale

1. Create an account at <https://tailscale.com> (free for personal use or a small team).
2. On the **server machine**, install the client (<https://tailscale.com/download>) and sign in. The machine appears in your tailnet with an automatic host name (for example `backos-server`), visible in the admin console: <https://login.tailscale.com/admin/machines>.
3. On **each client device** (laptop, phone): same installation, **same account**.
4. Quick test: from a client, `ping backos-server` (or the name shown in the console) should answer.

> [!TIP]
> In the admin console, pin a stable name for the server (*Settings → Machine → Edit machine name*) rather than relying on the system host name, which can change.

---

## 2. Start the back end

Run the **Local** stack, in the back-end repository (this one). Follow **[Local](DEPLOIEMENT_LOCAL.md)** from the start: it covers the settings file, the folder for generated projects, the start, and the owner's activation details. In short:

```bash
cp .env.local.example .env.local      # then fill it in, as explained in the Local guide
make up-local                         # or: ./scripts/stack.sh up local
```

The Local stack publishes its port on every network interface of the machine, the Tailscale one included, so the API is reachable at `http://backos-server:<LOCAL_PORT>` from your tailnet (`4803` unless you changed `LOCAL_PORT`).

Check it with `curl http://backos-server:<LOCAL_PORT>/api/health` from another device of the tailnet.

---

## 3. Start the front end

The front end is a **separate project** with its own repository. In that repository:

```bash
cp .env.local.example .env.local
```

Set `NEXT_PUBLIC_API_URL` to the back end's Tailscale address. Without HTTPS for now, use `http://backos-server:<LOCAL_PORT>/api`. Then:

```bash
docker compose -f docker-compose.local.yml --env-file .env.local up -d --build
```

(These commands belong to the front-end project. Follow its own README if it differs.)

Open the front end from any device on your tailnet, at `http://backos-server:3000`. In the back end's `.env.local`, set `FRONTEND_URL` (and `CORS_ORIGIN`, if you restricted it) to that address.

---

## 4. (Optional) HTTPS, to install the web app (PWA)

Browsers require a secure context (HTTPS, or `localhost`) to allow a service worker, and therefore to offer *Install the app*. Tailscale provides this natively. Without it, BackOS stays fully usable over plain HTTP: you only lose the *Install the app* prompt.

1. In the Tailscale admin console, open **DNS** and turn on **MagicDNS** (probably already on) and **HTTPS Certificates**.
2. On the server, once the back end **and** the front end are started:

   ```bash
   tailscale serve --bg --https=443 http://localhost:3000
   ```

   The front end is now served in HTTPS at `https://backos-server.<your-tailnet>.ts.net` (the exact tailnet name is shown in the admin console).

3. Serve the back end under the same host name, on a path rather than a separate port:

   ```bash
   tailscale serve --bg --set-path=/api https://localhost:443/api http://localhost:<LOCAL_PORT>/api
   ```

   The exact flags change with Tailscale versions: check `tailscale serve --help` or <https://tailscale.com/kb/1242/tailscale-serve> if this command does not match your version.

4. Set `NEXT_PUBLIC_API_URL` in the front end's `.env.local` to the unified HTTPS address, and **rebuild** (the value is baked into the build, not read at runtime):

   ```ini
   NEXT_PUBLIC_API_URL=https://backos-server.<your-tailnet>.ts.net/api
   ```

   ```bash
   docker compose -f docker-compose.local.yml --env-file .env.local up -d --build
   ```

Then, from any device on the tailnet, open `https://backos-server.<your-tailnet>.ts.net` in Chrome or Edge: an install icon appears in the address bar (or menu ⋮ → *Install app*).

---

## 5. Stop and restart

To free your PC's resources. **No data is lost** as long as you do not erase the volumes.

```bash
# Stop the back end (from the back-end repository)
make down-local

# Stop the front end (from the front-end repository)
docker compose -f docker-compose.local.yml --env-file .env.local down
```

To restart, run the same commands as in steps 2 and 3. Your PostgreSQL data stays in its named volumes. Remember that the generated backends (`backos-gen-*`) keep running: see [Local](DEPLOIEMENT_LOCAL.md#stopping-does-not-stop-generated-backends).

---

## 6. Move to another machine

Nothing specific to redo:

1. Copy (or `git clone`) both repositories to the new machine.
2. **Copy your `.env.local` files.** They hold your generated secrets: **do not regenerate them**, or you lose access to the data that was already encrypted.
3. Install the Tailscale client on the new machine, with the same account.
4. Run steps 2 and 3 again.

The Tailscale host name will probably change (new machine): update `NEXT_PUBLIC_API_URL` accordingly and rebuild the front end.

---

## Where to go instead

- The chosen option: [WireGuard](DEPLOIEMENT_WIREGUARD.md).
- Back to the [overview of the deployment guides](README.md).
