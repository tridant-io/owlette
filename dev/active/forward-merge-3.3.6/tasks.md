# forward-merge `release/3.3.6` into `dev` — Tasks
**Progress**: 14/14 complete

Every task is executed by a fresh agent with no conversation context. Read [plan.md](plan.md) and the sections of
[research/conflicts.md](research/conflicts.md) your task names — nothing else. Line and symbol references were
read on 2026-09-22 against `origin/dev` (`bbdbbebf`) and `origin/release/3.3.6` (`6201fd1f`); re-locate by symbol
if a line has drifted. `dev/active/` is gitignored, so search this directory with plain `grep -rn`.

## Paths and commands (every task uses these spellings)

| what | value |
| --- | --- |
| main checkout | `C:\Users\admin\Documents\Git-restored\Owlette` |
| merge worktree (**work here**) | `C:\Users\admin\Documents\Git-restored\Owlette-merge` |
| junction for `agent\src` (**edit through this**) | `C:\Users\admin\Documents\Git-restored\Owlette-merge-agentsrc` |
| branch | `merge/3.3.6-into-dev` |
| python | `C:/Users/admin/Documents/Git-restored/Owlette/agent/.venv/Scripts/python` |
| agent tests | from the worktree root: `<python> -m pytest agent/tests/` |
| git in the worktree | `git -C C:\Users\admin\Documents\Git-restored\Owlette-merge <cmd>` |
| the two sides of a conflicted file | `git -C <wt> show :1:<path>` (base) · `:2:` (**dev / ours**) · `:3:` (**3.3.6 / theirs**) |
| what is still unresolved | `git -C <wt> diff --diff-filter=U --name-only` |

## Standing rules for every task

- **Edit `agent/src/*.py` only through the junction path**, and read it through the junction too:
  `C:\Users\admin\Documents\Git-restored\Owlette-merge-agentsrc\<file>.py`. The project hook
  `.claude/hooks/deploy-agent.mjs` copies any edited path containing `agent/src/` into the live install at
  `C:\ProgramData\Owlette\agent\src\` and restarts the service; the junction path does not contain that
  substring, so a half-merged module never reaches the running agent. Everything else (tests, `web/`, the
  installer script, docs) is edited at its normal path under the worktree.
- **The `pre-commit-check.mjs` hook proves nothing here.** It runs `tsc`, `jest` and `pytest` with the working
  directory set to the *main checkout*, so it passes on this merge whatever the worktree contains. Run the checks
  your task's done-when names, yourself, from the worktree root.
- **Between Wave 1 and the end of Wave 3 the tree does not parse.** `shared_utils.py`, `secure_storage.py` and
  `owlette_service.py` carry conflict markers until their own task resolves them, so any pytest run that imports
  one fails at collection. Run only the module-scoped checks your task names; the full suite belongs to Wave 5.
  If a check your task names cannot run because of an unresolved module, use the fallback the task gives, and say
  so in the Log.
- **Tasks in one wave never touch the same file and never depend on each other.** The exception is Wave 5, which
  runs in order: gates, then review, then the VM matrix, then the PR.
- **Never `git merge --abort`** — it throws away every resolution before it. If you believe the merge must be
  restarted, stop and log it.
- **Never push to `dev`, `main` or `release/3.3.6`; never upload, finalise or set-as-latest any installer.** The
  only branch this plan writes is `merge/3.3.6-into-dev`, and only Task 5.4 pushes it.
- **Waves 1–3 stage, they do not commit.** The merge is in progress from Task 0.1 onward, and git refuses to
  commit while any unmerged path remains — so every task in Waves 1–3 finishes with `git -C <wt> add <its files>`
  and no commit. The index in the worktree is where the work is durable; also save a patch of your resolution to
  the session scratchpad (`git -C <wt> diff --cached -- <your files> > <scratch>/<task>.patch`) before you stop.
  The single merge commit is created at the start of Task 4.1, once the last conflict is gone. It therefore also
  carries Task 1.3's label addition and any Task 2.3 version fix; that is git's only option mid-merge, and the
  merge commit body says so.
- Task 0.1 commits the plan files before the merge starts; Waves 1–3 stage only; from Task 4.1 on, one commit per
  task, in the worktree: `type: details`, lowercase, one line, conventional
  type, ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. A body only where the
  why is not obvious.
- **Confidentiality**: this repository is public. Describe changes as guarantees and mechanics, the way
  `docs/changelog.md` does. No exploitation steps, no "an attacker could", and no reference to the private
  hardening plan or its memos in any commit message, comment, PR body or tracked file.
- Web edits: `npx eslint <file>` clean, all UI copy lowercase, theme tokens only, `lucide-react` only.
- Never modify `firestore.rules`, `.tokens.enc*`, `.claude/hooks/` or `.claude/settings.json`. No new npm or pip
  packages.
- If you find something [research/conflicts.md](research/conflicts.md) did not predict, **stop and add it to
  `## Log`** rather than deciding it yourself.
- Labels: `[agent]` runs on this dev box · `[human]` needs the owner's hardware, accounts or eyes ·
  `[agent+human]` says which half is which.

---

## Wave 0: set up and start the merge

- [x] **Task 0.1: worktree, junction, baseline, merge left in progress** `[agent]`
  - Files: creates `C:\Users\admin\Documents\Git-restored\Owlette-merge` (worktree) and
    `C:\Users\admin\Documents\Git-restored\Owlette-merge-agentsrc` (junction); copies
    `dev/active/forward-merge-3.3.6/{plan.md,tasks.md,research/conflicts.md}` into the worktree; commits
    `plan.md` and `tasks.md` only.
  - Do:
    1. `git -C C:\Users\admin\Documents\Git-restored\Owlette fetch origin`, then
       `git -C C:\Users\admin\Documents\Git-restored\Owlette worktree add -b merge/3.3.6-into-dev C:\Users\admin\Documents\Git-restored\Owlette-merge origin/dev`.
       Do not disturb the main checkout's branch or working tree.
    2. `cmd /c mklink /J "C:\Users\admin\Documents\Git-restored\Owlette-merge-agentsrc" "C:\Users\admin\Documents\Git-restored\Owlette-merge\agent\src"`
       (a junction needs no elevation). Confirm `C:\Users\admin\Documents\Git-restored\Owlette-merge-agentsrc\owlette_service.py`
       reads through it.
    3. Copy this plan directory into the worktree, then `git add -f dev/active/forward-merge-3.3.6/plan.md dev/active/forward-merge-3.3.6/tasks.md`
       and commit. **Do not add `research/conflicts.md`** — plan.md D12: it stays untracked until the 3.3.6
       release hold expires, and exists as two on-disk copies (main checkout and worktree) in the meantime.
    4. Capture the `dev` baseline while the tree is still clean: `<python> -m pytest agent/tests/ -q` from the
       worktree root. Record passed/skipped/failed.
    5. `git -C <wt> merge --no-commit --no-ff origin/release/3.3.6`. Expect it to stop with conflicts. **Leave it
       in progress** — do not commit, do not abort, do not resolve anything.
    6. Write the inventory into `## Log`: every path from `git -C <wt> diff --diff-filter=U --name-only` with its
       marker count (`git -C <wt> grep -c "^<<<<<<< " -- <path>`), compared line by line against
       research §1's table (10 files / 25 hunks). Flag any drift — a file in one list and not the other is a
       signal that `dev` moved again and the later tasks' anchors need re-reading.
  - Done when: `git -C <wt> rev-parse --abbrev-ref HEAD` is `merge/3.3.6-into-dev`; `git -C <wt> rev-parse -q --verify MERGE_HEAD`
    resolves to 3.3.6's tip; the junction resolves; `dev/active/forward-merge-3.3.6/plan.md` and `tasks.md` are
    tracked on the branch and `research/conflicts.md` is not; `## Log` carries the dev baseline counts and the
    conflict inventory with the drift check.
  - Depends on: nothing.

---

## Wave 1: mechanical resolutions, the lazy table, the web label

