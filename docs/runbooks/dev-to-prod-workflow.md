# dev-to-prod workflow

> **scope**: branching model, promotion patterns, version coordination, tag discipline. Per-surface deploy mechanics live in sibling runbooks.

## the two-branch model

Owlette uses a two-branch promotion model:

- `dev` -> `dev.owlette.app`
- `main` -> `owlette.app`

Both branches auto-deploy through Railway on push.

Each branch has its own Railway service:

- the `dev` branch should deploy through the dev Railway service
- the `main` branch should deploy through the prod Railway service

The intended environment mapping is:

| branch | web host | Firebase project | R2 buckets |
|--------|----------|------------------|------------|
| `dev` | `dev.owlette.app` | `owlette-dev-3838a` | `owlette-dev-content`, `owlette-dev-manifests` |
| `main` | `owlette.app` | `owlette-prod-90a12` | `owlette-prod-content`, `owlette-prod-manifests` |

Maintainers should verify Railway service env vars on the first prod deploy they own.
The branch-to-service mapping is operationally real, but it is not pinned in repo.
That means repo files alone cannot prove the production Railway service points at the
prod Firebase project or prod R2 buckets.

The safest assumption is:

- `dev` is the integration branch
- `main` is the production branch
- Railway handles web deploys after branch pushes
- Firebase Functions, Firestore rules, and Storage rules deploys remain manual

Per-surface deploy mechanics live in sibling runbooks:

- [production-deploy.md](production-deploy.md)
- [agent-installer-release.md](agent-installer-release.md)
- [hotfix-rollback.md](hotfix-rollback.md)

## day-to-day: working on dev

Normal development starts from `dev`.

1. Branch from `dev`.
2. Push work to a topic branch or directly to `dev`.
3. Open a PR to `dev` or merge directly.
4. Let Railway auto-deploy `dev` to `dev.owlette.app`.
5. Verify the change in dev.
6. When the release set is ready, merge `dev` into `main`.

Current practice is permissive.
Direct pushes and direct merges are part of the observed workflow.
That does not mean every maintainer should prefer direct pushes.
It means the repo history does not show a hard PR-only process.

Recommended day-to-day hygiene:

- keep feature work small enough to verify on `dev.owlette.app`
- run local checks before pushing to `dev`
- avoid mixing unrelated fixes in one release moment
- note any manual deploy steps needed after the web deploy
- update docs and changelog before promotion when user-visible behavior changes

The dev environment exists to absorb integration risk.
Use it before production promotion.

## promoting dev -> main

Current observed practice from git log:

- promotions are manual merge commits
- promotions are not squash merges
- promotions are mostly not pull requests
- a typical subject is `chore: merge dev for vX.Y.Z production release`

Observed examples include:

- `chore: merge dev for v2.6.0 production release`
- `chore: merge dev - remove sparkline no data text`
- `chore: Merge dev for production release - timezone and time format settings`

Only one promotion PR was found:

- `Merge pull request #6 from theexperiential/dev`

The rest of the observed promotions are direct merge commits.

Promotion frequency is not calendar-based.
It usually happens once per release moment, with gaps varying from days to weeks.

`dev` can run far ahead of `main`.
At the time of the workflow audit, `dev` was about 391 commits ahead of `main`.
That long-running divergence is normal for this repository.

Basic promotion flow:

1. Confirm `dev` is ready.
2. Check out `main`.
3. Pull the latest `main`.
4. Merge `dev` using a regular merge commit.
5. Resolve conflicts if any.
6. Push `main`.
7. Watch Railway production deploy.
8. Run post-deploy smoke checks.

Commands:

```bash
git checkout dev
git pull

git checkout main
git pull

git merge dev
git push origin main
```

Do not use a squash merge for normal promotion.
The historical model preserves the merge relationship between `dev` and `main`.

Use a clear merge subject when Git opens the merge editor:

```text
chore: merge dev for vX.Y.Z production release
```

If there are conflicts, resolve them intentionally.
Conflicts are expected to be rare, but they matter because `main` may contain
hotfix or doc-only commits that are not in `dev`.

After pushing `main`, Railway auto-deploys the production web service.
That does not deploy Firebase Functions, Firestore rules, or Storage rules.
Use [production-deploy.md](production-deploy.md) for the full release procedure.

## pre-promotion checklist

Before merging `dev` into `main`, confirm the release has been verified.

Recommended checks:

- lint passes
- smoke scripts pass
- e2e tests pass when the change touches user flows
- `dev.owlette.app` has been checked manually for the changed surface
- changelog is updated for user-visible release content
- version files are coordinated when this is a versioned release
- installer version has been bumped before building, if an installer is included
- manual deploy surfaces have an owner
- a release that changes `firestore.rules` has deployed its rules to prod, and any function that reads the same field, before `main` receives the web

