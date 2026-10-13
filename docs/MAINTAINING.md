# Maintaining BackOS

[← Documentation](README.md)

For the maintainers. It records how the repository is organised and which GitHub settings it
relies on, because those settings are not stored in the code.

**On this page:** [Branch model](#branch-model) · [Day to day](#day-to-day) · [Promoting develop to main](#promoting-develop-to-main) · [GitHub settings](#github-settings) · [What the automation does](#what-the-automation-does)

---

## Branch model

```
 your branch ──▶ develop (pre-production) ──▶ main (production)
 contributor's fork ─▶ develop
```

| Branch    | Role                                                                                      | Who updates it                                   |
| --------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `main`    | Production. What `git clone` gives, what the demo and the private copy follow             | Only by promoting `develop` (a release pull request), or a `hotfix/...` pull request |
| `develop` | Pre-production. Everything is tested here, as if it were in production, before `main`     | Pull requests from contributors and from your own branches; small changes may go straight in |
| other     | Short-lived working branches. Created from `develop`, merged back into `develop`          | Their author                                     |

Contributors never target `main`: the PR triage bot refuses it (see below).

## Day to day

- **A real piece of work**: create a branch from `develop`, work, open a pull request into `develop`,
  merge it once the checks pass.
- **A quick, small change**: you may commit directly to `develop` (your administrator rights
  bypass the rule on that branch, see the settings below).
- **A contributor's pull request**: read it, check the labels and the bot's comment, merge it into
  `develop`, then test `develop`.

## Promoting develop to main

1. Check that `develop` is healthy: its CI is green, and you have run it as you would in production
   (`pnpm test:e2e`, a deployment on your own instance).
2. Open a pull request with the base `main` and the compare branch `develop`. The bot labels it
   `release` and asks for no type: it gathers many changes, each already checked when it entered
   `develop`.
3. Merge it. This is what makes the changes reach everyone who clones BackOS, the demo (the `CD`
   workflow deploys it), and your private copy (its synchronization follows `main`).

Use a **merge commit** for this pull request, not a squash, so that the history of `develop` is kept.

An urgent fix may go straight to `main` from a branch named `hotfix/<something>` of this repository.
Merge `main` back into `develop` right afterwards.

## GitHub settings

These live in the repository's **Settings** on GitHub.

### Rulesets (Settings → Rules → Rulesets)

**`main`** (strict):

- Restrict deletions, block force pushes.
- Require a pull request before merging: 1 approval, and review from Code Owners.
- Require status checks to pass: `Check the type of change`, plus the checks of the CI workflow.
  (They only appear in the list after they have run once.)
- Add yourself to the **bypass list** (repository admin role). Without it you could not merge your
  own pull requests, since nobody can approve their own.

**`develop`** (lighter):

- Block force pushes and deletions.
- Require status checks to pass for pull requests, but **do not** require an approval, and keep the
  bypass for administrators, so that you can still commit small changes directly.

### Other settings

- **Settings → General**: default branch `main` (people who clone the project get production);
  *Automatically delete head branches* is handy.
- **Actions → General**: for pull requests from forks, *Require approval for all outside
  collaborators*.
- **Code security**: secret scanning with push protection; private vulnerability reporting.
- **`.github/CODEOWNERS`**: your GitHub handle must be on the line, otherwise GitHub ignores it.

## What the automation does

| Workflow            | Runs on                                          | Purpose                                                                    |
| ------------------- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| CI                  | Every pull request, pushes to `develop` and `main` | Lint, build, tests, security scans; a boot test of every feature combination once features exist |
| CodeQL              | Pull requests and pushes on `develop` and `main`, weekly | Security analysis                                                    |
| PR triage           | Every pull request                               | Checks the declared type against the files, labels, comments; refuses a pull request into `main` that is not a release or a hotfix |
| CD                  | Pushes to `main`, version tags                   | Builds the image, deploys the demo (and production on a tag)               |
| Dependabot          | Weekly                                           | Dependency updates, as pull requests into `develop`                        |

The branch names are `main` and `develop`. If you ever rename them, set the repository variables
`RELEASE_BRANCH` and `INTEGRATION_BRANCH` (Settings → Secrets and variables → Actions → Variables)
and update the branch lists in the workflows.

A private copy of the project, if you keep one, follows `main`; its synchronization is described in
that copy's own documentation.