- [x] **Task 1.1: the eight mechanical hunks, the installer's two `Step 0c` blocks, and the credentials loop** `[agent]`
  - Files: `agent/host/Cargo.lock`, `desktop/src-tauri/Cargo.lock`, `agent/tests/unit/test_shared_utils.py`,
    `agent/src/installer_utils.py` (via the junction), `agent/src/owlette_runner.py` (via the junction),
    `agent/owlette_installer.iss`
  - Do: read research §2.6–§2.10 and §2.9 first, then resolve exactly these six files and nothing else.
    - both `Cargo.lock`s: the owlette package version becomes `3.3.6` (plan.md D8 — the higher of the two sides,
      matching `VERSION`, both `Cargo.toml`s and `tauri.conf.json`, which auto-merged).
    - `test_shared_utils.py`: keep **everything from both sides** — both import lines (`plistlib`/`subprocess`
      and `re`) and every appended class (`TestPlatformNormalisation`, `TestOsVersionString`,
      `TestPosixMetricProbes`, `TestWmiProbesOffWindows`, `TestConfiguredApiBase`). `TestConfiguredApiBase::test_no_other_module_reads_firebase_api_base_itself`
      is a gate that stays red until Tasks 2.2 and 3.2 land — that is correct, do not weaken it, do not add an
      exemption.
    - `installer_utils.py`: keep both additions in this order — dev's `ARTIFACT_MAGIC`,
      `UPDATE_ARTIFACT_NAMES`, `MIN_ARTIFACT_BYTES`, `verify_artifact_family`, then 3.3.6's `open_verified`
      (whose `pywintypes`/`win32file` imports are already function-local; leave them there).
    - `owlette_runner.py`: take dev's side. `MockService` stays deleted and the import stays
      `from owlette_service import OwletteService, Util`. 3.3.6's three edits inside `MockService` are carried
      into `_init_state` by Task 3.2 instead — nothing is lost.
    - `owlette_installer.iss`: keep **both** `Step 0c` blocks in `CurStepChanged`/`ssPostInstall` —
      `HardenInstallTree()` first, dev's `{app}\swoop` `icacls` pass after — with a one-line comment saying the
      path sets are disjoint and why swoop is handled separately. Then, in `HardenInstallTree`'s generated
      credentials block, make the `.tokens.enc` stanza loop over **both** `.tokens.enc` and `.tokens.enc.v1`
      (plan.md D6 — the pre-migration copy is a credential store too). Keep the file ASCII-only.
  - Done when: `git -C <wt> diff --diff-filter=U --name-only` no longer lists any of the six; no conflict marker
    survives in them (`git -C <wt> grep -n "^<<<<<<< \|^=======$\|^>>>>>>> " -- <the six paths>` is empty);
    `<python> -m py_compile agent/src/installer_utils.py agent/src/owlette_runner.py` is clean; both `Cargo.lock`s
    carry the same version string as `VERSION` and both `Cargo.toml`s; the `.iss` credentials block names both
    token paths; the six files are staged (`git -C <wt> add`) and the patch is saved to the scratchpad.
  - Depends on: 0.1.

- [x] **Task 1.2: `acl_hardening` and `connection_manager` go lazy** `[agent]`
  - Files: `agent/src/acl_hardening.py` (via the junction), `agent/src/connection_manager.py` (via the
    junction), `agent/tests/unit/test_acl_hardening.py`
  - Do: read research §2.4 and §3.1 and plan.md D4. `acl_hardening.py` merged clean and is wrong on `dev` as it
    stands — it imports Windows modules at module scope and publishes a `SPECS` table built at import.
    - move `win32security`, `win32ts`, `ntsecuritycon` and `winreg` out of module scope into the functions that
      use them. The AST guard (`agent/tests/unit/test_no_platform_imports.py`) walks `ast.Try` bodies as
      import-time nodes, so a `try: import win32… except ImportError` at module scope does **not** satisfy it.
    - replace `SPECS = _build_specs()` with a `@functools.lru_cache(maxsize=1)`-decorated `specs()` accessor. No
      module-scope consumer anywhere may evaluate the table — that is the whole point.
    - make `SID_SYSTEM` / `SID_ADMINISTRATORS` / `SID_USERS` lazily initialised the same way.
    - `connection_manager._read_watchdog_disabled_value`: move its `import winreg` inside the function body. One
      line, no behaviour change.
    - add a comment beside the spec table recording plan.md D7: the swoop and roost data-root IPC and log
      directories (`ipc/{jobs,results,swoop,requests}`, `logs/swoop`) are deliberately not rows here, because the
      correct ACE set depends on which principal reads each one and those readers are not shipped; whatever
      consumes them verifies the creator's identity the way the Cortex command read path does. `cache/update` is
      the POSIX-only staging directory after this merge and needs no Windows ACL.
    - update `test_acl_hardening.py` for the accessor. Do **not** add anything to `WINDOWS_ONLY_MODULES` (rule 2
      of the guard would then flag every module-scope `import acl_hardening`, which is how three modules consume
      it). Do **not** add the `.tokens.enc.v1` row — Task 3.1 owns it.
  - Done when: from the worktree root, `PYTHONPATH=agent/src <python> -c "import acl_hardening; print(len(acl_hardening.specs()))"`
    prints a non-zero count on Windows and the module imports with no Windows module at module scope; the guard
    reports **no violation naming `acl_hardening.py` or `connection_manager.py`** — either from
    `<python> -m pytest agent/tests/unit/test_no_platform_imports.py -q`, or, if that run cannot collect because
    another module still carries markers, from a targeted call:
    `<python> -c "import sys;sys.path.insert(0,'agent/tests/unit');import test_no_platform_imports as g;print(g.find_violations({p:open('agent/src/'+p,encoding='utf-8').read() for p in ['acl_hardening.py','connection_manager.py']}))"`
    printing `[]`; `<python> -m pytest agent/tests/unit/test_acl_hardening.py -q` green (or, if it cannot collect
    for the same reason, logged and deferred to Task 5.1 with the reason); `git -C <wt> grep -n "acl_hardening.SPECS" -- agent/src agent/tests`
    lists only files Waves 2–4 own, and those files are named in `## Log` as the handover; staged, patch saved.
  - Depends on: 0.1.

