<!-- Thank you for contributing to BackOS! This takes two minutes. A bot checks that the type below matches what you changed. -->
<!-- IMPORTANT: this pull request must target the `develop` branch (the pre-production), not `main` (production). Change the base branch at the top of the page if needed. -->

## What does this change?

<!-- One or two sentences. Link the issue if there is one: "Closes #123". -->

## Type of change

Tick **exactly one** box.

- [ ] **Fix**: something was broken and now works. <!-- type:fix -->
- [ ] **Improvement**: the base BackOS does the same thing, better (tests, speed, clarity, small changes to what exists). It becomes part of the base for everyone. <!-- type:improvement -->
- [ ] **New feature**: something new that some people may not want. It goes in `src/features/<name>/` and is **off by default**. <!-- type:feature -->
- [ ] **Documentation** only. <!-- type:docs -->

<details>
<summary>Feature or improvement? Three questions</summary>

1. Does the base BackOS still work **exactly as before** without this change?
2. Does it add something a person could want to **not have** (a new screen, tables, a service, a heavy dependency, new permissions)?
3. Does it need **its own** tables, settings or packages?

A "yes" to question 2 or 3 means it is a **feature**. Tests, performance work and bug fixes are improvements.
Details: [`src/features/README.md`](../blob/main/src/features/README.md).

</details>

## Checklist

- [ ] `pnpm test`, `pnpm build` and `pnpm lint:check` pass on my machine (`pnpm format` fixes the formatting).
- [ ] I added or updated tests.
- [ ] I updated the documentation if behaviour changed.

### Only for a **new feature**

- [ ] I started from `pnpm feature:new <name>`, and replaced every `TODO`.
- [ ] `defaultEnabled` is `false`.
- [ ] I tested it switched **on** and switched **off**.
- [ ] I did not edit the base to make room for it (if the base needs a hook, it is a separate "Improvement" pull request).
- [ ] If it adds database tables: the migration is included, and it links to the core by plain ids.
- [ ] Its `README.md` is filled in.

### Only for an **improvement or fix that changes behaviour for everyone**

- [ ] I explain here what changes for people who update, and what they must do (new setting, migration...).