The web follows the rules, never the other way round.
Railway deploys `main` on push, and the rules and functions are manual (see "manual deploy boundaries"), so this ordering is a step someone takes, not something the merge does.

### machine scope (rules 2.12.0, web 4.1.28)

4.1.28's web reads `machineIds` on member rows and expects prod's rules to enforce it.
Prod ran rules 2.11.0 before it, and 2.11.0 has no notion of a scope: over those rules a scoped member reads the whole site straight from Firestore (every machine, log and deployment, and for a scoped admin the audit log and webhooks too), while the dashboard and the API show them only their machines.
So before `dev` is merged into `main` for 4.1.28 or later:

1. Deploy rules 2.12.0 to prod:

   ```bash
   firebase deploy --only firestore:rules --project prod
   ```

2. Deploy the usage function, which needs whole-site standing from the same release:

   ```bash
   firebase deploy --only functions:getUsageSummaryHttp --project prod
   ```

3. Prove the read path against prod's deployed rules:

   ```bash
   node scripts/check-membership-read-path.mjs --env=prod
   ```

4. Before the first scoped row exists on prod, confirm that the Vercel standby serves the same commit as Railway.
   A failover to an older standby is a rollback, and an older web ignores `machineIds` and widens every scoped member (see [hotfix-rollback.md](hotfix-rollback.md)).

   ```bash
   curl -s https://owlette.app/api/health
   curl -s https://vercel-origin.owlette.app/api/health
   ```

   Both `commit` values must match, and the first must report `"origin":"railway"`.
   A null `commit` proves nothing: settle it from the Railway and Vercel dashboards instead.

Steps 1 to 3 are safe on their own: no prod row carries `machineIds` yet, and a row without it is whole site under 2.12.0.

### command queue (rules 2.13.0, release 4.2.0)

Rules 2.13.0 let an agent's token only remove entries from its machine's `commands/pending`; only the server adds them.
The file carries 2.12.0 as well, so a project still on older rules gets both in one deploy: run the machine scope steps above from 4.2.0's file and step 1 deploys 2.13.0.
Every agent from 3.2.0 on only removes entries there, so no agent has to update first.
Before `dev` is merged into `main` for 4.2.0:

1. In `web`, run `npm run test:rules` and `npm run e2e:desktop-sync`, whose tier 0 spec (`e2e/desktop-sync/tier0-commands-pending.spec.ts`) runs a real agent's command flow against these rules.
2. Deploy rules 2.13.0 to dev, if dev is not on it yet:

   ```bash
   firebase deploy --only firestore:rules --project dev
   ```

3. On dev, queue a screenshot on an online machine and confirm it completes and its entry leaves `commands/pending`.
4. Deploy the same file to prod (the same deploy with `--project prod`), and repeat step 3 on one prod machine.

Never deploy rules older than 2.13.0 to a project that has it (see [hotfix-rollback.md](hotfix-rollback.md)).

The repo has no automated post-merge smoke job today.
Do not assume a green push to `main` means every production surface is healthy.

## hotfix patterns

There are three practical hotfix patterns.

### forward-fix from dev

This is the most common pattern.

Use it when:

- production is not immediately broken
- the fix can wait for the next normal promotion
- `dev` already contains the right direction of travel

Flow:

1. Fix the issue on `dev`.
2. Verify on `dev.owlette.app`.
3. Include the fix in the next `dev` -> `main` promotion.

This keeps history simple and avoids special-case branch work.

### fix-on-dev-then-merge-to-main-immediately

Use this when production is broken and `dev` can safely be promoted.

Flow:

1. Fix on `dev`.
2. Verify on `dev.owlette.app`.
3. Confirm unrelated `dev` changes are acceptable for production.
4. Merge `dev` into `main`.
5. Push `main`.
6. Run production smoke checks.

This is still a normal merge promotion.
The urgency is different; the mechanics are the same.

### direct fix-on-main + back-merge to dev

Use this only when `dev` cannot safely be promoted but production needs a fix now.

Flow:

1. Branch from `main`.
2. Fix only the production issue.
3. Merge or push the fix to `main`.
4. Verify production.
5. Back-merge or cherry-pick the fix into `dev`.

At the time of audit, `main` had 38 commits not in `dev`.
Those are likely cherry-picked hotfixes or doc-only main edits.
Back-merge is the maintainer's responsibility.
There is no automation that keeps `dev` caught up with direct `main` work.

Full hotfix decision tree:

- [hotfix-rollback.md](hotfix-rollback.md)

## tags and releases

Current state: every release from `v4.1.5` on is tagged (4.1.12 never shipped).

Earlier releases are mostly untagged.
The older tags are `v2.0.43`, `v2.0.46`, `v2.0.47`, `v2.12.3`, `v2.12.21`, `v3.0.0`, `v3.3.3` and `v4.1.0` to `v4.1.3`; prod's 3.3.6 has none.

The tag pattern is in [version-management.md](../internal/version-management.md) ("tags"): `vX.Y.Z` on the release's merge commit into `dev`.