- [x] **Task 1.3: a web label for `install_permissions_repaired`** `[agent]`
  - Files: `web/app/logs/page.tsx`
  - Do: the agent emits an `install_permissions_repaired` machine event when the service repaired drifted install
    permissions (research §3.8). Nothing under `web/` names it, so `actionLabel` (`web/app/logs/page.tsx:235`)
    falls back to the raw wire string in the feed and in the filter chips. Add
    `{ value: 'install_permissions_repaired', label: 'install permissions repaired' }` to the **`agent`** group of
    `ACTION_TYPE_GROUPS` (`:137`), next to the other service-lifecycle rows. Lowercase copy, wire value unchanged.
    `web/e2e/videos/16-logs-and-troubleshooting.video.ts` cites this block by line number — if its comment is now
    off, correct the comment, nothing else.
  - Done when: `npx eslint web/app/logs/page.tsx` clean from the worktree root; `cd web && npx tsc --noEmit`
    clean (run `npm ci` in the worktree's `web/` first if `node_modules` is absent); the new option appears
    exactly once and every other option is untouched (`git -C <wt> diff -- web/app/logs/page.tsx` is a
    one-line-plus-comment addition); staged (it lands in the merge commit — see the standing rules).
  - Depends on: 0.1.

---

## Wave 2: `shared_utils`, the api-base allowlist, version hygiene

- [x] **Task 2.1: resolve `shared_utils.py`** `[agent]`
  - Files: `agent/src/shared_utils.py` (via the junction), `agent/tests/unit/test_shared_utils_hardening.py`
  - Do: read research §2.2 and §3.6. Six conflict hunks, resolved per that table:
    - imports: keep **both** `import osadapter` and `import acl_hardening`.
    - `create_data_directories` docstring: merge both sentences (dev's "every required data-root directory" and
      3.3.6's note that the Cortex IPC directories are service-owned).
    - the directory list: keep dev's additions (`ipc/{jobs,results,swoop,requests}`, `logs/swoop`) and **drop**
      the three `ipc/cortex_*` rows — they move to `_create_cortex_ipc_dirs`, which must remain their only
      creator.
    - the platform arm: keep both, under `_IS_WINDOWS` / else — POSIX keeps `posix.harden_data_root(...)` +
      `grant_data_group`, Windows keeps `if is_system_process(): _create_cortex_ipc_dirs()`.
    - the helper block: keep **both** verbatim — dev's `open_new_file` / `_carry_file_identity` /
      `_seed_file_identity` and 3.3.6's `_json_file_dacl` / `_write_new_file_with_dacl` / `_write_protected_temp`.
    - inside `write_json_to_file`, the three-way branch exactly as research §2.2 writes it: `_write_protected_temp`
      when `dacl is not None`, otherwise dev's `os.fdopen(open_new_file(temp_path))` + `_carry_file_identity`.
    Then the two POSIX guards from §3.6: `_create_cortex_ipc_dirs` returns immediately when not on Windows
    (today it is unreachable off Windows only by coincidence, and an empty table would make its lookup a
    `KeyError`), and `_process_user_sid`'s "could not read this process's token user" warning is gated on
    `_IS_WINDOWS` so a POSIX agent start does not emit a spurious warning on every boot. Every read of the
    hardening table goes through `acl_hardening.specs()` at call time, never a module-scope constant.
    `harden_existing_json`, `is_owlette_api_base` and `get_configured_api_base` auto-merged — leave them as they
    landed.
  - Done when: no conflict marker survives in the file; `PYTHONPATH=agent/src <python> -c "import shared_utils"`
    succeeds from the worktree root; `<python> -m pytest agent/tests/unit/test_shared_utils_hardening.py agent/tests/unit/test_shared_utils.py -q`
    passes except for `TestConfiguredApiBase::test_no_other_module_reads_firebase_api_base_itself`, which stays
    red until Task 3.2 (say so in the Log, with the survivors it names);
    `git -C <wt> grep -n "SPECS" -- agent/src/shared_utils.py` is empty; `ipc/cortex_*` appears in
    `_create_cortex_ipc_dirs` and nowhere else; staged, patch saved.
  - Depends on: 1.2 (the `specs()` accessor).

- [x] **Task 2.2: `auth_manager` keeps both intents; the runner's api-base read goes through the accessor** `[agent]`
  - Files: `agent/src/auth_manager.py` (via the junction), `agent/src/owlette_runner.py` (via the junction)
  - Do: read research §2.5 and §3.4.
    - `auth_manager.py` has one conflict hunk where both sides rewrote the same two lines. Keep **both intents**:
      dev's `self.machine_id = machine_id or shared_utils.get_machine_id()` (the stable cross-platform id —
      dropping it re-breaks machine identity on macOS and Linux) **and** 3.3.6's gate
      `if not shared_utils.is_owlette_api_base(self.api_base): raise ValueError(...)` (dropping it un-ships the
      "the agent sends its credentials only to the owlette.app API hosts" guarantee). Update the docstring to
      state both.
    - `owlette_runner.py` around line 339: `api_base = shared_utils.read_config(['firebase', 'api_base'])`
      becomes `shared_utils.get_configured_api_base()`. This is a dev-only call site that 3.3.6 never saw.
    Change nothing else in either file; `owlette_runner.py`'s conflict was already resolved in Task 1.1.
  - Done when: `<python> -m py_compile agent/src/auth_manager.py agent/src/owlette_runner.py` clean;
    `git -C <wt> grep -n "read_config(\['firebase', *'api_base'\])" -- agent/src` returns **exactly one** hit, in
    `owlette_service.py` (quote it in the Log as the handover to Task 3.2); the auth_manager unit tests under
    `agent/tests/` that cover machine id and api_base pass (locate them by name;
    `<python> -m pytest agent/tests/ -q -k "auth_manager"`), or the collection failure is logged with the
    unresolved module that caused it; staged.
  - Depends on: 1.1 (the runner's conflict), 2.1 is **not** required — `get_configured_api_base` auto-merged.

- [x] **Task 2.3: version files and both changelogs audited** `[agent]`
  - Files: read-only unless something is wrong — `VERSION`, `agent/VERSION`, `web/package.json`,
    `docs/changelog.md`, `web/content/docs/changelog.mdx`, `docs/internal/version-management.md`,
    `.claude/CLAUDE.md`, `agent/host/Cargo.toml`, `desktop/src-tauri/Cargo.toml`,
    `desktop/src-tauri/tauri.conf.json`
  - Do: these all auto-merged (research §2.11) — this task proves it rather than assuming it. Check, and fix only
    what is wrong:
    - plan.md D8: the merged tree carries `max(dev, 3.3.6)` in every version file and never lowers `dev`.
      Measured at plan time: `dev` was `3.3.5`, so `3.3.6` everywhere is correct. If `git show origin/dev:VERSION`
      now reads higher than `3.3.6`, that higher version wins in every version file instead — state which rule
      applied in the Log.
    - both changelogs read, top to bottom: the `## [Unreleased]` section with dev's unreleased entries intact
      (the two metrics-chart entries), then `## [3.3.6] - 2026-09-21`, then `## [3.3.5] - 2026-09-15`. The 3.3.6
      entry is identical in both files and contains no internal links (the public docs-links e2e spec checks
      every internal link and anchor on that page).
    - `.claude/CLAUDE.md` says `**Version**: 3.3.6` and carries the `-DevGrant` paragraph in the agent-dev-testing
      section; `docs/internal/version-management.md` reads 3.3.6 for both product and agent.
    - run `node scripts/sync-versions.js <the version from VERSION>` from the worktree root and confirm
      `git -C <wt> status --porcelain` is unchanged afterwards. A diff here is the finding: keep it only if it
      moves in the D8 direction, and log it either way.
  - Done when: every bullet above is checked off in the Log with the value seen; `sync-versions.js` is a no-op;
    any fix is a one-line version correction and nothing else, staged (it lands in the merge commit); if nothing
    needed changing, the Log entry records that and nothing is staged.
  - Depends on: 1.1 (the two `Cargo.lock`s).

---

## Wave 3: the credential store and the service file

- [x] **Task 3.1: `secure_storage` keeps one write choke point, and the pre-migration copy is protected** `[agent]`
  - Files: `agent/src/secure_storage.py` (via the junction), `agent/src/acl_hardening.py` (via the junction),
    `agent/tests/unit/test_secure_storage.py`
  - Do: read research §2.1 and §3.2 and plan.md D5/D6. Five conflict hunks, and the resolution is a design, not
    a pick: dev's write choke point plus 3.3.6's protected atomic replace.
    1. **Write the failing test first.** In `test_secure_storage.py`, assert that after a key-derivation
       migration the token store **and** its pre-migration copy carry the same restricted DACL, and that the
       copy is created through the protected path. Run it and record that it fails, with the assertion text.
    2. imports: dev's `platform`, `InvalidToken`, `Optional` plus 3.3.6's `glob`, `secrets`, `stat`; keep **both**
       `import osadapter` and `import acl_hardening`.
    3. keep `_write_token_file(path, blob)` as the single writer and make it Windows-aware: on `os.name == 'nt'`
       it calls the protected create-then-replace path, otherwise dev's `os.open` / `O_NOFOLLOW` / `O_BINARY` /
       mode `0600` body. Lift the protected replace to a **module function taking the destination path** (it is a
       method on the release branch only because it read `self.token_file`), so all three existing callers —
       `_rewrite_store`, `_retain_previous_store`, `_save_data` — get it, which is what hardens the `.v1` copy.
       The per-save temp name stays unpredictable (`f"{path}.{secrets.token_hex(4)}.tmp"`), attributes are set
       before the replace because a rename carries the source's attributes, and the spec comes from the
       credential row of `acl_hardening.specs()` (call time, never import time) including the writer's own SID so
       a pairing session over RDP cannot lock itself out.
    4. `_load_data`: 3.3.6's "refuse anything that is not a plain file at the token path" early return
       (directory, symlink, reparse point), **then** dev's `_read_file` / `_migrate_token_file` /
       `_note_retained_copy` body.
    5. `_save_data`: dev's `_writer_fernet()` cipher choice **and** the protected replace. Taking 3.3.6's side
       here encrypts with `self._fernet` and throws away the rule that a store whose pre-migration copy could not
       be kept stays readable to a pre-migration agent — that rule is the rollback path.
    6. tail: keep **both** `encrypt_value`/`decrypt_value` (they serve the Cortex API key in `config.json`) and
       the replace helper.
    7. `clear_tokens` merges both bodies: remove `.tokens.enc`, the `.v1` copy, **and** any `*.tmp` leftovers.
    8. in `acl_hardening.py`, add a `.tokens.enc.v1` spec row with the same ACEs as `.tokens.enc`, so start-up
       repair fixes drift on it too. Nothing else in that file.
  - Done when: the test from step 1 fails before the change and passes after — paste both result lines in the
    Log; `<python> -m pytest agent/tests/unit/test_secure_storage.py agent/tests/unit/test_acl_hardening.py -q`
    green; no conflict marker survives in `secure_storage.py`;
    `git -C <wt> grep -n "_write_token_file(" -- agent/src/secure_storage.py` shows the one definition and the
    three callers and no fourth write path; the spec table has a `.tokens.enc.v1` row whose ACEs equal the
    `.tokens.enc` row's (assert this in a test, not by eye); `PYTHONPATH=agent/src <python> -c "import secure_storage"`
    succeeds; staged, patch saved.
  - Depends on: 1.2, 2.1.

- [x] **Task 3.2: resolve `owlette_service.py` — everything except self-update** `[agent]`
  - Files: `agent/src/owlette_service.py` (via the junction), `agent/tests/unit/test_owlette_service_hardening.py`
  - Do: read research §2.3, §3.4 and §3.5. Five conflict hunks, 22 hunks that merged **without** a marker into a
    file whose structure changed underneath them, and one invariant to honour.
    - **hunk 1 (module imports)**: take dev's side — the module-scope `win32*` / `servicemanager` block stays
      deleted. Give 3.3.6's new hardening code **function-local** imports instead. Taking 3.3.6's side fails
      `test_no_platform_imports.py` and the CI step `python -c "import firebase_client, owlette_service, configure_site"`
      on both POSIX legs.
    - **hunk 2 (the module-level block after `_stop_process_outside_window`)**: pure adjacency — keep **both**
      dev's `_processes_running_from` / `_remove_tree_nofollow` and 3.3.6's install-tree hardening block
      (`_CONSOLE_USER_ACL_PATHS`, `_FILE_FULL`, `_FILE_MODIFY`, `_UPDATE_STAGING_ACES`, `_UPDATE_MARKER_DACL`,
      `_console_session`, `_token_user_sid`, `_discard_untrusted_file`, `_create_update_marker`,
      `_file_has_content`, `_file_id`, `_pid_descends_from`, `_read_cortex_command`, `_cortex_command_refusal`).
      **But**: none of those four constants may be evaluated at import. `_UPDATE_STAGING_ACES` and
      `_CONSOLE_USER_ACL_PATHS` are bare `next(...)` lookups over the spec table with no default — a
      `StopIteration` at import off Windows — and `_FILE_FULL` / `_FILE_MODIFY` read `ntsecuritycon`, which does
      not import there at all. Turn all four into call-time lookups through `acl_hardening.specs()` and
      function-local imports (plan.md D4: no module-scope table lookup anywhere).
    - **hunk 3 (`_init_state`)**: take dev's `_init_state`. It is the declared single place for service state and
      the hosted path builds the instance with `object.__new__` and calls it. Port exactly one substantive line
      from 3.3.6's side: `api_base = shared_utils.get_configured_api_base()` replacing the raw
      `read_config(['firebase','api_base'])`.
    - **hunk 4 (`_auth_manager`)**: take dev's read-through `@property` over `firebase_client.auth_manager`.
      3.3.6's inline Firebase-init block already lives in dev's `_initialize_or_restart_firebase_client`; the only
      thing to port there is `get_configured_api_base()`.
    - **hunk 5 (the `update_owlette` dispatch)**: take dev's dispatch line, keeping dev's split
      (`_handle_update_owlette` → `_run_self_update` / `_self_update_worker`). This deliberately drops 3.3.6's
      hardened monolithic block, which **Task 4.1 re-implements inside dev's split**. Log that handover
      explicitly; 3.3.6's version stays readable at
      `git -C <wt> show origin/release/3.3.6:agent/src/owlette_service.py`.
    - **the 22 clean hunks**: read each one against dev's structure using research §2.3's table as the checklist
      — `_write_service_status`, `_read_stop_sentinel`, `_drain_cortex_ipc_commands`, `_refresh_user_token`,
      `launch_process_as_user`, `_check_update_status`, `main`, and the new methods `_repair_install_acls`,
      `_start_session_acl_repair`, `_sweep_stale_update_installers`, `_check_console_session`. Each must land in
      the method dev actually has, once, and read the state dev actually keeps. Anything that landed in a method
      dev moved, duplicated or split gets fixed here, and the check is named in the Log.
    - **the invariant (§3.5)**: five of 3.3.6's seven new attributes are declared in `main()` on the release
      branch. On `dev`, `_init_state` is the one place service state may be added — split the two and the hosted
      path dies with `AttributeError` in production. Move `_acl_console`, `_acl_repair_lock`,
      `_acl_startup_repaired`, `_update_image_handle` and `console_user_token` into `_init_state` (declaration
      only) and leave `main()` doing the work (`_acl_console = _console_session()`,
      `_acl_startup_repaired = True`). `_update_image_handle` is declared `None` here and assigned by Task 4.1.
      `_untrusted_sentinel_logged` is `getattr`-guarded and `_pending_anomaly_event` is set before every read —
      leave both, with a one-line comment saying why they are exempt.
  - Done when: no conflict marker survives in the file; `PYTHONPATH=agent/src <python> -c "import firebase_client, owlette_service, configure_site"`
    succeeds from the worktree root; `<python> -m pytest agent/tests/unit/test_owlette_service_hardening.py agent/tests/unit/test_no_platform_imports.py agent/tests/unit/test_shared_utils.py -q`
    green — including `TestConfiguredApiBase::test_no_other_module_reads_firebase_api_base_itself`, with no new
    exemption added to it; `git -C <wt> grep -n "read_config(\['firebase'" -- agent/src` is empty;
    `git -C <wt> grep -n "next(" -- agent/src/owlette_service.py` shows no module-scope lookup over the spec
    table; `_init_state` declares the five attributes; the Log lists each of the 22 clean hunks with "landed
    correctly" or what was fixed; staged, patch saved. This is the last conflicted file — confirm
    `git -C <wt> diff --diff-filter=U --name-only` is now **empty** and say so in the Log, because Task 4.1's
    first step depends on it.
  - Depends on: 1.2, 2.1, 2.2.

---

## Wave 4: the merge commit, then self-update

- [x] **Task 4.1: dev's split self-update takes on 3.3.6's hardened staging semantics** `[agent]`
  - Files: `agent/src/owlette_service.py` (via the junction), `agent/tests/unit/test_self_update_hardening.py`
  - Do: read research §3.3 in full — this is the merge's single largest correctness risk, and the only resolution
    that is a rewrite rather than a choice. `dev` split `update_owlette` out of `handle_firebase_command` into
    `_handle_update_owlette` → `_run_self_update` (Windows) / `_self_update_worker` (POSIX), with
    `_update_already_in_progress`, `_write_update_marker`, `_update_staging_dir`, `_start_windows_update` and
    `_check_update_status`. 3.3.6 hardened the monolithic inline block dev deleted. Port the hardening into dev's
    methods, one at a time. 3.3.6's source: `git -C <wt> show origin/release/3.3.6:agent/src/owlette_service.py`.
    0. **Create the merge commit first, before touching anything.** Confirm
       `git -C <wt> diff --diff-filter=U --name-only` is empty and `MERGE_HEAD` still resolves, then
       `git -C <wt> commit` — one merge commit, `chore: merge release/3.3.6 into dev`, with a body that names the
       five hand-written resolutions, says the self-update hardening is re-implemented in the commit that follows,
       notes that the commit also carries the `install_permissions_repaired` label, and states the `-DevGrant`
       consequence: a developer box that reinstalls the agent needs one elevated
       `scripts/bootstrap-windows.ps1 -DevGrant` run or the deploy hook fails quietly. Guarantees and mechanics
       only. If anything is still unmerged, stop and log it — do not commit a partial resolution.
    1. **Tests first.** Rewrite `test_self_update_hardening.py`'s cases against dev's split shapes (they were
       written against the monolith and cannot pass as they stand). Each case names the guarantee it holds:
       one staging directory, created fail-closed; the checksum taken from the held handle; the handle held
       across the hand-off; a marker only the service could have written; the stale-installer sweep. Run them and
       record that they fail.
    2. **Windows arm of `_run_self_update`**: the single staging directory is `update-staging` — the path the
       spec table and the installer harden — created through `acl_hardening.create_private_dir(staging_dir, <the
       staging ACEs>)`, fail-closed (if it cannot be created with that DACL, the update does not proceed). dev's
       `cache/update` + `os.chmod(0o700)` stays on the **POSIX arm only**, unchanged, and that arm calls no
       Windows helper.
    3. the download passes `strict_path=True`, and the verified handle comes from
       `installer_utils.open_verified(installer_path, expected_sha256)` — the checksum is taken from that open
       handle, the handle is stored on `self._update_image_handle` (declared in `_init_state` by Task 3.2), and it
       is **still open** when the installer is launched, so the file that was hashed is the file that runs. Do not
       re-open the path by name between verify and launch.
    4. `_write_update_marker` writes through `_create_update_marker` with the marker DACL instead of a plain
       `open(..., 'w')`; `_update_already_in_progress` and `_check_update_status` verify the marker's creator
       before acting on it, and refuse hard links and reparse points.
    5. the launcher result is checked with `_pid_descends_from` before it is trusted.
    6. `_sweep_stale_update_installers` (wired into `main` by Task 3.2) stays as it is — confirm it is reachable
       and is not duplicated here.
    Leave `_check_update_status`'s marker path and `_update_staging_dir` agreeing with each other: one staging
    directory, one marker location, read and written by the same helpers.
  - Done when: the merge commit exists with two parents (`git -C <wt> log -1 --pretty=%P` shows dev's tip and
    3.3.6's tip) and its body carries the `-DevGrant` note; the rewritten tests fail before the port and pass
    after — paste both summary lines in the Log;
    `<python> -m pytest agent/tests/ -q` from the worktree root is green (this is the first point in the plan
    where the whole suite must pass — beat the baselines in `## Log`); `create_private_dir` is called on the
    staging directory on the Windows arm and the failure path does not continue; `strict_path=True` is on the
    download; `open_verified`'s handle is assigned to `self._update_image_handle` and no `open(`/`os.stat(` by
    name happens between verification and launch; `_create_update_marker` is the only writer of the marker;
    the creator check is present in both `_update_already_in_progress` and `_check_update_status`;
    `_pid_descends_from` guards the launcher result; the POSIX arm still uses `cache/update` + `0o700`;
    `git -C <wt> grep -n "cache/update\|update-staging" -- agent/src` shows the Windows/POSIX split with no
    crossover; the self-update work is a second commit on top of the merge commit, not folded into it.
  - Depends on: 3.2 (same file), 3.1, 1.2.

---

## Wave 5: gates, review, VM, PR — **this wave runs in order**

- [x] **Task 5.1: the local gate run** `[agent]`
  - Files: none by default. Fix-forward is allowed for small, obvious breakage in files earlier waves resolved;
    anything structural in `acl_hardening.py`, `secure_storage.py`, `owlette_service.py` or
    `owlette_installer.iss` **stops and logs** instead.
  - Do: run every gate that runs on this box, from the worktree root, and record each result in the Log with its
    numbers.
    1. `<python> -m pytest agent/tests/` — full, no `-x`. Compare against both baselines in `## Log` (3.3.6's
       1432 passed / 5 skipped, and dev's own count from Task 0.1). Explain any new skip.
    2. `<python> -m pytest agent/tests/unit/test_no_platform_imports.py -q` and
       `PYTHONPATH=agent/src <python> -c "import firebase_client, owlette_service, configure_site"`.
    3. **Simulated POSIX collection.** Write a throwaway script in the session scratchpad (not in the repo) that
       installs a `sys.meta_path` finder raising `ImportError` for `win32*`, `pywintypes`, `pythoncom`,
       `win32com*`, `ntsecuritycon`, `winreg` and `wmi`, sets `OWLETTE_DATA_ROOT` to a writable temp tree, then
       imports `firebase_client`, `owlette_service` and `configure_site`. It must import cleanly — that is the
       local proxy for the `macos-15` / `ubuntu-24.04` legs, which run the same three imports plus the unit suite
       with the five `--ignore`s in `.github/workflows/agent-tests.yml`. Say plainly in the Log that the
       authoritative POSIX proof is CI on the PR, not this script.
    4. swoop and roost regressions that overlap the permission work:
       `<python> -m pytest agent/tests/unit/test_swoop_spawn.py agent/tests/unit/test_swoop_paths.py agent/tests/unit/test_swoop_doorbell.py agent/tests/integration/test_swoop_wiring.py agent/tests/unit/test_sync_assembler.py -q`,
       and `cargo test` with the working directory `agent/swoop`.
    5. Both hand-resolved locks still resolve: `cargo check` in `agent/host` and in `desktop/src-tauri`, and
       `cd desktop && npm test` (vitest).
    6. Web: `cd web && npx tsc --noEmit`, `npx jest`, then `/preflight` (lint, typecheck, unit, firestore rules,
       local e2e). `npm ci` in the worktree's `web/` first. The e2e prerequisites are already installed
       machine-wide (JDK 21, `firebase-tools@15`, chromium); the app runs on :3100.
    7. `node scripts/check-security-alerts.mjs` from the worktree root. Exit 1 is a blocker: fix it, or get the
       owner's written reason. Never ack on your own judgment, and never ack a `verify:*` key.
  - Done when: every step above has a recorded result in the Log; the agent suite and the web gates are green;
    any fix-forward is its own commit with the gate it unblocked named in the message.
  - Depends on: 4.1.

- [x] **Task 5.2: adversarial review of the four security surfaces** `[agent]`
  - Files: writes `dev/active/forward-merge-3.3.6/review.md` (**untracked** — same hold as
    `research/conflicts.md`, plan.md D12). No source changes in this task; findings become fix commits only after
    they are triaged in the Log.
  - Do: hand the review to a separate agent with no context from the resolution work (a fresh Opus subagent), and
    give it: the merge diff (`git -C <wt> diff origin/dev...HEAD -- agent/ web/`), the 3.3.6 changelog entry as
    the list of guarantees, and `.claude/CLAUDE.md`'s review-discipline section so severities stay calibrated.
    Scope: `agent/src/secure_storage.py`, `agent/src/acl_hardening.py`, the self-update path in
    `agent/src/owlette_service.py`, and `agent/owlette_installer.iss`. The brief is exactly two questions:
    **name anything 3.3.6 protected that the merged code no longer protects, and anything `dev` protected that is
    now weaker.** Every finding cites file and line and states actor, mechanism and outcome; a clean review is a
    valid result; settled decisions (plan.md D4–D8) are not refiled as discoveries.
  - Done when: `review.md` exists with each finding graded and dispositioned (fixed in commit X / accepted with a
    reason / not a finding, with why); every High or Critical is fixed or has the owner's written acceptance;
    the fixes are committed and Task 5.1's agent suite re-run green after them.
  - Depends on: 5.1.

- [x] **Task 5.3: the VM upgrade matrix against a build from the merge branch** `[agent+human]`
  - Files: `scripts/vm/18b-verify-upgrade.ps1` (the new assertion row)
  - Do: **this is verification of a merge, not a release** (plan.md D11). No installer from this build is
    uploaded, finalised or set as latest, and no `installer_metadata` id moves.
    - `[agent]`: add an assertion row to `18b-verify-upgrade.ps1` for the credential file's **pre-migration
      copy** — `.tokens.enc.v1`, asserted the same way the script already asserts `.tokens.enc` (no
      `BUILTIN\Users` ACE at all when the file is present). This is the case the matrix has never run, because
      that file does not exist on `release/3.3.6`. Keep the file ASCII-only and parse-check it with
      `[System.Management.Automation.Language.Parser]::ParseFile`.
    - `[agent]`: build the candidate from the merge branch in the worktree — `cd agent && build_installer_full.bat`,
      using the non-interactive invocation in `.claude/skills/build-system.md` (it has a `pause` that hangs an
      agent session otherwise). Copy the result aside as `Owlette-Installer-merge-candidate.exe` so it can never
      be mistaken for the released 3.3.6 artifact, and record its size and sha256 in the Log.
    - `[human]`: on the Hyper-V host, run the matrix with the candidate and at least
      `-FromVersion 3.3.4,3.3.6` — the upgrade path from the last pre-hardening fielded build and from the
      released 3.3.6 itself — plus the negative control that deliberately re-weakens one directory and must fail
      the assertion. The rows to read: no standard-account write bit on any code directory, service directory,
      the uninstaller or the root documents after install and after the service's start-up repair; the credential
      store **and its pre-migration copy** carrying the same restricted permissions; a self-update installing the
      bytes it verified; the watchdog enabled with only the legacy file present and disabled with the
      administrator-set registry value; and the console-user smoke checks (pairing phrase, Cortex round trip,
      `config.json` edit, `app_states.json` readable).
  - Done when: the script's new row is committed; the PASS/FAIL table for every row is pasted into the Log with
    the candidate's sha256; the negative control failed as required; no installer left the VM host or the build
    directory, and the Log says so explicitly.
  - Depends on: 5.2.

- [x] **Task 5.4: push, open the PR, watch CI, close #173** `[agent+human]`
  - Files: none in the repo — the PR body and the `#173` closing comment.
  - Do:
    1. `git -C <wt> push -u origin merge/3.3.6-into-dev`. Never push to `dev` or `main`.
    2. Open the PR `merge/3.3.6-into-dev` → `dev` **as a draft**, so CI's three-OS `agent tests` legs and the
       `playwright e2e` run report before anyone reviews. Body: link #173; the five hand-written resolutions
       (`acl_hardening` lazy, `shared_utils` three-way, `secure_storage`'s choke point plus the pre-migration
       copy, `owlette_service`'s hunks and the `_init_state` invariant, the self-update rewrite) and one line
       each on why it is not a straight pick; the gate results from 5.1–5.3 including the VM table; the
       `-DevGrant` consequence for developer machines and that its failure mode is quiet; and the statement that
       no installer from this merge was uploaded anywhere. Guarantees and mechanics only, no exploitation
       detail. End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
    3. Watch the triggered runs in the background: `gh run watch <id> --exit-status`. On a red leg,
       `gh run view <id> --log-failed`, then fix forward on this branch (allowed here — it is not `dev`) and push
       again. The POSIX legs are the ones most likely to be red first.
    4. Mark ready for review once every leg is green. `[human]`: the owner approves and merges (`dev`
       auto-deploys, so the merge is the owner's call, not the agent's).
    5. After it merges, close #173 with a comment pointing at this PR and saying why it could not be retargeted:
       the resolution is "merge these commits and then change five of the resolved files", and a PR whose diff is
       a conflicted merge is not reviewable. Leave `release/3.3.6` and its tag alone — prod's installer catalog
       points at that build.
  - Done when: the PR is merged into `dev`; every CI leg was green on the merged head; #173 is closed with the
    pointer comment; the worktree and junction are removed
    (`git -C <main> worktree remove ...`, `cmd /c rmdir "...Owlette-merge-agentsrc"`) and the branch is deleted
    on the remote; the two follow-ups in plan.md's handover section are restated in the Log so nothing is lost.
  - Depends on: 5.3.

---

## Log

_Append an entry per task: what was done, the numbers, and anything the research did not predict. Newest last._

- 2026-09-22 — plan and tasks written. Baselines to beat, to be filled by Task 0.1: `release/3.3.6` reported
  1432 passed / 5 skipped; `dev`'s own count is unmeasured. Open drift checks for Task 0.1: `dev` was at
  `bbdbbebf` and `VERSION` `3.3.5` when the research was done; the conflict inventory is 10 files / 25 hunks.
- 2026-09-22 — Task 0.1 done. Worktree `Owlette-merge` on `merge/3.3.6-into-dev` from `origin/dev` @ `723fc344`
  (one commit past the research's `bbdbbebf`: `test: every internal docs link and anchor resolves`, touches only
  `web/e2e/specs/public/docs-links.spec.ts` — no merge anchor moved). Junction resolves. Plan commit `c1bc8d89`
  (plan.md + tasks.md; research/conflicts.md untracked, two on-disk copies). `dev` baseline: **1821 passed /
  319 skipped / 0 failed** (64 s). Merge of `6201fd1f` in progress, MERGE_HEAD verified. Inventory = research
  exactly: 10 files / 25 hunks — shared_utils 6, owlette_service 5, secure_storage 5, test_shared_utils 3,
  installer.iss 1, auth_manager 1, installer_utils 1, owlette_runner 1, host Cargo.lock 1, desktop Cargo.lock 1.
  No drift.
- 2026-09-22 — Task 1.1 done. Both `Cargo.lock`s → 3.3.6 (= `VERSION`, both `Cargo.toml`s). `test_shared_utils.py`:
  both import lines and every class from both sides kept (the raw-api-base scan guard stays red until 2.2/3.2).
  `installer_utils.py`: dev's artifact-family block then 3.3.6's `open_verified`. `owlette_runner.py`: dev's side
  (no `MockService`; the three api-base edits go to `_init_state` in 3.2). `.iss`: `HardenInstallTree()` is Step 0c,
  dev's swoop `icacls` pass is now Step 0d with a comment on why the sets are disjoint; the credentials stanza
  loops over `.tokens.enc` and `.tokens.enc.v1`. Not predicted by the research: the `.iss` has always carried
  UTF-8 arrows in comments on every branch (64–71 lines), so "ASCII-only" was applied to the additions only.
  `py_compile` clean; no markers; six files staged; patch `task-1.1.patch`.
- 2026-09-22 — Task 1.2 done. `acl_hardening.py`: no Windows import at module scope (each lives in the function
  that uses it; `console_user_sid`/`dev_mode_enabled`/`_build_specs` gate on `os.name`); `specs()` is an
  `lru_cache(maxsize=1)` accessor over the unchanged `_build_specs()` builder (kept uncached because
  `TestInstalledTreeGate` builds a table under patched roots); the three well-known SIDs resolve lazily through
  a module `__getattr__` (PEP 562) backed by an `lru_cache`d `_sid()`, so every existing `acl_hardening.SID_*`
  read keeps working unchanged; the access masks are the ntsecuritycon literals (`0x1F01FF`, `0x1301BF`,
  `0x1200A9`, inherit `0x03`) that the tests already assert; D7 comment sits beside the table.
  `connection_manager._read_watchdog_disabled_value` imports `winreg` in its body. Tests: 14 `patch.object(ah,
  'SPECS', …)` → `patch.object(ah, 'specs', return_value=…)`, 3 reads → `ah.specs()`, and the two
  `TestConsoleUserSid` cases patch `sys.modules` instead of module attributes. Checks: `specs()` → 18 rows;
  targeted guard call names neither file (the three rule-3 lines it prints are an artefact of passing it two
  files); `test_acl_hardening.py` **71 passed** — run with `--noconftest` + `PYTHONPATH=agent/src`, because the
  autouse `_invalidate_shared_utils_caches` fixture imports `shared_utils`, which still carries markers (rerun
  under conftest belongs to 5.1). Handover — remaining `acl_hardening.SPECS` readers: `shared_utils.py:1408` and
  `test_shared_utils_hardening.py:541` (2.1), `secure_storage.py:158,169` (3.1), `owlette_service.py:773,786`
  and `test_owlette_service_hardening.py:91-92` (3.2). Staged; patch `task-1.2.patch`.
- 2026-09-22 — Task 1.3 done. `install_permissions_repaired` → "install permissions repaired" in the `agent`
  group; the video spec's range comment was already stale on dev (`133-211` vs an array ending at 226) and now
  reads `137-227`. eslint: 0 errors (two pre-existing `<img>` warnings at 427/1218, both present on dev); `tsc
  --noEmit` clean after `npm ci` in the worktree's `web/`. Staged; patch `task-1.3.patch`.
- 2026-09-22 — Task 2.2 done. `auth_manager.__init__`: 3.3.6's `is_owlette_api_base` gate kept, dev's
  `get_machine_id()` kept, docstring says both. `owlette_runner.py`: the raw read is at line 161 on the merged
  tree (not 339 — `MockService` is gone) and now calls `get_configured_api_base()`. Handover to 3.2 — the one
  raw read left: `owlette_service.py:1011: self._api_base = shared_utils.read_config(['firebase', 'api_base'])
  or shared_utils.get_api_base_url()`. `py_compile` clean. `test_auth_manager.py` cannot run yet: it skips
  itself with "auth_manager import failed: invalid syntax (secure_storage.py, line 25)" — deferred to 5.1.
  Staged; patch `task-2.2.patch`.
- 2026-09-22 — Task 2.3 done. `origin/dev:VERSION` is 3.3.5, so 3.3.6 wins everywhere (D8 rule 1). Seen:
  `VERSION`/`agent/VERSION` 3.3.6; `web/package.json`, `tauri.conf.json`, both `Cargo.toml`s 3.3.6; both
  changelogs `[Unreleased]` (pin-a-metric, chart-scale) → `[3.3.6] - 2026-09-21` → `[3.3.5] - 2026-09-15`; the
  3.3.6 entry byte-identical in both files, no internal links (only the two literal API URLs in prose);
  `.claude/CLAUDE.md` `**Version**: 3.3.6` + the `-DevGrant` paragraph; `version-management.md` 3.3.6 ×3.
  **Finding the research missed:** `node scripts/sync-versions.js 3.3.6` was *not* a no-op — `agent/swoop/Cargo.toml`
  sat at 3.3.5 (the swoop crate exists only on dev, so 3.3.6's bump never touched it), and
  `scripts/sync-versions.js:28` records that the streamer refuses to run when its version differs from the
  agent's — the naive merge would have stranded swoop on every machine. Kept that bump (D8 direction) and made the
  matching one-line change in `agent/swoop/Cargo.lock` (CI runs `cargo test --locked`); `cargo metadata --locked`
  resolves at 3.3.6. Discarded the script's other output: `Last Updated` date stamps in two docs and CRLF-only
  rewrites of five version files. Staged; patch `task-2.3.patch`.
- 2026-09-22 — Task 2.1 done. Six hunks resolved per research §2.2 (both imports; merged docstring; dev's four
  `ipc/*` rows kept, the three `cortex_*` rows and dev's duplicate `logs/swoop` row dropped; `_IS_WINDOWS` /
  else arms with dev's `grant_data_group` between them; both helper blocks verbatim; the three-way
  `write_json_to_file` branch). §3.6 guards: `_create_cortex_ipc_dirs` returns off Windows and reads
  `acl_hardening.specs()`; the token-user warning is gated on `_IS_WINDOWS`. **Two things the research did not
  predict, decided by the coordinator (both preserve dev's behaviour, neither weakens a 3.3.6 guarantee):**
  (a) dev's tri-platform tests (`test_data_root.py:51`, `test_osadapter_contract.py:1303`) expect
  `ensure_data_directories()` to create `ipc/cortex_*` on POSIX with mode 0o770, while 3.3.6 makes
  `_create_cortex_ipc_dirs` the trio's only creator — resolved as: off Windows the trio stays in the makedirs
  list exactly as on dev; on Windows only a SYSTEM process creates it. `test_data_root.py:51` now asserts the
  trio exists *iff* not Windows (a user process must not create it there). (b) `acl_hardening._DATA_ROOT`
  ignored dev's `OWLETTE_DATA_ROOT` override (`osadapter.DATA_ROOT_ENV`), so its table and shared_utils'
  `CORTEX_IPC_*_DIR` pointed at different trees whenever the root is relocated (the tests' sandbox, and any
  operator using the override on Windows: `repair_all` would ACL `%PROGRAMDATA%\Owlette` while the agent lived
  elsewhere). `acl_hardening` now reads the override first (`import osadapter` — its package `__init__` is
  stdlib-only, no cycle); `test_shared_utils_hardening::test_directory_creation_logs_reach_the_log_file`
  relocates through the override instead of `PROGRAMDATA`. Handover: three more 3.3.6 tests still set
  `PROGRAMDATA` — `test_owlette_service_hardening.py:485,861` (3.2) and `test_self_update_hardening.py:156`
  (4.1) — expect the same fix. Also updated `_base_dirs()` in the hardening test for dev's rows and its
  `acl_hardening.SPECS` read. Results: guard clean for the three lazy modules; `test_shared_utils_hardening`,
  `test_shared_utils`, `test_data_root`, `test_osadapter_contract`, `test_acl_hardening` → **271 passed, 1
  failed** — the one is `TestConfiguredApiBase::test_no_other_module_reads_firebase_api_base_itself`, whose
  survivor is `owlette_service.py:1011` (3.2). Staged; patches `task-2.1.patch`, `task-1.2.patch` refreshed.
- 2026-09-22 — Task 3.1 done. Red first: `TestPreMigrationCopy::test_the_copy_and_the_store_are_written_alike`
  failed with `AssertionError: the copy and the store, both through the writer — assert 0 == 2 (recorder.calls
  == [])`, and `::test_the_repair_table_carries_the_copy_with_the_stores_aces` with `KeyError: '.tokens.enc.v1'`
  (phase A: hunks resolved, dev's writer untouched — 17 failed / 27 passed, the other 15 being 3.3.6's
  protected-path tests, which is the naive merge's loss made visible). Then: `_write_token_file(path, blob)`
  stays the single writer and routes `os.name == 'nt'` to a module-level `_replace_token_file(path, payload)`
  (random `<path>.<hex8>.tmp`, DACL before first byte via `shared_utils._write_new_file_with_dacl(...,
  dacl_first=True)`, attributes set before `os.replace`); POSIX keeps dev's `os.open`/`O_NOFOLLOW`/0600 body.
  dev's Windows-only bits in that body (`_set_windows_attributes`, the three `_FILE_ATTRIBUTE_*`) are gone —
  dead once the Windows path is the replace. `_load_data` = plain-file check then dev's body; `_save_data`
  keeps `_writer_fernet()`; `encrypt_value`/`decrypt_value` kept; `clear_tokens` had already auto-merged both
  bodies. `_token_file_spec` reads `specs()`. `.tokens.enc.v1` row added beside `.tokens.enc` with the same
  ACEs (table now 19 rows). Tests: `test_secure_storage.py` fixtures moved off the removed `_get_machine_guid`
  onto the `osadapter._adapter` binding (dev's pattern), `SPECS` patch → `specs`; `test_machine_identity.py`:
  `test_a_rewrite_that_fails_mid_write_says_what_is_on_disk` is now `skipif` on Windows (it asserts the POSIX
  truncate-then-write shape; on Windows a failed rewrite leaves the store whole, covered by
  `test_a_failed_re_encrypt_leaves_the_original_store_intact`); the two console-user row lists
  (`test_acl_hardening.py`, `test_owlette_service_hardening.py:144`) include `.tokens.enc.v1`. Green:
  `test_secure_storage` + `test_machine_identity` + `test_acl_hardening` + `test_shared_utils_hardening` →
  **156 passed, 2 skipped**. `_write_token_file(` = one def + three callers; `import secure_storage` ok; no
  markers. Staged; patches `task-3.1.patch`, `task-1.2.patch` refreshed.
- 2026-09-22 — Task 3.2 done. Hunk 1: dev's side (no module-scope pywin32). Hunk 2: both blocks; the four
  import-time constants are gone — `_FILE_FULL`/`_FILE_MODIFY`/`_FILE_READ` are the ntsecuritycon literals,
  `_console_user_acl_paths()` and `_update_marker_dacl()` read the table at call time, `_UPDATE_STAGING_ACES`
  is **not** carried (its only consumer was the dropped monolithic block; 4.1 defines its call-time form),
  `_console_session`/`_token_user_sid` import `win32ts`/`win32security` in-body. Hunk 3: dev's `_init_state`
  with `self._api_base = shared_utils.get_configured_api_base()`. Hunk 4: dev's property. Hunk 5: dev's
  dispatch — **3.3.6's hardened monolithic `update_owlette` block is dropped here and handed to 4.1**
  (readable at `git show origin/release/3.3.6:agent/src/owlette_service.py`, the `update_owlette` branch of
  `handle_firebase_command`). The 22 clean hunks, checked against dev's structure, all landed correctly:
  `_write_service_status_early` (`write_json_to_file`), `_write_service_status` (`_file_id` before/after
  guard), `_read_stop_sentinel` (trusted-owner check + `_discard_untrusted_file`),
  `_drain_cortex_ipc_commands` (`console_user_sid` + `_read_cortex_command` + `_cortex_command_refusal`),
  `_refresh_user_token` (session-repair trigger), new `_start_session_acl_repair` / `_check_console_session`,
  `launch_process_as_user` (pid-file ACL, exclusive create, `win32file` args handle — **fixed**: added the
  function-local `import win32file` beside dev's `win32con`/`win32process`), the local-config-watcher tick
  (`_check_console_session()`), `_check_update_status` (trusted-owner check on the marker), new
  `_repair_install_acls` (now reads `_console_user_acl_paths()`) / `_sweep_stale_update_installers`, and
  `main()` (repair, `harden_existing_json`, sweep). §3.5 invariant: `_init_state` now declares
  `_acl_repair_lock`, `_acl_console`, `_acl_startup_repaired`, `_update_image_handle`, `console_user_token`;
  `main()` keeps doing the work and no longer re-creates the lock (a second Lock object would orphan a holder);
  `_untrusted_sentinel_logged` and `_pending_anomaly_event` stay exempt with the comment. Tests
  (`test_owlette_service_hardening.py`): pywin32 patches target the real modules (`win32ts`, `win32profile`,
  `win32process`) since the service imports them in-body; `_CONSOLE_USER_ACL_PATHS`/`SPECS` reads →
  accessors; the two `PROGRAMDATA` fixtures relocate through `osadapter.DATA_ROOT_ENV`; the main() test holds
  the lock across the call instead of expecting main() to create it; the launch-handoff fake service gained
  dev's `_record_launch` tail. Checks: `python -c "import firebase_client, owlette_service, configure_site"`
  ok; `git grep "read_config(\['firebase', 'api_base'\])"` empty; no module-scope `next(`; `test_no_platform_imports`
  and `test_shared_utils` (incl. `TestConfiguredApiBase`) green with no exemption added;
  `test_owlette_service_hardening` **162 passed, 3 failed** — the three are `TestSelfUpdateGuard` (the
  trusted-owner check in `_update_already_in_progress`), which is 4.1's self-update rewrite. Staged; patch
  `task-3.2.patch`. **`git diff --diff-filter=U --name-only` is empty — the merge has no unresolved path.**
- 2026-09-22 — Task 4.1 done, as four commits on `merge/3.3.6-into-dev`: **`b7b17d7b` the merge commit**
  (parents `c1bc8d89` = dev's tip + plan commit, `6201fd1f` = 3.3.6's tip; body names the five resolutions, the
  follow-up self-update commit, the label, and the `-DevGrant` consequence), **`6d4ce917`** (a POSIX regression
  the research did not predict: `acl_hardening.is_trusted_owner` answers False wherever pywin32 is absent, and
  3.2's clean hunks called it unconditionally in `_read_cortex_command` and `_check_update_status` — off Windows
  every queued cortex command and every update marker would have been refused; both gated on `os.name == 'nt'`,
  test `test_the_owner_checks_are_windows_only` red first — pytest could not even format the failure with
  `os.name` patched, the assertion fired inside `_read_cortex_command` — then `2 passed`; `_read_stop_sentinel`
  needs no gate, its watcher is Windows-only), **`69fe4a02` the self-update port** — red first: the rewritten
  `test_self_update_hardening.py` gave `10 failed, 4 passed`; after: `82 passed` together with the hardening
  file. Windows arm of `_run_self_update`: `_update_staging_dir('windows')` = `update-staging` via
  `create_private_dir(staging, _update_staging_aces())` (call-time table lookup, raises if the row is absent);
  earlier hold released before the download; `strict_path=(os_family == 'windows')`; checksum through
  `installer_utils.open_verified`, handle on `self._update_image_handle`, nothing reopens the path before
  `_start_windows_update` runs it by the same path; `_write_update_marker` → `_create_update_marker` on Windows
  (POSIX keeps the plain write), and it now runs **before** the download too (dev's design — the guard
  brackets the whole operation), so a planted file at the marker path fails the update before anything is
  downloaded rather than after; `_update_already_in_progress` trusts only a marker this service wrote
  (Windows); POSIX arm untouched (`cache/update` + 0o700, calls no Windows helper — tested).
  `_pid_descends_from` (task item 5) already guards the launcher result in `launch_process_as_user` (3.2's clean
  hunk); the self-update path has no launcher result. **`f73a3d65` a second clean-but-wrong merge found by the full
  suite:** both sides defined `_check_console_session` (dev: swoop's session-change notifier on the 5-second
  loop; 3.3.6: the ACL session repair on the local-config-watcher tick) — Python kept the later definition, so
  swoop would never have heard of a session change. 3.3.6's is `_check_console_session_acls` now, called from the
  watcher as before. Six tests adjusted for merged shapes (`test_service_shutdown` api-base stub arity,
  `test_update_artifact_guard` stubs the Windows owner check on its POSIX-lane double, `test_recover_identity`
  imports `owlette_service`, `test_configure_site_headless` patches dev's `_service_control`,
  `test_config_sync_client`/hardening tests use the new name). **Full suite: `2074 passed, 319 skipped, 0
  failed`** (dev baseline 1821/319/0; release/3.3.6 1432/5). Patches `commit-a.patch`, `task-4.1.patch`,
  `commit-c.patch`.
- 2026-09-22 — Task 5.1 done (all from the worktree root, on `698e0d9d`). (1) full agent suite: **2076 passed,
  319 skipped, 0 failed** (dev baseline 1821/319/0; release/3.3.6 1432/5); the one new skip is
  `test_machine_identity.py:253` (POSIX truncate-then-write shape, explained in 3.1). (2) `test_no_platform_imports`
  4 passed; `import firebase_client, owlette_service, configure_site` ok. (3) simulated POSIX collection
  (`scratchpad/posix_collect.py`: a meta_path finder refusing `win32*`, `pywintypes`, `pythoncom`, `ntsecuritycon`,
  `winreg`, `wmi`, data root on a temp tree): all three modules import cleanly — a local proxy only; **the
  authoritative POSIX proof is CI's macos-15 / ubuntu-24.04 legs on the PR.** (4) swoop/roost pytest set: 137
  passed, 2 skipped; `cargo test` in `agent/swoop`: every suite `ok`. (5) `cargo check --locked` in `agent/host`
  and `desktop/src-tauri`: both resolve; `cd desktop && npm test`: 32 files, 489 passed. (6) web: `npm run lint` 0
  errors (9 pre-existing warnings, all present on dev); `tsc --noEmit` clean; jest 302 suites, 6021 passed, 1
  skipped; local Playwright e2e **400 passed** (13 min); `test:rules` running at the time of writing (result
  appended below). (7) `node scripts/check-security-alerts.mjs`: `RESULT: CLEAR` (1 previously acknowledged
  blocker, 27 warnings; code-scanning acks report UNKNOWN because SAST has not run on this ref — re-check on dev).
- 2026-09-22 — Task 5.2 done. Fresh Opus reviewer, scope as specified; report at
  `dev/active/forward-merge-3.3.6/review.md` (untracked, two copies). Verdict: **Q1 — nothing 3.3.6 protected is
  lost; Q2 — one Low; plus one High carried from shipped 3.3.6, not caused by the merge.** F1 (Low): the
  migration's writer contract is OSError and the Windows writer could raise other types → fixed `2ecf5458`
  (test red `assert None == 'dummy-refresh-token'`, then green). C1 (High, pre-existing in the fielded 3.3.6; the mechanism stays in the untracked review.md): the
  guarantee that the permission repair and the installer act only on plain files and directories at table paths
  is now explicit → fixed `4831ff3a` (`repair_all` skips a link or reparse point and logs it; the generated
  script gains a `Plain` guard before every `icacls` call; test with a real junction red, then green; generated
  PowerShell reconstructed and parse-checked). Suite after both: 2076/319/0. **Owner decision owed:** a 3.3.7 patch for the fielded 3.3.6
  and whether the advisory (release Task 4.3) names it. The reviewer's "checked and found sound" list is in the
  report with the line each guarantee was verified at.
- 2026-09-22 — Task 5.1 addendum: `npm run test:rules` → Test Suites: 5 passed, 5 total Tests:       139 passed, 139 total  exit 0. Every 5.1 gate is green.
- 2026-09-22 — Task 5.3 done, run from this box (it is the Hyper-V host; `owlette-e2e`, PowerShell Direct).
  Candidate built from the worktree at `9b928cdd`'s tree minus the harness commits (code identical): `agent/build/installer_output/Owlette-Installer-v3.3.6.exe`,
  copied aside as `Owlette-Installer-merge-candidate.exe` — **45,923,378 bytes, sha256
  `36977243ecb903a2b26a4992fca5188ed5b963701ad668cfb04e2d158eb1083a`**. **No installer left the build directory or
  the VM host; nothing was uploaded, finalised or set as latest; no `installer_metadata` id moved.** Harness changes
  (committed): the `.tokens.enc.v1` row (`698e0d9d`) and the cortex smoke turning `cortex.enabled` on first
  (`9b928cdd`) — the first pass failed that smoke on both legs because dev's service drains the cortex queue only
  while the hoot switch is on (dev's deliberate kill switch, absent on 3.3.6; not a merge regression). Second pass,
  `-FromVersion 3.3.4,3.3.6`: **PASS=24 FAIL=0 SKIP=8 — UPGRADE VERIFY OK**. Per leg (3.3.4 and 3.3.6 identical):
  clean image PASS · from-install PASS (service Running) · candidate push PASS (size + sha verified in guest) ·
  candidate install PASS · acl: paths present PASS · acl: no Users write PASS · acl: .tokens.enc SKIP (unpaired) ·
  acl: .tokens.enc.v1 SKIP (no pre-migration copy — needs a machine paired before the migration, i.e. a
  `-AuthorizePairing` run with the owner) · service running PASS · pairing phrase PASS · pairing authorize SKIP ·
  cortex round trip PASS (switch turned on first) · screenshot SKIP (unpaired) · config.json edit PASS · app_states
  read PASS · self-update dry run PASS (staged + hashed + read-shared in update-staging). Negative control
  (3.3.6 leg, `agent\` re-granted Users Modify): **FAIL=1 — `acl: no Users write — agent [M]`**, everything else
  as above, harness exit 1 as required. Full output: scratchpad `matrix2.log`. Not proven here: the credential
  files' DACLs (unpaired) and the junction guard on a real machine (no probe in the harness yet).
- 2026-09-22 — Task 5.4 in progress. `merge/3.3.6-into-dev` pushed (`f4d681ae`); **draft PR #174 → dev**
  opened with the body from the plan (five resolutions, gate results, VM table, `-DevGrant` note, no-upload
  statement). CI runs being watched: agent tests (windows / macos-15 / ubuntu-24.04 + roost minio), playwright
  e2e, rust build, CodeQL, actions security; the quick gates (dependency review, token-log scan, firebase-admin
  guard, live-vulnerability check) already green. Marking ready for review and the merge itself are the owner's;
  #173 is closed after the merge; worktree/junction removal asked for, not done unasked.
- 2026-09-22 — Task 5.4, CI iterations on #174. Push 1 (`f4d681ae`): macos-15 and ubuntu-24.04 legs failed at
  collection — the five 3.3.6 test modules import pywin32 at module scope (the simulated-POSIX proxy in 5.1 had
  only covered `agent/src`, not the tests). Fix `310adc1b`: each `importorskip`s pywin32 right after `import
  pytest`, so the leg reports a skip; a second proxy (`scratchpad/posix_collect_tests.py`, collect-only under a
  finder that raises ModuleNotFoundError for pywin32) now collects 1972 items / 0 errors / 7 module skips. Push
  2: both legs then ran the suite — ubuntu 1188 passed / 1 failed (3.3.6's `TestWriteJsonToFileLocks` imports
  `win32file` in-body → `@pytest.mark.windows` on the class, `4588676b`); macos 1184 passed / 1 failed on dev's
  own `TestIdentityPathNormalisation::test_a_recorded_row_still_matches_after_a_restart` (`identity_matches`
  False with identical row values; the merge touched none of the identity helpers; dev's last three macOS legs
  passed it) — watching push 3 to tell a runner flake from a regression before digging.
- 2026-09-22 — Push 3 (`4588676b`): macos passed the identity test (push 2's failure was a runner flake); both
  POSIX legs then failed one dev test, `test_the_artifact_is_staged_where_only_root_can_write`, which called
  `_update_staging_dir()` without the os family 4.1 added → `7099d269` passes `'linux'`. Push 4 (`7099d269`):
  **agent tests green on windows-latest, macos-15, ubuntu-24.04 and the roost/minio job — the authoritative
  POSIX proof.** Remaining watchers: playwright e2e, rust build, CodeQL, actions security, security preflight.
- 2026-09-22 — Push 4 (`7099d269`): **every check on #174 green** — agent tests (3 OS + minio), playwright e2e
  (emulator suite, lint/types/unit, rules), rust build, CodeQL (js + python), zizmor, security preflight,
  dependency review, token-log scan, firebase-admin guard, line-count. PR marked **ready for review**. Left for
  the owner: approve + merge (dev auto-deploys); then close #173 with the pointer comment; remove the worktree
  and junction; delete the remote branch. Follow-ups restated: a `-AuthorizePairing` matrix run to prove the two
  credential-file rows; the 3.3.7 question for the fielded 3.3.6 (review C1) and its advisory wording; a
  creator-identity check for the POSIX cortex/IPC channel (plan D7's obligation, now explicit in
  `_read_cortex_command`'s docstring); dev's cortex kill switch means an unpaired dev-built agent never drains
  the cortex queue — expected, documented in the harness.
- 2026-09-22 — Task 5.4 done. Owner said "Go": **#174 merged into `dev` as `23c42e1e`** (merge commit, 21:25 UTC).
  GitHub marked #173 merged by itself (its commits arrived through #174); a pointer comment is on it. Remote
  branch `merge/3.3.6-into-dev` deleted. dev's push-triggered CI (agent tests, e2e, rust, CodeQL, security) and
  the Railway deploy of dev.owlette.app being watched. Worktree `Owlette-merge` + junction and the release
  worktree `Owlette-3.3.6` are still on disk — removal is a recursive delete and waits for the owner's ok on the
  exact command. Step 2 (promotion) starts from `dev` @ `23c42e1e`.
