# machine-scope — Tasks
**Progress**: 57/62 complete

Read before any task. /execute passes an agent only a task's Files, Do and Done when, so every Do starts by sending you back here.
- `plan.md` and `context.md` in `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/`.
- The owner's rulings (context.md, "Owner rulings"):
  - decisions 1, 2, 3, 10, 13 and 14 are this release;
  - decisions 6, 7, 9 and 11 interact with it.
- `GLOSSARY.md`. After task 4.7 it defines machine scope, whole site and scoped member. Release 2 defines swoop mode.
- From wave 4 on, the `release names` block in this file's Log (task 3.1). Where a task says "release 2's X", the block gives X's shipped name and file. If a shipped name differs from the one written here, follow the block and say so in your Log line.
- Release 2's plan, `dev/active/admin-sites/`, and especially its context.md "Seams for release 3".
- The research maps behind the anchors, in the session scratchpad's `research/` folder: rules.md, routes-machines.md, routes-site.md, swoop.md, swoop-left-site.md, swoop-pills.md, client-reads.md, tests.md and docs-openapi.md.

Line numbers are origin/dev ab4689bb (4.1.25). Releases 1 and 2 land before wave 3 and move them, so find each spot by the quoted code.

House rules for every task:
- **Where you work.** Use the worktree `C:/Users/admin/Documents/Git-restored/Owlette-machine-scope-wt`, on branch `feat/machine-scope` (task 0.1 makes it), never the main checkout.
- **Staging and commits.**
  - Stage only your task's files, by path: `git add <paths>`, never `-A` or `.`. A wave's agents share one tree.
  - Make one commit per task, with a conventional one-line message (`feat: …`, `test: …`, `docs: …`) and the attribution trailer your session's instructions give.
  - Never push. Task 12.1 ships.
- **The Log.** Never edit `tasks.md`. End your reply with a `Log:` line saying what you did and what you could not run, and the orchestrator records it.
- **Your files only.** A file your task does not list is out of bounds. If the work needs one, stop and say so.
- **Copy.** Lowercase user-facing copy. Comments are lowercase and explain only the non-obvious why.
- **Never:**
  - add a package;
  - touch `.claude/hooks/` or `.claude/settings.json`;
  - log a token;
  - change `firestore.rules` outside task 2.2 (owner decision 2).
- **Checks before you finish.**
  - `cd web && npx eslint <each web file you edit>` and `npx tsc --noEmit` are clean.
  - Run the jest files you touched and the folder they live in.
  - tsc skips tests and specs (the `web/tsconfig.json` exclude), so jest and `playwright test --list` are the checks for those.
- **Terms** (GLOSSARY):
  - Say machine scope, whole site, scoped member (code and docs), "limited to some machines" (UI copy) and swoop mode.
  - Never allowlist, full member, partial member or unscoped member.
  - Say pairing (not enrollment), roost (not distribution), and hoot settings (`settings/cortex`, not "cortex").