Tag every release.

Tagging matters because the CI installer build workflow is triggered by tag push:

- `.github/workflows/build-installer.yml`

That makes tags operationally meaningful, not just bookkeeping.

Use a release tag that matches the coordinated application version:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

If the release includes an agent installer, do not push or tag until every installer is built, uploaded to dev and its download verified ([agent-installer-release.md](agent-installer-release.md)).
The installer filename bakes in the version.

## version coordination

Owlette has multiple versioned surfaces.

The coordinated app version is stored in `/VERSION`, `/agent/VERSION`, `/web/package.json` and the other surfaces listed in [version-management.md](../internal/version-management.md).

Use the sync script to bump them together:

```bash
node scripts/sync-versions.js X.Y.Z
```

The script updates every one of them; the list is in [version-management.md](../internal/version-management.md).

The script does not update:

- `firestore.rules`

Firestore rules are independently versioned.
The Firestore rules schema version is a security-schema version, currently `2.13.0` (the `// Version:` line at the top of `firestore.rules`).
Do not assume an app patch release implies a Firestore rules version bump.

Default bump granularity is `PATCH` unless the user explicitly says otherwise.

Critical release ordering:

1. Pick the release version.
2. Run `node scripts/sync-versions.js X.Y.Z`.
3. Update both changelogs (`docs/changelog.md` and `web/content/docs/changelog.mdx`).
4. Build the agent installers, upload them to dev and verify the downloads ([agent-installer-release.md](agent-installer-release.md)).
5. Only then push, merge, and tag the release.

Do not build the installer before bumping the version.
The installer bakes the version into the EXE filename.

## branch protection

Maintainer input needed.

No `.github/branch-protection*` config is visible in repo.
Memory files note "don't push to main directly" as guidance, not enforcement.

A direct merge commit exists in main history:

- `fix: critical token revoke bug - merge from dev`

That suggests there is no hard PR-only rule today.

Branch protection is configured on GitHub, not in repo files.
If stricter protection is needed, configure it on github.com:

1. Open the repository on GitHub.
2. Go to Settings.
3. Go to Branches.
4. Add a branch protection rule.
5. Apply it to `main`.

Recommended protection questions for maintainers:

- should `main` require pull requests?
- should `main` require passing checks?
- should administrators be included?
- should force pushes be disabled?
- should release managers be the only direct push exception?

Until those answers are explicit, treat branch protection as an operational unknown.

## environment isolation

Owlette has separate dev and production infrastructure.

Firebase isolation:

- dev project: `owlette-dev-3838a`
- prod project: `owlette-prod-90a12`
- mapping source: `.firebaserc`

R2 isolation:

- dev content bucket: `owlette-dev-content`
- dev manifest bucket: `owlette-dev-manifests`
- prod content bucket: `owlette-prod-content`
- prod manifest bucket: `owlette-prod-manifests`

Railway isolation:

- dev branch has a dedicated Railway service
- main branch has a dedicated Railway service
- service env vars must be set correctly by maintainers

Runtime environment detection:

- code path: `web/lib/r2Client.server.ts`
- function: `currentEnv()`
- first source: `ROOST_ENV`
- second source: `RAILWAY_ENVIRONMENT`
- third source: `RAILWAY_PUBLIC_DOMAIN`
- default: `dev`

`ROOST_ENV` is authoritative when set.
The default to `dev` is a fail-safe.

Recommended Railway configuration:

- set `ROOST_ENV=dev` on the dev Railway service
- set `ROOST_ENV=prod` on the prod Railway service

Set production explicitly.
Do not rely on domain fallback when a single env var can remove ambiguity.

## manual deploy boundaries

The branch promotion model only explains web auto-deploy.

These surfaces are manual:

- Firebase Functions
- Firestore rules
- Storage rules
- agent installer release

Manual means a merge to `main` does not automatically publish them.
For a normal release, use [production-deploy.md](production-deploy.md).
For installer release, use [agent-installer-release.md](agent-installer-release.md).
For emergency response, use [hotfix-rollback.md](hotfix-rollback.md).

## known gaps in this workflow

- Tags are complete only from `v4.1.5`; earlier releases, prod's 3.3.6 among them, are mostly untagged.
- Branch protection on `main` is GitHub-side, not pinned in repo.
- Functions/rules/storage deploys are 100% manual. No CI automation pushes them on merge to `main`.
- `main` has 38 commits not in `dev` (cherry-picked hotfixes or doc-only main edits). No back-merge automation.
- No automated post-merge smoke job.
- Cherry-pick/back-merge protocol not written down.

## further reading

- [production-deploy.md](production-deploy.md)
- [agent-installer-release.md](agent-installer-release.md)
- [hotfix-rollback.md](hotfix-rollback.md)
- `/docs/internal/version-management.md`
- `/.claude/CLAUDE.md` (Git Workflow section)
