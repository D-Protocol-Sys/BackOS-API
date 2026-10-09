# Production + WireGuard for admin access

[← All deployment guides](../README.md) · [Combined deployments](../README.md#1-which-guide-should-i-follow)

Keep BackOS **public for your users**, and move the **server's administration tools** (SSH, direct database access…) behind a private VPN tunnel.

| At a glance        |                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| **Best for**       | Production in the open, with admin access nobody can reach from the Internet                          |
| **Public**         | Ports `80/443` (the product, for everyone)                                                            |
| **Private**        | SSH, `psql`, Traefik dashboard, `docker compose logs/exec`: only through the tunnel (`51820/UDP`)     |
| **Read first**     | [Production](../DEPLOIEMENT_PRODUCTION.md) and [WireGuard](../DEPLOIEMENT_WIREGUARD.md)               |

**On this page:** [Understand it first](#understand-it-first) · [How it works](#how-it-works) · [Step by step](#step-by-step) · [Good to know](#good-to-know)

---

## Understand it first

> [!IMPORTANT]
> This combination adds **no restriction inside the NestJS application**. There is no built-in mechanism such as "this API route is only allowed from the VPN". It is an **infrastructure pattern**, not a product feature.
>
> The app stays public for your users as usual. WireGuard only protects the **server's administration tools**, which have no reason to be exposed publicly: SSH access, direct database access, the Traefik dashboard, `docker exec` and raw logs, monitoring tools.

## How it works

```
                            Internet
                               │
                 ┌─────────────┴──────────────┐
          Port 80/443                   Port 51820/UDP
        (everyone:                     (you only, with
         this is the product)           your WireGuard key)
                 │                               │
                 ▼                               ▼
         ┌───────────────┐             ┌──────────────────┐
         │   Traefik     │             │   WireGuard      │
         │  → PROD stack │             │   server         │
         │  (as in the   │             └────────┬─────────┘
         │  Production   │                      │
         │  guide)       │            once in the tunnel,
         └───────────────┘            direct access to the server:
                                       - SSH (port 22, never otherwise
                                         opened publicly)
                                       - the database, to debug
                                         without going through the API
                                       - Traefik dashboard, enabled only
                                         on the WireGuard interface
                                       - docker compose logs / exec
```

1. The `prod` stack (`deploy/docker-compose.prod.yml`) runs exactly as described in [Production](../DEPLOIEMENT_PRODUCTION.md). **Nothing changes there.**
2. WireGuard runs **in addition**, set up with [WireGuard](../DEPLOIEMENT_WIREGUARD.md) (DuckDNS if your IP is dynamic, key generation).
3. The server's firewall opens **only** `80/443` (Traefik, public) and `51820/UDP` (WireGuard): **never** SSH (`22`) to the public, **never** PostgreSQL (`5432`), even though `docker-compose.prod.yml` does not publish them anyway. This is defence in depth: the server firewall **and** Docker isolation, not one or the other.
4. Once in the tunnel (`10.8.0.x`), you reach the server as if you were in front of it: normal SSH to `10.8.0.1`, then, on the server, the usual administration commands.

> [!NOTE]
> The production database is **not published on any port**, not even on the server's `localhost`. To work on it directly, open a shell *inside* its container once you are connected to the server over the tunnel:
> `docker exec -it <PROJECT_NAME>-prod-postgres psql -U <POSTGRES_USER> -d <POSTGRES_DB>`

---

## Step by step

### 1. Deploy production

Follow [Production](../DEPLOIEMENT_PRODUCTION.md) **in full**. No step changes.

### 2. Set up WireGuard on the same server

Follow [WireGuard](../DEPLOIEMENT_WIREGUARD.md) **in full**, with the **Linux** variants. Generate **one key per administrator or device**, never a shared key: if someone leaves the team, you revoke only their key.

### 3. Prove that the tunnel works, before closing anything

> [!WARNING]
> **Do not skip this step.** If you close public SSH before the tunnel works, you lock yourself out of your own server. Keep your current SSH session open, and know how to reach your provider's console as a fallback.

From a device with the tunnel switched **on**:

```bash
ssh <user>@10.8.0.1
```

✅ You must get a shell **through the tunnel** before going further.

### 4. Lock the firewall

Example with `ufw`. **The order matters:** `ufw` applies the first matching rule, so the tunnel rule for SSH comes first.

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 51820/udp
sudo ufw allow in on wg0 to any port 22 proto tcp   # SSH, only from the tunnel
sudo ufw default deny incoming                       # everything else is closed, SSH included
sudo ufw enable
```

Check it: `sudo ufw status verbose`. Then, from a device **outside the tunnel**, SSH to the public IP must **fail**; through the tunnel it must still work.

> [!NOTE]
> `ufw` does not filter ports that a Docker container publishes itself: Docker adds its own network rules. That is one more reason why the prod stack publishes only what Traefik needs. If you use your cloud provider's firewall (security group), apply the same rules there too.

### 5. (Optional) Open the Traefik dashboard to the tunnel only

To debug Traefik, enable its dashboard **only on the WireGuard interface**, in `deploy/docker-compose.edge.yml`. In the `command` list, **change** the existing `--api.dashboard=false` to `--api.dashboard=true`, and publish the dashboard port on the tunnel address instead of a public one, next to the existing `80` and `443` mappings:

```yaml
ports:
  - "80:80"
  - "443:443"
  - "10.8.0.1:8080:8080"
```

Depending on your Traefik configuration, the dashboard may also need `--api.insecure=true` to be served on port `8080`. That is acceptable **only because** the port is bound to the tunnel address and not to a public one. Check Traefik's documentation for your version, and restart `edge` after the change.

---

## Good to know

**Advantages**

- The app stays fully public for your users: no compromise on the product experience.
- The tools that would give total access to the server if their credentials leaked (SSH, raw database) are never exposed to Internet scans or brute force.
- No dependency on a managed third-party VPN service: consistent with the choice of WireGuard over Tailscale (see [Tailscale](../DEPLOIEMENT_INTERNE_TAILSCALE.md)).

**Limits**

- It protects **only the infrastructure**, not the application itself. A flaw in the API is still exploitable publicly, as on any classic production deployment. Do not mistake "admin access protected" for "smaller attack surface of the app".
- One more layer to maintain: WireGuard keys to manage, renew, and revoke when an administrator leaves.
- If the server that hosts WireGuard goes down, remote admin access goes down with it, at the same time as production. There is no redundancy on that point (your cloud provider's console generally remains an independent way in).
- The automatic deployments of the [CI/CD](../CI_CD.md) pipeline connect to the server over **SSH from GitHub's servers**, which are not in your tunnel. Closing public SSH therefore **stops them**. Either keep deploying by hand over the tunnel (`./scripts/stack.sh deploy prod <tag>`), or leave SSH open to a restricted set of addresses.

---

## Related guides

- [Production](../DEPLOIEMENT_PRODUCTION.md) · [WireGuard](../DEPLOIEMENT_WIREGUARD.md) · [Demo + Production](DEPLOIEMENT_COMBINE_DEMO_PRODUCTION.md)