- **The rig.** Only tasks 1.1, 2.2, 3.1, 10.1, 11.1 and 12.1 run an emulator (`npm run test:rules`, `npm run e2e`, a single-spec run, or the owner's headed preview). Each is alone in its wave, because two runs at once collide on ports :9099, :8080, :9199 and :3100.

## Wave 0: worktree, branch, preconditions

- [x] **Task 0.1: Worktree, branch, tracked plan copy, release states and the owner's answers**
  - Files: `dev/active/machine-scope/plan.md`, `tasks.md` and `context.md`, copied into the worktree and force-added. No product files.
  - Do:
    1. From the main checkout (`C:/Users/admin/Documents/Git-restored/Owlette`), run `git fetch origin`. Record whether two releases have merged into origin/dev, using `git show origin/dev:docs/changelog.md | grep -n "^## \["` and `git log origin/dev --oneline -40`:
       - release 1 (4.1.26);
       - release 2 (4.1.27: the admin sites page with the swoop mode).

       Waves 1–2 go ahead either way. Wave 3 waits until release 2 has merged.
    2. Run `git worktree add ../Owlette-machine-scope-wt -b feat/machine-scope origin/dev`. A branch cut from origin/dev tracks dev, so its first push needs an explicit refspec (`git push -u origin feat/machine-scope:feat/machine-scope`). Do not push now.
    3. In the worktree, run `cd web && npm ci`, then `cd ../functions && npm ci`. A worktree needs its own install: a junction to another checkout's node_modules breaks Turbopack.
    4. Copy the three plan files from the main checkout's `dev/active/machine-scope/` into the worktree's. Force-add the three paths with `git add -f`, and commit `docs: machine-scope plan`. dev/active is gitignored, and an untracked plan was lost once. /execute keeps reading the main checkout's copy; task 11.1 refreshes the tracked one.
    5. Put the owner's answers to context.md's open questions 2, 3 and 4 in your Log line, as the orchestrator relays them.
       - Wave 2 waits for all three, because task 2.2's rules depend on question 3. If one is missing, name it and stop after step 4.
       - The tasks are written for the defaults: 2 = no, 3 = hidden, 4 = later. context.md, "If the owner answers otherwise", lists what a different answer changes.
  - Done when:
    - the worktree exists on `feat/machine-scope`, cut from origin/dev;
    - `web` and `functions` are installed in it;
    - the plan files are committed in it;
    - the Log line records release 1's and release 2's state and the three answers, or names the one that is missing.

## Wave 1: whole-site positive controls on today's rules

- [x] **Task 1.1: Whole-site read controls in the rules suite, on 2.11.0**
  - Files: `web/__tests__/rules/siteReadControls.test.ts` (new)
  - Depends on: 0.1
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`. Then pin everything a whole-site member, a whole-site admin and a superadmin can read today, so that task 2.2 cannot quietly break any of it. Today the rules suite pins reads on only five paths (research tests.md §4).
    - **Lifecycle**, as in `web/__tests__/rules/membership.test.ts`:
      - `/** @jest-environment node */`;
      - `initRulesHarness()` in beforeAll;
      - `clearFirestoreData()` plus seeding through `seedAsAdmin` in beforeEach;
      - `cleanupRulesHarness()` in afterAll (`web/__tests__/rules/harness.ts:58-105`).
    - **Principals:**
      - `asUser('member-1','member',['site-a'])`;
      - `asUser('admin-1','admin',['site-a'])`;
      - `asUser('super-1','superadmin',[])`.
    - **Seed on site-a:**
      - Machines `m1` and `m2`, each with:
        - `config/site-a/machines/{m}`;
        - `commands/pending`, `screenshots/s1`, `installed_software/x`, `hardware/profile`, `cortex/state`;
        - `logs/l1` (the per-machine logs subcollection) and `metrics_history/b1`.
      - Site logs: `sites/site-a/logs/la {machineId:'m1', action:'process_started', level:'info', timestamp}` and `logs/lb {machineId:null, …}`.
      - `deployments/d1`, `installer_templates/t1`, `project_templates/p1`.
      - `roosts/r1`, with its `target_state/m1` and `versions/v1`.
      - `talons/k1`, `talon_runs/k2`, `cortex-events/e1`, `audit_log/a1` and `webhooks/w1`.
      - `settings/{swoop,display,cortex,alerts}`.
      - `config/site-a/{schedule_presets,reboot_presets,project_distribution_presets,talon_presets}/x`.
      - `chats/c1 {source:'autonomous', siteId:'site-a', targetMachineId:'m1', updatedAt}`, with `messages/x` and `stream/current`.
    - **Cases**, table-driven with `it.each` (pattern: `web/__tests__/rules/planCollections.test.ts:42-102`), each named by its path:
      - Every principal gets `assertSucceeds(getDoc(...))` on every document above except `audit_log/a1` and `webhooks/w1`.
      - Every principal can list:
        - `collection(db,'sites','site-a','machines')`;
        - `collection(db,'config','site-a','machines')`;
        - `query(collection(db,'sites','site-a','logs'), orderBy('timestamp','desc'))`;
        - `query(collection(db,'chats'), where('source','==','autonomous'), where('siteId','==','site-a'), orderBy('updatedAt','desc'))`.
      - The admin and the superadmin also read `audit_log/a1` and `webhooks/w1`.
    - No scoped principal goes in this file; task 2.2 has its own.
  - Done when: `cd web && npm run test:rules` passes against the unchanged firestore.rules (2.11.0), with every new case green.

## Wave 2: beside release 2 (files release 2 does not touch)

- [x] **Task 2.1: `web/lib/machineAccess.ts`, the one reading of a machine scope**
  - Files: `web/lib/machineAccess.ts` (new), `web/__tests__/lib/machineAccess.test.ts` (new)
  - Depends on: 0.1
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`. Write a pure module with no firebase imports. The browser and the server both import it, so the server, the dashboard and the read-path script read a member row exactly as the rules do.
    ```ts
    import { FIRESTORE_IN_LIMIT } from '@/lib/logFilters';
    /** at most this many machines per scoped member: the dashboard lists them with one documentId() `in` query */
    export const MAX_MACHINE_SCOPE = FIRESTORE_IN_LIMIT;
    export function parseMachineIds(memberData: Record<string, unknown> | null | undefined): readonly string[] | null;
    export function scopeCovers(scope: readonly string[] | null, machineId: string): boolean;
    export type MachineIdsInput = { ok: true; value: string[] | null } | { ok: false; error: string };
    export function normalizeMachineIdsInput(raw: unknown, opts: { allowNull: boolean }): MachineIdsInput;
    ```
    - `parseMachineIds`:
      - no own `machineIds` key (`Object.prototype.hasOwnProperty.call`) gives `null`, the whole site;
      - present but not an array gives `[]`, which reaches nothing, as the rules' `in` error does;
      - otherwise, the string entries, de-duplicated and sorted.
    - `scopeCovers(null, x)` is true. For an array it is `includes`.
    - `normalizeMachineIdsInput` validates an API body field:
      - an array of 1..MAX_MACHINE_SCOPE ids, each matching `/^[A-Za-z0-9_-]{1,128}$/` (the shape machine routes accept), comes back de-duplicated and sorted;
      - `null` is accepted only with `allowNull` (PATCH clears with null);
      - `[]`, non-arrays and bad ids are refused.
    - Lowercase errors:
      - `'machineIds must list between 1 and 30 machine ids; send null for the whole site'`, with the null clause only when `allowNull` is set;
      - `machine id "<id>" is not a valid machine id`.
    - A header comment says that absent means whole site, that malformed means no machines, and why this lives in one place.
    - Tests:
      - `parseMachineIds`: absent gives null; `[]`, `null`, `'m1'` and `{}` each give `[]`; `['m2','m1','m1',3]` gives `['m1','m2']`.
      - `scopeCovers`: `(null,'x')` and `(['a'],'a')` are true; `(['a'],'b')`, `([],'a')` and `(['a'],'__proto__')` are false.
      - `normalizeMachineIdsInput`:
        - a valid list comes back sorted and unique;
        - 31 ids, `[]`, a string, and ids containing `/` or `.` are refused;
        - `null` is refused without `allowNull`, and gives `{ok:true,value:null}` with it.
  - Done when: `cd web && npx jest __tests__/lib/machineAccess.test.ts` passes, and eslint and tsc are clean.

- [x] **Task 2.2: firestore.rules 2.12.0, machine scope**
  - Files: `firestore.rules`, `web/__tests__/rules/machineScope.test.ts` (new)
  - Depends on: 1.1
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`. The owner gave an explicit go to change firestore.rules for this release (decision 2). The swoop mode needs no rules change (decision 14).
    - Change only the user term of each block. These stay byte-identical, because agents are clients of the rules (ADR 0001):
      - every `isServiceAccount()`, `agentCanAccessMachine(...)` and `agentCanAccessSite(...)` disjunct;
      - the inline agent condition on target_state.
    - Leave `firestore.indexes.json` alone: no index is needed.
    - This task assumes the owner's default for open question 3 (autonomous chats hidden). If the Log says otherwise, follow context.md "If the owner answers otherwise".

    1. After `isSiteAdmin` (~line 180), add this section (comments lowercase):
       ```
       // ---- machine scope (2.12.0) ----
       // a member row may carry machineIds: [<machineId>, ...]. absent = whole site (every row
       // before 2.12.0, every owner). present = only those machines and nothing site-wide.
       // fails closed: [] reaches nothing; null or a non-list makes `in` an evaluation error,
       // which denies. widening is a field delete, never null. both helpers read the member
       // document isActiveMember() already reads, so no access is added. call them only
       // behind isActiveMember(siteId).
       function memberIsWholeSite(siteId) {
         return !('machineIds' in get(/databases/$(database)/documents/sites/$(siteId)/members/$(request.auth.uid)).data);
       }
       function memberHoldsMachine(siteId, machineId) {
         return machineId in get(/databases/$(database)/documents/sites/$(siteId)/members/$(request.auth.uid)).data.machineIds;
       }
       // site-wide reach: every collection that spans machines.
       function canAccessWholeSite(siteId) {
         return isAuthenticated() && isNotDeletedUser() &&
                (isSuperadmin() || (isActiveMember(siteId) && memberIsWholeSite(siteId)));
       }
       // one machine. rules are not filters: a list is provable only when the query pins the
       // id (documentId() ==/in, or a machineId field ==/in) to values all in the scope.
       function canAccessMachine(siteId, machineId) {
         return isAuthenticated() && isNotDeletedUser() &&
                (isSuperadmin() ||
                 (isActiveMember(siteId) &&
                  (memberIsWholeSite(siteId) || memberHoldsMachine(siteId, machineId))));
       }
       ```
    2. In `isSiteAdmin` (175-180), the member branch becomes `(isActiveMember(siteId) && siteMemberRole(siteId) in ['owner', 'admin'] && memberIsWholeSite(siteId))`. A scoped admin row then fails `webhooks` (555) and `audit_log` (640).
    3. Above `canAccessSite` (151-166), add the invariant:
       ```
       // canAccessSite admits a machine-scoped member. it gates only documents that say nothing
       // about other machines: the site document, settings/{swoop,display,cortex}, and the
       // schedule and reboot presets. a block that spans machines takes canAccessWholeSite; a
       // block under one machine takes canAccessMachine. a new block written with canAccessSite
       // hands every scoped member the whole collection.
       ```
    4. Change `canAccessSite(siteId)` to `canAccessMachine(siteId, machineId)` at:
       - the machines read (282) and the commands read (304);
       - the screenshots read (317);
       - the installed_software read (326) and delete (331);
       - the hardware read (344) and the cortex read (360);
       - the per-machine logs read (376) and the metrics_history read (394);
       - the `config/{siteId}/machines/{machineId}` read (688).
    5. Change `canAccessSite(siteId)` to `canAccessWholeSite(siteId)` at:
       - deployments (416), installer_templates (427), project_templates (438);
       - roosts (462), the target_state read (493) and delete (504), versions (517);
       - cortex-events (602), talons (657), talon_runs (665);
       - project_distribution_presets (714), talon_presets (721).
    6. Keep `canAccessSite` on purpose at `sites/{siteId}` (270), schedule_presets (700) and reboot_presets (707). They carry no machine data, and a scoped admin's machine-config dialogs read them.
    7. The site logs read (582) becomes `allow read: if canAccessMachine(siteId, resource.data.machineId) || isServiceAccount() || agentCanAccessSite(siteId);`. A scoped member's list must pin `machineId`, and a row without a machineId is whole-site only.
    8. The settings read (856) becomes `allow read: if canAccessWholeSite(siteId) || (canAccessSite(siteId) && settingId in ['swoop', 'display', 'cortex']);`. `useSwoopSettings` reads a denial as `enabled:false`, which would hide swoop. Alerts stays whole site.
    9. In chats (867-870), messages (879-882) and stream (891-894), change the autonomous branch's `canAccessSite(…)` to `canAccessWholeSite(…)`.
    10. The header:
        - The version line (4-7) reads `// Version: 2.12.0 - a member row may carry machineIds: that member reaches only those machines (canAccessMachine) and nothing site-wide (canAccessWholeSite); 2.11.0 made webhook documents site-admin read`. Indent continuation lines 19 spaces, as today.
        - `// Last Updated: <the day you commit>`.
        - In Security Model (9-17), add `// - A member row may list machineIds: that member reaches only those machines, and nothing site-wide`.
        - In Site Access (24-25), add "a row with machineIds reaches only those machines".
        - In the cost block (99-116), add a line: memberIsWholeSite() and memberHoldsMachine() read the same member document, so per-machine reads still cost 2, and chat messages and stream 3.
    11. Write the new `web/__tests__/rules/machineScope.test.ts` (research rules.md §7), with task 1.1's lifecycle.
        - **The scoped principal.** `const db = await asUser('scoped-1','member',[])` writes only the users doc. Then a local `seedMember(siteId, uid, role, machineIds?)` writes, through seedAsAdmin, `{uid, role, status:'active', addedAt:new Date(), addedBy:'system:rules-harness', ...(machineIds !== undefined ? { machineIds } : {})}`. Never call asUser with the site afterwards: it rewrites the row.
        - **Seed** machines `IN` and `OUT` on site-a with task 1.1's per-machine documents, plus the same site documents.
        - **PER_MACHINE**, `it.each` over the machine doc, the config doc, `commands/pending`, `screenshots/s1`, `installed_software/x`, `hardware/profile`, `cortex/state`, the per-machine `logs/l1` and `metrics_history/b1`: the scoped member's get on IN succeeds, and on OUT it fails.
        - **Lists:**
          - the unfiltered machines and config lists FAIL;
          - `query(collection(db,'sites','site-a','machines'), where(documentId(),'in',['IN']))` SUCCEEDS and returns exactly `['IN']` (`expect(snap.docs.map(d=>d.id)).toEqual(['IN'])`; pattern `membership.test.ts:268-271`);
          - the same `in` with `['IN','OUT']` FAILS;
          - `documentId() == 'IN'` succeeds;
          - the config collection behaves the same way;
          - a metrics_history list under IN succeeds, and under OUT fails.
        - **The 30 cap:** seed a row with 30 ids (IN plus 29 others), and an `in` with those 30 succeeds. 31 values throws the SDK's invalid-argument error before any rules evaluation; assert the error code.
        - **Site logs:**
          - `where('machineId','==','IN')` and `where('machineId','in',['IN'])`, each with `orderBy('timestamp','desc')`, SUCCEED;
          - the unfiltered list FAILS, and so does `in ['IN','OUT']`;
          - the scoped get of `logs/lb` (machineId null) FAILS;
          - a whole-site member's get of `lb` SUCCEEDS.
        - **SITE_WIDE**, `it.each` over deployments, installer_templates, project_templates, roosts, target_state, versions, cortex-events, talons, talon_runs, project_distribution_presets, talon_presets, `settings/alerts`, and chat c1 with its messages and stream: the scoped member fails.
        - **Carve-outs** that succeed for the scoped member: `sites/site-a`, `settings/swoop`, `settings/display`, `settings/cortex`, schedule_presets and reboot_presets.
        - **A scoped admin** (role admin, machineIds `['IN']`): `audit_log` and `webhooks` FAIL; machines/IN succeeds; machines/OUT fails.
        - **Fail closed:** with `machineIds: []`, machines/IN fails, deployments fail and `sites/site-a` succeeds. The same holds with `machineIds: null`.
        - **Controls:**
          - a whole-site member's unfiltered machines, config and logs lists succeed;
          - a superadmin with no rows reads everything;
          - `asAgent('site-a','OUT')` still reads and writes its own machine and config;
          - a soft-deleted scoped user (users doc with `deletedAt`; pattern `membership.test.ts:152-168`) fails machines/IN;
          - the scoped member cannot `setDoc` or `updateDoc` their own member row, nor `updateDoc(ref, { machineIds: deleteField() })`;
          - `collectionGroup('members')` with `where('uid','==','scoped-1')` succeeds and returns the row carrying machineIds.
  - Done when:
    - `cd web && npm run test:rules` is green: task 1.1's file, every pre-existing rules test, and the new file.
    - `git diff --stat` shows no change to `firestore.indexes.json` or `firebase.json`.

- [x] **Task 2.3: the read-path check covers machine scope against deployed rules**
  - Files: `scripts/check-membership-read-path.mjs`
  - Depends on: 0.1
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`. Extend the read-only checker (research rules.md §9).
    - **New flags in `KNOWN` (44):**
      - `--scoped`: choose only a subject with at least one row whose `machineIds` is an array.
        - With `--uid`, it uses that uid's first scoped row.
        - It exits 3 when there is no such row.
      - `--list-scoped`: print every member row that carries `machineIds`, one line each: `siteId  uid  role  machineIds  →  DELETE /api/sites/<siteId>/members/<uid>`. That is the request a rollback sends (context.md "Rollback"). Then exit 0. It stays read-only and prints no key.
    - **`resolveSubjects` (135-179)** keeps `machineIds` per row, parsed as `web/lib/machineAccess.ts` does: absent gives null, a non-array gives [], and strings come back sorted and unique.
    - **A new section, `--- machine scope ---`**, runs when the subject has a scoped row; take the first. `IN` is the first scope id that exists as `sites/{S}/machines/{id}` (adminDb). `OUT` is any other machine doc on that site; SKIP the OUT checks when there is none. Then:
      - expectAllowed: getDoc machines/IN and `config/{S}/machines/IN`.
      - expectDenied: getDoc machines/OUT.
      - expectDenied: unfiltered `collection(db,'sites',S,'machines')` and `collection(db,'config',S,'machines')`.
      - expectAllowed: `query(collection(db,'sites',S,'machines'), where(documentId(),'in',scope.slice(0,30)))`. Print PASS or FAIL on whether the returned ids equal the scope ids that exist. Do the same for config.
      - expectAllowed: `query(collection(db,'sites',S,'logs'), where('machineId','in',scope.slice(0,30)), orderBy('timestamp','desc'), limit(5))`. A failed-precondition (missing index) is a FAIL; expectAllowed already prints the error.
      - expectAllowed: `query(collection(db,'sites',S,'logs'), where('action','==','exe_missing'), where('machineId','in',scope.slice(0,30)), limit(20))`, the dashboard's alert-toast shape.
      - expectDenied: `query(collection(db,'sites',S,'logs'), orderBy('timestamp','desc'), limit(1))`.
      - expectDenied: `collection(db,'sites',S,'deployments')`.
      - expectAllowed: getDoc `sites/{S}/settings/swoop`.
      - expectDenied: getDoc `sites/{S}/settings/alerts`.
      - expectDenied: `collection(db,'sites',S,'audit_log')`. Print the row's role, because this must be denied even for a scoped admin.
    - Import `documentId`, `orderBy` and `limit` from the web SDK, the way the script imports the rest.
    - Update the header's usage block (25-31) and the exit codes. The script still writes nothing.
  - Done when:
    - `node --check scripts/check-membership-read-path.mjs` passes, and `--help` lists both new flags.
    - If dev credentials are present (web/.env.local, .claude/.env.local), these pass:
      - `--env=dev` passes its existing checks, and the scope section reports SKIP, because no scoped row exists yet;
      - `--env=dev --list-scoped` prints no rows.
    - Otherwise the Log says "creds unavailable, not run".

- [x] **Task 2.4: per-site usage needs whole-site standing**
  - Files: `functions/src/telemetry.ts`, `functions/test/telemetry.test.ts`
  - Depends on: 0.1
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`.
    - `isAuthorizedForSiteUsage` (telemetry.ts:353-378) authorizes a member only when `member.status === 'active' && !Object.prototype.hasOwnProperty.call(member, 'machineIds')`.
    - A scoped member gets the same single 401 a stranger gets, and the function's no-probe rule (311-326) stays.
    - Its doc comment says cost data is site-wide.
    - Tests, in the existing deps-injection style:
      - a scoped member row (`machineIds:['m1']`) gives false;
      - `machineIds: []` gives false;
      - a whole-site member gives true;
      - a superadmin gives true;
      - an inactive row gives false.
  - Done when: `cd functions && npm test && npm run build` passes. The deploy to dev is task 12.1, with the owner's go.

## Wave 3: rebase onto release 2

- [x] **Task 3.1: Rebase onto dev with release 2 merged, and record what releases 1 and 2 shipped**
  - Files: none of the product's (git only). The `release names` block goes in your Log reply.
  - Depends on: release 2 merged into origin/dev (release 1 before it), and waves 0–2.
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`.
    1. In the worktree, run `git fetch origin && git rebase origin/dev`. Waves 0–2 touched no file that release 2 touches, so expect no conflict. If one appears, resolve it keeping both sides, and name the file in the Log.
    2. Re-run what waves 1–2 proved: `cd web && npm ci` if the lockfile moved, then `npm run test:rules` and `npx jest __tests__/lib/machineAccess.test.ts`; then `cd ../functions && npm test`.
    3. Read the code and write a Log block headed `release names`. Release 2's plan (`dev/active/admin-sites/`) planned the names below. Confirm each one, or give the shipped name and file:
       - **Release 2, the swoop mode:**
         - `web/lib/swoopMode.ts`: `SwoopMode`, `SWOOP_MODES`, `SWOOP_MODE_LABELS`, `parseSwoopMode`, `grantedSwoopMode(role, mode)` and `effectiveSwoopMode(role, mode, membersMayWatch)`.
         - `capabilities.ts`: `MemberStanding { role, swoopMode }`; `siteStanding(bySite)` returning `{ siteRoles, swoopModes }`; `UserActor.swoopModes`; `explicitSwoopMode(actor, siteId)`; where in `hasCapability` the override sits, and its exact condition.
         - `sitePolicy.server.ts`: `facts.swoopMode`, `deriveSwoopMode(memberData, role)`, the exported `deriveMembership`, and `listUserStanding(uid)`.
         - Which builders call `siteStanding`: the wrapper, `_shared`'s `requireSiteCapability`, `assertUserHasSiteCapability`, the candidates route, and any others.
         - The wrapper's swoop refusal, which should carry `code: 'capability_missing'` for bypass-exempt capabilities. Note the expression it uses.
         - `evaluateSwoopAccess`: `members_may_not_watch` applies only with no explicit mode.
         - Kill and `GET /api/sites/{siteId}/swoop/sessions`: SWOOP_SETTINGS_MANAGE, or still MACHINE_REMOTE_CONTROL if the owner refused release 2's question 5.
         - Release 2's pill email gate (its task 4.3): the file, whether it runs in the browser or on the server, and what it keys on.
       - **Release 2, membership:**
         - `updateMember({ siteId, uid, role?, swoop? })` returning `{ before, after }` as `MemberAccess { role, swoop }`.
         - The PATCH revocation: reasons `role_changed` and `swoop_changed`, and when it passes `controlOnly`.
         - The PATCH's "neither" 400 message.
         - The POST's `swoop` validation.
         - The audit verbs `member_role_changed` and `member_swoop_changed`.
         - The member-candidates route path.
       - **Release 2, UI and helpers:**
         - `useSiteMembers`: `SiteMember.swoop`, `AddSiteMemberInput` and the `updateMember(uid, patch)` patch shape.
         - `SiteMembersSection`, `MemberAccessFields` (props), `AddMemberDialog`, `ChangeAccessDialog` (props), and the shared `SegmentedControl`.
         - Whether `useSiteMachines` was extracted.
         - `siteTalonSuccessors`, `SiteList`'s role label, `SiteSettings`' member-only copy, and the route `/admin/sites/{siteId}?section=members`.
         - `seedMemberRow`/`grantMembership`'s `extra: { swoop }`.
         - The escalation blocks it added (13–18), and that `web/__tests__/lib/sitePolicy.test.ts` exists.
         - The ADR it took (0015), and the GLOSSARY entries it added or changed: Site settings, swoop mode, Site role, Viewer and Kill.
       - **Release 1:**
         - `revokeSwoopSessionsForUser`: seats removed with `removeSwoopViewers`, and a session ended only when nobody else is in it. Its reason type.
         - The session GET's viewer names.
         - How "this machine has left the site" is detected. Expected: the create route's 404 code `machine_not_found`, and the record's `endReason: 'machine_removed'`. Does anything read the machine document from `useMachines`?
    4. If release 2 shipped without the swoop mode, stop and say so: waves 4 on are written for decisions 13–14.
  - Done when:
    - the branch is rebased on origin/dev, with release 2 in its history;
    - the suites in step 2 are green;
    - the Log reply carries the complete `release names` block.

## Wave 4: the decision core, the writer, browser data, vocabulary

- [x] **Task 4.1: The decision core: machine scope beside release 2's swoop mode, in one standing**
  - Files:
    - `web/lib/capabilities.ts`, `web/lib/sitePolicy.server.ts`
    - in `web/lib/authorizedHandler.server.ts`, `web/app/api/_shared.ts` and `web/lib/apiAuth.server.ts`: the `siteStanding(...)` expressions only
    - `web/__tests__/lib/capabilities.test.ts`, `web/__tests__/lib/sitePolicy.test.ts` (release 2's file, extended)
  - Depends on: 2.1, 3.1
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`. Extend release 2's helpers; do not write parallel ones. The check order is: the role matrix, then release 2's swoop mode, then machine scope.
    - **`capabilities.ts`:**
      - Export `MACHINE_CAPABILITIES: ReadonlySet<Capability>` (MACHINE_VIEW, MACHINE_REMOTE_VIEW, MACHINE_EXEC_COMMAND, MACHINE_REMOTE_CONTROL, MACHINE_CONFIG_WRITE) and `isMachineCapability(c)`.
        - Comment: these act on one machine, and they are the only capabilities a scoped actor can hold. Every other site-scoped capability is site-wide.
        - Name the site-wide ones that look machine-sized: MACHINE_REMOVE (it changes the site's fleet), UNINSTALL_TRIGGER (the deploy page's surface), MACHINE_ENROLL, AGENT_TOKEN_REVOKE, and SWOOP_SETTINGS_MANAGE (since release 2, also kill and the site's sessions list). Open question 2 covers the first two.
      - Release 2's `MemberStanding` gains `machineIds: readonly string[] | null`. Doc: the member row's machine scope (`parseMachineIds`); null means whole site.
      - `UserActor` gains `machineScopes?: Readonly<Record<string, readonly string[] | null>>`. Doc:
        - there is one entry for every site in `siteRoles`, null for whole site, and only `siteStanding` writes it;
        - a site in `siteRoles` without an entry in a present map reaches nothing;
        - an actor with no map at all (a test literal) reads as whole site;
        - task 8.1 makes it required.
      - Release 2's `siteStanding(bySite)` also returns `machineScopes`, built with `Object.create(null)` like its other maps. For every site it puts in `siteRoles`, `machineScopes[id] = standing.machineIds`, and null stays null.
        - Owner rows are included: the rules scope an owner row that carries the field, and the writers never put it there.
        - Update its doc.
      - Add `export function machineScopeOf(actor: UserActor, siteId: string): readonly string[] | null`:
        - map absent gives null;
        - `siteId` not an own key (`Object.prototype.hasOwnProperty.call`) gives `[]` (fails closed);
        - null gives null, and an array gives that array;
        - anything else gives `[]`.
      - In `hasCapability(actor, capability, siteId?, machineId?)`, restructure release 2's site-scoped branch so its swoop-mode answer no longer returns early:
        ```ts
        // 1. the role matrix, 2. a person's swoop mode (release 2: same condition, same values)
        const held = /* release 2's override when it applies */ ?? SiteRoleCapabilityMatrix[siteRole].includes(capability);
        if (!held) return false;
        // 3. machine scope: a scoped actor holds machine-class capabilities on its machines only
        const scope = machineScopeOf(actor, siteId);
        if (scope === null) return true;
        if (!MACHINE_CAPABILITIES.has(capability)) return false;
        return machineId !== undefined && scope.includes(machineId);
        ```
        - System actors and the superadmin short-circuit are unchanged.
        - Rewrite the function's doc: the three steps in order, and that no machineId denies a scoped actor.
    - **`sitePolicy.server.ts`:**
      - `SiteAccessFacts` gains `machineIds: readonly string[] | null`, beside release 2's `swoopMode`. Doc: the member row's machine scope; null means whole site. It is always null for a superadmin (the rules' `isSuperadmin()` short-circuit) and without an active membership.
      - Add `export function deriveMachineIds(memberData: Record<string, unknown> | null, role: MembershipRole): readonly string[] | null` beside `deriveSwoopMode`. It gives null when `role` is null, else `parseMachineIds(memberData)`. Doc: unlike the mode, it reads an owner row too, because the rules do.
      - In `resolveSiteAccess`, set `machineIds: globalRole === 'superadmin' ? null : deriveMachineIds(memberData, membershipRole)`. No new read.
      - Add `export function memberStanding(memberData: Record<string, unknown> | null): MemberStanding`:
        - `role` is `deriveMembership(memberData)`;
        - `swoopMode` is `deriveSwoopMode(memberData, role)`;
        - `machineIds` is `deriveMachineIds(memberData, role)`.

        `listUserStanding` builds each entry with it in place of its inline object, so every reading of a row is the same.
      - Add `export function standingOf(facts: SiteAccessFacts): MemberStanding`, returning `{ role: facts.membershipRole, swoopMode: facts.swoopMode, machineIds: facts.machineIds }`.
    - **The builders that already go through `siteStanding`.** The wrapper's site call in `authorizedHandler.server.ts`, `requireSiteCapability` in `_shared.ts` and `assertUserHasSiteCapability` in `apiAuth.server.ts` pass `siteStanding({ [siteId]: standingOf(outcome.facts) })` in place of their inline `{ role, swoopMode }`.
      - `authToActor`'s standing parameter becomes `ReturnType<typeof siteStanding>`, and `loadUserActor` passes `siteStanding({})`.
      - Change nothing else in those three files; tasks 5.1 and 5.2 add the gates.
      - The candidates route uses `listUserStanding`, which this task updates, so it needs no edit.
      - If tsc names another production file that builds a `MemberStanding` or calls `siteStanding`, fix it the same way when no other wave-4 task lists that file, and name it in your Log. Otherwise stop and log it.
    - **Tests, `capabilities.test.ts`.** Every existing case and release 2's mode cases stay unchanged.
      - The cross product, in one `it.each`: role (member, admin, owner) × swoop mode (absent, none, view, control) × scope (whole site, `['m1']`) × machineId (m1, m2, none) × every site-scoped capability. A small oracle in the test computes the expected value:
        - MACHINE_REMOTE_CONTROL is held iff `grantedSwoopMode(role, mode) === 'control'` and the machine rule holds;
        - MACHINE_REMOTE_VIEW is held iff the granted mode is not `'none'` and the machine rule holds;
        - MACHINE_EXEC_COMMAND and MACHINE_CONFIG_WRITE are held iff the role is admin or owner and the machine rule holds; the mode never moves them;
        - MACHINE_VIEW is held iff the machine rule holds;
        - every site-wide capability follows the role matrix on the whole site, and is false on `['m1']` with or without a machineId, the owner's SITE_DELETE included.

        The machine rule: the whole site always passes, even with no machineId; `['m1']` passes only for machineId m1.
      - Named cases on top:
        - a member set to control on `['m1']` holds CONTROL on m1, but not on m2, not with no machineId, and holds nothing else (EXEC_COMMAND is false on m1);
        - an admin set to view on `['m1']` holds EXEC_COMMAND on m1, but not CONTROL;
        - an admin set to none on `['m1']` holds neither swoop capability on m1, and keeps CONFIG_WRITE there.
      - Fail closed: `siteRoles: {site_a:'admin'}` with `machineScopes: {}` is denied every site-scoped capability, with or without a machineId. So are `machineScopes: {site_a: []}` and a non-array, non-null entry.
      - A scope on site_a says nothing about site_b. `siteStanding({ site_a: { role:'admin', swoopMode:null, machineIds:['m1'] }, site_b: { role:'admin', swoopMode:null, machineIds:null } })` holds SITE_MEMBER_MANAGE on site_b and not on site_a.
      - machineIds `'__proto__'` and `'constructor'` are false. A siteId `'__proto__'` stays an own key of `machineScopes`.
      - A superadmin with a scope entry holds everything. An actor literal with no `machineScopes` key gives exactly today's results.
      - `siteStanding` writes a `machineScopes` entry (null or the list) for every site in `siteRoles`, and none for a null role.
    - **Tests, `sitePolicy.test.ts`** (extend release 2's file):
      - `deriveMachineIds`: a null role gives null; an absent field gives null; `['m2','m1']` gives `['m1','m2']`; a malformed value gives `[]`; an owner row with the field gives the list.
      - `resolveSiteAccess` puts `facts.machineIds` on each fixture: absent, a list, malformed, a superadmin with a scoped row (null) and an inactive row (null). It still makes exactly one getAll with three refs.
      - `memberStanding` equals `{ role, swoopMode, machineIds }` from the three derive functions on every fixture row. `listUserStanding` entries equal `memberStanding` of their rows; this replaces release 2's equivalence assertion.
      - `standingOf` copies the three facts.
    - **Then** run these untouched: `web/__tests__/lib/authorizationParity.test.ts`, `authorizedHandler.test.ts`, `apiAuth.test.ts` and `__tests__/api/scopeEnforcement.test.ts`. They must stay green, parity's read-count pins (L465-490) included, because no row in them carries machineIds.
  - Done when: those suites and `cd web && npx jest __tests__/lib __tests__/api` are green, and tsc and eslint are clean on the five code files.

- [x] **Task 4.2: The membership writer stores machine scope**
  - Files: `web/lib/membership.server.ts`, `web/__tests__/lib/membership.test.ts`
  - Depends on: 2.1, 3.1
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`. Extend release 2's writer.
    - **`MemberDoc`** gains `machineIds?: string[]`. Doc: the machine scope; absent means whole site; written sorted and unique; never written as `[]` or null; owners never carry it.
    - **`MembershipFailure`** gains `{ kind: 'invalid_machine_ids' }`.
    - **`addMember`:**
      - Its input gains `machineIds?: readonly string[]`.
      - When it is given, re-validate it with `normalizeMachineIdsInput(…, { allowNull: false })`. A failure returns `invalid_machine_ids` and writes nothing.
      - Write the normalized list into the `batch.create` payload, beside release 2's `swoop`.
      - When it is absent, no field is written, so the exact `toEqual` (membership.test.ts L122-140) still passes.
    - **Release 2's `updateMember`** gains `machineIds?: readonly string[] | null`:
      - an array is normalized (an invalid one gives `invalid_machine_ids`, and nothing is written);
      - null writes `machineIds: FieldValue.delete()`, the whole site;
      - absent leaves the field untouched.

      Around it:
      - Release 2's `MemberAccess` gains `machineIds: string[] | null`. `before` is `parseMachineIds(row)` as a mutable copy; `after` is what was written.
      - Release 2's "with neither field, nothing is written" becomes "with none of the three".
      - The owner's row is refused whatever is sent, machineIds included.
      - Add to the module header's invariants: a role or swoop change keeps the machine scope (scoped admins exist, decision 3), and widening is an explicit `machineIds: null`.
    - **New `export async function pruneMachineFromMembers(input: { siteId: string; machineId: string; db?: FirebaseFirestore.Firestore }): Promise<number>`:**
      - It queries `sites/{siteId}/members` where `machineIds array-contains machineId`. That is collection scope, which automatic single-field indexing covers.
      - It writes one batch of `update({ machineIds: FieldValue.arrayRemove(machineId) })` and returns the count.
      - A row emptied by pruning keeps `machineIds: []`, which means no machines. Never delete the field: that would widen the person to the whole site.
      - Doc: a re-paired or reused machine id must never inherit an old grant. Task 5.7 calls it on removal and on pairing.
    - **Tests**, in membership.test.ts. Extend its path-keyed double so `FieldValue.delete()` and `arrayRemove` can be represented.
      - `addMember`:
        - with `['m2','m1']` it writes exactly `{uid, role, status, addedAt, addedBy, machineIds:['m1','m2']}`;
        - without the field, the existing toEqual passes;
        - `[]` or 31 ids give `invalid_machine_ids`, and nothing is written.
      - `updateMember`:
        - machineIds only keeps role and swoop;
        - role only and swoop only each keep an existing machineIds;
        - null deletes the field;
        - all three in one call write all three;
        - the owner's row gives `is_owner` for machineIds;
        - `before` and `after` carry machineIds.
      - `pruneMachineFromMembers`:
        - it removes the id from two rows and leaves a third untouched;
        - a row whose only machine was pruned keeps `[]`;
        - it returns 2.
  - Done when:
    - the membership tests are green;
    - `cd web && npx jest __tests__/api/sites-members.test.ts __tests__/api/membershipEscalation.test.ts` is still green (behaviour unchanged);
    - tsc and eslint are clean.

- [x] **Task 4.3: The browser data layer: membership scope and scoped machine listeners**
  - Files: `web/hooks/useFirestore.ts`, `web/__tests__/hooks/useMachines.scope.test.ts` (new), `web/__tests__/hooks/useSiteMemberships.scope.test.ts` (new)
  - Depends on: 2.1, 3.1
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`. Release 2 changed other functions in this file (the lifted `createSite`); leave them alone.
    - **`useSiteMemberships` (706-765):**
      - `SiteMemberships` gains `scopeMap: Map<string, readonly string[]>`, holding only scoped sites (absent means whole site).
      - Fill it from the same snapshot loop (742-751), with `parseMachineIds(data)` for active rows with a valid role.
      - Add a `scopeMapsEqual` guard beside `roleMapsEqual` (687-691) that compares keys and arrays element by element.
      - Reset it in the render-time reset (718-723).
      - Do NOT import useAuth here: `AuthContext.tsx:29` imports this module, so that would be a cycle.
    - **Fix the stale comment at ~702-704** ("No composite index is needed…"). The `members.uid` COLLECTION_GROUP field override in firestore.indexes.json is what makes the query legal (scripts/check-membership-read-path.mjs:14-18).
    - **`useMachines` (1115)** becomes `useMachines(siteId: string, machineIds?: readonly string[] | null)` (research client-reads §4).
      - Add `documentId` to the firebase/firestore import (4-15).
      - `scopeKey`:
        - is null when machineIds is null or undefined;
        - otherwise, the JSON of the sorted unique ids, capped at `MAX_MACHINE_SCOPE`. Warn once with `console.warn` when a longer list is cut: that is a data error the server never writes.
      - `loadKey` is `siteId` without a scope, and `${siteId}:${scopeKey}` with one. `loadedSiteId` (1120) becomes `loadedKey`.
      - With a scope, the config effect (1146-1217) and the status effect (1249-1485) listen to `query(col, where(documentId(), 'in', ids))`; without one, to the plain collection. `scopeKey` goes in their deps.
      - An empty scope (`'[]'`) opens no listener and returns `machines: []` with `loading: false`.
      - Lines 1952-1953 compare `loadedKey` to `loadKey`.
      - The refused status listener (1470-1473) also calls `setMachines([])` and `setLoadedKey(loadKey)`, besides setError, so a page stops loading on a refused read. It stays refused until the inputs change.
      - The reconcile, the profile cap and identity reuse are untouched, and the snapshot shape is identical.
    - **Tests for `useMachines`.** Mock firebase/firestore's `collection`, `query`, `where`, `documentId` and `onSnapshot` (pattern `web/__tests__/hooks/useMachines.identity.test.ts`):
      - a call without a scope subscribes to the plain collections, as today;
      - `['m2','m1']` subscribes to both collections with `where(documentId(),'in',['m1','m2'])`, and never to a plain collection;
      - a new array with the same ids does not resubscribe;
      - `[]` subscribes nothing, and reports `loading:false` with no machines;
      - a refused status listener ends loading, with machines `[]` and the error set.
    - **Tests for `useSiteMemberships`:**
      - a row with machineIds lands in `scopeMap`, and a row without is absent;
      - a malformed value gives `[]`;
      - an inactive row is ignored;
      - an identical snapshot keeps the same Map instance.
  - Done when: the new tests and every existing `__tests__/hooks/useMachines.*.test.ts` pass, and tsc and eslint are clean.

- [x] **Task 4.4: Alert emails respect machine scope (owner decision 10)**
  - Files:
    - `web/lib/adminUtils.server.ts`
    - `web/app/api/agent/alert/route.ts`, `web/app/api/alerts/trigger/route.ts`
    - `web/app/api/cron/display-alerts/route.ts`, `web/app/api/cron/health-check/route.ts`, `web/app/api/cron/process-alerts/route.ts`
    - `web/lib/talons/outputs.server.ts`, `web/lib/hoot-escalation.server.ts`
    - `web/__tests__/lib/adminUtils.test.ts`, `web/__tests__/api/cron/health-check.test.ts`, and any other test that builds `SiteRecipient` objects (`grep -rn mutedMachines web/__tests__`)
  - Depends on: 2.1, 3.1
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`.
    - **`SiteRecipient` (adminUtils:7-12)** gains `machineIds: readonly string[] | null`, where null means whole site.
    - **`getSiteAlertRecipients` (163-259) finds recipients through member rows too.** Today they come only from the legacy `users where sites array-contains siteId`, so a scoped member, or anyone once `scripts/migrations/strip-legacy-membership.mjs` runs, would silently get nothing. Inside its existing try, after the plan-pause check and before the users query (195-198):
      1. Read `sites/{siteId}/members` once. Build `rowByUid` from it: `{ active: status === 'active' && the role is owner, admin or member; machineIds: parseMachineIds(data) }`.
      2. The legacy users query runs as today. Each recipient it pushes gets `machineIds: rowByUid.get(uid)?.machineIds ?? null`.
      3. Active member uids that neither the legacy query nor the owner branch has seen are read with `db.getAll`, in chunks of 100. Each is pushed with today's rules (deletedAt, email, the preference opt-out, mutedMachines, alertCcEmails, `siteHasUsers`) and its row's machineIds.
      4. The owner branch and the ADMIN_EMAIL fallback get `machineIds: null`.
      5. A failure of the new read takes the existing enumerationFailed path, which leaves only the fallback recipient. Never fail open to a scoped member.

      Update the function's doc: recipients are active member rows plus the legacy array during the transition, plus the owner.
    - **Delete three unused helpers in the same file:** `getSiteAdminEmails` (:47), `getSiteProcessAlertEmails` (:106) and `getSiteAlertEmailsWithCc` (:296). Each lists recipients with no machine scope, and nothing calls them; confirm with `git grep -n` first. Delete any constant or import only they used.
    - **Export `recipientWantsMachine(recipient: SiteRecipient, machineId: string): boolean`**, equal to `!recipient.mutedMachines.includes(machineId) && scopeCovers(recipient.machineIds ?? null, machineId)`. The `?? null` keeps the recipients that tests build by hand at the whole site.
    - **Replace every per-machine mute check with it:**
      - `agent/alert/route.ts` :418 and :574;
      - `alerts/trigger/route.ts` :71;
      - `cron/display-alerts/route.ts` :97-99 (filter the alerts);
      - `cron/health-check/route.ts`: `filterSectionsForRecipient` (236-245) takes the recipient instead of `mutedMachines`; call site :516;
      - `cron/process-alerts/route.ts` :172;
      - `lib/talons/outputs.server.ts` :152: with `ctx.machineId`, use recipientWantsMachine; with no machine, skip recipients whose machineIds is not null, because a scoped member holds nothing site-wide;
      - `lib/hoot-escalation.server.ts` :39: pass the identifier its mute check and timezone lookup already use (`machineName`, which is the machine id there). The machineName/machineId mismatch is a backlog item, not this task.
    - **Tests:**
      - adminUtils:
        - a scoped member row gives `machineIds:['m1']`;
        - a whole-site row and the owner give null;
        - a scoped member whose users doc has no legacy `sites[]` entry is still a recipient, with `['m1']`;
        - an inactive row adds no one;
        - a failed members read gives the fallback only;
        - the recipientWantsMachine truth table: a mute wins, a covering scope passes, null covers everything.
      - health-check: a scoped recipient's email lists only their machines' sections.
      - Add one scoped case to each existing test of the other alert routes. Where a route has no test, cover it through adminUtils and health-check, and say so in the Log.
  - Done when: the touched tests pass; `cd web && npx jest __tests__/api __tests__/lib` is green; tsc and eslint are clean.

- [x] **Task 4.5: Browser hooks: alert toasts and autonomous chats follow scope**
  - Files: `web/hooks/useAgentAlertToasts.ts`, `web/hooks/useHoot.ts`, `web/__tests__/hooks/useAgentAlertToasts.test.ts` (new), `web/__tests__/hooks/useHoot.autonomous.test.ts` (new)
  - Depends on: 2.1, 3.1
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`.
    - **`useAgentAlertToasts(siteId, onUseSuggestedPath?, launchCopyOf?, machineIds?: readonly string[] | null)` (47-…):**
      - With an array, `[]` opens no listener; otherwise add `where('machineId', 'in', ids.slice(0, MAX_MACHINE_SCOPE))` to the query at 65-69.
      - The effect deps use a stable key of the sorted ids.
      - null keeps today's query.
    - **`useOwletteChat` (useHoot.ts:123-145)** options gain `includeAutonomous?: boolean`, defaulting to true so HootChatView keeps compiling. Task 7.6 makes it required and drops the default. When it is false:
      - the history effect (627-730) builds no `autoQuery`, so `autoLoaded` starts true;
      - `loadMore` (806-830) skips the autonomous page.

      Doc: autonomous hoot chats are whole-site (rules 2.12.0).
    - **Tests:**
      - toasts: a scoped query carries the `in` filter; `[]` subscribes nothing; null is unchanged.
      - `useOwletteChat` with `includeAutonomous:false` runs only the user query; with true it runs both, as it does today.
  - Done when: the new tests pass along with `__tests__/hooks/useHoot.*.test.ts`, and eslint is clean.

- [x] **Task 4.6: The e2e seed helper takes a machine scope**
  - Files: `web/e2e/helpers/seed.ts`
  - Depends on: 3.1
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`.
    - Release 2's `extra` argument on `seedMemberRow` (211-228) and `grantMembership` (186-200) gains `machineIds?: string[]`. It is spread into the row only when given.
      - An explicit `[]` is written as `[]`: the empty-scope e2e needs it.
      - Nothing ever writes null.
    - Both JSDocs gain this line: "a row with machineIds is a scoped member: it reaches only those machines and nothing site-wide".
    - No spec changes. Every existing caller is unchanged.
  - Done when: `cd web && npx eslint e2e/helpers/seed.ts` is clean, and `npx playwright test --list` still lists the suite. Do not run the rig.

- [x] **Task 4.7: ADR 0016 and the glossary**
  - Files: `docs/adr/0016-members-can-be-scoped-to-machines.md` (new), `GLOSSARY.md`
  - Depends on: 3.1
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`. Write the ADR in `docs/adr/0013-*`'s format: a `#` title, one paragraph, then `## Consequences` bullets. The number is fixed: 0015 is release 2's add-member search rule.
    - **Title:** "A member can be limited to machines, and only whole-site members reach anything site-wide".
    - **The paragraph:**
      - What drove it: giving one person on another owlette account control of one machine meant moving the machine to a site of its own.
      - The field `machineIds` (1–30 machines of the site). With it, a person reaches only those machines, at their site role, with their swoop mode applying there and nowhere else (release 2), and reaches nothing site-wide whatever their role. Without it, the row is whole site, so every existing row is unchanged.
      - The three fail-closed layers:
        - the rules: `canAccessMachine`, `canAccessWholeSite`, and `isSiteAdmin` needing whole site;
        - the server: `resolveSiteAccess`'s facts; release 2's one `siteStanding` builder; the wrapper's scope step before the capability kill switch; the `_shared` gates' default refusal; and `hasCapability`'s order (role matrix, then swoop mode, then scope);
        - the dashboard, which queries exactly the listed machines, because rules are not filters.
      - Moving a machine between sites is out: fielded agents cannot follow a server-side move.
    - **Consequences:**
      - `canAccessSite` admits scoped members, and is reserved for the site document, `settings/{swoop,display,cortex}`, and the schedule and reboot presets.
      - An out-of-scope machine answers 404 'machine not found or no access'. A site-wide route, kill and the site's swoop sessions list included, answers 403.
      - `[]` reaches nothing. Widening is `PATCH {machineIds:null}`, never `[]`. Owners' rows and your own row cannot be scoped.
      - The 30 cap comes from Firestore's `in` limit.
      - Rollback order: remove scoped members first (old code ignores the field and widens them), then the web, then the rules. Never redeploy an older Railway deployment, or serve an older Vercel standby, while a scoped row exists.
      - Site logs are filtered by machineId. Autonomous hoot chats stay whole site. Alert emails reach a scoped member only for their machines.
      - Removing a machine, and pairing a machine whose document had gone, drop its id from every member's scope.
      - In a shared swoop session, narrowing takes someone's seat out within one lease plus 30 s; alone, the session ends within about 2 s.
      - Fielded agents are untouched (ADR 0001).
    - **GLOSSARY, under "Pairing and access"**, after release 2's entries following **Site role**, add:
      - **Machine scope**: "The machines a member row lists in `machineIds`, at most 30. Someone with one, a scoped member, sees and acts on only those machines: their site role and their swoop mode apply there and nowhere else, and nothing that spans machines reaches them. A scoped admin is a scoped member whose role is admin. The members section shows "N machines"; UI copy says "limited to some machines"." _Avoid_: allowlist, machine permissions, partial member, "scope" alone.
      - **Whole site**: "A member row with no machine scope: every machine of the site, and the only standing that reaches what spans machines: the site's settings, members and presets pages and APIs, deployments, roost, talons, webhooks, kill and the site's swoop sessions list, and the audit log. Owners are always whole site." _Avoid_: full member (it reads as the site role `member`), unscoped member.
    - **Amend existing entries**, keeping release 2's wording around each:
      - **Site** (:9-11): after "…attach to", add "; a membership can be narrowed to some of its machines (machine scope)".
      - **Site role**: add "A machine scope narrows which machines a role covers, never what it allows."
      - **Viewer**: add "on a machine their access covers" to both the watching half and the control half of release 2's text.
      - **Kill**: where release 2's text says a site owner or admin, make it "a whole-site owner or admin".
    - **Add a flagged ambiguity:**
      - **scope.** An API key's scopes (`site=<id>:read`), a talon's `scope.machineIds`, and a member's machine scope (`machineIds` on the member row) are three different things. Say which.
  - Done when:
    - the ADR is one paragraph plus consequences;
    - the glossary has both new entries, the four amendments and the flagged ambiguity;
    - nothing else in GLOSSARY.md changed.

- [x] **Task 4.8: MachineAccessField, the machines half of a person's access**
  - Files: `web/components/admin/sites/MachineAccessField.tsx` (new), `web/__tests__/components/admin/sites/MachineAccessField.test.tsx` (new)
  - Depends on: 2.1, 3.1
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`. This is a route-agnostic field. Task 7.9 renders it inside release 2's `MemberAccessFields`.
    - **Props:** `{ machines: { id: string; name: string }[]; value: string[] | null; onChange: (next: string[] | null) => void; disabled?: boolean; idPrefix: string }`, where null means whole site.
    - **The choice.** Use release 2's shared `SegmentedControl` (`web/components/admin/SegmentedControl.tsx`), labelled `access`, with the options "whole site" | "some machines".
      - Picking "some machines" from null sets `[]`, which stays invalid until a machine is picked.
      - Picking "whole site" sets null.
    - **The picker.** In "some machines" mode, render `MultiSelect` (`web/components/ui/multi-select.tsx`) with:
      - `groups=[{ group: null, options: machines.map(m => ({ value: m.id, label: m.name })) }]`;
      - `allLabel="pick machines"`, `itemNoun="machines"`, `searchPlaceholder="search machines…"`;
      - `data-testid={\`${idPrefix}-machines\`}`.
    - **Empty never means all.** Here MultiSelect's empty selection, and its "none" button, mean NONE picked. While the value is `[]`, the field shows "pick at least one machine" in `text-danger`. Above MAX_MACHINE_SCOPE it shows "at most 30 machines".
    - **The hint** under the choice:
      - whole site: "every machine, and the site-wide pages their role allows: settings, members, deployments, roost and talons."
      - some machines: "only the machines you pick: their role and swoop apply there. nothing site-wide, whatever their role."
    - **Exports:**
      - `isAccessValid(value)` = `value === null || (value.length >= 1 && value.length <= MAX_MACHINE_SCOPE)`;
      - `accessLabel(machineIds: readonly string[] | null)`: 'whole site', 'no machines', '1 machine' or `${n} machines`;
      - `liveMachineIds(value, machines)`: the value filtered to ids that are still machines of the site. A saved dead id would 400.
    - **Tests:**
      - whole site gives null; some machines gives `[]`; picking gives `['m1']`;
      - MultiSelect's "none" in some-machines mode leaves `[]` and shows the hint. It never widens;
      - `isAccessValid`, `accessLabel` and `liveMachineIds`;
      - the choice is a labelled group with `aria-pressed` buttons.
  - Done when: the test passes, and eslint and tsc are clean.

## Wave 5: gates, hoot, swoop, builders, AuthContext, leaving machines

- [x] **Task 5.1: authorizedSiteHandler: machine scope is part of site access**
  - Files: `web/lib/authorizedHandler.server.ts`, `web/__tests__/lib/authorizedHandler.test.ts`
  - Depends on: 4.1
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`. The actor already carries the scope (task 4.1).
    - **A new step** right after the actor is built and before "// 5. Read kill-switch config" (~622). It runs unconditionally, before `securityConfig.read()`, so `capability_enforcement=false` can never widen a scope:
      ```ts
      // machine scope is part of site access, like membership: the kill switch never reaches it.
      const routeMachineId = await extractRouteParam(routeParamsPromise, 'machineId');
      const machineScope = outcome.facts.machineIds;
      if (machineScope !== null) {
        if (routeMachineId !== null && !machineScope.includes(routeMachineId)) {
          denyAudit(siteId, { correlationId, actor, capability: options.capability, target: { kind: targetKind, id: targetId } as AuditTarget, outcome: 'deny', denyReason: 'machine_out_of_scope', metadata: { route: request.nextUrl.pathname, method: request.method, machineId: routeMachineId } });
          return problemNotFound('machine not found or no access');
        }
        if (routeMachineId === null || !isMachineCapability(options.capability)) {
          denyAudit(siteId, { …, denyReason: 'machine_scope_site_wide', metadata: { route: request.nextUrl.pathname, method: request.method, ...(routeMachineId ? { machineId: routeMachineId } : {}) } });
          return /* the same refusal the capability step returns for this capability */;
        }
      }
      ```
      - The 403 reuses the capability step's refusal expression (release 2), so a bypass-exempt swoop capability refused here carries `code: 'capability_missing'`, and every other capability gets the plain `forbidden`. Swoop's viewer ends only on a coded refusal.
      - Read `params.machineId` directly. targetIdParam and apiKeyScope.idParam miss the 8 process verbs and uninstall (research routes-machines §2).
      - `metadata.machineId` on the site-wide deny matters on uninstall, whose audit target id is the siteId.
      - The 404 deliberately matches 'site not found or no access', and does not reveal whether the machine exists.
    - **The capability step** (~683) becomes `hasCapability(actor as Actor, options.capability, siteId, routeMachineId ?? undefined)`.
    - **The pipeline comment** (1-28) gains the new step.
    - **Tests.** Extend the file's setup:
      - `setMember` (release 2 gave it `extra`) takes `machineIds` through `extra`;
      - the double returns the site doc for other `sites/…` paths, so assert outcomes, not machine reads;
      - pass the route params `{ siteId, machineId }`.

      Cases:
      - A scoped member, `['m1']`:
        - a MACHINE_VIEW route on m1 runs the handler;
        - on m2 it gets 404 'machine not found or no access', a deny audit with denyReason `machine_out_of_scope` and `metadata.machineId` 'm2', and no handler call.
      - A scoped member set to control, `['m1']`: a MACHINE_REMOTE_CONTROL route on m1 runs; on m2 it gets 404.
      - A scoped admin, `['m1']`:
        - MACHINE_EXEC_COMMAND on m1 runs;
        - MACHINE_REMOVE on m1 gets 403 with `machine_scope_site_wide` and `metadata.machineId` 'm1';
        - SWOOP_SETTINGS_MANAGE on m1 (kill's shape) gets 403 with body `code: 'capability_missing'`;
        - with no machineId, SITE_MEMBER_MANAGE gets 403, and so does SWOOP_SETTINGS_MANAGE (the site sessions list's shape).
      - A scoped admin set to view, `['m1']`: MACHINE_REMOTE_CONTROL on m1 gets 403 `capability_missing` from the capability step.
      - With the kill switch off (pattern near L373), all of the above still refuse, and a whole-site member still reaches a non-exempt route, so the bypass is intact.
      - An api key owned by a scoped user, with `machine=*:write`, gets 404 on m2.
      - A superadmin with no row runs on m2. A whole-site admin is unchanged.
      - `siteDocReads` stays 1.
  - Done when: the authorizedHandler tests are green; `cd web && npx jest` is green (route suites that mock the wrapper are unaffected); tsc and eslint are clean.

- [x] **Task 5.2: The `_shared` and apiAuth gates learn machine scope**
  - Files: `web/app/api/_shared.ts`, `web/lib/apiAuth.server.ts`, `web/__tests__/api/_shared.test.ts`, `web/__tests__/lib/apiAuth.test.ts`, `web/__tests__/api/scopeEnforcement.test.ts`
  - Depends on: 4.1
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`. The capability builders already carry the scope (task 4.1); this task adds the gates.
    - **`apiAuth.server.ts`:** `assertUserHasSiteAccess` (426-446) returns `{ siteId, siteData, machineIds: outcome.facts.machineIds }`. Keep the throws and their messages exactly; the suite asserts them.
    - **`_shared.ts`:**
      - `ScopedAuthSuccess` gains `machineIds: readonly string[] | null`. It is null for agents, superadmins and whole-site members.
      - `assertSiteAccessOrProblem` (468-498) also returns `machineIds: access.machineIds ?? null`. Suites mock the adapter without the field.
      - `requireSiteAuthAndScope(req, siteId, permission, options: { machineScope?: 'deny' | 'admit' } = {})` (500-541). After the access check:
        - a scoped caller without `machineScope: 'admit'` gets `problemForbidden('capability not granted')`;
        - with `'admit'`, the result carries machineIds.

        Its doc comment says the default deny keeps every site-wide read closed to a scoped member (audit log, quota, roosts, chunks, webhooks, the events stream), and a route that admits must filter or check.
      - New `export async function requireSiteMachineAuthAndScope(req, siteId, machineId, permission)`:
        - it calls `requireSiteAuthAndScope(…, { machineScope: 'admit' })`;
        - then it checks `scopeCovers(result.machineIds, machineId)`, and answers `problemNotFound('machine not found or no access')` if it fails.

        It is for single-machine routes that keep their `site=` api-key scope.
      - `requireMachineAuthAndScope` (558-627): after the access check (610-611) and before `runScopeCheck`, a machine outside the scope gets 404 'machine not found or no access'. The agent short-circuit (586-605) stays first and returns machineIds null.
      - `requireRoostAuthAndScope` (629-691): a scoped caller gets 403 'capability not granted' after the access check, reads included. Roost is site-wide.
      - `requireChatAuthAndScope` (746-780) admits scoped callers and returns their machineIds.
      - `requireAgentOrSiteAuthAndScope` (782-829): its user path inherits the default deny; its agent path is unchanged.
      - `requirePlatformAuthAndScope` returns machineIds null.
    - **Tests:**
      - `_shared.test.ts`:
        - requireSiteAuthAndScope refuses a scoped caller with 403 by default, and admits them with `admit`, returning `['m1']`;
        - requireSiteMachineAuthAndScope: m1 is ok, m2 is 404;
        - requireMachineAuthAndScope: scoped m1 is ok, m2 is 404, and an agent token for m2 is ok (the short-circuit);
        - requireRoostAuthAndScope refuses a scoped read with 403;
        - requireChatAuthAndScope returns machineIds;
        - `requireSiteCapability` refuses a scoped admin MACHINE_ENROLL and allows a whole-site admin.
      - `apiAuth.test.ts`: assertUserHasSiteAccess returns machineIds. assertUserHasSiteCapability refuses MACHINE_ENROLL to a scoped admin, and to a member set to swoop control, and allows a whole-site admin.
      - `scopeEnforcement.test.ts`: its mock, which has no machineIds, keeps passing as whole site. Add one scoped case per gate.
  - Done when: these suites and all of `__tests__/api` are green (route suites mock these gates), and tsc and eslint are clean.

- [x] **Task 5.3: hoot reaches only the machines in scope**
  - Files:
    - `web/lib/hoot-utils.server.ts`, `web/lib/hootStream.server.ts`
    - `web/lib/hoot/turnRunner.server.ts`, `web/lib/hoot/followupSweep.server.ts`
    - `web/lib/talons/hootOutput.server.ts` (one call)
    - `web/app/api/hoot/route.ts`
    - `web/__tests__/lib/hoot-utils.test.ts`, `web/__tests__/lib/hootStream.test.ts`, `web/__tests__/lib/hoot/turnRunner.test.ts`, `web/__tests__/lib/hoot/followupSweep.test.ts`, `web/__tests__/lib/hoot/talon-tools.test.ts`, `web/__tests__/api/hoot-turn.test.ts`
  - Depends on: 4.1
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`. Release 2 left hoot's builders alone, because they never read a member row; this task routes them through `siteStanding`.
    - **`SiteAccessLevel`** (hoot-utils ~370-380) gains `standing: MemberStanding`, and `verifyUserSiteAccess` (425-468) returns `standingOf(facts)`. Doc on `isSiteAdmin`: it stays the role, which still decides the tool tier. A scoped admin gets tier 3 on their machines (decision 3), and `standing.machineIds` narrows where it applies.
    - **`listSiteMachines(db, siteId, scope: readonly string[] | null)`** (583-594) takes a required third parameter. When the scope is an array (`Array.isArray`, so a test calling without it stays whole site), it filters the docs to the scope. Every caller states it:
      - resolveHootTargets (708) passes `request.scope`;
      - hootStream's site mode (91) passes `access.standing.machineIds`;
      - turnRunner (550) passes `params.access.standing.machineIds`, as defense in depth;
      - `talons/hootOutput.server.ts:198` passes `null`, with a comment that a talon's author is whole site (task 6.5 enforces it).
    - **`ResolveHootTargetsRequest`** (641-647) gains a required `scope: readonly string[] | null`. resolveHootTargets reads `request.scope ?? null` (tests build requests without it) and passes it to listSiteMachines:
      - an out-of-scope id is `unknown_machine` (400, and nothing leaks);
      - `requested: null` (all machines) means all machines in scope.
    - **The hoot route `web/app/api/hoot/route.ts`:** both resolveHootTargets calls (285, 315) pass `scope: access.standing.machineIds`.
    - **Other callers.** If tsc names another production caller of `listSiteMachines`, `resolveHootTargets` or `buildExecutableTools`, pass its access's scope the same way, as long as no other wave-5 task lists that file, and name it in your Log. Otherwise stop and log it.
    - **followupSweep:**
      - `resolveFollowupTarget` (199-229) gains a `scope` parameter and passes it to both of its resolveHootTargets calls (204, 225);
      - the call at 286 passes `access.standing.machineIds`, resolved at 266;
      - a machine dropped from the scope narrows the follow-up, as a machine that left the site does.
    - **`BuildExecutableToolsOptions`** (125-188):
      - `userSiteRole?: MembershipRole` becomes `userStanding?: MemberStanding`, the person's standing on the site (role, swoop mode, machine scope). Without it, every site-scoped tool still denies.
      - A new REQUIRED `machineScope: readonly string[] | null` drives what the model is offered. It is separate from `userStanding` because the conversations API (hootStream) builds its actor without site standing, as today, yet must still hide site-wide tools. Required, so a new caller cannot forget it; at runtime `undefined` (a test literal) reads as whole site.
      - `actionContextForHoot` (217-226) builds the actor with `...siteStanding(options.userStanding ? { [siteId]: options.userStanding } : {})`.
      - `buildExecutableTools` (2075-…) skips every tool in a new exported `SITE_WIDE_SERVER_TOOLS` set (`get_site_logs`, `deploy_software`, `create_talon`, `list_talons`, `set_talon_enabled`) when `options.machineScope` is an array.
      - turnRunner (613-624) passes `userStanding: params.access.standing, machineScope: params.access.standing.machineIds`.
      - hootStream (434-443, 503-512) passes `machineScope: access.standing.machineIds`, and no standing, as today.
    - **hootStream's machine mode** (132-143): before `isMachineOnline`, `if (access.standing.machineIds && !access.standing.machineIds.includes(machineId)) return { ok: false, status: 404, error: 'machine not found or no access' }`. This covers both copies of the conversation routes: `/api/hoot/conversations/{id}` and `/api/chat/{id}`.
    - **Tests:**
      - hoot-utils:
        - verifyUserSiteAccess returns the standing;
        - resolveHootTargets with scope `['m1']`: `requested:null` gives ids `['m1']` only; `['m2']` gives unknown_machine `['m2']`; a mention of m2 gives unknown_machine;
        - scope null is unchanged;
        - buildExecutableTools with `machineScope:['m1']` omits the five tools and keeps the per-machine ones;
        - the actor from actionContextForHoot carries machineScopes and swoopModes from `userStanding`.

        Replace the three `userSiteRole` literals here and in talon-tools.test.ts with `userStanding: { role, swoopMode: null, machineIds: null }`.
      - hootStream: scoped site mode dispatches only to in-scope online machines, and offers none of the five tools. Machine mode on an out-of-scope id gives 404 before any machine read.
      - turnRunner: a scoped turn passes the standing and scope through.
      - followupSweep: a follow-up whose machine left the scope narrows.
      - hoot-turn: a scoped caller asking for `['m2']` gets 400 unknown_machine.
  - Done when: these suites and `__tests__/api/hoot-*.test.ts`, `__tests__/api/chat.test.ts` and `__tests__/lib/talons` are green, and tsc and eslint are clean.

- [x] **Task 5.4: swoop: the policy passes the machine, and revocation narrows by machine**
  - Files: `web/lib/swoop/policy.server.ts`, `web/lib/swoop/revokeViewerSessions.server.ts`, `web/__tests__/lib/swoop/policy.server.test.ts`, `web/__tests__/lib/swoop/lease.test.ts`, `web/__tests__/hooks/useSwoopSession.test.tsx`
  - Depends on: 4.1
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`. Re-read both files first. Release 1 changed how a seat leaves a session, and release 2 added the mode check and the `swoop_changed` reason. Keep both mechanisms and add only the machine.
    - **`evaluateSwoopAccess`:** the capability check becomes `hasCapability(input.actor, capability, input.siteId, input.machineId)`.
      - It stays BEFORE `step_up_required`, so no step-up window is ever written for a machine out of scope. The create route's fresh-ceremony and mfaProof branches write one on a `step_up_required` refusal.
      - The refusal stays 403 `capability_missing`, already a withdrawal (`web/lib/swoop/backoff.ts:89-95`).
      - `members_may_not_watch` is release 2's rule: it applies only to a member with no explicit mode. A scoped row keeps its role and its mode, so the rule is unchanged.
      - No new deny code: the wrapper's 404 refuses an out-of-scope machine first, and the viewer treats a 404 at create as final.
    - **`revokeSwoopSessionsForUser`:**
      - The reason union gains `'scope_changed'`.
      - New `keepMachineIds?: readonly string[]`, documented as "a scope was narrowed". When it is given:
        - every seat on a machine outside the list ends, whatever it is, and its audit row says `scope_changed`;
        - a seat on a listed machine ends only when `controlOnly` is set and it holds control, and its audit row says `args.reason`.

        Without it, today's rules hold: with `controlOnly`, control seats end; without, every seat ends.
      - Seats leave through release 1's `removeSwoopViewers`. A session ends only when nobody is left in it.
      - Name the third trigger in the header comment (1-16), and restate the bound: about 2 s when the person is alone in the session; within one lease plus 30 s when it is shared.
    - **Tests, policy.server.test.ts.** Extend release 2's cross-check over role × mode × `membersMayWatch` with scope (whole site, `['m1']`) × machine (m1, m2):
      - `evaluateSwoopAccess` for view is ok exactly when `effectiveSwoopMode !== 'none'` and the machine is covered;
      - for control with `stepUpOpen: true`, exactly when it is `'control'` and covered;
      - on m2 under `['m1']`, every ask gives `capability_missing`, before `members_may_not_watch` and before `step_up_required`.

      Named cases:
      - a scoped member set to control: control on m1 without a window gives `step_up_required`, and is ok with `stepUpOpen: true`; m2 gives `capability_missing` even with `stepUpOpen`;
      - a scoped member with no mode, `membersMayWatch` off: watching m1 gives `members_may_not_watch`;
      - the same row with `view`: ok;
      - `evaluateLeaseRenewal` with m1 dropped from the scope gives `capability_missing`.
    - **Tests, lib/swoop/lease.test.ts** (the revocation section, ~211+):
      - `keepMachineIds: ['m1']` alone takes the person's seat on m2 out with `scope_changed`, and leaves their m1 seats;
      - with `controlOnly`, a control seat on m1 goes too, with `args.reason`;
      - in a shared m2 session, the seat goes and the session continues for the other viewer;
      - alone in it, the session ends.
    - **Tests, useSwoopSession.test.tsx**, beside 'a policy refusal on the mint is final' (~354): `mint = { status: 404, body: { detail: 'machine not found or no access' } }`, with no code, puts the state in error with that detail and `retryIn` null. There is no second mint after 60 s, and no "this machine has left the site." (release 1's copy).
  - Done when: these suites and `__tests__/api/swoop/*.test.ts` are green, and tsc and eslint are clean.

- [x] **Task 5.5: The talons store and users/me state a standing**
  - Files: `web/lib/talons/store.server.ts`, `web/app/api/users/me/route.ts`, `web/__tests__/lib/talons/store.test.ts`
  - Depends on: 4.1
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`.
    - **The successor actor** in talons/store.server.ts (~600-631) reads the member row by hand. It becomes `...siteStanding({ [siteId]: memberStanding(memberData ?? null) })`, replacing the hand parse of `rawSiteRole`. `successorRejection` (640-655) then refuses a scoped successor with `insufficient_role`, because TALON_MANAGE is site-wide.
    - **users/me/route.ts:80** becomes `{ type: 'user', userId, role, ...siteStanding({}) }`.
    - **Tests:**
      - reassigning to a scoped admin gives `insufficient_role`;
      - reassigning to a member set to swoop control gives `insufficient_role` (a mode never grants TALON_MANAGE);
      - reassigning to a whole-site admin is ok.
  - Done when: the talons store tests and `__tests__/api/sites-talons*.test.ts` are green, and tsc and eslint are clean.

- [x] **Task 5.6: AuthContext: machineScope, isMachineAdmin and siteRole**
  - Files: `web/contexts/AuthContext.tsx`, `web/__tests__/contexts/AuthContext.test.ts`
  - Depends on: 4.3
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`. Release 2 does not touch this file, and the dashboard does not read the swoop mode (release 2, decision 26).
    - Take `scopeMap` from `useSiteMemberships` (1195) as well.
    - **Exported pure helpers**, beside 248-306. The scope map is a new REQUIRED last parameter of the three existing helpers, so every existing call in `AuthContext.test.ts` passes `new Map()`; nothing defaults it.
      - `computeIsSiteAdmin(role, roleMap, siteId, scopeMap)`: owner or admin AND `!scopeMap.has(siteId)`.
      - `computeIsSiteOwner(role, roleMap, siteId, scopeMap)`: the same rule.
      - `computeAdministersAnySite(role, roleMap, scopeMap)`: some owner or admin site that is not in scopeMap.
      - New `computeMachineScope(role, scopeMap, siteId): readonly string[] | null`: null for a superadmin, else `scopeMap.get(siteId) ?? null`.
      - New `computeIsMachineAdmin(role, roleMap, scopeMap, siteId, machineId)`: true for a superadmin; false with a null role; otherwise owner or admin AND `scopeCovers(scopeMap.get(siteId) ?? null, machineId)`.
    - **`AuthContextType` (355-394) gains:**
      - `machineScope: (siteId: string) => readonly string[] | null`, documented "null = whole site";
      - `isMachineAdmin: (siteId: string, machineId: string) => boolean`, documented "owner or admin whose access covers the machine, or a superadmin: gates commands, process config and displays on that machine. swoop is not here: the server decides it from the role, the swoop mode and the scope";
      - `siteRole: (siteId: string) => SiteRole | null`, the role map's value. It is for labels only, never for a gate.
    - **Rewrite the isSiteAdmin doc:** "whole-site owner or admin (or superadmin): gates site-wide surfaces such as site settings, members, the admin panel, remove machine, revoke token and clear logs; false for a scoped row".
    - **Defaults** (396-410): `machineScope: () => null`, `isMachineAdmin: () => false`, `siteRole: () => null`. Add useCallback wrappers after 1247, and add them to the value and its deps (1249-1275).
    - **Tests** (AuthContext.test.ts, near computeIsSiteAdmin ~L58):
      - a scoped admin:
        - isSiteAdmin is false;
        - isMachineAdmin is true for m1 and false for m2;
        - administersAnySite is false, and true when another site is a whole-site admin;
      - a malformed scoped owner row gives isSiteOwner false;
      - a whole-site row is unchanged; a superadmin is true everywhere;
      - computeMachineScope;
      - siteRole returns the row's role, scoped or not.
  - Done when: the AuthContext tests and `__tests__/contexts/AuthContext.accessResolution.test.tsx` are green, and tsc and eslint are clean.

- [x] **Task 5.7: A machine id leaves every scope when its machine leaves, or pairs anew**
  - Files:
    - `web/lib/actions/removeMachine.server.ts`, `web/lib/pairingPlan.server.ts`
    - `web/app/api/agent/auth/device-code/poll/route.ts`, `web/app/api/agent/auth/exchange/route.ts`
    - `web/__tests__/lib/actions/removeMachine.test.ts`, `web/__tests__/lib/pairingPlan.test.ts` (new), `web/__tests__/api/agent/device-code.test.ts`, `web/__tests__/api/agent/exchange.test.ts`
  - Depends on: 4.2
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`.
    - **Why a removal prune alone is not enough.** Machine ids start as hostnames and get reused, so a member row must never keep a grant to an id from before that machine paired. The dashboard's removal goes through `removeMachine`, but the desktop app's own leave-site does not:
      - `run_leave_site` and the daemon's leave call `_deregister` (agent/src/configure_site.py:665-720, 781-795, 1929), which deletes `sites/{S}/machines/{id}` through the agent's REST client;
      - so the member rows keep the id. A replacement kiosk with the same hostname, or TEC-B4A paired back to TEC (open question 9), would inherit the grant.
    - **`removeMachine.server.ts`:** after the machine+config batch (77-80), and after release 1's sweep of the machine's swoop sessions, call `pruneMachineFromMembers({ siteId, machineId, db })` in its own try/catch with a `logger.warn`, like the best-effort deletes beside it. A failure is non-fatal: the pairing prune below catches the id later. Mention it in the header comment (1-16).
    - **`pairingPlan.server.ts`:** rename `stampPairedAt` to `recordPairing(siteId, machineId)`. Its transaction already reads the machine doc; make it return whether the doc existed.
      - When it did not, after the transaction, `await pruneMachineFromMembers({ siteId, machineId })` in its own try/catch with `logger.warn`. Missing means one of two things: an id new to this site, or one whose doc a leave deleted, by dashboard removal or the desktop app's leave-site.
      - When it did exist (a re-pair of a machine still on the site, legacy docs with no `pairedAt` included), keep the grants.
      - Rewrite its doc for both jobs.
    - **The call sites** pass the new name: poll route :355 and :378, and exchange :175. Update the mocks in device-code.test.ts and exchange.test.ts.
    - **Tests:**
      - removeMachine: the removal calls the prune with the site and machine; a prune failure is logged and the removal still resolves.
      - `pairingPlan.test.ts`: a fake db plus a mocked `@/lib/membership.server`:
        - a missing doc stamps `pairedAt` and prunes once;
        - an existing doc prunes nothing;
        - an existing doc with no `pairedAt` is stamped and not pruned;
        - a prune failure is logged and still resolves;
        - a machine id containing `/` returns early, as today.
      - device-code and exchange: each success path calls `recordPairing`.
  - Done when: these suites and `__tests__/api/agent` are green, and tsc and eslint are clean.

## Wave 6: routes and route suites

- [x] **Task 6.1: Machine routes on the `_shared` gates check scope, and an inventory keeps it so**
  - Files:
    - `web/app/api/sites/[siteId]/machines/route.ts`, `web/app/api/sites/[siteId]/machines/[machineId]/route.ts` (GET only)
    - `web/app/api/sites/[siteId]/machines/[machineId]/deployments/route.ts`, `web/app/api/sites/[siteId]/machines/[machineId]/swoop/step-up/route.ts` (GET only)
    - `web/__tests__/api/sites-machines.test.ts`, `web/__tests__/api/swoop/step-up.test.ts`, `web/__tests__/api/machineRouteGates.test.ts` (new)
  - Depends on: 5.2
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`.
    - **The machines list** (route.ts:30) calls `requireSiteAuthAndScope(request, siteId, 'read', { machineScope: 'admit' })`.
      - When `auth.machineIds` is not null, keep only the machine docs in scope.
      - Their `currentRoosts` come along: roosts that target their machine are about their machine. Open question 6 covers this.
      - Say so in the header comment (2-5).
    - **Machine detail GET** (:38), **machine deployments GET** (:24) and **step-up GET** (:135) use `requireSiteMachineAuthAndScope(request, siteId, machineId, 'read')`. That keeps their `site=` api-key contract. Step-up GET stays off the wrapper, per its header (118-128).
    - **A new inventory test** (walker pattern: `web/__tests__/api/auditMutationCoverage.test.ts:170-247`). Walk every `route.ts` under `app/api/sites/[siteId]/machines/[machineId]/`. Each must:
      - name a machine-checking gate: `authorizedSiteHandler(`, `requireMachineAuthAndScope(`, `requireSiteMachineAuthAndScope(`, `createControlHandler(`, or `handleControlVerb(` (the four process verbs import it from `../_helpers`); or
      - be a pure re-export (`export { … } from`; e.g. cortex-enabled);
      - and never call `requireSiteAuthAndScope(` directly.

      Its failure message names the file and says to use a machine-checking gate.
    - **Tests:**
      - the list as a scoped member returns only m1; whole site is unchanged;
      - detail, deployments and step-up GET give 404 on m2 and 200 on m1;
      - the inventory passes on today's tree, and fails on a fixture string that calls `requireSiteAuthAndScope(` (test the matcher itself).
  - Done when: these suites and all of `__tests__/api` are green.

- [x] **Task 6.2: Site logs and the site document for scoped callers**
  - Files: `web/app/api/sites/[siteId]/logs/route.ts`, `web/app/api/sites/[siteId]/logs/[logId]/route.ts`, `web/app/api/sites/[siteId]/route.ts` (GET only), `web/__tests__/api/site-logs.test.ts`, `web/__tests__/api/sites.test.ts`
  - Depends on: 5.2
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`.
    - **Logs GET** (207) admits scoped callers. When the caller is scoped:
      - an empty scope gives an empty page at once;
      - a `machineId` query filter outside the scope gives an empty page at once, with no read;
      - otherwise, `fetchPage` (246-261) adds `query.where('machineId', 'in', scope)` (scope ≤ 30; the (machineId, timestamp desc) composite exists), and `include` (262-266) also requires `log.machineId !== null && scope.includes(log.machineId)`.

      A one-machine member never scans the whole collection (research routes-site risk: collectFilteredPage's loop).
    - **logs/{logId} GET** (37) admits scoped callers. One whose row has no machineId, or a machineId outside the scope, gets the same 404 as a missing log (47-55).
    - **`[siteId]/route.ts` GET** (50) admits them: the site document says nothing about machines. PATCH and DELETE are on the wrapper (and release 2's DELETE re-check), and already refuse scoped callers.
    - **Tests:**
      - a scoped list returns only m1 rows, and the query carried `machineId in ['m1']`;
      - `machineId=m2` gives an empty page with no read;
      - `[]` gives an empty page;
      - logs/{id} gives 404 for m2 and for a null-machine row, and 200 for m1;
      - GET site as a scoped caller gives 200;
      - whole site is unchanged.
  - Done when: these suites are green.

- [x] **Task 6.3: The members API reads and writes machine scope beside the swoop mode**
  - Files: `web/app/api/sites/[siteId]/members/route.ts`, `web/app/api/sites/[siteId]/members/[uid]/route.ts`, `web/__tests__/api/sites-members.test.ts`, `web/__tests__/lib/actions/transferSiteOwnership.test.ts`
  - Depends on: 4.2, 5.1, 5.4
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`. Build on release 2's handlers: the `swoop` field, the in-handler SITE_MEMBER_MANAGE re-checks and `updateMember`. Change only what machine scope needs.
    - **GET:** every member gains `machineIds: string[] | null` (`deriveMachineIds(row, rowRole)`), beside release 2's `swoop`. Update the header comment (1-24).
    - **POST** may carry `machineIds`:
      - When the key is present, validate it with `normalizeMachineIdsInput(body.machineIds, { allowNull: false })`. A failure gives 400 `problemValidation` on field `body.machineIds`. Absent means whole site.
      - After targetUid is resolved, `targetUid === ctx.actor.userId` with machineIds gives 403, code `cannot_modify_own_membership`, in the problem shape of `refuseSelfMembershipChange` (`[uid]/route.ts:80-98`).
      - Every id must exist as `sites/{siteId}/machines/{id}` (one getAll); otherwise 400 with field `body.machineIds: ['unknown machine: <ids>']`.
      - The owner guard already answers 409 `target_is_owner`.
      - Pass machineIds to `addMember`.
      - A re-add writes nothing, machine scope included, which `roleHonored: false` already says.
      - The emitMutation attributes gain `requestedMachineIds` when given.
    - **PATCH:**
      - **Body** `{ role?, swoop?, machineIds? }`. With none of the three, return `problemValidation('role, swoop or machineIds is required', …)` with each field's error `['provide at least one of role, swoop, machineIds']`. This replaces release 2's two-field message.
      - **Validation.** Release 2's self refusal and SITE_MEMBER_MANAGE re-check stay first, before the body read. Validate role and swoop as release 2 does. When the machineIds key is present, use `normalizeMachineIdsInput(…, { allowNull: true })`, plus the POST's existence check for arrays; null clears to the whole site.
      - Call `updateMember({ siteId, uid, role, swoop, machineIds })` inside `withIdempotency`.
      - **Failures.** `is_owner` keeps 409 `cannot_change_owner_role`, with the detail "the owner's role, swoop and access come with ownership; transfer ownership via POST /api/sites/{siteId}/transfer-ownership instead". `invalid_machine_ids` gives 400 on `body.machineIds`.
      - **One revocation per PATCH**, replacing release 2's branches. With `before` and `after` from the writer, `g(x) = grantedSwoopMode(x.role, x.swoop)`, and `roleMoved = role !== undefined`:
        ```ts
        const watchLost = g(before) !== 'none' && g(after) === 'none';
        const controlLost = g(before) === 'control' && g(after) !== 'control';
        const narrowed = after.machineIds !== null &&
          (before.machineIds === null || before.machineIds.some((id) => !after.machineIds!.includes(id)));
        if (watchLost) revoke({ reason: roleMoved ? 'role_changed' : 'swoop_changed' }); // every seat
        else if (controlLost || narrowed) revoke({
          reason: controlLost ? (roleMoved ? 'role_changed' : 'swoop_changed') : 'scope_changed',
          ...(controlLost ? { controlOnly: true } : {}),
          ...(narrowed ? { keepMachineIds: after.machineIds! } : {}),
        });
        ```
        It is fire and forget (`void`), as now, with `actor`, `auditActor` and `correlationId` as today. Seats on dropped machines are audited `scope_changed` inside the revoke (task 5.4).
      - **Emit.** The verb is `member_role_changed` when a role was sent, else `member_swoop_changed` when a swoop was sent, else `member_access_changed`. Attributes carry each field that was sent (`role`, `swoop`, `machineIds`).
      - **The response** is `{ siteId, uid, role: after.role, swoop: after.swoop, machineIds: after.machineIds }`.
      - **Rewrite the PATCH doc comment:** machine scope, and the one revocation.
    - **Tests** (sites-members.test.ts, with release 2's mocks):
      - GET returns machineIds, both an array and null, beside swoop.
      - POST:
        - `['m2','m1']` writes the sorted field;
        - an unknown machine, `[]`, 31 ids or a bad shape each give 400;
        - self with machineIds gives 403 cannot_modify_own_membership;
        - the owner gives 409 target_is_owner;
        - an existing member gives 200, roleHonored false, and no write.
      - PATCH:
        - machineIds only writes the field, keeps role and swoop, and calls revoke with `keepMachineIds` and reason `scope_changed` and no `controlOnly` (mirror the controlOnly assertion near L1083);
        - machineIds null writes `FieldValue.delete()`, and does not revoke;
        - `{swoop:'view', machineIds:['m1']}` on an admin with no mode makes ONE revoke call with `controlOnly: true`, `keepMachineIds: ['m1']` and reason `swoop_changed`;
        - `{swoop:'none', machineIds:['m1']}` makes one revoke call with neither filter;
        - `{role:'member'}` on an admin with no mode gives controlOnly with `role_changed` (release 2's case, unchanged);
        - widening, from `['m1']` to null, does not revoke;
        - narrowing from `['m1','m2']` to `['m1']` revokes with keep `['m1']`, and re-sending the same list does not revoke;
        - `{}` gives 400 with the new message;
        - the owner gives 409, and self gives 403 before any body read;
        - the response carries all three fields, and the three verbs are emitted as above.
      - transferSiteOwnership.test.ts: a scoped successor's member row is written WITHOUT machineIds or swoop, because an owner is whole site and always controls. The existing `tx.set` (transferSiteOwnership.server.ts:140-146) already does this; the test pins it.
  - Done when: these suites and `__tests__/api/membershipEscalation.test.ts` are green, and tsc and eslint are clean.

- [x] **Task 6.4: hoot routes refuse machines outside scope**
  - Files: `web/app/api/hoot/cancel-tool/route.ts`, `web/app/api/hoot/provision-key/route.ts`, `web/app/api/hoot/conversations/route.ts`, `web/app/api/chat/new/route.ts`, `web/__tests__/api/hoot-cancel-tool.test.ts`, `web/__tests__/api/hoot-provision-key.test.ts`, `web/__tests__/api/chat.test.ts`
  - Depends on: 5.2, 5.3
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`.
    - **cancel-tool:**
      - After verifyUserSiteAccess (121) and before the chat checks, an out-of-scope `machineId` gets `NextResponse.json({ error: 'machine not found or no access' }, { status: 404 })`, in this route's JSON shape.
      - The actor (177-185) is built with `...siteStanding({ [siteId]: access.standing })`.
    - **provision-key:**
      - The same 404, before the capability check (76).
      - The actor (69-75) goes through `siteStanding`.
      - The check becomes `hasCapability(actor, Capability.MACHINE_EXEC_COMMAND, siteId, machineId)`.
    - **hoot/conversations POST**, after requireChatAuthAndScope (230-231): `if (machineId && !scopeCovers(auth.machineIds, machineId)) return problemNotFound('machine not found or no access')`.
      - Make the same change in its copy, `/api/chat/new/route.ts`. The `/api/chat` routes are full copies, not re-exports (an owner backlog note), so a fix lands in both.
      - A site-wide conversation (no machineId) is allowed: runHootStream narrows it to the caller's machines (task 5.3).
    - **Tests, for each route:**
      - a scoped caller on m2 gets 404, with nothing queued or written;
      - m1 gives today's success;
      - whole site is unchanged.
  - Done when: these suites are green.

- [x] **Task 6.5: Talons whose author is limited to some machines stop**
  - Files: `web/lib/talons/author.server.ts`, `web/__tests__/lib/talons/author.test.ts`
  - Depends on: 5.3
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`.
    - In `resolveTalonAuthor` (70-98), after verifyUserSiteAccess: `if (access.standing.machineIds !== null) throw new TalonAuthorError('creator_access_revoked', \`Talon ${talon.id} author ${userId} is limited to some machines; a talon needs whole-site standing.\`)`.
    - The engine disables the talon, as when an author is removed; reassigning it keeps it.
    - Doc: why. Talons span the site, their hoot outputs list every machine (`talons/hootOutput.server.ts`, which passes a whole-site scope), and TALON_MANAGE is site-wide.
    - **Tests:**
      - a scoped author gives `creator_access_revoked`;
      - an author with `machineIds: []` does too;
      - a whole-site author is unchanged.
  - Done when: `__tests__/lib/talons` is green, and tsc and eslint are clean.

- [x] **Task 6.6: swoop and site-wide route suites prove the scope with the real wrapper**
  - Files:
    - `web/__tests__/api/swoop/sessions.test.ts`, `web/__tests__/api/swoop/site-sessions.test.ts`, `web/__tests__/api/swoop/settings-and-kill.test.ts`, `web/__tests__/api/swoop/lease.test.ts`
    - `web/__tests__/api/display-settings.test.ts`, `web/__tests__/api/site-audit-log.test.ts`, `web/__tests__/api/quota-events.test.ts`
    - release 2's pill email gate test, if the 3.1 Log puts that gate on the server
  - Depends on: 5.1, 5.4
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`. Tests only. Use each file's member-row seeding (release 2 gave the swoop files an optional `swoop`) with machineIds added.
    - **sessions:**
      - a scoped admin's create on m2 gives 404, with NO step-up window written and no session record;
      - a scoped member's watch on m1 gives 201;
      - a scoped member set to control: control on m1 takes the step-up path, as an admin's does; m2 gives 404 before any window is written;
      - a scoped admin's control on m1 takes the step-up path, as today.
    - **site-sessions:** a scoped admin and a scoped member set to control both get 403. Release 2's route is site-wide, and the wrapper also refuses any scoped caller on a route with no machineId. A whole-site admin gets 200.
    - **settings-and-kill:**
      - Kill follows the 3.1 Log:
        - on SWOOP_SETTINGS_MANAGE (expected), a scoped admin and a scoped controller get 403 `capability_missing` on m1, and 404 on m2;
        - if the owner kept it on MACHINE_REMOTE_CONTROL, the scoped controller's kill on m1 is ok and closes every user's windows there, and m2 gives 404.
      - swoop-settings GET and PATCH by a scoped admin give 403.
    - **lease:** a renewal by a viewer whose scope no longer holds the machine gives 404.
    - **display-settings:** a scoped admin's GET and PATCH give 403.
    - **site-audit-log and quota-events** run the real `_shared` gates (research tests.md §3):
      - a scoped member and a scoped admin get 403 from the audit log list and record, from quota and quota history, and from the events stream;
      - CONTROL: a whole-site member still gets 200.
    - **Viewer emails** (release 2's gate, if it is on the server): a scoped admin in the session gets names and no emails; a whole-site admin gets emails.
    - The ASH route suites that mock the wrapper inline (sites-deployments, sites-talons, sites-agent-tokens, sites-alerts, presets) would test nothing here. Task 5.1's wrapper tests cover them: every wrapper route without a machineId refuses a scoped caller.
  - Done when: these suites are green.

- [x] **Task 6.7: The parity matrix covers machine scope on all three gates**
  - Files: `web/__tests__/lib/authorizationParity.test.ts`
  - Depends on: 5.1, 5.2
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`.
    - `grant()` (L38-56) gains optional machineIds, and `resolveDoc` (62-81) returns it on the member row.
    - **New cases:**
      - a scoped member on the existing no-machine path `/api/sites/site-a/thing` gets 403 on BOTH Path A (the wrapper, MACHINE_VIEW) and Path B (requireSiteAuthAndScope by default);
      - new Path A′ (the wrapper with params `{siteId, machineId}`) and Path C (requireMachineAuthAndScope), on `/api/sites/site-a/machines/m1/thing`:
        - in scope, both give 200;
        - out of scope, both give 404;
        - whole site, both give 200.
    - The read-count pins (L465-490) are unchanged.
  - Done when: the parity suite is green.

- [x] **Task 6.8: Member candidates leave out sites where the caller is scoped**
  - Files: `web/__tests__/api/sites-member-candidates.test.ts`, and the candidates route only if the new case fails
  - Depends on: 4.1, 5.1
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`.
    - Release 2's route judges each listed site with `hasCapability` over `siteStanding(listUserStanding(uid))`. Task 4.1 made `listUserStanding` carry machineIds, so a site where the caller is scoped grants no SITE_MEMBER_MANAGE. Release 2's seams note expects no route edit.
    - **Add cases:**
      - The caller is a whole-site admin on A and a scoped admin on B, with T as the target: the result holds A's members and never B's.
      - The mocked `ctx.actor` carries the wrapper's real shape: `siteRoles` and `machineScopes` for T only. A's members still come back. This proves the route rebuilds the standing from `siteStanding`'s whole output, and does not spread only `siteRoles` over `ctx.actor`.
    - If the second case fails, fix the route so the actor spreads every map `siteStanding` returns, add the route file to your commit, and say so in the Log.
  - Done when: the candidates suite is green.


#### Added 2026-11-09 by the orchestrator: two gaps wave 6 found that no task owned

- [x] **Task 6.9: A scoped admin in a swoop session gets no viewer emails**
  - Files: `web/app/api/sites/[siteId]/machines/[machineId]/swoop/sessions/[sessionId]/route.ts`, `web/__tests__/api/swoop/sessions.test.ts`
  - Depends on: 5.1, 6.6
  - Do: First read the house rules at the top of this file, and the Log's `release names` block (the pill email gate). Today the session GET's gate is `withEmail = ctx.actor.role === 'superadmin' || siteRole === 'owner' || siteRole === 'admin'` (route.ts ~96-100). It keys on the site role, so an admin limited to some machines, seated in a session on one of their machines, gets every viewer's email. 6.6 confirmed this red with a probe. Re-key it to whole-site standing: a superadmin, or an owner or admin whose machine scope is null. Read the scope with `machineScopeOf(ctx.actor, siteId)` from `web/lib/capabilities.ts`; the wrapper builds the actor with `siteStanding`, so `machineScopes` is present when the target is scoped. Names are unchanged: they still go to everyone seated. `kickable` stays on SWOOP_SETTINGS_MANAGE, which a scoped admin never holds (the wrapper's scope step refuses site-wide capabilities). Test, in the "naming the people in it" describe: narrow ADMIN's row to `[MACHINE]` (through `mocks.memberDocs`, as 6.6 did), call `viewersAs(ADMIN)`, and expect the four names and no `email` on any viewer. The existing "gives an admin in it every email too" case is the whole-site control, unchanged.
  - Done when: the new case was red before the change and is green after; `__tests__/api/swoop` is green; eslint and tsc are clean.

- [x] **Task 6.10: Resuming a hoot conversation on a machine outside scope answers a plain 404**
  - Files: `web/app/api/hoot/conversations/[conversationId]/route.ts`, `web/app/api/chat/[conversationId]/route.ts`, `web/__tests__/api/chat.test.ts`
  - Depends on: 5.3, 6.4
  - Do: First read the house rules at the top of this file. Both routes wrap any `runHootStream` failure as a problem titled 'hoot stream unavailable' with code `cortex_unavailable` (conversations route.ts ~200-208, chat route.ts ~199-207), keeping the status. 5.3's machine-mode refusal, a 404 with 'machine not found or no access', therefore reaches the caller with that title and code. Since 6.4 refuses an out-of-scope machine when a conversation is created, this happens only when a person resumes a conversation pinned to a machine they have since lost. When `runHootStream` fails with status 404, answer with `problemNotFound('machine not found or no access')` (the ADR 0016 text) in each route's existing problem shape. Every other failure keeps today's wrapping. Test both routes (chat.test.ts already drives both create routes; follow its `describe.each` pattern for the resume routes): a resume whose stream refuses 404 gives the plain not-found title and code `not_found`, and a 503 from the stream still gives 'hoot stream unavailable' / `cortex_unavailable`.
  - Done when: the new cases were red before the change and are green after; `__tests__/api/chat.test.ts` and the `hoot-*` suites are green; eslint and tsc are clean.

## Wave 7: the browser

- [x] **Task 7.1: The dashboard page: scoped data, and what a scoped person sees when there is nothing**
  - Files: `web/app/dashboard/page.tsx`, `web/app/dashboard/components/MachinesNotice.tsx` (new), `web/__tests__/app/dashboard-machines-notice.test.tsx` (new)
  - Depends on: 4.3, 4.5, 5.6
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`. Release 2 owns this page's site-settings wiring; touch nothing else here. The machine cards and rows compute per-machine admin themselves (task 7.2), so the page passes them nothing new.
    - **Data.** Take `machineScope` from useAuth (120), and set `const scope = currentSiteId ? machineScope(currentSiteId) : null`. Then:
      - `useMachines(currentSiteId, scope)` (207);
      - `useDeployments(scope === null ? currentSiteId : '')` (223). Deployments are whole-site, `useDeployments('')` opens nothing (web/hooks/useDeployments.ts:160), and a scoped member's `checkMachineHasActiveDeployment` reads false;
      - `useAgentAlertToasts(currentSiteId, handleUseSuggestedExePath, launchCopyOf, scope)` (639);
      - `showGettingStarted` (806-811) is false when `scope !== null`.
    - **New `MachinesNotice.tsx`.** Its pure `export function machinesNotice(input: { scoped: boolean; loading: boolean; count: number; error: string | null }): 'load_error' | 'none_for_you' | null` decides:
      - `error` gives `'load_error'`;
      - `scoped && !loading && count === 0` gives `'none_for_you'`;
      - otherwise null.

      Two small components render the states:
      - `NoMachinesForYou`: the existing empty-state pattern (an icon, a title and one line). The title is "no machines here for you yet"; the line is "a site admin chooses which machines you can reach.".
      - `MachinesLoadError({ error })`: `<div className="bg-danger-surface border border-danger-border rounded-lg p-4 text-danger">` with "machines couldn't load: {error}. reload, or ask a site admin if it keeps happening.".

      The page renders whichever `machinesNotice` picks, in place of the getting-started card.
    - **Tests:**
      - `machinesNotice`'s truth table;
      - both components render their exact copy, with theme classes only.
  - Done when: the test and `cd web && npx jest __tests__/app` are green, and lint and tsc are clean. Task 9.1's e2e proves the page.

- [x] **Task 7.2: Machine cards, rows, menus and pills: per-machine admin actions**
  - Files:
    - `web/app/dashboard/components/MachineCardView.tsx`, `web/app/dashboard/components/MachineListView.tsx`
    - `web/components/MachineContextMenu.tsx`, `web/components/MachineStatusPill.tsx`
    - tests: `web/__tests__/app/machine-views-a11y.test.tsx`, `machine-views-active-hours.test.tsx`, `machine-views-os-line.test.tsx`, `machine-views-plan-lock.test.tsx`, `web/__tests__/components/MachineCardView.rebootPending.test.tsx`, `MachineContextMenu.test.tsx`, `MachineContextMenu.a11y.test.tsx`, `MachineStatusPill.theme.test.tsx`
  - Depends on: 5.6
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`. Decision 3: a scoped admin gets commands and machine config on their machines, and nothing site-wide. There are two predicates from useAuth:
    - `isSiteAdmin(siteId)`, site-wide and false for a scoped row;
    - `isMachineAdmin(siteId, machineId)`, per machine.

    Swoop is not gated here; the server decides it.
    - **MachineCardView:**
      - The container (1292-1293) already reads useAuth. It computes `isMachineAdmin(currentSiteId, machine.machineId)` per card, and passes both values to `MachineCard` (1312-1330).
      - In MachineCard, these gates switch to `isMachineAdmin`:
        - the status pill's cancel (421);
        - reboot-pending approve and dismiss (506);
        - the launch-mode toggle (1043);
        - edit process (1162);
        - add process (1243, 1262).
      - `MachineContextMenu` (443-452) receives both.
    - **MachineListView:**
      - `MachineRow` already calls `useAuth()` (359). It computes `const canAdminMachine = isMachineAdmin(currentSiteId, machine.machineId)` itself, so the dashboard and the demo page pass nothing new. The demo has no user, so it gets false, as today.
      - These gates switch to it:
        - the status pill (528);
        - launch mode, desktop (861) and compact (981);
        - edit (928);
        - add process (1104, 1121).
      - `MachineContextMenu` (755-763) receives both.
    - **MachineContextMenu:**
      - a new prop `isMachineAdmin?: boolean`;
      - restart, shutdown and cancel (335), and the offline schedule-restarts item (419), use it;
      - "turn on swoop…" (439, site settings), revoke token and remove machine (584) keep `isSiteAdmin`.
    - **MachineStatusPill:** rename the prop `isSiteAdmin` to `isMachineAdmin` (22, 101, 155, 223). Cancelling a pending restart is a command on that machine.
    - **Tests:**
      - every listed test that mocks useAuth gains `isMachineAdmin`, `machineScope: () => null` and `siteRole`;
      - a scoped admin (isSiteAdmin false, isMachineAdmin true) sees restart, shutdown and process editing, but not revoke token, remove machine or "turn on swoop…";
      - a member sees none of them.
  - Done when: these suites and `cd web && npx jest __tests__/app __tests__/components` are green, and lint and tsc are clean.

- [x] **Task 7.3: DisplayLayoutPanel acts on its machine**
  - Files: `web/components/charts/DisplayLayoutPanel.tsx`, `web/__tests__/components/DisplayLayoutPanel.test.tsx`
  - Depends on: 5.6
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`.
    - At 222-223, `const canAdminMachine = isMachineAdmin(siteId, machineId)` replaces every use of `canSiteAdmin` (466 …). Store, restore and clear are machine routes on MACHINE_CONFIG_WRITE.
    - **Tests:**
      - the mock gains `isMachineAdmin`;
      - a scoped admin of this machine sees store, restore and clear;
      - one whose access does not cover it sees none;
      - a member sees none.
  - Done when: the suite is green, and lint and tsc are clean.

- [x] **Task 7.4: The nav and the site lists for scoped sites**
  - Files:
    - `web/components/PageHeader.tsx`, `web/hooks/useCurrentSite.ts`, `web/components/NoSitesEmptyState.tsx`
    - `web/app/deployments/page.tsx`, `web/app/roosts/RoostsPageClient.tsx`, `web/app/talons/page.tsx`
    - tests: `web/__tests__/components/PageHeader.test.tsx`, `web/__tests__/app/roosts-page.swap.test.tsx`, `web/__tests__/hooks/useCurrentSite.test.ts` (new), `web/__tests__/components/NoSitesEmptyState.test.tsx` (new)
  - Depends on: 5.6
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`.
    - **`NAV_ITEMS` (38-75)** give talons, roost and deploy `wholeSiteOnly: true`. With `const scopedHere = !!currentSiteId && machineScope(currentSiteId) !== null`, one filtered list feeds both the desktop page dropdown and the drawer.
    - **`useCurrentSite(options: { wholeSiteOnly?: boolean } = {})`:**
      - when the option is set, filter `sites` to `machineScope(site.id) === null` before every derivation;
      - add `limitedOnly: boolean` to the result: true when the option filtered every site out of a non-empty list.
    - **NoSitesEmptyState** gains `limited?: boolean`. With it, it shows:
      - title: "this page needs whole-site access";
      - line: "you reach only some machines on your sites. ask a site admin if you need to {action}.".

      Without it, the copy is today's.
    - **The deployments, roosts and talons pages** call `useCurrentSite({ wholeSiteOnly: true })` and pass `limited={limitedOnly}`. The talons page replaces its inline "no sites available" block (:247) with `<NoSitesEmptyState action="manage talons" limited={limitedOnly} />`. The logs page keeps the default, because its rows are filtered by machine (task 7.7).
    - **Tests:**
      - PageHeader with a scoped current site lists dashboard, hoot and logs only, in both menus; a whole-site site lists all six;
      - useCurrentSite filters out scoped sites, falls back to the first whole-site site, and gives `hasNoSites` and `limitedOnly` true when every site is scoped;
      - NoSitesEmptyState renders both copies;
      - mocks gain `machineScope`.
  - Done when: these suites are green, and lint and tsc are clean.

- [x] **Task 7.5: The swoop picker and viewer read only what they may**
  - Files:
    - `web/components/swoop/SwoopPicker.tsx`, `web/app/swoop/[siteId]/[machineId]/page.tsx`
    - `web/hooks/useSwoopSession.ts`, only if step 3 below needs it
    - tests: `web/__tests__/components/SwoopPicker.test.tsx`, `web/__tests__/app/swoop-viewer-refused.test.tsx`, `web/__tests__/app/swoop-viewer-ended.test.tsx`, `web/__tests__/hooks/useSwoopSession.test.tsx`
    - release 2's pill email gate test, if the 3.1 Log puts that gate in the browser
  - Depends on: 4.3, 5.6
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`.
    1. **SwoopPicker** (56): `useMachines(siteId, machineScope(siteId))`. `canEnable` (110) stays `isSiteAdmin`.
    2. **The viewer page** (64-65): `useMachines(siteId, [machineId])`, one `documentId() in` read for everyone, whole-site members included (the rules allow it). The osFamily lookup is unchanged. Its `settingsHref` and `upgradeHref` already gate on `isSiteAdmin` and `isSiteOwner`, which are whole-site now.
    3. **"This machine has left the site" (release 1) fires only on its explicit signals:** the create route's 404 with code `machine_not_found`, and a record whose `endReason` is `machine_removed`.
       - For a scoped person outside their scope, the wrapper answers a bare 404 'machine not found or no access', and the one-doc listener is refused. Neither may read as "left".
       - If release 1 infers "left" from the machine doc going missing from `useMachines`, or from any 404, change it in the page or the hook. The doc signal, if kept, needs a seen-then-gone latch and `error === null`.
       - The copy for an out-of-scope machine is the wrapper's detail, 'machine not found or no access', shown as a final refusal with the existing back link.
    4. **Viewer emails** (release 2's pill gate, if it is in the browser): add a case where a scoped admin (isSiteAdmin false) sees names and no emails.
    - **Tests:**
      - the picker passes the scope;
      - the viewer subscribes with `[machineId]`;
      - a refused machine read (error set, no machines) shows no "left the site";
      - a 404 with no code at create shows 'machine not found or no access' and no "left the site";
      - release 1's `machine_not_found` case still shows "this machine has left the site.";
      - mocks gain `machineScope`, `isMachineAdmin` and `siteRole`.
  - Done when: these suites are green, and lint and tsc are clean.

- [x] **Task 7.6: The hoot page lists in-scope machines and skips autonomous chats on a scoped site**
  - Files: `web/app/hoot/components/HootChatView.tsx`, `web/hooks/useHoot.ts`, `web/__tests__/components/HootChatView.test.tsx`, `web/__tests__/hooks/useHoot.autonomous.test.ts`
  - Depends on: 4.3, 4.5, 5.6
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`.
    - `useMachines(currentSiteId, machineScope(currentSiteId))` (265).
    - `useOwletteChat` (416) gets `includeAutonomous: machineScope(currentSiteId) === null`. `siteMachineIds` already derives from `machines`, so it is scoped.
    - In `useHoot.ts`, `includeAutonomous` becomes REQUIRED and loses its default, so every caller has to say it. A new caller that forgot it would open a listener the 2.12.0 rules refuse on a scoped site.
    - The tier-3 approval toggle (1206) stays `isSiteAdmin`.
    - **Tests:**
      - on a scoped site, the machine picker shows only in-scope machines, and useOwletteChat gets `includeAutonomous: false`;
      - useHoot.autonomous's cases pass the flag explicitly;
      - mocks gain `machineScope`.
  - Done when: the suites are green, and lint and tsc are clean.

- [x] **Task 7.7: The logs page queries by machine for scoped sites**
  - Files: `web/app/logs/page.tsx`, `web/lib/logFilters.ts`, `web/__tests__/lib/logFilters.test.ts`
  - Depends on: 5.6
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`.
    - **`planActionFilter(selected, totalOptions, maxInValues = FIRESTORE_IN_LIMIT)`** (logFilters.ts:30-37) compares against `maxInValues`. Doc: Firestore caps a query at 30 disjunctions in total, so an action `in` beside a machine `in` gets floor(30 / machines).
    - **The logs page:**
      - `const scope = currentSiteId ? machineScope(currentSiteId) : null`.
      - `buildLogsQuery` (286-310) gains `scope`. With an array and `filters.machine === 'all'`, it adds `where('machineId', 'in', scope)`.
      - The plan at 302 and the memo at 593 both use `maxInValues = scope && filters.machine === 'all' ? Math.max(1, Math.floor(FIRESTORE_IN_LIMIT / scope.length)) : FIRESTORE_IN_LIMIT`, so the query and the in-memory narrowing agree.
      - `[]` runs no query and shows the empty list.
      - The machine options (869) already come from the loaded rows.
      - `canManageLogs` (480) stays `isSiteAdmin`.
    - **Tests:** planActionFilter with maxInValues 1 and two selected gives `clientSide: true`; the default is unchanged.
  - Done when: the logFilters tests are green, and lint and tsc are clean. Task 9.1's e2e proves the page.

- [x] **Task 7.8: Schedule dialogs read machines only when open, and only in scope**
  - Files: `web/components/RestartScheduleDialog.tsx`, `web/components/ApplyScheduleToMachinesDialog.tsx`, `web/__tests__/components/RestartScheduleDialog.test.tsx` (new), `web/__tests__/components/ApplyScheduleToMachinesDialog.test.tsx` (new)
  - Depends on: 4.3, 5.6
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`.
    - **RestartScheduleDialog** (150): `useMachines(open ? siteId : '')`. The dialog uses only `updateRestartSchedule`. Every card mounts it, so today the dashboard runs 2N+1 machine listeners, and each one would be refused for a scoped member.
    - **ApplyScheduleToMachinesDialog:** its body (65+) already mounts only while open. Its call (66) becomes `useMachines(siteId, machineScope(siteId))`, so it lists only machines the person may configure, minus the current one, as today.
    - **Tests** (mock `@/hooks/useFirestore` and `useAuth`):
      - RestartScheduleDialog, closed, calls useMachines with `''`; open, with the site id;
      - ApplyScheduleToMachinesDialog passes `machineScope(siteId)`. With useMachines returning `[IN, IN2]` and the current machine IN, it lists IN2 only, and the select-all row counts one.
  - Done when: the new tests and `__tests__/components` are green, and lint and tsc are clean.

- [x] **Task 7.9: The members section: access beside role and swoop mode**
  - Files:
    - release 2's `web/components/admin/sites/SiteMembersSection.tsx`, `MemberAccessFields.tsx`, `AddMemberDialog.tsx` and `ChangeAccessDialog.tsx`
    - `web/hooks/useSiteMembers.ts`
    - `web/components/SiteMachinesList.tsx` and `web/hooks/useSiteMachines.ts` (new), only if the 3.1 Log says release 2 did not extract it
    - tests: `web/__tests__/components/admin/sites/SiteMembersSection.test.tsx`, `MemberAccessFields.test.tsx`, `AddMemberDialog.test.tsx`, `ChangeAccessDialog.test.tsx`, `web/__tests__/hooks/useSiteMembers.test.ts`, and `web/__tests__/components/SiteMachinesList.test.tsx` only if extracting
  - Depends on: 4.8, 6.3
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`. Release 2's seams note: the machines field goes into `MemberAccessFields`, which both "add member" and "change access..." render, so a person's access is edited in one place. The access column goes inline in the table.
    - **`useSiteMembers`:**
      - `SiteMember` gains `machineIds: string[] | null`;
      - `AddSiteMemberInput` gains `machineIds?: string[]`, sent only when given;
      - the `updateMember(uid, patch)` patch gains `machineIds?: string[] | null`. It sends only the keys present, `machineIds: null` included;
      - `UpdateSiteMemberResult` gains `machineIds`.
    - **`useSiteMachines(siteId)`** (GET `/api/sites/{siteId}/machines`) supplies `{ id, name }[]`. If release 2 did not extract it, extract it from `web/components/SiteMachinesList.tsx:53-68` into `web/hooks/useSiteMachines.ts`, and use it from both places.
    - **`MemberAccessFields`** gains the props `machines`, `machineIds: string[] | null` and `onMachineIdsChange`. Under the swoop field, it renders `<MachineAccessField idPrefix={\`${idPrefix}-machines\`} machines={machines} value={machineIds} onChange={onMachineIdsChange} disabled={disabled} />` (task 4.8).
    - **`SiteMembersSection`:**
      - It calls `useSiteMachines(siteId)` once and passes `machines` to both dialogs.
      - **An inline "access" column** follows swoop, from md up. Its cell is `accessLabel(member.machineIds)`. A scoped row gets a Tooltip listing the machine names; an id with no machine shows as the id. Below md, ` · {accessLabel}` follows the swoop label on the role line. Nothing is clipped at 390 px, and the header is one row.
    - **`ChangeAccessDialog`** gains the props `siteId` and `machines`. Its machines field is seeded from `member.machineIds`.
      - **Save** sends only the changed fields. `machineIds` is null to widen, or `liveMachineIds(value, machines)`. Save stays disabled while `!isAccessValid`.
      - **A footnote for narrowing**, added after release 2's when ids are removed: `' a swoop session they are in on a machine you take away ends.'`.
      - **The talon warning.** When the choice moves from whole site to some machines, fetch the authored count with `useTalonReassign().fetchSiteAuthored(siteId, member.uid)`. Above 0, show:
        - for one talon: "they wrote 1 talon, which stops at its next run once their access is limited. reassign it to keep it.";
        - for n talons: "they wrote {n} talons, which stop at their next run once their access is limited. reassign them to keep them.".

        A scoped author's talons are disabled (task 6.5).
      - **The success toast** keeps release 2's title, `access updated`. Its description appends ` access: ${accessLabel(after.machineIds)}.`.
    - **`AddMemberDialog`:**
      - its machines field starts at whole site (null);
      - submit adds `machineIds: liveMachineIds(value, machines)` only when the value is an array;
      - "add member" stays disabled while `!isAccessValid`.
    - **Mobile:** per the owner's phone rules, no buttons are clipped at 390 px, and headers stay one row. Task 9.3's e2e proves it.
    - **Tests:**
      - useSiteMembers: updateMember sends exactly `{ machineIds: null }` and `{ machineIds: ['m1'] }`; addMember omits machineIds when it is not given.
      - MemberAccessFields: the machines field renders under swoop and reports changes.
      - ChangeAccessDialog:
        - it is seeded from machineIds;
        - picking "some machines" then IN sends `{ machineIds: ['IN'] }`; whole site sends `{ machineIds: null }`;
        - a role change plus a narrowing sends one patch with both;
        - save is disabled at `[]`;
        - the talon warning shows its count; the narrowing footnote shows; the toast description names the access.
      - AddMemberDialog: some machines then IN sends `machineIds: ['IN']`; untouched sends none.
      - SiteMembersSection:
        - access labels render; the tooltip lists the names; a dead id shows as the id;
        - the owner's row and your own row have no "change access...", as in release 2.
  - Done when: these suites are green, and lint and tsc are clean.

- [x] **Task 7.10: The site list, the site settings page and talon successors learn scope**
  - Files: release 2's `web/components/admin/sites/SiteList.tsx` and `SiteSettings.tsx`, `web/lib/talonSuccessors.ts`, `web/__tests__/components/admin/sites/SiteList.test.tsx`, `SiteSettings.test.tsx`, `web/__tests__/lib/talonSuccessors.test.ts`
  - Depends on: 4.8, 5.6
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`.
    - **`siteTalonSuccessors`** (release 2's seam: it must exclude scoped admins, who hold no TALON_MANAGE):
      - its input rows gain `machineIds?: readonly string[] | null`;
      - drop every row whose machineIds is an array;
      - the doc says why.
    - **SiteList's role label.** Release 2's `isSiteOwner ? 'owner' : isSiteAdmin ? 'admin' : 'member'` would read "member" for a scoped admin. With `const scope = machineScope(site.id)`:
      - when `scope !== null`, the label is `${siteRole(site.id) ?? 'member'} · ${accessLabel(scope)}`, e.g. "admin · 1 machine";
      - otherwise, release 2's label;
      - such a row has no gear, as release 2's `isSiteAdmin` gate already gives.
    - **SiteSettings.** When `!isSiteAdmin(siteId)` and `machineScope(siteId) !== null`, release 2's member-only line becomes "your access to {site.name} covers only some of its machines, and its settings need the whole site. ask its owner or an admin.". No sections render.
    - **Tests:**
      - talonSuccessors: a scoped admin is dropped; whole-site owners and admins stay; release 2's cases are unchanged.
      - SiteList: a scoped admin's row reads "admin · 1 machine" with no gear; a scoped member's row reads "member · 2 machines".
      - SiteSettings: a scoped admin gets the scoped line and no section group.
      - Mocks gain `machineScope` and `siteRole`.
  - Done when: these suites are green, and lint and tsc are clean.

- [x] **Task 7.11: Escalation blocks for machine scope**
  - Files: `web/__tests__/api/membershipEscalation.test.ts`
  - Depends on: 5.1, 6.3
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`.
    - Number the new blocks after the last block in the file; release 2 added 13–18, so start at 19 unless the 3.1 Log says otherwise. Each refusal has a POSITIVE CONTROL. Use the file's real wrappers and its transaction double.
    - **Setup:** the file's `seedMemberRow` takes machineIds through its row fields. Make sure the `firebase-admin/firestore` mock's `FieldValue.delete()` sentinel removes the key in `applyOps` (release 2 needed it for `swoop: null`; reuse it).
    - **Blocks:**
      - **19.** A scoped admin cannot reach the member surface: GET, POST, PATCH and DELETE give 403, with the kill switch ON and OFF. CONTROL: a whole-site admin can.
      - **20.** A scoped member cannot widen their own scope: PATCH on their own row with `{machineIds:null}` gives 403. With the switch off, the scope step refuses first; either way, nothing is written. CONTROL: a whole-site admin clears someone else's scope.
      - **21.** The owner cannot be scoped: PATCH owner `{machineIds:['m1']}` gives 409, and POST owner with machineIds gives 409 target_is_owner. CONTROL: an admin row is scoped.
      - **22.** A key owned by a scoped user is bounded: with a `machine=*:write` key, a machine route on m2 gives 404. Use a route this file can import. CONTROL: m1 is allowed.
      - **23.** A scoped member set to swoop control holds nothing site-wide: the members GET, and `GET /api/sites/{siteId}/swoop/sessions` if the file can import it, give 403 with the switch on and off. CONTROL: a whole-site admin gets 200.
  - Done when: the suite is green.

- [x] **Task 7.12: The dashboard hides swoop from someone whose swoop mode is none**
  - Files: `web/contexts/AuthContext.tsx`, `web/hooks/useFirestore.ts` (useSiteMemberships exposes the row's `swoop`, per 5.6's note), `web/components/MachineContextMenu.tsx`, `web/app/dashboard/components/MachineCardView.tsx`, `web/app/dashboard/components/MachineListView.tsx`, `web/app/dashboard/page.tsx`, and the tests beside them that assert the swoop entries
  - Depends on: 7.1, 7.2 and 7.5, which hold these files first. It runs after them, never beside them.
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`.
    - Owner ruling, 2026-11-07: someone whose effective swoop mode on a site is `none` sees no swoop entry for that site's machines (the card's swoop button, the menu item and the list view's swoop control). This answers release 2's question 6 ("the dashboard reads the mode in release 3"). It reverses context decision 16's "the dashboard does not read the mode" for this one case. The server still decides (`evaluateSwoopAccess`); this only stops the dashboard offering what the API refuses, as `swoopOff` already does.
    - AuthContext exposes `swoopMode(siteId)`, the effective mode from the member row it already reads: `effectiveSwoopMode(role, parseSwoopMode(row.swoop), membersMayWatch)` from `web/lib/swoopMode.ts`. A superadmin and an owner always have `control`. Read `membersMayWatch` where `swoopOff` is read today, and change no listener for it.
    - Hide the entries where the mode is `none`, exactly where `swoopOff` hides them now. Watch and control both keep the entry, because the viewer steps down to watching on `capability_missing`.
  - Done when: component tests show a member set to none sees no swoop entry, a member set to watch and a default member on a `membersMayWatch` site still see it, and a superadmin sees it on a site where they hold no row; the touched suites, eslint and tsc are green.

## Wave 8: the actor maps required, the contract, the docs

- [x] **Task 8.1: `machineScopes` and `swoopModes` become required on UserActor**
  - Files: `web/lib/capabilities.ts`, and every production builder tsc names
  - Depends on: all of waves 4–7
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`. No other wave-8 task touches a `.ts` file under `web/`; task 8.6 touches only `sdks/` and `cli/`, and docs pages. So this task owns every `.ts` change under `web/` in this wave.
    - In `UserActor`, `machineScopes?:` becomes `machineScopes:`, and `swoopModes?:` becomes `swoopModes:`. `siteStanding` writes both, so a builder that passes tsc for one passes for the other.
    - Run `cd web && npx tsc --noEmit`. Every error is a production builder that skips `siteStanding`. Fix each one through `siteStanding`; an actor with no site uses `...siteStanding({})`.
    - Delete `machineScopeOf`'s "map absent" branch only if no test literal still needs it. Tests are outside tsconfig and keep their literals, so expect to keep it, and update its doc to say it is for test literals.
    - Then grep production code for object literals typed or cast as `UserActor` or `Actor` with `type: 'user'` (`git grep -n "type: 'user'" -- web/lib web/app`). Confirm each spreads `siteStanding(...)`, and list them in the Log.
    - Update the field docs: required, so the compiler names any builder that forgets them.
  - Done when: tsc is clean, no builder writes an ad-hoc actor, and jest is green.

- [x] **Task 8.2: openapi**
  - Files: `web/openapi.yaml`
  - Depends on: waves 5–7
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`. Release 2 already gave the Site Members operations their operationIds, `swoop`, and its candidates path; build on them.
    - **info.description** (~31), after "A site the caller cannot access answers `404`": "A machine outside the caller's machine scope answers `404` the same way; a caller with a machine scope gets `403` from every site-wide operation."
    - **Site Members:**
      - GET items gain `machineIds` (`type: [array, 'null']`, `items: {type: string}`, `maxItems: 30`): "the machines this member reaches; null = the whole site".
      - The POST body gains `machineIds`:
        - an array: `minItems: 1`, `maxItems: 30`, `uniqueItems: true`, with the item pattern `^[A-Za-z0-9_-]{1,128}$`;
        - "each a machine of this site; omit for the whole site";
        - 400 on field `body.machineIds`;
        - 403 `cannot_modify_own_membership` when you scope yourself;
        - roleHonored covers the machine scope too.
      - PATCH: add `machineIds` (an array as for POST, or null to give back the whole site) beside `role` and `swoop`, with `minProperties: 1`.
        - The 400 text is "role, swoop or machineIds is required".
        - The response gains `machineIds`.
        - The 409 `cannot_change_owner_role` text covers access.
        - The side effect: one revocation; seats on machines dropped from the scope end (`scope_changed`).
      - transfer-ownership: "the successor's row loses any machine scope and swoop mode: an owner is whole site and always controls".
    - **Other operations:**
      - listSiteMachines (~4831): "a caller with a machine scope gets only those machines".
      - listSiteLogs (~1660) and the log item (~1828): rows only for the caller's machines; another machine's row, or one with no machine, answers 404 on the item.
      - listSiteSwoopSessions (~8621) and the machine kill operation: "a caller with a machine scope gets `403`", beside release 2's SWOOP_SETTINGS_MANAGE text.
      - startSwoopSession (~7929): "a machine outside the caller's scope answers `404` before any of the refusals below; inside it, the caller's swoop mode applies".
      - createHootConversation (~2410): "machineId must be within the caller's machine scope (404 otherwise); a site-wide conversation covers only the caller's machines".
      - The member-level reads that become whole-site only, where "any member" becomes "any whole-site member; a caller with a machine scope gets `403`": listAuditRecords (:6139), getSiteQuota (:6059), listRoosts (:3683), streamEvents (:6717) and listWebhookSubscriptions (:6258).
  - Done when: `cd web && npm run validate:api` and `npx jest __tests__/api/openapi.test.ts` pass.

- [x] **Task 8.3: Docs: the access model, the data model, the rules, setup, agent and API pages**
  - Files:
    - `web/content/docs/reference/authentication.mdx`, `web/content/docs/reference/firestore-data-model.mdx`, `web/content/docs/reference/agent-commands.mdx`
    - `web/content/docs/setup/firestore-rules.mdx`, `web/content/docs/setup/firebase.mdx`, `web/content/docs/agent/remote-commands.mdx`
    - `web/content/docs/api/authentication.mdx`, `web/content/docs/api/errors.mdx`, `web/content/docs/api/webhooks.mdx`, `web/content/docs/api/versions.mdx`, `web/content/docs/api/chunks.mdx`
    - `docs/internal/version-management.md`
  - Depends on: waves 5–7
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`. Use GLOSSARY terms, and build on release 2's edits to these pages (its swoop mode in reference/authentication and firestore-data-model).
    - **reference/authentication.mdx** (339-376) gets a "machine scope" subsection:
      - the field;
      - the five machine-class capabilities against the site-wide ones;
      - the check order (role, then swoop mode, then scope), with a small table of scope × mode;
      - where it is enforced:
        - the rules' `canAccessMachine` and `canAccessWholeSite`;
        - the wrapper's scope step, which `capability_enforcement` never turns off (amend 361);
        - the `_shared` gates;
        - the dashboard's `isSiteAdmin`, `isMachineAdmin` and `machineScope` (amend 355-359, 363-376);
      - 404 vs 403.
    - **reference/firestore-data-model.mdx:**
      - the `members/{uid}` fields (110-122) gain `machineIds`, beside release 2's `swoop`;
      - the "site members read" lines on per-machine paths say "members whose access covers the machine read"; on site-wide paths, "whole-site members read" (the lines are listed in research docs-openapi §C);
      - settings (124-135): swoop, display and hoot settings (`settings/cortex`) are readable to scoped members; alerts only to whole-site members;
      - list the read exceptions once, in one place: the site document, `settings/{swoop,display,cortex}`, and the schedule and reboot presets stay readable to a scoped member on purpose.
    - **reference/agent-commands.mdx:13** and **agent/remote-commands.mdx:143:** "every member of the site can read" the command docs becomes "every member whose access covers the machine".
    - **setup/firestore-rules.mdx:**
      - the helpers table (50-63) gains the four helpers;
      - the site-access paragraph (65-70) gains machineIds;
      - the access matrix (72-116) notes what a scoped member gets per row, the exceptions above included;
      - the tests list (144) adds `siteReadControls.test.ts` and `machineScope.test.ts`;
      - the version (196) becomes 2.12.0, with the invariant.
    - **setup/firebase.mdx:188-208**, the access model summary: a membership can be limited to some machines, and what it then reaches.
    - **api/authentication.mdx** (131-146): a key never grants more than its owner holds, the owner's machine scope included.
    - **api/errors.mdx:** the `cannot_change_owner_role` row covers access. Where 404s are explained, add 'machine not found or no access'. No new code.
    - **api/webhooks.mdx:334-340** (GETs, retry and probe), **api/versions.mdx:17-28** (roost reads) and **api/chunks.mdx:69-77** (membership): "member" becomes "whole-site member", and a member limited to some machines gets 403.
    - **docs/internal/version-management.md:61:** "Current: 2.2.0" becomes 2.12.0.
  - Done when:
    - `cd web && npx fumadocs-mdx` succeeds;
    - `git grep -n -i -E "allowlist|full member|partial member|unscoped member" -- <this task's files>` finds nothing;
    - task 10.1's `public/docs-links.spec.ts` run is what proves the links.

- [x] **Task 8.4: Docs: the product pages**
  - Files:
    - release 2's members page (`web/content/docs/dashboard/admin/member-management.mdx`) and `web/content/docs/dashboard/admin/index.mdx`
    - `web/content/docs/dashboard/swoop.mdx`, `web/content/docs/dashboard/hoot.mdx`, `web/content/docs/reference/hoot-tools.mdx`
    - `web/content/docs/dashboard/admin/email-alerts.mdx`, `web/content/docs/dashboard/activity-logs.mdx`
    - `web/content/docs/architecture.mdx`, `web/content/docs/dashboard/talons.mdx`
    - `web/content/docs/dashboard/process-management.mdx`, `web/content/docs/dashboard/displays.mdx`, `web/content/docs/dashboard/restart-schedules.mdx`
  - Depends on: wave 7
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`.
    - **The members page:**
      - the access column, and "change access..." with role, swoop and machines in one dialog;
      - access set at add time;
      - what someone limited to some machines sees and cannot reach;
      - the owner's row and your own row cannot be changed;
      - at most 30 machines;
      - removing a machine, or a machine leaving the site, drops it from everyone's access;
      - narrowing stops the talons they wrote;
      - in a shared swoop session, narrowing takes effect within about five minutes;
      - release 2 kept :100 ("to narrow someone's access…"); replace it with machine scope.
    - **dashboard/admin/index.mdx:**
      - the roles table and the capability matrix (:65-98): the `scope` column gains "your machines" for machine-class capabilities;
      - who reaches the admin panel: owners and admins of the whole site of at least one site;
      - someone limited to some machines is bounced.
    - **swoop.mdx:**
      - "watching versus control" (release 2's section): it applies per machine the access covers;
      - the lease re-check list (238) adds "a machine dropped from the viewer's access";
      - admin → swoop (309-311) is for whole-site owners and admins;
      - a machine outside your access answers 404, not a refusal code (338-356).
    - **hoot.mdx** (23, 83-91, 271):
      - "all machines" means all machines your access covers;
      - site-level tools are not offered to someone limited to some machines;
      - autonomous chats are hidden where your access is limited.
    - **reference/hoot-tools.mdx** (19, 21, 83, 142-144): get_site_logs, deploy_software and the talon tools are not offered to someone limited to some machines.
    - **email-alerts.mdx** (11-21): someone limited to some machines gets alerts for those machines only; site-level emails skip them. Recipients come from the site's member list.
    - **activity-logs.mdx** (7): you see rows for the machines your access covers.
    - **architecture.mdx** (109, 349-360): the who-has-what table gains machine scope.
    - **talons.mdx:** a talon whose author is limited to some machines is disabled at its next run (creator access revoked).
    - **process-management.mdx:49, displays.mdx:38, restart-schedules.mdx:25:** "site admins" becomes "site admins whose access covers the machine". Decision 3 gives scoped admins machine-level write.
  - Done when:
    - `cd web && npx fumadocs-mdx` succeeds;
    - the avoid-word grep (as in task 8.3) over this task's files finds nothing;
    - task 10.1's docs-links run proves the links.

- [x] **Task 8.5: The records: readme, changelogs, skills, protocol, coverage, product, runbooks**
  - Files:
    - `README.md`, `docs/changelog.md`, `web/content/docs/changelog.mdx`
    - `.claude/skills/firebase-integration/SKILL.md`, `.claude/skills/codebase-map/SKILL.md`
    - `agent/swoop/PROTOCOL.md`, `web/e2e/COVERAGE.md`, `PRODUCT.md`
    - `docs/runbooks/dev-to-prod-workflow.md`, `docs/runbooks/hotfix-rollback.md`
  - Depends on: wave 7
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`.
    - **README.md:**
      - The swoop line (:37). Whatever release 2 left, it ends as: "watching needs a membership that reaches the machine; control needs a swoop mode of control there (site owners and admins have it unless set otherwise) and a fresh second factor."
      - :55 reads: "roles are per site (member, admin, owner), granted by a membership on each site that can be limited to some of its machines; a platform superadmin reaches every site." Keep release 2's added sentence about the settings page.
    - **Both changelogs**, by hand, under `## [Unreleased]`, with identical text:
      ```
      ### added — a member can be limited to some machines

      A site admin can now give someone access to only some of the site's machines, up
      to 30: in the site's members section, **change access…** → **some machines**, or
      the same choice when adding them. That person sees only those machines on the
      dashboard, in swoop, in hoot and in the activity log, gets alert emails only for
      them, and acts on them at their site role, with their swoop mode applying there:
      give a member **control** and they can take control of just those machines.
      Nothing that spans machines reaches them, whatever their role: no site settings,
      members, deployments, roost, talons, webhooks, audit log or admin panel. Their API
      keys carry the same limit. Everyone else keeps the whole site, as before. A
      machine that is removed or leaves the site drops out of everyone's access, and
      limiting someone's access stops the talons they wrote. The API takes `machineIds`
      on `POST /api/sites/{siteId}/members` and `PATCH /api/sites/{siteId}/members/{uid}`
      (`null` gives back the whole site) and returns it from the members list.
      Firestore rules 2.12.0 enforce the same limit on every read.
      ```
      The heading is lowercase and the body is sentence case, wrapped like the neighbouring entries.
    - **firebase-integration SKILL.md:**
      - the `members/{uid}` shape (19-23) gains machineIds;
      - Security Rules (147-169): `canAccessMachine`, `canAccessWholeSite`, `isSiteAdmin` needing whole site, and the canAccessSite invariant;
      - the server: `facts.machineIds`, `siteStanding`'s `machineScopes`, and the wrapper's scope step;
      - the alert recipients now read member rows.
    - **codebase-map SKILL.md:**
      - lib: `web/lib/machineAccess.ts` (the one reading of a machine scope);
      - components: `admin/sites/MachineAccessField.tsx`;
      - hooks: `useSiteMachines` if task 7.9 extracted it.
    - **PROTOCOL.md §10:** the lease re-check list adds "a machine dropped from the viewer's machine scope". Also: a narrowed viewer in a shared session loses their seat and is out within one lease.
    - **COVERAGE.md:** rows for `sites/machine-scope.spec.ts`, the machine-scope describe in `swoop/session.spec.ts`, and `sites/member-access.spec.ts`. Update the members access row too.
    - **PRODUCT.md:35:** roles can be limited to some machines.
    - **docs/runbooks/dev-to-prod-workflow.md**, "pre-promotion checklist":
      - A release that changes `firestore.rules` deploys its rules (and any function that reads the same field) to prod before `main` receives the web.
      - For 2.12.0, that is `firebase deploy --only firestore:rules` and `--only functions:getUsageSummaryHttp` on prod, then `node scripts/check-membership-read-path.mjs --env=prod`.
      - Before the first scoped row exists on prod, confirm that `vercel-origin.owlette.app` serves the same commit as Railway.
    - **docs/runbooks/hotfix-rollback.md:**
      - While `check-membership-read-path.mjs --list-scoped` lists any row, never roll the web back by redeploying an older Railway deployment, and never let a Vercel standby serve older code. Old code ignores `machineIds` and widens every scoped member.
      - Remove the scoped members first, using the DELETEs the script prints.
  - Done when:
    - both changelog entries are identical, and `grep -c "a member can be limited to some machines"` finds one in each;
    - every heading still sits under `[Unreleased]`. Project memory: entries can land in a released section;
    - the avoid-word grep over the edited docs finds nothing.

- [x] **Task 8.6: The SDKs and the CLI carry machine scope (only if the owner said now)** (skipped: owner Q4, later)
  - Files:
    - `sdks/node/src/resources/members.ts`, `sdks/node/__tests__/resources.test.ts`, `sdks/node/README.md`
    - `sdks/python/roost/resources/members.py`, `sdks/python/tests/test_members.py`
    - `cli/src/commands/site.ts`, `cli/__tests__/commands/site-http.test.ts`
    - `web/content/docs/api/sdk-node.mdx`, `web/content/docs/api/sdk-python.mdx`, `web/content/docs/cli/reference/site.mdx`
  - Depends on: 6.3
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`.
    - **If the 0.1 Log says question 4 is "later"** (the default, which also matches release 2's question 7), change nothing. Reply with `Log: deferred by the owner (question 4)`, and make no commit.
    - **If it is "now":**
      - **The SDKs:**
        - `SiteMember` gains `machineIds: string[] | null`, and `swoop` too if release 2 left it out;
        - the `add` options gain `machineIds?: string[]`;
        - a new `update(siteId, uid, { role?, swoop?, machineIds? })` PATCHes with only the keys given.
        - Fix the stale `roleHonored` "always true" docs while there (research docs-openapi §D).
      - **The CLI:**
        - `site members` shows an `access` column ("whole site", "N machines");
        - `site add-member --machines a,b`;
        - a new `site set-access <siteId> <uid> (--machines a,b | --whole-site)`.
      - **Tests**, in each package's style.
      - **The docs pages** follow.
  - Done when: if "now", each package's own tests pass (`cd sdks/node && npm test`; the Python SDK's runner per its README; `cd cli && npm test`). If "later", the Log line says deferred.


#### Added 2026-11-09 by the orchestrator

- [x] **Task 8.7: Every talon re-checks its author before any output fires**
  - Files: `web/lib/talons/engine.server.ts`, `web/__tests__/lib/talons/engine.test.ts`, `web/content/docs/dashboard/talons.mdx`, `web/content/docs/dashboard/admin/member-management.mdx` (only the talon lines)
  - Depends on: 6.5, 8.4
  - Do: First read the house rules at the top of this file. **Owner ruling, 2026-11-09:** fix it in 4.1.29. Today only talons with a hoot output or a visual check call `resolveTalonAuthor` (hootOutput.server.ts:286, visualCheck.server.ts:184). A talon whose outputs are only command, email or webhook keeps firing after its author is limited to some machines (6.5) or leaves the site (pre-existing). The single execution path is `engine.server.ts` (trigger → condition → outputs). Resolve the author once per run, before the first output, using `resolveTalonAuthor(db, siteId, talon)`. A `TalonAuthorError` whose reason is in `CREATOR_DISABLED_REASONS` (`creator_access_revoked` and the rest) ends the run and disables the talon the same way a hoot output's refusal does today. Find that path and reuse it, so the card shows the same reason. Don't resolve twice in a run: hand the resolved author to the hoot and visual-check outputs if they take it; if they don't, leave their own call alone and say so. Docs: `talons.mdx` and the talon lines of `member-management.mdx` (8.4 wrote "stops for hoot-output and visual-check talons only") now say every talon switches off at its next run when its author is limited to some machines or leaves the site. The changelog entry 8.5 wrote ("limiting someone's access stops the talons they wrote") and the change-access dialog's warning are then true as written; check both and leave them.
  - Done when: engine tests show a command-only talon, an email-only talon and a webhook-only talon each refused and disabled with `creator_access_revoked` once the author is scoped, and once the author's row is gone. They are red before the change. A whole-site author's talons still fire. The talons suites are green; eslint and tsc are clean.

- [x] **Task 8.8: The `_shared` access adapter fails closed on a missing scope**
  - Files: `web/app/api/_shared.ts` (the `machineIds: access.machineIds ?? null` at ~518-519 only), and the test suites that mock `assertUserHasSiteAccess` without `machineIds` (find them with a grep)
  - Depends on: 5.2, 8.1
  - Do: First read the house rules at the top of this file. 8.1 removed `siteStanding`'s fail-open `machineIds ?? null`. `_shared.ts` keeps a second one, and its comment says suites mock the adapter with no `machineIds`. Production always returns `machineIds` (5.2), so only tests reach it, but it is a fail-open default. Remove it: read `access.machineIds` as it is, with a type that makes it required. Give every mock of `assertUserHasSiteAccess` that lacks the field `machineIds: null`. Don't change any route's behaviour.
  - Done when: no `?? null` default on `machineIds` remains in `_shared.ts`; tsc forces the field; the full web jest is green; eslint is clean.


- [x] **Task 8.9: Alert recipients fail closed on a missing scope**
  - Files: `web/lib/adminUtils.server.ts` (`recipientWantsMachine`, ~20-21), `web/lib/talons/outputs.server.ts` (~158), the test suites that build a `SiteRecipient` without `machineIds` (find them with a grep), and two docs lines 8.7 left stale: `web/content/docs/cli/reference/site.mdx` (~178) and `web/content/docs/reference/authentication.mdx` (~388)
  - Depends on: 4.4, 8.7, 8.8
  - Do: First read the house rules at the top of this file. 8.8 found two more test-only fail-open defaults like the ones 8.1 and 8.8 removed: `recipientWantsMachine` reads `recipient.machineIds ?? null` (its comment: "a recipient built without the field (tests) reads as the whole site"), and `talons/outputs.server.ts:158` reads `(recipient.machineIds ?? null) !== null`. `SiteRecipient.machineIds` is already typed as required. Remove both defaults, so a recipient without the field reaches no machine and a site-level talon run skips it. Give every recipient literal in the tests `machineIds: null` where it should be whole site. Don't change behaviour for a recipient that carries the field.
  - Done when: neither default remains; a new case shows a recipient with no `machineIds` gets nothing, red before the change; the full web jest is green; eslint and tsc are clean.


- [x] **Task 8.10: `machineScopeOf` fails closed, and two stale talon comments**
  - Files: `web/lib/capabilities.ts` (`machineScopeOf` only, ~342-347), the test suites whose actor literals carry `siteRoles` but no `machineScopes` (find them with a grep), `web/app/api/sites/[siteId]/talons/authored/route.ts` (the comment at ~5-8 only), `web/lib/actions/deleteUser.server.ts` (the comment at ~12 only)
  - Depends on: 8.1, 8.7, 8.9
  - Do: First read the house rules at the top of this file. After 8.1, 8.8 and 8.9, a missing scope reaches nothing everywhere except `machineScopeOf`, which still reads an actor with no `machineScopes` map as the whole site (`if (!actor.machineScopes) return null`). 8.1 kept that branch for test literals that tsc never checks. Every production builder now spreads `siteStanding`, so the map is always present (8.1 verified this). Make the branch fail closed: an actor with no map reaches no machine (`[]`), except a superadmin, who stays whole-site. Give every test literal that relied on the old reading `machineScopes` (null per site for whole-site actors). Also fix the two comments that still say "a talon with a hoot output … starts failing": since 8.7 every talon re-checks its author before any output fires and switches off with nothing fired.
  - Done when: a new `capabilities.test.ts` case shows an actor with no map reaches no machine, red before the change; a superadmin is unchanged; the full web jest is green; eslint and tsc are clean.

## Wave 9: e2e specs, authored in parallel (nothing here runs the rig)

- [x] **Task 9.1: e2e: the scoped journeys**
  - Files: `web/e2e/specs/sites/machine-scope.spec.ts` (new)
  - Depends on: 4.6, waves 5–7
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`. New user-facing behaviour ships with e2e (owner rule).
    - **Setup:**
      - `test.use({ storageState: { cookies: [], origins: [] } })` and `test.describe.configure({ mode: 'serial' })`.
      - A random `SUFFIX`; `SITE = site-scope-${SUFFIX}`; `IN = mach-scope-in-${SUFFIX}`; `IN2 = mach-scope-two-${SUFFIX}`; `OUT = mach-scope-out-${SUFFIX}`. No id contains another, so `hasText` filters stay strict.
    - **beforeAll:**
      - `seedSite({ id: SITE, name: \`scope ${SUFFIX}\`, owner: 'someone-else', timezone: 'UTC' })`.
      - `seedMachine(SITE, id, { monitorCount: 0 })` for IN, IN2 and OUT, so no hardware subdoc outlives the cleanup.
      - Two log docs through `getAdminDb()`, for IN and OUT: `{ timestamp: Timestamp.now(), action: 'process_started', level: 'info', machineId, machineName: machineId, processName: \`e2e-proc-${machineId}\` }`.
      - Three dedicated users: `seedDedicatedUser({ ...dedicatedUser('member', \`scope-m-${SUFFIX}\`), sites: [] })` for `member`, and the same with `scope-a-` for `admin` and `scope-e-` for `empty`. `dedicatedUser` defaults to site-A, which `sites: []` avoids; the global role grants nothing.
      - Their rows:
        - `seedMemberRow(SITE, member.uid, 'member', { machineIds: [IN] })`;
        - `seedMemberRow(SITE, admin.uid, 'admin', { machineIds: [IN, IN2] })`;
        - `seedMemberRow(SITE, empty.uid, 'member', { machineIds: [] })`.
    - **Sign in** each user through /login, like `web/e2e/specs/swoop/picker.spec.ts:70-77` (`fillLogin`).
    - **Tests:**
      1. **The member's dashboard and nav:**
         - the card view shows IN, not IN2 or OUT; the list view (`view-toggle-list`) shows only IN's `machine-row`;
         - the page menu (the desktop dropdown; the drawer on `mobile-chromium`, via `web/e2e/helpers/mobile.ts`) has dashboard, hoot and logs, and no talons, roost or deploy;
         - the user menu (`user-menu-trigger`) has no "admin panel";
         - `/admin/sites/${SITE}` is refused by the admin guard (the `web/e2e/specs/access-control/route-guards.spec.ts` pattern);
         - `/deployments` shows "this page needs whole-site access".
      2. **The empty scope:**
         - `empty`'s dashboard shows "no machines here for you yet" and "a site admin chooses which machines you can reach.";
         - `getting-started-enter-phrase` and `getting-started-authorize` have count 0.
      3. **The scoped admin's menus:**
         - IN's `machine-context-menu-trigger` opens a menu with `machine-context-menu-reboot` and `machine-context-menu-shutdown`, and no `machine-context-menu-revoke-token` or `machine-context-menu-remove`;
         - "add process" is visible;
         - the site switcher (`site-switcher-trigger`) has no "site settings" and no "manage sites";
         - `/admin` and `/admin/sites/${SITE}` both bounce to /dashboard.
      4. **The scoped admin's schedule dialogs:**
         - on IN, `machine-context-menu-schedule-restarts` (or its `-gear` half while online) opens "restart schedule — …";
         - "apply to other machines..." opens "apply restart schedule to...", which lists IN2 and not OUT.
      5. **The admin's API, from the page.** Use `page.evaluate(fetch)` (`web/e2e/specs/access-control/admin-api-403.spec.ts:22-41`) and send an `Idempotency-Key`:
         - `POST /api/sites/${SITE}/machines/${OUT}/commands {type:'capture_screenshot'}` gives 404 with detail 'machine not found or no access', and an Admin SDK read of `sites/${SITE}/machines/${OUT}/commands/pending` has no capture_screenshot entry;
         - the same on IN gives 2xx, and the entry appears;
         - `GET /api/sites/${SITE}/machines` gives ids `[IN, IN2]`.
      6. **The admin's own API key.** Mint one with `mintApiKey({ ownerUid: admin.uid, scopes })` (`web/e2e/helpers/apiKey.ts:43`), with `scopes` granting `machine=*:write` in the helper's `ApiKeyScope` shape (`web/lib/apiKeyTypes.ts`). The same commands POST with `authHeaders()` gives 404 on OUT and 2xx on IN.
      7. **The member's /logs:** IN's row (`e2e-proc-${IN}`) is visible, and OUT's is absent.
      8. **The member's /hoot:** the machine picker lists IN, not OUT.
    - **afterAll:** delete the machines and their `commands/*`, the log docs, the three member rows, the site doc, the three users docs and Auth users (`getAdminAuth().deleteUser`), and the minted key's docs. The `admin/swoop.spec.ts` afterAll is the pattern.
    - **Both projects.** It runs on chromium and mobile-chromium. Where an assertion is desktop-only, use the drawer, or skip on `testInfo.project.name === 'mobile-chromium'` with a reason.
  - Done when: `cd web && npx eslint e2e/specs/sites/machine-scope.spec.ts` is clean, and `npx playwright test --list e2e/specs/sites/machine-scope.spec.ts --project=chromium --project=mobile-chromium` lists every test. Task 10.1 runs it.

- [x] **Task 9.2: e2e: swoop under machine scope and swoop mode**
  - Files: `web/e2e/specs/swoop/session.spec.ts`
  - Depends on: 4.6, waves 5–7
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`.
    - Add a `test.describe('machine scope', …)` to the file. Reuse its helpers rather than copying them: `seedTotpUser`, `signIn`, `freshTotp`, `nextGrant`, `recordSwoopResponses`, `readSession`, `apiCall`, `alertLine`, `expectHostPicture` and `FakeSwoopHost` (`web/e2e/helpers/swoopHost.ts`). Release 2 added its own `swoop mode` describe here; leave it as it is.
    - **The describe's beforeAll:**
      - Machines `SCOPE_IN = \`mach-scope-in-${SUFFIX}\`` and `SCOPE_OUT = \`mach-scope-out-${SUFFIX}\``, made with `seedMachine` on the file's `SITE_ID`, where swoop is already on.
      - Three people:
        - `scopedController`: `seedTotpUser(\`scope-ctl-${SUFFIX}\`)`, then `grantMembership(SITE_ID, uid, 'member', { swoop: 'control', machineIds: [SCOPE_IN] })`;
        - `scopedAdmin`: `seedTotpUser`, then `'admin'` with `{ machineIds: [SCOPE_IN] }`;
        - `scopedWatcher`: a dedicated member with no second factor (the file's `watcher` pattern), then `'member'` with `{ machineIds: [SCOPE_IN] }`.
    - **Tests:**
      1. **`a scoped watcher sees only their machine, and is refused another before any ceremony`:**
         - Sign in. `/swoop` shows SCOPE_IN's card and not SCOPE_OUT's.
         - `/swoop/${SITE_ID}/${SCOPE_IN}` mints `ctl: false` and shows `/view only/i`. End the session.
         - `/swoop/${SITE_ID}/${SCOPE_OUT}`:
           - the alert line shows 'machine not found or no access';
           - there is no dialog `/confirm it.s you/i`, and no "this machine has left the site.";
           - within 5 s, no session POST follows the 404 (count them with `recordSwoopResponses`).
      2. **`a scoped member set to control takes control of their machine, through a host, and nothing else`:**
         - `FakeSwoopHost.start({ browser, viewer: page, siteId: SITE_ID, machineId: SCOPE_IN })`, and `signIn(page, scopedController, secret, { fresh: true })`; the fresh sign-in is the step-up.
         - `nextGrant` gives `ctl: true`, `expectHostPicture` passes, `host.leases` equals `[{ viewer, sid, uid: scopedController.uid, ctl: true }]`, and `/view only/i` has count 0.
         - From the page:
           - `GET /api/sites/${SITE_ID}/swoop/sessions` gives 403;
           - a kill on SCOPE_OUT gives 404;
           - a kill on SCOPE_IN gives 403. If the 3.1 Log says kill stayed on MACHINE_REMOTE_CONTROL, it gives 200 instead; do it last.
         - End the session, and stop the host in `finally`.
         - Then `/swoop/${SITE_ID}/${SCOPE_OUT}` shows the 404 line. `users/${uid}/swoop_step_up/${binding}` does not exist, where `binding = sha256(\`${uid}/${SITE_ID}/${SCOPE_OUT}\`).slice(0, 32)`, as `stepUpMachineBinding` computes it in `web/lib/swoop/policy.server.ts`. That proves the wrapper refused before the fresh-ceremony branch wrote a window.
      3. **`a scoped admin takes control after the step-up dialog`:**
         - `signIn(page, scopedAdmin, secret)` (aged), then `/swoop/${SITE_ID}/${SCOPE_IN}`.
         - The dialog shows `/confirm it.s you/i`. Fill `freshTotp(page, secret, spent)` and confirm.
         - The 201's `ctl` is true, and `readSession` viewers equal `[[scopedAdmin.uid, true]]`. End the session.
    - **afterAll:** remove the three rows, the two machines with their `swoop_sessions` and `commands`, and the users and Auth users, following the file's own cleanup.
  - Done when: eslint is clean on the file, and `npx playwright test --list e2e/specs/swoop/session.spec.ts --project=chromium --project=mobile-chromium` lists the describe.

- [x] **Task 9.3: e2e: editing access in the members section, a phone included**
  - Files: `web/e2e/specs/sites/member-access.spec.ts` (new)
  - Depends on: 4.6, waves 5–7
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`.
    - **Setup** (serial, empty storageState):
      - `SITE`, with machines `IN` and `OUT` (as in task 9.1) and swoop turned on: `restoreSwoop = await setSiteSwoop(SITE, { enabled: true })`.
      - Four dedicated users:
        - `owner`, made the site's owner through `seedSite({ owner: owner.uid })`;
        - `siteAdmin`, through `grantMembership(SITE, uid, 'admin')`;
        - `target`, a whole-site member;
        - `newbie`, with no row.
      - One talon doc authored by `target`: `sites/${SITE}/talons/e2e-talon-${SUFFIX}`, with `createdBy: target.uid`, `name: 'e2e talon'`, and the minimal fields an existing talons spec seeds (`git grep -n "createdBy" web/e2e/specs/talons`).
    - **Sign in as siteAdmin** (fillLogin) and open release 2's members section, `/admin/sites/${SITE}?section=members` (the route per the 3.1 Log).
    - **Tests, in order:**
      1. **`narrowing access ends their session on a dropped machine`:**
         - In a second context (`browser.newContext()`), target signs in and opens `/swoop/${SITE}/${OUT}`. Wait for the 201 (`nextGrant`-style, `ctl: false`).
         - Back on the admin page, target's row reads "whole site".
         - change access... → "some machines". Save is disabled, and "pick at least one machine" is visible.
         - Pick IN. "they wrote 1 talon" is visible.
         - Save. The toast says "access updated", and the row reads "1 machine". The Admin SDK row `sites/${SITE}/members/${target.uid}` has `machineIds` equal to `[IN]`.
         - `expect.poll` (10 s) on the admin page's GET of target's OUT session until `[state, endReason]` equals `['ended', 'scope_changed']`. Target was alone in it.
      2. **`whole site gives everything back`:** change access... → "whole site" → save. The row reads "whole site", and the Admin SDK data has no `machineIds` key.
      3. **`the owner's row and your own have no change access`:** neither row's menu offers "change access...".
      4. **`access is set when adding`:**
         - add member → newbie's full email → role member → machines "some machines" → IN → add.
         - The toast says "member added", and newbie's row reads "1 machine". The Admin SDK row has `machineIds` `[IN]`.
      5. **`removing a machine leaves no one holding it`:**
         - siteAdmin sends `DELETE /api/sites/${SITE}/machines/${IN}` from the page, with an `Idempotency-Key` (pattern `e2e/specs/security-boundary/major-flows.spec.ts:60`), and gets 2xx.
         - Reload the section. Newbie's row reads "no machines", and the Admin SDK `machineIds` equals `[]`.
      6. **`the editor fits a phone`:** on `mobile-chromium` (390 px), open change access... on target's row, and `expectFullyWithinViewport` (`web/e2e/helpers/mobile.ts`) the access buttons, the machine picker trigger, save and cancel. Skip on chromium, with a reason.
    - **afterAll:**
      - `restoreSwoop()`;
      - delete the machines and their `swoop_sessions`/`commands`, the talon doc, the member rows, the site doc, and the users docs and Auth users;
      - reset `users/{uid}.lastSiteId` if it changed (release 2's contamination note).
  - Done when: eslint is clean, and `--list` shows every test on both projects.


- [ ] **Task 9.4: The existing members e2e follows the access column, and four stale talon comments**
  - Files: `web/e2e/specs/sites/site-members.spec.ts`, plus the comment lines only in `web/app/api/sites/[siteId]/members/[uid]/route.ts` (~9-11), `web/lib/talons/store.server.ts` (~553-556), `web/app/api/users/[uid]/talons/route.ts` (~5-6), `web/hooks/useTalonReassign.ts` (~8-9)
  - Depends on: 7.9, 8.7, 8.10
  - Do: First read the house rules at the top of this file. 9.3 found that `site-members.spec.ts` has probably been red since 7.9 (be2cef36). Its `COLUMNS` has no `access`, so `'actions'` now reads the access cell (~line 300). Its swoop-cell `toHaveText` checks (~254, 262, 270, 301) read the full text, which now includes the md:hidden ` · {access}` suffix. Update the spec to 7.9's table: add the access column, and match the swoop cell without the suffix (or assert the suffix where the viewport shows it). Don't weaken an assertion. Also rewrite the four comments that still say "a talon with a hoot output … stops dead / starts failing". Since 8.7, every talon re-checks its author before any output fires and switches off at its next run with nothing fired.
  - Done when: eslint is clean on every touched file, tsc is clean, and `npx playwright test --list e2e/specs/sites/site-members.spec.ts` loads. 10.1 runs the spec on the rig.

## Wave 10: one rig run

- [ ] **Task 10.1: Build once, and run the new specs and the docs links**
  - Files: the three specs from wave 9. Product files only to fix a real defect, each logged with the task that owns the file and a regression test.
  - Depends on: waves 8–9
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`. This is the only task in its wave, so it owns the rig.
    1. `cd web && npm run e2e:build`.
    2. `cd .. && firebase emulators:exec --only auth,firestore,storage --project demo-playwright-e2e "cd web && npx playwright test e2e/specs/sites/machine-scope.spec.ts e2e/specs/swoop/session.spec.ts e2e/specs/sites/member-access.spec.ts e2e/specs/public/docs-links.spec.ts --project=chromium --project=mobile-chromium"`.
    3. **A failure in a spec's own logic** is fixed in the spec. **A product defect** gets a failing jest case first, then the fix in the owning file. **A broken docs link** is fixed in the wave 8 page that has it.
    4. **A late `ERR_ADDRESS_IN_USE`,** or a stuck loading screen, is this box's port exhaustion: rerun after TIME_WAIT drains, and only then treat a red as real. Beside another session's emulator, use shifted ports (`web/e2e/README.md`).
  - Done when: every test in the four specs passes on both projects, and the Log lists each fix and the task that owns it.

## Wave 11: local verification

- [ ] **Task 11.1: The local gates and the two-axis review**
  - Files: `dev/active/machine-scope/{plan,tasks,context}.md` (the tracked copy, refreshed). Fixes go to the files that own them, and are logged.
  - Depends on: all of waves 0–10
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`. Work on the named branch, never a detached HEAD: project memory says the security gate grades main there. Run:
    1. `node scripts/check-security-alerts.mjs`, which must exit 0. Never ack on your own judgment.
    2. `cd web && npm run lint && npx tsc --noEmit && npm test -- --ci`.
    3. `cd web && npm run test:rules`. Never beside e2e: both use :8080.
    4. `cd web && npm run validate:api`.
    5. `cd functions && npm test && npm run build`.
    6. From the worktree root, `C:/Users/admin/Documents/Git-restored/Owlette/agent/.venv/Scripts/python -m pytest agent/tests/`. The agent is untouched, but this release still ships installers.
    7. `cd web && npm run e2e`: the full suite, on both projects. Late `ERR_ADDRESS_IN_USE` or stuck-loading failures are port exhaustion: rerun after TIME_WAIT drains.
    8. `/verify` on the diff against origin/dev. Resolve every confirmed finding.
    9. Copy the main checkout's three plan files over the tracked copy, and commit `docs: machine-scope plan log`.

    Record each command's result in the Log.
  - Done when: all nine are done and green, and the Log says so plainly, naming anything not run.

## Wave 12: the owner sitting, and ship to dev

- [ ] **Task 12.1: UX review, then rules and function to dev, read path, full release, merge, tag**
  - Files: `VERSION`, `agent/VERSION` and `web/package.json` (through `node scripts/sync-versions.js`), `docs/changelog.md`, `web/content/docs/changelog.mdx`, plus build outputs (not committed)
  - Depends on: 11.1
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`. Batch every owner step into one sitting (the tridant:wizard skill; project memory: no repeated manual asks).
    - **The owner's sitting, all in one ask:**
      - **(0) UX review first**, in a headed emulator preview. Localhost uses dev Firebase, and the owner's passkey 2FA cannot pass there, so seed the emulator instead (project memory, owner-ux-review-local-preview).
        - Open two windows: a whole-site admin on the members section, and a scoped member on the dashboard.
        - The owner looks at:
          - the access field in "change access..." and in "add member", the talon warning and the access column;
          - the scoped dashboard, the "no machines here for you yet" state, and "this page needs whole-site access";
          - each of those at 390 px, in light and dark.
        - If he rejects anything, fix it, re-run the affected checks from 11.1, and show it again before (a).
      - **(a)** `firebase deploy --only firestore:rules --project owlette-dev-3838a` from this branch. It is safe for every existing row: none carries machineIds, and absent is the whole site.
      - **(b)** `firebase deploy --only functions:getUsageSummaryHttp --project owlette-dev-3838a`.
      - **(c)** uploading the installers to dev and setting them as latest.
      - **(d)** opening and merging the release PR into dev, and the tag.
    - **Steps after the go:**
      1. Run (a) and (b). Keep both deploy outputs ("released rules firestore.rules to cloud.firestore"; the function's success line) for the Log. Then `node scripts/check-membership-read-path.mjs --env=dev`: its existing checks pass for a whole-site subject, and the scope section SKIPs. The first scoped row, in task 13.1, proves 2.12.0's behaviour.
      2. The full release (decision 8). Follow `.claude/skills/build-system/SKILL.md` → "Agent Installer Release" and `docs/runbooks/agent-installer-release.md`. The version is the next patch after release 2 (4.1.28 if release 2 is 4.1.27); confirm it in the ask.
         - `node scripts/sync-versions.js X.Y.Z`;
         - turn `[Unreleased]` into `## [X.Y.Z] - <date>` in both changelogs;
         - commit `release: X.Y.Z`, listing any security acks in the body;
         - build the signed exe here (OWLETTE_SIGN=1, using the skill's non-interactive invocation), the pkg on the MBA and the deb on the kiosk VM. Project memory has the access notes;
         - `node scripts/refresh-docs-screens.mjs`;
         - (c), then download and check each installer from dev.
      3. (d):
         - push with the explicit refspec `git push -u origin feat/machine-scope:feat/machine-scope`;
         - open the PR to dev, and wait for its checks (playwright e2e, rules, checks, openapi-validate, functions);
         - merge, and tag `vX.Y.Z`;
         - watch the post-push run in the background (`gh run watch <id> --exit-status`). On a red: `gh run view <id> --log-failed`, diagnose, and propose a fix. Never auto-fix and repush.
      4. `GET $OWLETTE_DEV_API_URL/api/health` shows the new version.
  - Done when:
    - dev serves the new installers and runs the new web;
    - the rules and function deploy outputs are in the Log. The Firebase console's rules tab is an optional owner look, not the proof;
    - the read-path script passed;
    - the tag is pushed;
    - the Log records each step and anything left unverified.

## Wave 13: proof on dev.owlette.app (the owner's sitting)

- [ ] **Task 13.1: One real scoped member with swoop control on dev, proved from the deployed rules and from their seat**
  - Files: none (evidence goes in the Log)
  - Depends on: 12.1
  - Do: First read the house rules at the top of `C:/Users/admin/Documents/Git-restored/Owlette/dev/active/machine-scope/tasks.md`. Prove the owner's own case: a member scoped to one machine, with swoop mode control.
    1. **Owner:**
       - Pick a non-superadmin account with an enrolled second factor, on a dev site with at least two machines (or create one with an address you control).
       - In the site's members section, use change access... → role member, swoop control, machines "some machines" → one machine → save.
       - Give its email here.
    2. **Me, read-only:**
       - `GET /api/sites/{site}/members` with the dev key (`OWLETTE_API_KEY`) shows the row with `machineIds` and `swoop` set; note its uid.
       - If the key lacks admin on that site (as on elm-gate today), skip this read and run step 3 without `--uid`. It picks the only scoped row and prints whose it is.
    3. **Me:** `node scripts/check-membership-read-path.mjs --env=dev --scoped --uid=<uid>`. Every check must pass:
       - the per-machine gets;
       - the `documentId() in` lists;
       - both logs `in` queries, the alert-toast shape included;
       - the site-wide denials.

       A FAIL is a stop. Report it, and use the rollback in context.md only on the owner's call.
    4. **Owner,** in a private window signed in as that account, with a screenshot of each:
       - the dashboard shows only that machine;
       - the page menu has no talons, roost or deploy, and `/deployments` says "this page needs whole-site access";
       - `/swoop` lists only that machine;
       - taking control works after the step-up: no "view only", and the mouse moves;
       - a second machine's `/swoop/{site}/{machine}` URL says 'machine not found or no access' with no step-up;
       - `/logs` shows only that machine's rows;
       - `/admin` is refused.
    5. **Owner:** keep the scoped row (for example, to scope Slawek on TEC later), or give back the whole site.
    6. **Report** plainly what was seen, before and after, and what stayed unverified. Prod is not part of this release. At promotion, the runbook step from task 8.5 deploys 2.12.0 and the function to prod before this web reaches main, and checks the Vercel standby's commit.
  - Done when: the script output and the owner's screenshots are in the Log, or the Log says plainly which check could not be done.

## Log
### 2026-11-04
- Plan created from the 2026-11-04 research maps (rules, routes-machines, routes-site, swoop, swoop-left-site, swoop-pills, client-reads, tests, docs-openapi, ui, user-search, billing) and owner decisions 1–12.
- Revised the same day against:
  - owner decisions 13–14, the per-person swoop mode;
  - two critiques;
  - release 2's revised plan (`dev/active/admin-sites`, swoop mode with `MemberStanding`/`siteStanding`/`swoopModes`/`updateMember`, kill on SWOOP_SETTINGS_MANAGE, ADR 0015).
- Waves 4 on now build on release 2's merged helpers. The scope × mode decisions are in context.md.
- A read-only dev check: `elm-gate` holds only TEC-B4A. `GET /api/sites/elm-gate/members` answers 403 `scope_insufficient` with the dev key, so Slawek's role is unverified.
- Start with task 0.1.
- 2026-11-04 ~03:40, decisions by Claude under the owner's standing rulings (the owner may override):
  - scoped admins cannot remove their machine or uninstall on it (site-wide); autonomous hoot chats stay hidden from scoped members; SDK/CLI machineIds later (same answer as release 2's Q7); the three small leaks (excludedMachineIds ids, uids in commands/pending, step-up windows outliving a narrowing) are accepted and documented; scoped members may see roost names for their machines; the 30-machine cap stands; version 4.1.28; a machine that leaves and pairs back starts with no member grants; whether TEC-B4A moves back to TEC is the owner's call after release 3.
- 2026-11-04 ~04:05, task 0.1 (by the orchestrator): release 1 (4.1.26) NOT merged yet (branch fix/swoop-second-viewer-joins at 53516e53 plus follow-on commits in flight); release 2 (4.1.27) NOT merged (feat/admin-sites, wave 1 running). Worktree ../Owlette-machine-scope-wt on feat/machine-scope cut from origin/dev ab4689bb; plan committed as 9abafa74; web and functions npm ci run. Answers: Q2 = no (scoped admins cannot remove/uninstall), Q3 = hidden (autonomous chats), Q4 = later (SDK/CLI). Waves 1-2 may proceed; wave 3 waits for release 2's merge.
- 2026-11-04 ~04:30, task 1.1 done (commit 2003d61c): web/__tests__/rules/siteReadControls.test.ts, 139 whole-site read controls on rules 2.11.0; npm run test:rules 338/338 twice. Note for 2.2: chats/c1 has no userId (autonomous branch only); logs/lb has machineId null and must stay readable whole-site.
- 2026-11-04 ~05:20, wave 2 done (4/4): 2.1 729e7298 (web/lib/machineAccess.ts, 21 tests), 2.2 51c5a305 (firestore.rules 2.12.0 + machineScope.test.ts 147 cases; red 44 on 2.11.0; npm run test:rules 485/485), 2.3 d0e44f2a (read-path script --scoped/--list-scoped; dev has 0 scoped rows; the scoped section is unproven until rules 2.12.0 deploy), 2.4 56c581eb (usage function needs whole-site standing, red-first, functions 357/357).
  Follow-up 2.5 (orchestrator): memberHoldsMachine must guard `data.machineIds is list` (a map value passes `in` by key); add the rules test case. Wave 3 waits for release 2's merge.
- Hardening note for 2.2: the client SDK does not enforce the 30-value `in` cap (firebase 12.19); the emulator rejects 31 with invalid-argument.
- 2026-11-04 ~06:00, follow-up 2.5 done (commit eb87cad0): memberHoldsMachine guards `machineIds is list`; red on 51c5a305 (a `{IN: true}` row could read machines/IN, config/IN and list by documentId in [IN]), green after: npm run test:rules 499/499. Waves 0-2 complete on feat/machine-scope (last commit eb87cad0); wave 3 (rebase) waits for release 2's merge to dev.
- 2026-11-07, task 3.1 done (task-executor): `feat/machine-scope` rebased onto origin/dev fccd85b9 with no conflict. Release 1 (bd426370) and release 2 (bb032cab) are in its history; head 72b3b66e (plan 50bbc873, then a13aca3c, 7df68fdb, e689347a, 896653c5, 9fa9fb01, 72b3b66e). Dev's rules are still 2.11.0. Lockfiles unchanged. test:rules 501/501, machineAccess 21/21, functions 357/357, tsc clean. **Version is now 4.1.29**: swoop-clarity takes 4.1.28 (owner, 2026-11-07, "both in parallel").
  `release names`: the full block is in this session's 3.1 report. The deviations below are what waves 4 on must follow:
  - Release 1's revocation ends the **whole** session (`endReason 'revoked'`, `endedFor`), and the others rejoin. It does not remove seats, so a narrowing reaches a shared session in ~2 s for everyone. Decision 14's "one lease plus 30 s" is wrong, and 5.4's `keepMachineIds` builds on the whole-session end.
  - The viewer email gate keys on the site role (`superadmin || owner || admin`, session GET route.ts:99-100), not SITE_MEMBER_MANAGE. 6.6 or 7.5 must re-key it to whole-site standing, or a scoped admin gets emails.
  - **Open, owner's call:** release 2's question 6 was answered "the dashboard reads the mode in release 3" (hide swoop entries from someone set to none; admin-sites tasks.md:1336). This plan's decision 16 says the dashboard does not read the mode, and no task carries it.
  - The escalation blocks end at 17, so the next is 18 (7.11 says 19).
  - `siteStanding` takes `[siteId, standing]` pairs and returns `swoopModes` only when non-empty: users/me's call is `siteStanding([])`, and 8.1 changes the optional.
  - The wrapper's `authToActor` parameter type (`authorizedHandler.server.ts:253-257`) must widen in 4.1 to carry `machineScopes`.
  - `useSiteMachines` was not extracted; site settings' `SiteMachinesList` fetches `GET /api/sites/{siteId}/machines`.
  - `siteStanding` is also called from hoot (`provision-key:74`, `cancel-tool:184`, `hoot-utils.server.ts:235`) and talons (`store.server.ts:626`). 4.1 covers them.
- 2026-11-07, owner rulings: release 2 Q6 holds, so the dashboard hides swoop from someone set to none. That is new task 7.12 (after 7.1, 7.2 and 7.5), reversing context decision 16 for this case only. Version 4.1.29. 55 tasks.

#### release names (task 3.1, 2026-11-07; worktree at fccd85b9 + 7, line numbers as of the rebase)
**Release 2, the swoop mode**
- `web/lib/swoopMode.ts`: `SWOOP_MODES = ['none','view','control'] as const`, `type SwoopMode`, `SWOOP_MODE_LABELS` = `{none:'no swoop', view:'watch', control:'control'}`, `parseSwoopMode(raw)` (undefined → null; a bad value → `'none'`), `grantedSwoopMode(role, mode)` (owner always `'control'`; otherwise the mode, or by role: member `'view'`, admin `'control'`), `effectiveSwoopMode(role, mode, membersMayWatch)` (a member with no mode on a site with `membersMayWatch` off gets `'none'`).
- `web/lib/capabilities.ts`:
  - `MemberStanding { role: SiteRole | null; swoopMode: SwoopMode | null }`.
  - `siteStanding(bySite: Iterable<readonly [string, MemberStanding]>)` → `{ siteRoles, swoopModes? }`, null-prototype records. A null role is skipped, an owner's mode is dropped, and `swoopModes` is present only when non-empty.
  - `UserActor.swoopModes?` (optional). `explicitSwoopMode(actor, siteId)` reads own properties only.
  - The override in `hasCapability(actor, capability, siteId?)` (319-344) sits in the site-scoped branch, after the own-property `siteRoles` lookup and its undefined check, before the `SiteRoleCapabilityMatrix` lookup. Its condition is `(capability === MACHINE_REMOTE_VIEW || capability === MACHINE_REMOTE_CONTROL) && siteRole !== 'owner'`, then `mode = explicitSwoopMode(...)`; if `mode !== null` it returns `CONTROL ? mode === 'control' : mode !== 'none'`. There is no machineId parameter yet.
- `web/lib/sitePolicy.server.ts`: `SiteAccessFacts.swoopMode`. `deriveSwoopMode(memberData, role)` is null unless the role is admin or member, otherwise `parseSwoopMode(memberData?.swoop)`. `deriveMembership` is exported. `listUserStanding(uid)` returns a null-prototype **record** `Record<string, MemberStanding & {role: SiteRole}>`; callers pass `Object.entries(...)`.
- Who calls `siteStanding`:
  - the wrapper, `authorizedHandler.server.ts:620` (`authorizedSiteHandler`). Its `authToActor` parameter type at 253-257 is the literal `{ siteRoles; swoopModes? }`, and **4.1 must widen it** to carry `machineScopes`;
  - `_shared.ts:419` (`requireSiteCapability`), `apiAuth.server.ts:469` (`assertUserHasSiteCapability`), `member-candidates/route.ts:105`;
  - `hoot/provision-key/route.ts:74` and `hoot/cancel-tool/route.ts:184` (from `access.siteRole`/`access.swoopMode`), `hoot-utils.server.ts:235` `actionContextForHoot` (from `options.userSiteRole`/`options.userSwoopMode`), and `talons/store.server.ts:626` `loadSuccessorActor` (from `deriveSwoopMode`).
  - hoot's `SiteAccessLevel` carries flat `siteRole` and `swoopMode`, not `standing`. Literal `{ siteRoles: {} }` actors are at `users/me/route.ts:80` (its planned `siteStanding({})` must be `siteStanding([])`) and the wrapper's `loadUserActor`.
- The wrapper's swoop refusal: `capabilityExempt = BYPASS_EXEMPT_CAPABILITIES.has(options.capability)` (MACHINE_REMOTE_CONTROL, MACHINE_REMOTE_VIEW, SWOOP_SETTINGS_MANAGE). On a deny it returns `problem({type: Forbidden, title:'forbidden', status:403, detail:'capability not granted', code:'capability_missing'})`; any other capability gets `problemForbidden('capability not granted')`. The wrapper's 404s (`problemNotFound`) carry code `not_found`. The viewer's `REVOKED_REFUSALS` (`useSwoopSession.ts:230`: `not_found`, `user_inactive`, `members_may_not_watch`) reads that as access removed.
- `evaluateSwoopAccess`: `members_may_not_watch` applies only for a member with `explicitSwoopMode === null` and `!settings.membersMayWatch`. It runs after `hasCapability(actor, cap, siteId)`, with no machineId.
- Kill (`.../swoop/kill`), `GET /api/sites/{siteId}/swoop/sessions` (names and emails via `viewerNames`) and the new `POST .../swoop/sessions/{sid}/kick` `{viewerId}` are all on SWOOP_SETTINGS_MANAGE. The session GET adds per-viewer `kickable = hasCapability(SWOOP_SETTINGS_MANAGE) && not self`.
- The pill email gate runs on the server, in the session GET (`web/app/api/sites/[siteId]/machines/[machineId]/swoop/sessions/[sessionId]/route.ts:96-100`). Names go only to people seated in the session. Emails go to `superadmin || owner || admin` by site role, **not SITE_MEMBER_MANAGE**, so 6.6 or 7.5 re-keys it to whole-site standing. Its test is `web/__tests__/api/swoop/sessions.test.ts` ("naming the people in it"). The machine doc mirrors `swoopSeats` (`{uid, displayName, ctl}`, never an email) via `syncMachineSwoopViewers`.

**Release 2, membership**
- `updateMember({ siteId, uid, role?: AssignableRole, swoop?: SwoopMode | null, db? })` (`web/lib/membership.server.ts:149`) → `MembershipResult<{ before, after }>`, each a `MemberAccess { role: MemberRole; swoop: SwoopMode | null }`. `swoop: null` writes `FieldValue.delete()`, and an owner row gives `is_owner`. `addMember` takes `swoop?`, and `MemberDoc.swoop?` exists.
- The PATCH revocation (`members/[uid]/route.ts:448-463`): `had`/`has = grantedSwoopMode(...)`, `lostSwoop = had !== 'none' && has === 'none'`, `lostControl = had === 'control' && has !== 'control'`. It fires on either, with reason `before.role !== after.role ? 'role_changed' : 'swoop_changed'`, and `controlOnly: true` unless `lostSwoop`. It is a void call, not awaited.
- The PATCH's "neither" 400: `problemValidation('role or swoop is required', { 'body.role': ['provide role, swoop or both'], 'body.swoop': [...same] })`. A bad swoop gives `'swoop must be none, view, control or null'`. The POST validates with `SWOOP_MODES.find(...)`, refuses null with `'swoop must be none, view or control'`, and writes the mode on a new row only.
- The audit verbs are in `emitMutation` attributes (`kind: 'site_member_mutated'`): `verb: role !== undefined ? 'member_role_changed' : 'member_swoop_changed'`.
- The member-candidates route is `GET /api/sites/{siteId}/member-candidates` on SITE_MEMBER_MANAGE; API keys are refused.
- The revocation reason type: `'member_removed' | 'role_changed' | 'swoop_changed'`.

**Release 2, UI and helpers**
- `useSiteMembers`: `SiteMember.swoop: SwoopMode | null`, `AddSiteMemberInput = { role; swoop?: SwoopMode } & ({uid} | {email})`, `updateMember(uid, patch: UpdateSiteMemberInput { role?: AddableSiteMemberRole; swoop?: SwoopMode | null })`.
- In `web/components/admin/sites/`:
  - `SiteMembersSection({ siteId })`;
  - `MemberAccessFields({ idPrefix, role, swoop: SwoopChoice, onRoleChange, onSwoopChange, membersMayWatch, disabled? })`, which also exports `SwoopChoice = 'default' | SwoopMode`, `toSwoopChoice` and `fromSwoopChoice`;
  - `AddMemberDialog({ siteId, membersMayWatch, onOpenChange, addMember })`;
  - `ChangeAccessDialog({ member, membersMayWatch, onOpenChange, updateMember })`, which also exports `memberLabel`.
  - `SegmentedControl<T>({ label, options, value, onChange })` is at `web/components/admin/SegmentedControl.tsx`.
- `useSiteMachines` does not exist. Site settings' `SiteMachinesList` fetches `GET /api/sites/{siteId}/machines`. The sections are general, members, machines, swoop (`SiteSwitches`) and danger.
- Smaller names:
  - `siteTalonSuccessors(members, excludeUid?)` (`web/lib/talonSuccessors.ts:69`) keeps owner and admin rows.
  - `SiteList` labels a site with `accessFor(site)`: `isSiteOwner ? 'owner' : isSiteAdmin ? 'admin' : 'member'`.
  - `SiteSettings`' member-only copy shows when `!held && !isSiteAdmin(site.id)`.
  - `/admin/sites/{siteId}?section=members` comes from `siteSettingsPath` in `web/lib/siteSettingsPath.ts`.
- `grantMembership` / `seedMemberRow` (`web/e2e/helpers/seed.ts:187`, `:213`) take `extra?: { swoop?: SwoopMode }`, spread into the row.
- The escalation blocks are **13–17** in `membershipEscalation.test.ts`, so the next is 18. `web/__tests__/lib/sitePolicy.test.ts` exists. ADR 0015 is release 2's, and 0016 is free. GLOSSARY added Swoop mode, Site settings and Kick, and changed Site role, Viewer, Kill and Session.

**Release 1**
- `revokeSwoopSessionsForUser` (`web/lib/swoop/revokeViewerSessions.server.ts:135`) ends the **whole** session for every unended session the user sits in (control seats only when `controlOnly`): `endReason 'revoked'`, `endedFor: uid`, via `endSwoopSessionForUser`. It uses the sid-scoped kill broadcast, or the polled `swoop_kill` if the broadcast fails, and everyone else rejoins and is decided again. It writes the audit row with `endReason: args.reason`, never throws, and returns `{ revokedSids }`. `removeSwoopViewers` serves only a person leaving their own seat and `viewer_left`.
- The session GET's viewer names come from `viewerNames([session])`, only when the caller holds a seat. Each entry has `displayName`, `email` behind `withEmail`, and `kickable`; the response also carries `endedFor`.
- "Left the site" fires only on the create route's 404 `machine_not_found` (`swoop/sessions/route.ts:259-265`, a missing machine doc) or on the record's `endReason: 'machine_removed'`, which `removeMachine` writes and `leftTheSite()` (`useSwoopSession.ts:256`) reads. A refused read gives `'refused'` or null, never "left". The viewer page reads `useMachines(siteId)` only for `osFamily` (`app/swoop/[siteId]/[machineId]/page.tsx:65-66`), and `SwoopPicker` lists from `useMachines(siteId)`.

- 2026-11-07, wave 4 done (8/8) on `feat/machine-scope`, beside swoop-clarity's wave 2. No emulator ran.
  - 4.1 ebb5782b, the decision core. Four departures, all for later tasks to read:
    - `siteStanding` returns `machineScopes` only when some site is scoped, then with an entry for every site. Always-present would break release 2's unchanged `toEqual` cases, `authorizedHandler.test.ts:295` and `hoot-utils.test.ts:2268`.
    - `machineIds ?? null` in `siteStanding` keeps release-2 test literals that lack the field reading as whole site. **8.1** gives those literals `machineIds: null`, drops the `??` (the one fail-open default) and makes `machineScopes` always present.
    - tsc named four builders outside the task's list:
      - `talons/store.server.ts` now uses `memberStanding`. That is **5.5's edit, done early**; 5.5 adds its tests and doesn't redo it.
      - hoot's `actionContextForHoot`, `hoot/cancel-tool` and `hoot/provision-key` pass `machineIds: null`. Until **5.3** (`userStanding`) and **6.4** (`access.standing`) replace exactly those three lines, a scoped person gets a whole-site hoot actor (for example, provision-key's site-level MACHINE_EXEC_COMMAND). Their comments say the real standing is threaded in.
    - A cross-product oracle covers 1,368 cases, and a mutation that lets site-wide capabilities through for a scoped actor fails 329 of them.
  - 4.2 1658597a: `MemberDoc.machineIds`, `invalid_machine_ids` and `MemberAccess.machineIds`. `addMember`/`updateMember` normalize the list, null deletes it, and a role or swoop change keeps the scope. `pruneMachineFromMembers` keeps `[]` and writes one batch (500 writes at most, enough). An invalid list is refused before the owner check.
  - 4.3 1ea3fb6b: `useSiteMemberships` gains `scopeMap`. `useMachines(siteId, machineIds?)` queries `documentId() in`, and `[]` opens nothing. Beyond the Do: `useMachines`' `error` is keyed to site and scope, so a refusal never carries over (7.1 relies on it).
  - 4.4 6f660624: `getSiteAlertRecipients` reads the member rows, and each recipient carries `machineIds`. `recipientWantsMachine` replaces every mute check. Three unused email helpers are deleted. A talon run on one machine counts a recipient left out by scope as muted, and a site-level run skips scoped recipients. Open: the display and process digests take the timezone from the site's first alerting machine, which may be outside a scoped recipient's scope.
  - 4.5 9a0dfbbb: `useAgentAlertToasts(…, machineIds?)` and `useOwletteChat({ includeAutonomous })` (default true; **7.6** makes it required). **7.1** passes the scope as the fourth argument.
  - 4.6 d33194a3: seed `extra.machineIds`. Latent: `session.spec.ts:485` has a TS2554 that tsc never checks (e2e is excluded).
  - 4.7 84ea77c4: ADR 0016 and the glossary. Three departures, all following the shipped code:
    - narrowing ends the whole swoop session within about 2 s, and everyone rejoins;
    - Kick is amended to "whole-site owner or admin";
    - Site role "takes away everything site-wide; it never widens what the role allows".
    - The ADR quotes the 404 text 'machine not found or no access', so **5.1** must use exactly that string.
  - 4.8 54127762: `MachineAccessField`.
    - `disabled` is a `<fieldset disabled>` wrapper.
    - A visible `aria-hidden` "access" label is unasked; the owner's UX review decides.
    - The picker's test id is `add-member-machines-machines` (9.3's e2e uses it).
- 2026-11-07, wave 5 done (7/7). No emulator ran.
  - **Git in a shared tree:** two plain `git commit`s swept up 5.7's staged files (5.4's 0b8d1403, then 5.1's f512c63f). Both agents soft-reset and recommitted their own paths, and the orchestrator committed 5.7 on its own. Nothing was lost. **Every executor brief from wave 6 on says to commit with `git commit --only -F <msg> -- <paths>`.**
  - 5.1 a3a6660b: the wrapper's scope step runs after the actor is built and before `securityConfig.read()`.
    - Off the scope: 404 'machine not found or no access', audited `machine_out_of_scope`.
    - On a site-wide route or capability: the capability refusal, audited `machine_scope_site_wide`.
    - `capabilityRefusal(capability)` is shared, and `hasCapability` gets the route's machineId.
    - `display-settings` (MACHINE_CONFIG_WRITE, no machineId) now refuses scoped callers, per decision 10.
    - 93/93, with 18 of the new cases red on the old wrapper.
  - 5.2 b1adbbf1:
    - `assertUserHasSiteAccess` returns `machineIds`.
    - `requireSiteAuthAndScope({ machineScope: 'deny' | 'admit' })` denies by default (403 'capability not granted').
    - New `requireSiteMachineAuthAndScope`: 404 off the scope.
    - `requireMachineAuthAndScope` gives the 404 after the agent short-circuit.
    - Roost refuses scoped callers, reads included. Chat returns `machineIds`; platform and agent return null.
    - The `requireSiteCapability` case is tested through the exported wrappers (WEBHOOK_MANAGE, DISTRIBUTION_MANAGE) because the function is private; MACHINE_ENROLL is pinned on `assertUserHasSiteCapability`.
    - **For wave 6:**
      - `requireSiteMachineAuthAndScope` audits key use and runs the plan gate (402 on a site without api keys) before its 404, unlike `requireMachineAuthAndScope`. Nothing leaks, but wave 6 may align them by passing the machineId in.
      - Until wave 6 opts them in, scoped members get 403 on the machines list, machine detail, deployments, step-up GET, logs, logs/{id} and GET site (fail-closed, as planned).
  - 5.3 fc78cbe8: `SiteAccessLevel.standing`.
    - `listSiteMachines`/`resolveHootTargets` take `machineScope` (named so per GLOSSARY, not `scope`).
    - `buildExecutableTools` hides `SITE_WIDE_SERVER_TOOLS` (five tools) from a scoped caller.
    - hootStream's machine mode gives 404 before any read. Follow-ups narrow to the owner's current scope.
    - `actionContextForHoot` uses `userStanding`.
    - **6.4 still replaces `machineIds: null` in hoot/cancel-tool and hoot/provision-key**; until then provision-key hands a scoped person a whole-site actor.
    - **Open (8.1):** `turnRunner.server.ts:553` reads `standing?.machineIds ?? null` because `asyncTurns.integration.test.ts:300`'s fixture has no `standing` (a strict read fails its 14 tests). Add `standing` there, then make the read strict.
    - The flat `siteRole`/`swoopMode` on `SiteAccessLevel` stay until 6.4, and no task deletes them after: **8.1 removes them.**
    - The conversation routes wrap the new 404 as "hoot stream unavailable" / `cortex_unavailable`, so **6.4** may want a plain not-found there.
  - 5.4 8958eccb:
    - `evaluateSwoopAccess` passes the machineId, still before members_may_not_watch and step_up_required.
    - `revokeSwoopSessionsForUser` gains `keepMachineIds` and `'scope_changed'`.
    - It follows the shipped code: no seat removal, so a narrowed shared session ends for everyone within about 2 s and the others rejoin.
    - A 96-case scope × machine cross-check (22 red on the old call). **For 6.3:** the members PATCH passes `keepMachineIds` with reason `'scope_changed'` when it narrows.
  - 5.5 2509478b:
    - The store needed no change (4.1's edit); users/me uses `siteStanding([])`.
    - Talon successors: a scoped admin and a member set to control are refused `insufficient_role`.
    - **For 8.1:** the "builds the same successor actor as before" `toEqual` has no `machineScopes`.
  - 5.6 17dcff1d:
    - AuthContext's `isSiteAdmin`/`isSiteOwner`/`administersAnySite` mean whole site (a required `scopeMap` parameter).
    - It adds `machineScope`, `isMachineAdmin` and `siteRole`, plus an exported `computeSiteRole` so the role tests run without mounting.
    - Room is left for 7.12's `swoopMode`, which also needs the row's `swoop` from `useSiteMemberships`.
    - None of the 53 `useAuth` mocks has the new fields; each wave-7 task adds them where it reads them.
  - 5.7 42413d88:
    - removeMachine prunes after the swoop sweep. `stampPairedAt` became `recordPairing`, which prunes only when the machine doc was missing.
    - A failed read prunes nothing; this is unspecified, deliberate and tested. removeMachine is the primary path, and pruning on a contention error would strip a machine still on the site.
- Wave 5 build check on the merged tree: tsc clean, full jest 477 suites (10955 tests) green.
- 2026-11-09, wave 6 done (8/8), every commit made with `git commit --only` (no sweeps). No emulator ran.
  - 6.1 cdd995bd: the machines list admits scoped callers and keeps only in-scope machines with their currentRoosts. Detail, deployments and step-up GET use `requireSiteMachineAuthAndScope`, giving 404 off the scope; `site=` keys still work. New `machineRouteGates.test.ts`: an inventory of all 30 `[machineId]` route files. Each must name one of the five machine gates or be a pure re-export whose target is a machine route (beyond the Do), and none may call `requireSiteAuthAndScope(`. Five cases fail on HEAD's routes. **Still open:** `requireSiteMachineAuthAndScope` runs the key audit and the plan gate (402) before its 404. Nothing leaks, and it is for whoever next owns `_shared.ts`.
  - 6.2 461f1720:
    - The logs GET, logs/{id} GET and site GET admit scoped callers.
    - An empty scope, or a machineId filter outside the scope, gives an empty page with no read, after query validation.
    - Otherwise the query carries `machineId in scope`, and `include` drops rows with no machine.
    - logs/{id} gives a missing log's 404 for rows with no machine and rows outside the scope.
    - A scoped admin's site PATCH is 403 (pinned beyond the list).
  - 6.3 52a3b548:
    - The members GET returns `machineIds`.
    - POST validates the list, refuses scoping yourself (403 `cannot_modify_own_membership`), and refuses unknown ids (400 `unknown machine: <ids>`) through an exported `refuseUnknownMachines`. It audits `requestedMachineIds`.
    - PATCH takes `{role?, swoop?, machineIds?}`, with null widening, and fires one revocation per PATCH (`controlOnly`, `keepMachineIds`, `scope_changed` when it only narrows). The verbs are `member_role_changed`, `member_swoop_changed` and `member_access_changed`.
    - The owner's 409 detail names access.
    - **Departure:** the revoke reason keeps release 2's `before.role !== after.role`. Transfer pins a successor owner row with no scope and no mode.
  - 6.4 3d7f5b4f:
    - cancel-tool and provision-key build their actor from `access.standing`. **This closes 4.1's whole-site hole on provision-key.**
    - Both give 404 off the scope before any read. provision-key checks `hasCapability(…, siteId, machineId)`.
    - The hoot/conversations and chat/new POSTs give 404 off the scope before idempotency.
    - No production code reads `SiteAccessLevel.siteRole`/`.swoopMode` any more. **8.1:** remove them and move `hoot-utils.test.ts` 2245/2255/2279 to `standing.role`.
    - The resume routes' 404 wrapping became task 6.10.
  - 6.5 a3594643: `resolveTalonAuthor` throws `creator_access_revoked` for an author whose scope is not null. **Pre-existing gap, backlog:** only talons with a hoot output or a visual check re-resolve their author, so command, email or webhook-only talons keep firing after the author is scoped or removed. Copy at `talons/types.ts:283` and the comment at `hootOutput.server.ts:198` are left for the docs tasks.
  - 6.6 2f1fbf91 (test only):
    - The scope is proven through the real wrapper on swoop create (404 `not_found` off the scope with no proof verified or write; step-up then 201 on m1), lease, kill, the site sessions list, swoop settings and display-settings.
    - It is also proven through the real `_shared` gate on the audit log, quota, quota history and the events stream, each with whole-site controls.
    - Rows are narrowed via `mocks.memberDocs`, because `seedMember`'s `extra` lacks `machineIds`.
    - **Found:** a scoped admin gets every viewer email (a probe showed it red), which became task 6.9.
  - 6.7 6d4b32f0: the parity matrix gains paths A′ (the wrapper with a machineId) and C (`requireMachineAuthAndScope`). The same 403 on A and B, then 200 in scope, the same 404 off it and 200 for the whole site. The red check against the pre-wave-5 gates was argued from the code, not run.
  - 6.8 1dfe8c51 (test only): the candidates route already leaves sites where the caller is scoped out. Two cases fail on a mutant route that spreads only `siteRoles`. 4.1's stale-map edge at `route.ts:105` remains: it fails closed, can't happen today, and 8.1 removes it.
- Tasks 6.9 (the swoop viewer email gate) and 6.10 (a plain 404 when resuming a hoot conversation) were added for the two gaps wave 6 found that no task owned.
- Claude's decision of 2026-11-04 stands: scoped members see roost names on their own machines (6.1 called it open; it is decided).
  - 6.9 957ecea7: the session GET gives viewer emails only to a superadmin, or to an owner or admin whose machineScopeOf is null. The scoped-admin case was red on user-admin@example.test first; it also pins kickable false for every viewer. swoop 263/263.
  - 6.10 94cad4cc: both resume routes answer a 404 from runHootStream with problemNotFound('machine not found or no access'); any other refusal keeps cortex_unavailable, and the two routes' edits are identical. Both 404 cases were red first; chat.test 54/54, hoot-* 148/148. The prompt is still appended and audited before the 404, as designed.
- Wave 6 build check (with 6.9 and 6.10): tsc clean, full jest 478 suites (11056 tests) green.
- 2026-11-09 **correction:** the escalation blocks in membershipEscalation.test.ts run **13–18** (release 2's block 18, 'nobody sets their own swoop mode or the owner's', is f885a9d1). 3.1's 'end at 17', and the wave-4 log that repeated it, were wrong. 7.11 numbered its blocks 19–23, which is correct.
- 2026-11-09, wave 7 done (12/12). Commits used `--only`, new files `git add -N` first. No emulator and no browser ran: 9.1 and 9.3's e2e and the owner's UX sitting (wave 12) prove the pages.
  - 7.1 aaa9a794: the dashboard passes the scope to useMachines and useAgentAlertToasts and opens no deployments listener when scoped. Getting-started is hidden. `MachinesNotice` shows "no machines here for you yet" or "machines couldn't load: …". Departure: the error drops a trailing full stop.
  - 7.2 51be8c45: cards, rows, menu and pill gate per-machine actions on `isMachineAdmin`. Revoke, remove and "turn on swoop…" stay on `isSiteAdmin` (Q2). The pill's prop is renamed. Side effect: a signed-in superadmin on /demo sees row edit controls whose handlers do nothing (demo cards already did).
  - 7.3 47e0bead: DisplayLayoutPanel's writes gate on `isMachineAdmin(siteId, machineId)`.
  - 7.4 af46a114: the nav hides talons, roost and deploy on a scoped site. `useCurrentSite({ wholeSiteOnly })` drops scoped sites, and `limitedOnly` drives `NoSitesEmptyState limited` ("this page needs whole-site access"). Talons' inline card became the shared one.
  - 7.5 be16dc3a: SwoopPicker reads `useMachines(siteId, machineScope(siteId))`; the viewer reads `[machineId]`. "Left the site" stays keyed to `machine_not_found` and `machine_removed`. **Gap (owner UX):** the picker ignores `useMachines`' error, so a refused read or a pruned `[]` reads "no machines in this site yet".
  - 7.6 f32074b4: HootChatView passes the scope and `includeAutonomous: scope === null` (now required). **8.1:** `useHoot.pin` and `useHoot.stop` tests omit the flag.
  - 7.7 8d93b8c6: the logs page adds `machineId in scope` and reads nothing for `[]`. Beyond the Do, it also reads nothing for a picked out-of-scope machine. `planActionFilter` takes `maxInValues`. **Backlog, pre-existing:** a refused logs listener leaves stale rows on screen.
  - 7.8 0fec87c5: both schedule dialogs read machines only while open, with the scope (beyond the Do for RestartScheduleDialog, so no whole-site listener is refused).
  - 7.9 be2cef36:
    - `useSiteMachines` is extracted from `SiteMachinesList`.
    - `useSiteMembers` carries `machineIds`.
    - `MemberAccessFields` renders `MachineAccessField`.
    - SiteMembersSection has an access column (md and up) or a ` · {access}` suffix below md.
    - Both dialogs send scope; change-access adds the narrowing footnote and the talon warnings; the dialogs scroll on short screens.
    - Full jest 483 suites green.
    - **Owner UX notes:**
      - a `[]` row cannot take a role-only change until a machine or the whole site is chosen;
      - the narrowing footnote repeats release 2's when both show;
      - 4.8's `aria-hidden` "access" label is still there.
  - 7.10 22c061e7: `siteTalonSuccessors` drops scoped rows. SiteList labels a scoped row "{role} · {n} machine(s)" with no gear. SiteSettings shows "your access to {name} is limited to some machines, and its settings need the whole site. ask its owner or an admin." (GLOSSARY wording, not the plan's).
  - 7.11 6074e5e6: escalation blocks **19–23** (18 already existed): scoped admins off the member surface; nobody widens their own row; the owner can't be scoped; a scoped admin's key gets 404 on m2; a scoped controller holds nothing site-wide. All five have positive controls. A negative control (wrapper with no scope step) turns 17 refusals red. **8.1:** the file's `mockListUserStanding` literal lacks `machineIds`.
  - 7.12 0b3e85bf: `useSiteMemberships` adds `swoopMap`. AuthContext adds `computeSwoopMode` and `swoopMode(siteId, membersMayWatch)`. **Departure:** it takes `membersMayWatch` because AuthContext reads no swoop settings. The page passes it from `useSwoopSettings`, so no new listener. MachineContextMenu gates every swoop row, the pill and `showScreen` on `swoopCapable && !noSwoop`, so a person set to none gets live view.
- Wave 7 build check: tsc clean, full jest 483 suites (11215 tests) green, eslint shows no errors.
- 2026-11-09, **task 8.6 is skipped**: owner Q4 (2026-11-04) puts SDK/CLI machineIds later.
- **Handed to 8.1 by earlier waves.** 8.1's Files widen to cover these:
  1. `web/lib/capabilities.ts`: `siteStanding` always returns `machineScopes` (an entry for every site in `siteRoles`), and drops the fail-open `machineIds ?? null` (4.1). The test literals without `machineIds` that this breaks are in `swoop/policy.server.test.ts`, `sites-member-candidates*.test.ts`, `membershipEscalation.test.ts` (`mockListUserStanding` ~302, 7.11), `capabilities.test.ts`, `authorizedHandler.test.ts:295`, `hoot-utils.test.ts:2268` and `talons/store.test.ts` ("builds the same successor actor as before", 5.5). Give them `machineIds: null` / `machineScopes`.
  2. `web/lib/hoot/turnRunner.server.ts:553`: make `standing.machineIds` a strict read, and give `web/__tests__/lib/hoot/asyncTurns.integration.test.ts:300`'s fixture a `standing` (5.3).
  3. `web/lib/hoot-utils.server.ts`: remove `SiteAccessLevel`'s flat `siteRole`/`swoopMode`, which no production code reads any more (6.4). Move `hoot-utils.test.ts` 2245/2255/2279 to `access.standing.role`.
  4. `web/__tests__/hooks/useHoot.pin.test.ts` and `useHoot.stop.test.ts`: pass `includeAutonomous` (7.6).
  5. `web/__tests__/api/sites-member-candidates.test.ts`: once `machineScopes` is always present, add 6.8's case 2 with nothing scoped (`member-candidates/route.ts:105` stale-map edge).
- 2026-11-09, wave 8 done (8.1–8.5; 8.6 skipped).
  - 8.1 2d3ab540: `machineScopes` and `swoopModes` are required, `siteStanding` always writes both, and a missing `machineIds` reaches nothing. Every hand-off item is done, and `SiteAccessLevel`'s flat fields are gone. Full jest 483/11217.
  - 8.2 309cc0f3: openapi follows what shipped. No uniqueItems (the server dedupes).
  - 8.3 76aea60f and 8.4 1360105a: docs follow what shipped (the whole-session end in about 2 s, whole-site-only viewer emails, swoop hidden at none). Each page passes fumadocs-mdx. The avoid-word grep still hits old, unrelated 'allowlist' lines (command types, roost destinations, registry paths).
  - 8.5 13db0c20: readme, changelogs (under [Unreleased]), skills, PROTOCOL §10, COVERAGE, PRODUCT and runbooks, including the prod rules-first order and the rollback trap. **For 9.1 and 9.3:** the `mobile-chromium` project only matches `mobile/*.spec.ts`, so put any phone check in a `mobile/` spec. **For 12.1:** grep both changelogs' `## [` headings after 4.1.28 merges.
- Owner ruling, 2026-11-09: every talon re-checks its author (task 8.7). Task 8.8 removes `_shared.ts`'s fail-open `?? null`.
  - 8.8 3e8722ba: `_shared`'s adapter reads `machineIds` strictly. 17 suites' mocks gained `machineIds: null`. scopeEnforcement's case now asserts 403 for a missing scope, red first. Full jest 483/11228. On the admit path a missing field throws in `scopeCovers` (a 500, which grants nothing and is unreachable in production). Task 8.9 added for the two recipient defaults it found.
  - 8.7 33c6f60d: the engine resolves the author once per run, after the condition and before the first output; a refusal is recorded on each output the way runHootOutput records its own, and settleTalon disables and audits. A non-author error gives `author_check_failed` and fires nothing (fails closed). Red first: 10 of 66. Talons 562, full jest 483/11228. The docs (talons.mdx, member-management) say every talon. Left as is: hoot and visual-check still resolve the author themselves (up to 3 reads a run). system:-authored plain talons now switch off as creator_not_a_user with ai-key card copy (no live creator). Stale docs lines folded into 8.9.
  - 8.9 69781266: `recipientWantsMachine` and talons' site-level check drop the `?? null`. A recipient with no `machineIds` reaches no machine; an undefined guard returns false, because `scopeCovers` throws, which would drop other recipients' alerts. Both cases were red first. site.mdx:178 and authentication.mdx:388 are fixed. Full jest 483/11230. Kept: `adminUtils.server.ts` ~129/~152 `?? null` are production reads for legacy `users.sites[]` users (4.4). **Backlog:** a legacy `users.sites[]` entry with no member row still gets whole-site alerts, and `row.active` is not checked there. That needs drifted data. Task 8.10 added (machineScopeOf, two comments).
- 2026-11-09, PR #479 (dev noindex) merged to dev by owlette-0b on the owner's 'merge 479' as 955fd3f1. **Verified live:** dev.owlette.app / and /register send `x-robots-tag: noindex, nofollow`; owlette.app sends none.
- 2026-11-10:
  - 8.10 d4fce676: `machineScopeOf` reads an actor with no map as `[]`; a superadmin stays whole-site. Red first. Literals in agent-tokens, sites-members, swoop policy and talons store gain `machineScopes`. Full jest 483/11232. Two comments fixed; four more are left for 9.4.
  - Wave 9 (specs only, no rig):
    - 9.1 3bf32876: sites/machine-scope.spec.ts (10, chromium) and mobile/machine-scope.spec.ts (4). `/admin` has no page, so the bounce check uses /admin/sites. It adds 7.12 (mode none gives live view), 7.10 (a fourth user who administers a second site whole) and 8.7 (a scoped admin's command talon re-run is disabled).
    - 9.2 52285e92: session.spec.ts's `machine scope` describe (5): the scoped watcher, the scoped controller, the scoped admin with 6.9 emails and kill/kick/list, narrowing ends the whole session (record ended/revoked/endedFor within 5 s), and mode none on the dashboard. Its tests run in order.
    - 9.3 96ac62e7: sites/member-access.spec.ts (7) and mobile/member-access.spec.ts (2: fits a phone, scrolls on a short screen). The 6.3 API refusals and the `[]` save gate are added. The narrowed record reads `revoked` with `endedFor`, and `scope_changed` is on the audit row.
  - **For 10.1:** run the new specs and `sites/site-members.spec.ts` (9.4) too. Untried selectors are listed in the 9.1 and 9.3 reports: the nested apply dialog, the page switcher, the superadmin talon re-run's `runs` shape, /hoot with only a user key, and the picker popover inside a modal.
