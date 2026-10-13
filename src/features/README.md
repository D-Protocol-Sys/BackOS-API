# Optional features

Everything in `src/` outside this folder is the **base BackOS**: what every installation gets.
A **feature** is something new that some people may not want (a new screen, new tables, a new
service, a heavy dependency). Features live here, one folder each, and are **off by default**.

> **About the names in this page.** `my-feature` is a **placeholder**: no optional feature is
> installed yet. Replace it with the name of your own. (Excalidraw, the whiteboard tool, is only an
> *illustration* of what could one day be a feature: it is not part of BackOS.)

> Not sure whether your change is a feature or an improvement? Ask three questions. Does the base
> BackOS still work exactly as before without it? Does it add something a person could want to
> *not have*? Does it need its own tables, settings or packages? If the answer to the second or
> the third is yes, it is a feature. Tests, performance work and bug fixes are improvements: they
> go in the base like any other change.

## Start from the skeleton

```bash
pnpm feature:new my-feature
```

It creates the folder below with working code and tests. The tests stay red until you have replaced
every `TODO` in `feature.ts`, so that a feature is never shipped with placeholder text.

## How it works

At startup, BackOS looks for `src/features/<name>/feature.ts`. Each one is a feature. A feature is
loaded only when its name appears in the `ENABLED_FEATURES` setting. A feature that is not loaded
has no routes, no services and no jobs. **You never edit `app.module.ts` to add a feature.**

```
src/features/my-feature/
├── feature.ts                # the manifest (required)
├── my-feature.module.ts
├── my-feature.controller.ts
├── my-feature.service.ts
└── my-feature.service.spec.ts
```

```ts
// src/features/my-feature/feature.ts
import * as Joi from 'joi';
import { defineFeature } from '../feature.types';
import { MyFeatureModule } from './my-feature.module';

export default defineFeature({
    name: 'my-feature',                 // kebab-case, identical to the folder name
    description: 'What my-feature adds, in one sentence',
    defaultEnabled: false,              // always false for a new feature
    module: MyFeatureModule,
    permissions: {                      // added to the global catalog (namespaced)
        'my-feature.read': 'View my-feature data',
        'my-feature.write': 'Create and edit my-feature data',
    },
    env: {                              // validated at boot; must be optional or have a default
        MY_FEATURE_MAX_ITEMS: Joi.number().integer().min(1).default(50),
    },
    requiredEnv: [],                    // variables that must be set only when the feature is on
});
```

## What a feature can declare without touching the base

| Need                    | How                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| Routes, services, jobs  | A normal Nest module, given as `module` in the manifest                                     |
| Permissions             | `permissions` in the manifest, used with `@RequirePermissions(featurePermission('my-feature.read'))` |
| Settings                | `env` (Joi rules, names prefixed with `MY_FEATURE_`) and `requiredEnv`                      |
| Audit log entries       | `featureAuditAction('my-feature.item.created')` and `featureAuditTarget('MyFeatureItem')`     |
| Know what is enabled    | `FeaturesService.isEnabled('my-feature')`, only if the base itself must adapt               |

## Rules

1. **Off by default.** `defaultEnabled: false`. Only a maintainer changes it, when a feature
   becomes part of the base. A test enforces this.
2. **Do not edit the base to make room for your feature.** If you really need a hook in the base,
   open a separate "improvement" pull request for it first.
3. **Prefix everything** with the feature name: permissions (`my-feature.read`), settings
   (`MY_FEATURE_...`), routes (`/my-feature/...`).
4. **Settings must never stop BackOS from starting when the feature is off.**
5. **Test it switched on and switched off.** The module must load and do nothing harmful when
   the feature is off, and work when it is on.

## Database

The tables of a feature are created in **every** database, empty when the feature is off: Prisma
applies the same migrations to everyone. Add the models to `prisma/schema.prisma` (at the end, in a
block commented `FEATURE: <name>`) with their migration, and link to the core with a plain id
column (`userId String`) rather than a Prisma relation: a relation would force a line into the
`User` or `Platform` model, which is shared by everybody.

## Permissions stay in the catalog

The permissions of a feature are kept in the database even while the feature is off. Otherwise the
startup synchronization would delete them, and with them every role's assignment of them.

## The front end

`GET /api/features` returns every installed feature with an `enabled` flag, so that the front end
can show or hide the matching screens.

## Pull requests

Tick **New feature** in the pull request description. A bot checks it against your files: a new
`src/features/<name>/` folder with its manifest and a test, `defaultEnabled: false`, and nothing
edited in the base. See `CONTRIBUTING.md` for the whole process.

See `docs/FEATURES.md` for the user-facing documentation.
