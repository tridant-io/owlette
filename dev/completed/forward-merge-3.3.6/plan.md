# forward-merge `release/3.3.6` into `dev` — Plan
**Created**: 2026-09-22 | **Status**: Active

## Summary

Agent 3.3.6 shipped to prod from the 3.3.5 release line on 2026-09-22 (PR #173). `dev` has moved a long way
under it — tri-platform (`osadapter`, the data-root seam, `_init_state`, `_write_token_file`, the key-derivation
migration and its `.tokens.enc.v1` rollback copy) plus swoop. This plan brings 3.3.6 forward onto `dev` as **one
hand-resolved merge commit** on a dedicated branch, so that every guarantee 3.3.6 shipped still holds on the
merged tree and nothing `dev` gained is weakened.

What 3.3.6 guarantees (the public description, from `docs/changelog.md` and PR #173) — the list the merge is
judged against:

- the program folders, the root documents and the uninstaller are readable and runnable by standard users,
  writable only by SYSTEM and administrators; the installer applies it on every install and upgrade and the
  service repairs drift at start-up and at login
- the machine credential file is limited to SYSTEM, administrators and the signed-in user; every save writes a
  new protected file and swaps it into place atomically
- self-update downloads into a folder only the service can write, and the checksum is taken from the same open
  file that is run
- the service verifies who created its stop signal, the update marker, the Cortex/hoot command queue and
  process-launch results before acting on them; hard links and reparse points are refused
- the recovery watchdog is disabled only through an administrator-set registry value
- the agent sends its credentials only to the owlette.app API hosts
- well-known accounts are identified by SID, so the permission code works on non-English Windows

Evidence base: [research/conflicts.md](research/conflicts.md) — 25 conflict hunks across 10 files, and ten
semantic hazards that merge clean and are still wrong. Every finding in it is a task, an accepted risk or a
stated non-issue below.

## Scope

**In**: resolving the merge on `merge/3.3.6-into-dev`; the five hand-written resolutions the research names
(`acl_hardening`, `shared_utils`, `secure_storage`, `owlette_service`, the self-update path); the two dev-only
`firebase.api_base` call sites; the `.tokens.enc.v1` hardening; the `install_permissions_repaired` web label;
verification through to a PR merged into `dev`.

**Out**: the prod promotion (`dev` → `main`) — a separate plan. Any installer release from this merge. Any
change to `release/3.3.6`, its tag, or prod's installer catalog. `firestore.rules`. New packages. swoop and
roost feature work.

## Decisions (settled — do not relitigate)

**D1 — one merge commit, resolved by hand, not a cherry-pick replay.** All 25 of 3.3.6's commits were written
against the pre-restructure `owlette_service.py`; replaying them hits the same five conflicts 25 times and every
intermediate commit is broken on the POSIX CI legs. Merge once with `--no-commit --no-ff`, fix forward in
follow-up commits on the same branch before the PR merges. The merge parent stays, so 3.3.6's history and tag
remain reachable from `dev`. Mechanically, git refuses to commit while any path is unmerged, so Waves 1–3 stage
their resolutions and the single merge commit is created at the start of Wave 4; everything after it is an
ordinary commit.

**D2 — a dedicated worktree, never `dev` itself.** Branch `merge/3.3.6-into-dev` cut from `origin/dev`, in a git
worktree at `C:\Users\admin\Documents\Git-restored\Owlette-merge`. `dev` auto-deploys; resolving on it is not an
option. The main checkout stays on its own branch and is not disturbed.

**D3 — resolution order, because each step reads the one before it**: mechanical conflicts → `acl_hardening`
made lazy → `shared_utils` → `secure_storage` + `.tokens.enc.v1` → `owlette_service` → the self-update rewrite
last, as its own task.

**D4 — `acl_hardening` goes lazy.** A `specs()` accessor (`functools.lru_cache`) replaces the `SPECS` module
constant, the four Windows imports move into the functions that use them, the well-known SID constants
initialise lazily, and `connection_manager`'s `import winreg` moves into its function body. No module-scope
`next(...)` lookup over the table anywhere — `owlette_service`'s four install-tree constants read `specs()` at
call time. This is what keeps the three-OS import legs green; adding the new modules to `WINDOWS_ONLY_MODULES`
makes it worse, because rule 2 of the guard then flags every module-scope `import acl_hardening`.

**D5 — `secure_storage` keeps one write choke point.** `_write_token_file(path, blob)` stays the single writer
and becomes Windows-aware (`os.name == 'nt'` → the protected create-then-replace path; else dev's
`os.open`/`O_NOFOLLOW` body). The protected replace is lifted to a module function taking a destination path, so
`_retain_previous_store` writes `.tokens.enc.v1` through it too. `_save_data` keeps dev's `_writer_fernet()`
cipher choice — that rule is the rollback path and taking 3.3.6's side throws it away. `clear_tokens` removes
`.tokens.enc`, the `.v1` copy and the `*.tmp` leftovers.

**D6 — `.tokens.enc.v1` is hardened in three places at once**: a `specs()` row with the credential-file ACEs so
start-up repair fixes drift, the protected write (falls out of D5), and the installer's credentials block
looping over both names. A test asserting the store and its pre-migration copy carry the same DACL after a
migration exists on neither branch and is written here, failing first.

**D7 — swoop's and roost's data-root IPC directories stay OUT of the hardening table, deliberately.** `dev` adds
`ipc/{jobs,results,swoop,requests}` and `logs/swoop` to `create_data_directories`; none are in the table, so they
inherit the data root's ACL. They stay out of this merge because the correct ACE set depends on which principal
reads each directory, and swoop's readers are not shipped yet — a guess that is too tight breaks swoop IPC
silently, and one that is too loose is worse than the status quo. The obligation moves to the reader: whatever
consumes those paths verifies the creator's identity the way the Cortex command read path already does. Recorded
as a comment beside the table and handed to swoop's enable/disable task. `{app}\swoop` is unaffected — the
installer's own `icacls` step covers the payload and the streamer re-checks it at spawn. `cache/update` is the
POSIX-only staging directory after this merge and needs no Windows ACL.

**D8 — version files carry `max(dev, 3.3.6)`; the merge never lowers `dev`.** Checked at plan time: `dev` is on
`3.3.5` (`VERSION`, `agent/VERSION`, `web/package.json`), so the auto-merged `3.3.6` everywhere is a forward
move and stands. If `dev` has moved onto a higher line by the time this runs, that higher version wins in every
version file and the changelog entry still lands as `[3.3.6]` in date order. Both changelogs end with the
`[Unreleased]` content preserved, then `## [3.3.6] - 2026-09-21`, then `## [3.3.5] - 2026-09-15`.

**D9 — editing `agent/src` on this machine goes through a junction.** The project hook
`.claude/hooks/deploy-agent.mjs` copies any edited path containing `agent/src/` into the live install at
`C:\ProgramData\Owlette\agent\src\` and restarts the service. Every task that edits `agent/src/*.py` reads and
writes through `C:\Users\admin\Documents\Git-restored\Owlette-merge-agentsrc\<file>.py`, a junction to the
worktree's `agent\src` created in Wave 0 — that path does not contain the substring the hook matches, so a
half-merged module never reaches the live service. Tests run from the worktree root with the main checkout's
interpreter: `C:/Users/admin/Documents/Git-restored/Owlette/agent/.venv/Scripts/python -m pytest agent/tests/`.

**D10 — PR #173 is closed once the replacement PR is open**, with a comment pointing at it. It cannot be
retargeted: the resolution is "merge these commits and then change five of the resolved files", and a PR whose
diff is a conflicted merge is not reviewable.

**D11 — the VM matrix here is verification of a merge, not a release.** A build is made from the merge branch to
drive `scripts/vm/18b-verify-upgrade.ps1`; it is never uploaded, never finalised, never set as latest, and no
`installer_metadata` id moves. Do not ship this merge and a 3.3.7 build from it in the same motion.

**D12 — confidentiality.** This repository is public. Describe every change as a guarantee and a mechanism, the
way the changelog does. No exploitation steps, no "an attacker could", no naming of the private hardening plan
or its memos. `plan.md` and `tasks.md` are force-added to git (`dev/active/` is gitignored, and that is how a
plan was lost once); `research/conflicts.md` stays untracked until the 3.3.6 release hold expires, and lives as
two on-disk copies in the meantime (main checkout and worktree).

## Waves

- **Wave 0 — set up and start the merge** (1 task): worktree, junction, the `dev` baseline test counts, the plan
  files tracked, then `git merge --no-commit --no-ff origin/release/3.3.6` left **in progress** with the
  conflicts in the index for the resolvers.
- **Wave 1 — mechanical resolutions, the lazy table, the web label** (3): the eight mechanical hunks plus the
  installer's two `Step 0c` blocks and its credentials loop · `acl_hardening` + `connection_manager` go lazy ·
  the `install_permissions_repaired` label on the logs page.
- **Wave 2 — `shared_utils`, the api-base allowlist, version hygiene** (3): the six `shared_utils` hunks with
  the three-way `write_json_to_file` branch and the POSIX guards · `auth_manager` (dev's stable machine id *and*
  3.3.6's API-host gate) plus the runner's raw `api_base` read · the version-file and changelog audit.
- **Wave 3 — the credential store and the service file** (2): `secure_storage`'s choke point, the
  `.tokens.enc.v1` row and the DACL-parity test · `owlette_service` conflict hunks 1–4, the 22 clean hunks read
  one by one against dev's structure, the five new attributes into `_init_state`, and the service's
  `api_base` call site.
- **Wave 4 — the merge commit, then self-update** (1): the single merge commit is created first, then dev's split
  methods take on 3.3.6's hardened staging semantics — one staging directory created fail-closed, hash taken from
  the held handle, verified-open across the hand-off, trusted creator checks on the marker, the stale-installer
  sweep — with tests that fail first, as a second commit.
- **Wave 5 — gates, review, VM, PR** (4, and this is the one wave that runs in order): the local gate run · an
  adversarial review of the four security surfaces · the VM upgrade matrix on the owner's host · push, PR,
  CI watch, close #173.

Full task text: [tasks.md](tasks.md).

## Gates

Nothing below is optional, and the two that must be re-proved rather than re-read are the credential store and
the self-update path.

1. **Agent suite on Windows**, full, from the worktree root. Beat both baselines: 3.3.6's 1432 passed / 5
   skipped and `dev`'s own count as measured in Wave 0. `test_acl_hardening.py`,
   `test_owlette_service_hardening.py`, `test_shared_utils_hardening.py`, `test_self_update_hardening.py` and
   `test_secure_storage.py` all pass on the merged shapes.
2. **The import guards**: `test_no_platform_imports.py` clean, and a simulated POSIX collection locally (the
   Windows extension modules blocked at `sys.meta_path`, `OWLETTE_DATA_ROOT` set, then importing the three CI
   entrypoints). The authoritative proof is CI's `macos-15` and `ubuntu-24.04` legs on the PR — the local run is
   a fast proxy, not a substitute.
3. **Desktop**: `npm test` (vitest) and `cargo check`, because both `Cargo.lock`s were resolved by hand and the
   lock must still resolve. Same for `agent/host`.
4. **Web**: `npx tsc --noEmit`, `npx jest`, and `/preflight` (lint, typecheck, unit, rules tests, local e2e).
   The changelog page is covered by the docs-links spec.
5. **`node scripts/check-security-alerts.mjs`** against this branch's lockfiles. No ack without the owner's
   written reason.
6. **Adversarial review** of `secure_storage.py`, `acl_hardening.py`, the self-update path in
   `owlette_service.py` and `owlette_installer.iss`, briefed as: *name anything 3.3.6 protected that the merged
   code no longer protects, and anything `dev` protected that is now weaker*. Calibrated to the repo's review
   discipline.
7. **VM upgrade matrix** (`scripts/vm/18b-verify-upgrade.ps1`) against a build from the merge branch, at least
   `3.3.4 → merged` and `3.3.6 → merged`, plus the negative control and a new assertion row for the credential
   file's pre-migration copy.
8. **CI on the PR**: `agent tests` (three OS legs + the roost/minio leg) and `playwright e2e` green before the
   PR is marked ready.

## Success criteria

- One merge commit plus fix-forward commits on `merge/3.3.6-into-dev`, merged into `dev` through a PR; #173
  closed with a pointer to it.
- Every guarantee in the Summary list holds on the merged tree, and the VM matrix asserts the install-tree,
  credential-file and self-update ones directly on an upgraded machine.
- The credential file **and its pre-migration copy** carry the same restricted DACL after a migration, proved by
  a test that failed before the change and by a VM row.
- A self-update installs the bytes it verified: one staging directory only the service can write, the checksum
  taken from the held handle, the handle held across the hand-off.
- No module in `agent/src` imports a Windows-only module at module scope, and nothing evaluates the hardening
  table at import; all three CI OS legs collect and pass.
- No raw `firebase.api_base` read survives anywhere in `agent/src` — the source-scan test is green with no new
  exemption.
- Machine identity on macOS/Linux still comes from the stable machine id, and the API-host gate still refuses a
  non-owlette API base.
- Version files and both changelogs are consistent, `node scripts/sync-versions.js <version>` is a no-op, and
  the `install_permissions_repaired` event renders as lowercase copy.
- No installer from this merge exists anywhere but the VM host and the build directory.

## Risks

1. **A plausible-looking resolution silently removes a shipped guarantee.** This is the PR-#171 class and it is
   the reason for D3's order, the fail-first tests and gate 6. The four files named there are the whole risk
   surface.
2. **The self-update rewrite is the single largest correctness risk.** Both sides are complete implementations,
   the conflict marker sits only on the dispatch line, and either side taken whole is wrong in a way no test
   currently catches. It gets its own wave, its own task and the reviewer's attention.
3. **The 22 `owlette_service` hunks that merged without a marker** landed in methods `dev` moved or split.
   Mitigated by reading each one against dev's structure rather than trusting the merge.
4. **The POSIX legs cannot be run properly on this box.** The local simulation is a proxy; a red leg may only
   appear on the PR. Budget a fix-forward pass after the first CI run.
5. **`_init_state` is an invariant, not a style rule.** Attributes declared in `main()` and read from the
   5-second loop work today and die with `AttributeError` one refactor later.
6. **Developer boxes need one elevated `-DevGrant` run** after they next install a 3.3.6-era agent, or the
   deploy hook starts failing quietly. Called out in the merge commit body and the PR body.
7. **The merged agent is the first build where the install-tree hardening meets the tri-platform data-root seam
   and the key-derivation migration.** It wants the VM matrix and a dev-box soak before it is ever a fleet
   artifact — which is what D11 forbids here.

## Rollback

Abandon the branch. Nothing in this plan touches `dev`, `main`, `release/3.3.6`, its tag, prod's installer
catalog or any `installer_metadata` id, so the whole recovery is:

```
git -C C:\Users\admin\Documents\Git-restored\Owlette worktree remove C:\Users\admin\Documents\Git-restored\Owlette-merge
git -C C:\Users\admin\Documents\Git-restored\Owlette branch -D merge/3.3.6-into-dev
```

plus removing the junction (`cmd /c rmdir "C:\Users\admin\Documents\Git-restored\Owlette-merge-agentsrc"` — a
junction, so this removes the link and not the target). PR #173 stays open until its replacement exists, so
abandoning before Wave 5 leaves the forward merge exactly where it is today. If the branch is abandoned after
the dev box has been re-installed from a merge build, re-install from prod's latest and re-run `-DevGrant`.

## Handover after the PR merges to `dev`

Nothing further in this plan. Two things it hands over:

- **`-DevGrant` on dev boxes.** Every developer machine that reinstalls the agent from a 3.3.6-era build needs
  one elevated `scripts/bootstrap-windows.ps1 -DevGrant` run, or the `deploy-agent.mjs` hook cannot write into
  the installed agent and fails quietly.
- **The next agent release cut from `dev` is the first artifact that carries both lines** — the install-tree
  hardening and the tri-platform data-root seam with its key-derivation migration. It needs the full VM matrix
  and a soak in its own release plan; this merge does not pre-authorise it.
- **Follow-up, filed not fixed**: hardening-table rows for the swoop and roost data-root IPC and log
  directories, with the reader-side identity check that D7 makes the condition for them.
