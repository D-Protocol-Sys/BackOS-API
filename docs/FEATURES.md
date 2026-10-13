# Optional features

BackOS comes in two parts:

- the **base**: everything every installation gets, always on;
- **optional features**: extras you switch on only if you want them. They are **off by default**.

If you only want the base BackOS, you have nothing to do.

## Switch features on or off

Set `ENABLED_FEATURES` in the settings file of your stack (`.env` and `.env.development` for
[Development](deployments/DEPLOIEMENT_DEV.md), `.env.local`, `.env.lan`, `.env.demo` or
`.env.production` for the other modes), then restart BackOS:

> [!NOTE]
> `my-feature` and `another-feature` below are **placeholders**, not real features: no optional
> feature is installed yet (see [Installed features](#installed-features)). When one exists, use
> its real name.

```ini
# Switch on two features
ENABLED_FEATURES=my-feature,another-feature

# Switch on every installed feature
ENABLED_FEATURES=all

# Everything except one
ENABLED_FEATURES=all,-another-feature
```

| Value                | Result                                                                        |
| -------------------- | ----------------------------------------------------------------------------- |
| unset or empty       | The base BackOS, plus any feature that is enabled by default                  |
| `name1,name2`        | Those features, in addition to the default ones                               |
| `all`                | Every installed feature                                                       |
| `-name`              | Switches that feature off (useful after `all`, or for a default one)          |

Names are not case-sensitive. Separate them with commas or spaces.

A name that is **not installed** stops BackOS at startup with a message listing what is installed,
so a typo never goes unnoticed. A feature that needs its own settings (for example an API key)
also stops BackOS at startup, with a clear message, **only if you switched it on** without them.

## See what is on

- The startup log says it: `Optional features enabled: my-feature, another-feature.` (placeholder names)
- `GET /api/features` (signed-in users) lists every installed feature with an `enabled` flag.
  The front end uses it to show or hide the matching screens.

## What a switched-off feature leaves behind

- **Its code does not run**: no routes, no background jobs.
- **Its database tables exist, empty.** Every database gets the same migrations, whatever you
  enable. They cost nothing.
- **Its permissions appear in the role editor.** Keep them as they are: they are kept on purpose,
  so that switching a feature off and on again never loses who could use it.

## Installed features

None yet.

## Writing a feature

Run `pnpm feature:new <name>` for a working skeleton. See
[`src/features/README.md`](../src/features/README.md) for the conventions, and
[`CONTRIBUTING.md`](../CONTRIBUTING.md) for how to tell a new feature (optional) from an improvement
(part of the base) and how a pull request is reviewed.
