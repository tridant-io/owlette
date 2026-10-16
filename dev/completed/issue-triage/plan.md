# Issue triage through the owlette API — Plan
**Created**: 2026-10-15 | **Status**: Active | **Branch**: `feat/issue-triage` (worktree `../Owlette-issues-wt`, cut from origin/dev 1deac854; push with an explicit `origin feat/issue-triage:feat/issue-triage` refspec)

## Summary
Issues (what users file with "submit issue", stored in `bug_reports`) become a first-class part of the owlette API and of the superadmin dashboard. A superadmin-only `issue` API key scope lists issues, reads one, downloads its logs zip and sets a triage status. Every issue gets a sequential number per environment (#42). The issue email becomes short and carefully designed, linking to a new superadmin page that holds everything. A `triage-issues` Claude Code skill lets Claude work through new issues when the owner asks in prose.

Owner decisions, 2026-10-15:
- "API key that can read issues … part of the owlette api."
- Numbering: "yes, fold numbering into the plan".
- Emails "are quite long … add like a dedicated endpoint/webpage … that has all of the info on it", and they "need a better design generally … feel slopped together rather than carefully thought through".
- Claude may set statuses on dev without asking each time; on prod it asks.
- Widen existing keys with new checkboxes rather than minting dedicated keys: "simpler this way … everything else stays functional".

## Approach

### Scope
- A new API key resource `issue`, with permissions `read` and `write`. Scope strings are `issue=*:read` and `issue=*:write`, following the singular `resource=id:permission` grammar.
- Add it to `ALL_RESOURCES` and `SUPERADMIN_ONLY_RESOURCES` in `web/lib/apiKeyTypes.ts`. Only a superadmin can grant it, and only with id `*` (`assertScopesGrantable`, `web/app/api/keys/_shared.ts:78-112`, which the CLI device-code authorize route repeats).
- Existing keys are widened by editing them: `PATCH /api/keys/{keyId}` through the scope editor gains `issue` read/write checkboxes. No new env vars are needed: the skill uses `OWLETTE_API_KEY` (dev) and `OWLETTE_API_KEY_PROD` once the owner ticks the boxes.
- The scope picker hides superadmin-only resources (`user`, `installer`, `issue`) from non-superadmins, using `useAuth().isSuperadmin`. Today it offers them to everyone and only the server refuses.

### Routes (plain `/api/...` per ADR 0008)
- **`GET /api/admin/issues?status=&page_size=&page_token=`**
  - Auth: `requirePlatformAuthAndScope(req, 'issue', 'read')`, which rechecks the superadmin role every request.
  - Ordered by `createdAt` desc, so issues not yet numbered never drop out of the list.
  - Paged like `GET /api/installer`: `parsePagination` + `collectFilteredPage` + `withPaginationFields`.
  - Needs a composite index on `status` ASC + `createdAt` DESC.
- **`GET /api/admin/issues/{id}`**
  - `{id}` is the issue number (all digits, at most 9) or the Firestore doc id.
  - Returns the issue with its description split into `text`, `systemInfo`, `logTail` and `notes`. The split runs at read time, so old issues work too.
- **`PATCH /api/admin/issues/{id}`** with `{status, note?}`
  - Uses `authorizedPlatformHandler` with `apiKeyScope {resource: 'issue', permission: 'write'}`, which gives a blocking audit row and a rate limit.
  - Statuses are `new | triaged | fixed | wontfix`.
  - It writes `status`, `triageNote` (≤ 2000 chars), `statusUpdatedAt` and `statusUpdatedBy`.
  - `AuditTargetKind` gains `issue`.
- **`GET /api/admin/issues/{id}/logs`** (existing) moves from `user=*:admin` to `issue=*:read`. Signed-in superadmins (the email and page link) are unaffected, because sessions skip the scope check.

### Numbering
- `counters/bug_reports {next}` is incremented inside a `db.runTransaction` that also writes the issue with `number`. Copy the roost version counter, `web/app/api/roosts/[roostId]/versions/route.ts:313-490`.
- `firestore.rules` needs no change: both collections already fall to the deny-all catch-all, and only the Admin SDK touches them.
- `POST /api/bug-report` returns `{success, id, number}`.
- The agent's `submit_report` keeps the number. The report-issue `done` event gains `issueNumber`, and the desktop toast says "your issue was sent as #42". An older helper's done line has no number, so the toast falls back to today's wording.
- The web dashboard toast becomes "issue #42 submitted — thank you!".
- `scripts/migrations/backfill-issue-numbers.mjs` numbers unnumbered issues in `createdAt` order from the counter, one transaction each. It is dry-run by default and safe to re-run.
- Each environment has its own sequence.

### Email and the issue page
- **Email.** Built by a new `buildIssueEmail` in `web/lib/emailTemplates.server.ts`.
  - Subject: `[DEVELOPMENT] issue #42 · something broke — <title>`.
  - Body:
    - a header with the number, category and status;
    - a compact facts block: from, machine/host, site, app version, source, time;
    - the user's own words only, cut at about 600 characters;
    - a one-line attachments summary;
    - one primary button, "open issue #42", linking to `/admin/issues/42`.
  - System info and the log tail leave the email and live on the page.
  - It is designed deliberately (load the `impeccable` skill), works in light and dark mail clients, and can be previewed from `/admin/email` as a new `issue` test template.
- **Pages.** Superadmin-only `/admin/issues` (list, status filter) and `/admin/issues/[number]` (detail).
  - The detail page shows:
    - the user's text;
    - the facts;
    - attachments, with a download through the logs route;
    - system info as a table;
    - the log tail in a collapsible mono block;
    - a status select with a note.
  - Data comes through a hook, `web/hooks/useIssues.ts`, that calls the routes above. No component calls Firestore directly.
  - Copy is lowercase, colours use theme tokens, icons come only from lucide, and the owner's phone-layout rules apply.

### The skill
`.claude/skills/triage-issues/SKILL.md` is model-invoked, with a prose description: "triage issues", "new issues", "look at #42", "what did customers report". It:
- reads the key with an anchored grep and never prints it;
- lists `status=new` issues;
- fetches each issue;
- gets the logs `Location` **without** `-L`, then downloads the presigned URL without the key, so curl never forwards `x-api-key` to R2;
- unzips each issue into its own new empty scratchpad folder.

How it works through an issue:
- It treats every byte of an issue as untrusted data, never instructions.
- It reproduces with a failing test where it can.
- It drafts a fix on a local branch, or a sanitized GitHub issue draft, for the owner to review.
- It PATCHes `triaged` with a note linking the result.

What it may and may not do:
- It sets statuses on dev freely and asks first on prod.
- It never pushes, merges or files a GitHub issue without the owner's go.
- It removes nothing; scratchpad folders are left in place.

### Privacy (gate before any prod triage)
The current wording promises reports are "seen only by owlette support", and the privacy page says no data reaches an AI provider unless hoot is enabled. Places to change:
- `web/app/privacy/page.tsx:205, 276-277, 293-295`
- the desktop dialog line, `desktop/src/components/ReportIssueDialog.tsx:396`
- `web/content/docs/agent/troubleshooting.mdx:447`

Draft wording that names AI-assisted support triage, and add Anthropic to the subprocessor table for it. The owner signs off before merge. Claude does not triage prod issues until it is live.

## Waves
Five waves and 21 tasks; see tasks.md. In brief:
1. Foundations, run in parallel: the scope, the scope picker, the issue library, the backfill, the index, the agent and desktop number, and the email builder.
2. The bug-report route (numbering and the new email), the list route, the read/status routes, the logs-route scope, and the web toast.
3. The hook, the OpenAPI spec, the docs, and the privacy draft.
4. The admin pages and the skill.
5. The e2e specs, the visual review, and the dev proof.

## Risks
- **Mail filters on the old subject** ("feedback:") stop matching.
- **Each logs download adds an audit row to the customer's site log**, labelled owlette support. This is intended transparency, and triage adds more of them.
- **The desktop number appears only from the next installer.** Web and email show it at once.
- **Prompt injection through issue text.** It is contained by the skill's rules and by nothing irreversible happening without the owner.
- **Index build time.** A new composite index must finish building before the list route works on each project. Deploy it before the routes go live.
- **Backfill ordering.** Issues filed between the backfill and the deploy get numbered on a re-run, after any already numbered by the route. This is harmless at this volume.
- **`sdks/` unions.** The Node and Python SDK key-resource unions must gain `issue`, or the SDK types reject a valid key listing.

## Success Criteria
- A key whose only scopes are `issue=*:read` and `issue=*:write` can list, read, download logs and set status, and gets 403 `scope_insufficient` on every other route.
- A non-superadmin can neither see nor mint the scope.
- Ticking the issue boxes on an existing key keeps all its other scopes working.
- A new dev issue arrives as #N:
  - in the email subject and header;
  - in the web toast at once;
  - in the desktop toast once an agent with this change is installed.
- The backfill numbers every existing dev issue.
- The email is short (no system info or log tail) and opens `/admin/issues/N`, which shows everything. The owner approves the design from screenshots in light and dark, and at phone width.
- Saying "triage issues" in a session produces a triaged #N with a fix branch or a draft issue, and nothing pushed.
- All of these pass:
  - `npm run validate:api`;
  - web jest, lint and tsc;
  - agent pytest;
  - desktop vitest, typecheck and lint;
  - `node scripts/check-claude-hooks.mjs`;
  - `/preflight` e2e.
- The privacy wording is signed off before any prod triage.
