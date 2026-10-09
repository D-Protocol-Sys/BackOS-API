# CI/CD: automatic builds and deployments

[← All deployment guides](README.md)

How GitHub Actions tests, builds, signs and deploys BackOS for you. **This is optional**: you can run every deployment mode by hand without it. It only deploys the two public stacks, [Demo](DEPLOIEMENT_DEMO.md) and [Production](DEPLOIEMENT_PRODUCTION.md). Development, Local and LAN are never deployed by the pipeline.

**On this page:** [The pipelines](#the-pipelines) · [Set it up](#set-it-up) · [Prepare the server](#prepare-the-server) · [How an automatic deployment works](#how-an-automatic-deployment-works) · [Deploy or roll back by hand](#deploy-or-roll-back-by-hand) · [Rollback limits](#rollback-limits) · [Recommended repository settings](#recommended-repository-settings) · [Tests](#tests)

---

## The pipelines

The workflows live in `.github/workflows/`.

| Workflow                  | When it runs                                                                  | What it does                                                                                                                                                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`ci.yml`**              | Every pull request, and every push to `main`                                  | Lint and Prettier check, build and typecheck, unit tests with a coverage report, real end-to-end tests (Docker), `pnpm audit` (high severity), dependency review on pull requests, secret scan (Gitleaks), Trivy filesystem scan (fails on critical/high findings) and Docker image scan reported in GitHub's *Security* tab |
| **`codeql.yml`**          | Every push to `main`, every pull request to `main`, and weekly (Monday, 03:00 UTC) | Static security analysis (SAST)                                                                                                                                                                                                                       |
| **`cd.yml`**              | Every push to `main`, every `vX.Y.Z` tag, and manually from the Actions tab   | Builds a **signed** image (cosign, keyless, through GitHub OIDC) with an SBOM and a provenance attestation, scans it with Trivy, pushes it to GHCR. Then **deploys to the demo automatically** (pushes to `main` only). **Production** is deployed only on a `vX.Y.Z` tag, or manually with the *Also deploy to PROD* option |
| **`reusable-deploy.yml`** | Called by `cd.yml`                                                            | Connects to the server over SSH, runs `scripts/stack.sh deploy <stack> <tag>`, checks that the application answers, and **rolls back** if the deployment or the health check fails                                                                              |
| **`dependabot.yml`**      | Weekly                                                                        | Updates for npm, Docker and GitHub Actions                                                                                                                                                                                                                      |

> [!IMPORTANT]
> Production never deploys on its own: it goes through a GitHub `environment: production` with **required reviewers**. Nobody pushes to production without an explicit human validation, even when the pipeline is green.

---

## Set it up

### 1. Add the secrets and variables

In your GitHub repository: **Settings → Secrets and variables → Actions**.

| Name                                                          | Type                | What it is for                                                                                                                          |
| ------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_PATH` | Secrets             | SSH access to your server. `DEPLOY_PATH` is the folder where the repository is cloned.                                                  |
| `DEMO_URL`, `PROD_URL`                                        | **Variables**       | Base public URL (for example `https://demo.example.com`), used for the health check (`/api/health`).                                    |
| `GHCR_USER`, `GHCR_TOKEN`                                     | Secrets, optional   | Only if the image package is **private**: your GitHub user name and a token with the `read:packages` right, used by the server to pull the image. |
| `CI_ENCRYPTION_KEY`, `CI_JWT_SECRET`                          | Secrets             | The end-to-end tests of the CI (any valid values: a 64-hexadecimal-character key and a secret of at least 32 characters).               |

`GITHUB_TOKEN` is provided by GitHub automatically.

**Nothing has to be edited in the files.** The image name (`ghcr.io/<owner>/<repository>`, lower case) is deduced from the repository, so a fork works as is once these settings are done.

> [!WARNING]
> If the secrets or variables are missing, the deployment jobs are **skipped with a warning**. The image is still built, scanned, signed and published. Check the run summary, especially before a release.

### 2. Protect production

Create the `production` environment: **Settings → Environments → New environment → `production`**, and add at least one **required reviewer**. (The `demo` environment is created automatically on first use.)

---

## Prepare the server

The pipeline logs in to your server and runs `scripts/stack.sh` there. Before the first deployment, the server needs:

- **Git, Docker and Docker Compose**, and `curl`. The SSH user must be allowed to run `docker`.
- The **repository cloned** in the folder you gave as `DEPLOY_PATH`.
- The **settings files** of the stacks you deploy, filled in as explained in the [Demo](DEPLOIEMENT_DEMO.md) and [Production](DEPLOIEMENT_PRODUCTION.md) guides: `.env.demo` and/or `.env.production`.
- **`.env.production` even if you only deploy the demo.** `edge` (Traefik) always reads it. A demo-only server needs just two lines in it: `PROJECT_NAME` (the same as in `.env.demo`) and `ACME_EMAIL`.
- Optionally **`cosign`**, to verify the image signature before each start. Without it, a warning is shown and the deployment goes on.

> [!NOTE]
> The pipeline drives the stacks with `stack.sh` (Docker Compose projects named `<project>-demo`, `<project>-prod`, `<project>-edge`). Keep managing them with `make` / `stack.sh` on the server: a stack started by hand with a plain `docker compose` would clash with it. See [Drive each stack with one tool only](README.md#drive-each-stack-with-one-tool-only).

---

## How an automatic deployment works

1. `cd.yml` publishes the image `ghcr.io/<owner>/<repository>:<tag>`. The tag is a short commit SHA, or `X.Y.Z` for a release (`latest` is also set on the default branch).
2. On the server, the pipeline runs `git fetch --tags` and checks out **the exact commit** that was built, so that the compose files and scripts match the image.
3. The server **pulls the image** (`docker pull`) and runs it **without rebuilding it**: what runs is exactly what was scanned (Trivy) and signed (cosign). If `cosign` is installed on the server, the signature is **verified** before the start (otherwise a warning is shown).
4. `stack.sh` records in `.env.production` / `.env.demo`: `IMAGE_TAG` (current version), `IMAGE_TAG_PREVIOUS` (the version it replaced) and `ORCHESTRATOR_IMAGE`.
5. If the start fails, or if `/api/health` does not answer within about 60 seconds, `stack.sh rollback` restarts the previous version.

> [!NOTE]
> Step 2 leaves the repository on a **detached commit** on the server. Before pulling by hand there, run `git switch main` (or the branch you use).

---

## Deploy or roll back by hand

The same commands work by hand on the server, from the project folder:

```bash
./scripts/stack.sh deploy prod 1.4.0     # deploy a published image
./scripts/stack.sh rollback prod         # go back to the previous version
```

`demo` works the same way (`deploy demo <tag>`, `rollback demo`). These two commands only accept `prod` or `demo`.

`make up-prod` keeps **building** the image from the code on the server. It is for the initial installation, or for use without the CI.

---

## Rollback limits

- It restores the **old image**, not the old database schema. A Prisma migration that drops or renames a column can make the old version unusable. Migrations that only **add** are safe. **Take a backup before any destructive migration.**
- Configuration files (compose, `.env`) do not go back: only the image does.
- The **first deployment has no previous version**: a rollback is then impossible (you get an explicit message).
- Running `rollback` **twice in a row** redeploys the version you just left.

---

## Recommended repository settings

Not in the code, to set in GitHub:

- **Protect the `main` branch**: require the CI to pass before merging, no direct push.
- **`production` environment** with at least one required reviewer.

---

## Tests

See the [tests coverage audit](../TESTS_COVERAGE_AUDIT.md) for the module-by-module state and the prioritized plan.

In short: real coverage was almost nil before this work (2 unit tests and 1 end-to-end scenario for about 183 files). Targeted unit tests were added on the most sensitive areas (authorization, encryption), coverage thresholds now make the CI fail if they regress, and the audit documents how to fill the rest in order of risk.

`deploy/docker-compose.test.yml` keeps its original role: the **ephemeral** infrastructure of the end-to-end tests, driven by Jest (`pnpm test:e2e` starts and destroys it on every run). It is not the demo environment.
