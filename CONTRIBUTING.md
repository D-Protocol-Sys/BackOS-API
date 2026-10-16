# Contributing to BackOS

Thank you for wanting to help. This page explains how to propose a change, and how a maintainer
decides what happens to it.

## The idea

BackOS has two parts:

- the **base**: what everyone who clones the project gets;
- **optional features**: extras that are **off by default** and that each person switches on if
  they want them (for example `ENABLED_FEATURES=my-feature`, where `my-feature` stands for the name of a real feature). See [docs/FEATURES.md](docs/FEATURES.md).

Every pull request is one of four types, and you say which in the pull request description:

| Type              | It is...                                                                                         | Where it goes                  |
| ----------------- | ------------------------------------------------------------------------------------------------ | ------------------------------ |
| **Fix**           | Something broken that now works                                                                  | The base                       |
| **Improvement**   | The same thing, done better: missing tests, speed, clarity, a small change to what already exists | The base                       |
| **New feature**   | Something new that some people may not want                                                      | `src/features/<name>/`, off by default |
| **Documentation** | Only documentation                                                                               | `docs/`, `README.md`           |

**Feature or improvement?** Ask yourself:

1. Does the base BackOS still work **exactly as before** without my change?
2. Does it add something a person could want to **not have**: a new screen, new tables, a new service, a heavy dependency, new permissions?
3. Does it need **its own** tables, settings or packages?

A "yes" to the second or third question means it is a **feature**. Writing the missing tests is an
improvement; adding a whiteboard tool such as Excalidraw to BackOS would be a feature (an illustration only: no such feature exists). When in doubt, ask in an issue before you
write the code.

## Branches

| Branch            | Role                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `main`            | **Production.** What people get when they clone BackOS. Only the maintainers update it, by promoting `develop`. |
| `develop`         | **Pre-production.** Every change lands here first and is tested as if it were in production. **Send your pull requests here.** |
| your own branch   | Short-lived. Create it from `develop`, and send it back to `develop`.                                  |

A pull request that targets `main` is refused by the bot, unless it is the maintainers' release
(`develop` into `main`) or an urgent `hotfix/...` branch of the repository.

## Set up

Follow the [development guide](docs/deployments/DEPLOIEMENT_DEV.md): PostgreSQL and Redis in
Docker, BackOS running on your machine with hot reload.

## Send a change

1. **Fork** the repository and clone **your fork**.
2. Start from `develop` and create your branch: `git switch develop`, then `git switch -c my-change`.
3. Make your change (see below for a new feature).
4. Run the checks:
   ```bash
   pnpm test
   pnpm build
   pnpm lint:check
   ```
   If `pnpm lint:check` complains about formatting, run `pnpm format`: it rewrites your files in the
   project's style (4 spaces, 120 columns), then check again.
5. Push your branch to your fork and open a **pull request** against **`develop`** (not `main`).
6. Fill in the pull request description. **Tick one type of change.**

### Writing a new feature

```bash
pnpm feature:new <name>      # for example: pnpm feature:new my-feature
```

Choose your own name (kebab-case): `my-feature` is only a placeholder. This creates `src/features/<name>/` with a manifest, a module, a controller, a service and
their tests. The tests stay red until you have replaced every `TODO`. Then:

- keep `defaultEnabled: false`;
- do **not** edit the base to make room for the feature (a hook the base needs is a separate
  "Improvement" pull request, sent first);
- test it switched on and switched off;
- if it needs database tables, include the migration;
- fill in the feature's `README.md`.

All the rules are in [`src/features/README.md`](src/features/README.md).

## What happens after you open the pull request

1. **Automatic checks** run: lint, build, unit tests, end-to-end tests, security scans, and, once
   features exist, a boot test with every combination of features.
2. **A bot checks the type** you ticked against the files you changed. It adds labels and one
   comment, updated on every push. A pull request whose type contradicts its content is blocked
   until you fix it; a doubtful one is flagged for a maintainer, not refused.
3. **A maintainer reviews** it. They may ask for changes, or move it to another type.
4. **If it is a fix or an improvement**, it is merged into `develop` and becomes part of the base.
   **If it is a feature**, it is merged into `develop` too, but **switched off by default**: people
   who do not want it notice nothing.
5. **The maintainers test `develop`** as if it were in production. When everything is in harmony,
   they promote it to `main`: that is when your change reaches the people who use BackOS.

A feature only joins the base (on by default) if the maintainers decide so explicitly.

## Conventions

- Code, comments and documentation are written in **English**.
- Keep a pull request to **one purpose**. A big change is easier to review as several small ones.
- Never commit secrets: `.env*` files are ignored by Git, only the `*.example` files are tracked.
- Do not report a security problem in a public issue: use the repository's private security
  reporting (the *Security* tab), if it is enabled, or contact a maintainer directly.
