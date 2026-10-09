# Demo + Production on the same server

[← All deployment guides](../README.md) · [Combined deployments](../README.md#1-which-guide-should-i-follow)

Run a **public demo** and the **real production** on a single machine, behind one Traefik.

| At a glance        |                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| **Best for**       | One server, two public instances: one to show, one to use                                                |
| **Reachable from** | The Internet: `https://example.com` (production) and `https://demo.example.com` (demo)                   |
| **You will need**  | **Two** domain names or sub-domains pointing to the server, ports 80/443, Docker and Docker Compose      |
| **Read first**     | [Production](../DEPLOIEMENT_PRODUCTION.md) and [Demo](../DEPLOIEMENT_DEMO.md) — this page only adds what is specific to running both |

**On this page:** [Is it possible?](#is-it-possible) · [How it works](#how-it-works) · [Before you start](#before-you-start) · [Step by step](#step-by-step) · [Troubleshooting](#troubleshooting) · [Good to know](#good-to-know)

---

## Is it possible?

Yes. It is the use case `scripts/stack.sh` and the `Makefile` were designed for: the two stacks are built to live together on one machine without colliding.

## How it works

Two **completely independent** instances (separate databases, separate containers, distinct Docker names: `${PROJECT_NAME}-demo-*` and `${PROJECT_NAME}-prod-*`). They share only the **`edge`** layer (one Traefik) and are told apart by **domain name**, not by port.

```
                    Internet (ports 80/443)
                              │
                         ┌────▼────┐
                         │ Traefik │  (a single one, shared)
                         └────┬────┘
                 ┌────────────┴────────────┐
        demo.example.com              example.com
                 │                            │
          ┌──────▼───────┐            ┌───────▼────────┐
          │  DEMO stack  │            │  PROD stack    │
          │  own DB      │            │  own DB        │
          │  demo account│            │  real accounts │
          │  read-only   │            │  real writes   │
          │  no Docker   │            │  Docker access │
          │  access      │            │  (generation)  │
          └──────────────┘            └────────────────┘
```

1. Traefik routes by the HTTP **`Host`** header: both stacks listen "behind" the same 80/443.
2. Each backend never sees the other's traffic: separate internal Docker networks (`${PROJECT_NAME}-demo-internal` and `${PROJECT_NAME}-prod-internal`), with no Docker rule linking them.
3. **Only `prod` has a `docker-socket-proxy`**. It runs inside the prod stack, on a private `docker_api` network that neither `edge` nor the demo can see. The demo therefore has no `DOCKER_HOST` and no network path to the host's Docker API: even if one of the two stacks is compromised, the other and the host stay out of reach.

---

## Before you start

- A server with **Docker and Docker Compose**, and ports **80 and 443** reachable. See [Production](../DEPLOIEMENT_PRODUCTION.md#before-you-start).
- **Two DNS names**, both pointing to the server's public IP, for example `example.com` and `demo.example.com`. Traefik and Let's Encrypt need **both** to issue the two certificates. Check them **before** you start.
- The project on the server: see [Get the project](../../../README.md#4-get-the-project-on-your-machine).
- **Two folders for generated projects**, created beforehand, one per stack (for example `/srv/backos/generated-prod` and `/srv/backos/generated-demo`).
- Your secrets, **different** for the demo and for production: see [Generate your secrets](../README.md#generate-your-secrets).

---

## Step by step

### 1. Create the two settings files

```bash
cp .env.production.example .env.production   # production domain, real secrets
cp .env.demo.example       .env.demo         # demo sub-domain, secrets of its own
```

Fill in both files (see [Production](../DEPLOIEMENT_PRODUCTION.md#1-create-your-settings-file) and [Demo](../DEPLOIEMENT_DEMO.md#1-create-your-settings-file)). Three rules specific to running both:

- **`PROJECT_NAME` must be the same in both files.** They share one Traefik network, named `${PROJECT_NAME}-edge`.
- **`ACME_EMAIL`** is read by Traefik from `.env.production`.
- **Different secrets, passwords and folders** (`GENERATED_PROJECTS_HOST_PATH`) for the demo and for production.

### 2. Start both stacks

`edge` starts **automatically** as a dependency of both commands:

```bash
make up-prod
make up-demo
```

(No `make`? Use `./scripts/stack.sh up prod` and `./scripts/stack.sh up demo`.)

> [!TIP]
> `make up` starts **every** stack at once, including `dev` (and it needs a `.env` file for it), which you do not need on a server. Prefer the two commands above.

### 3. Check

```bash
make ps
```

✅ Every container of both stacks should be up. Then check that both certificates were issued: Traefik only logs warnings and errors, so look for the absence of errors, then test both sites.

```bash
docker logs <PROJECT_NAME>-edge-traefik --tail 50
curl -I https://example.com/api/health
curl -I https://demo.example.com/api/health
```

### 4. Get the credentials

- **Owner of each instance:** written once to a file inside its API container (the logs only say where), valid 48 hours:

  ```bash
  docker exec <PROJECT_NAME>-prod-orchestrator cat /app/owner-activation.txt
  docker exec <PROJECT_NAME>-demo-orchestrator cat /app/owner-activation.txt
  ```

  Delete each file once read (`rm` instead of `cat`).
- **Demo account:** its e-mail or username and the secret that generates its sign-in codes are in `.env.demo` (`DEMO_WORKEMAIL`, `DEMO_USERNAME`, `DEMO_TOTP_SECRET`).

### 5. Generated backends (production only)

Production generates backends, the demo does not. Add the settings of [Generated backends in production](../DEPLOIEMENT_PRODUCTION.md#generated-backends-in-production) to `.env.production`.

---

## Troubleshooting

| Symptom                                           | Cause and fix                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| One domain gets a certificate, the other does not | Its DNS record does not point to the server yet. Fix it, then check: `docker logs <PROJECT_NAME>-edge-traefik --tail 50`.                  |
| *network … declared as external, but could not be found* | `edge` is not running, or `PROJECT_NAME` differs between `.env.production` and `.env.demo`. Use the same value in both.         |
| The demo refuses to start                         | `DEMO_WORKEMAIL` is missing in `.env.demo` (mandatory). Also check `DEMO_TOTP_SECRET`.                                                     |
| Production slows down when the demo is busy      | Both stacks share the machine's resources. See the limits below.                                                                            |

---

## Good to know

**Advantages**

- One machine, one Traefik to maintain, and one TLS certificate to renew per domain (automatic).
- Strict isolation between demo data and real data: no risk of mixing them.
- Fully tooled already (`Makefile`, `stack.sh`, CI/CD): nothing to configure beyond the two `.env.*` files.

**Limits**

- Both stacks share the CPU, RAM and disk of the same server. A demo that gets a traffic spike can slow production down. Only per-container CPU and memory limits exist, with no relative priority.
- A server failure takes **both** instances down at once (no redundancy).
- Separating them later (for example if the demo grows too demanding) is a real migration. Plan to move the demo to its own machine rather than letting them live together indefinitely if its usage grows.

---

## Related guides

- [Production](../DEPLOIEMENT_PRODUCTION.md) · [Demo](../DEPLOIEMENT_DEMO.md) · [Production + WireGuard](DEPLOIEMENT_COMBINE_PRODUCTION_WIREGUARD.md)
