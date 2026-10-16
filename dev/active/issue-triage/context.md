# Issue triage through the owlette API — Context
**Last updated**: 2026-10-15

## Key Files

### Create
- `web/lib/issues.server.ts`: statuses, description parsing, lookup by number or id, serialization, page URL
- `web/app/api/admin/issues/route.ts`: list
- `web/app/api/admin/issues/[id]/route.ts`: read and status
- `web/hooks/useIssues.ts`
- `web/app/admin/issues/page.tsx`, `web/app/admin/issues/[number]/page.tsx`, `web/components/admin/issues/*`
- `scripts/migrations/backfill-issue-numbers.mjs`
- `.claude/skills/triage-issues/SKILL.md`
- `web/e2e/specs/admin/issues.spec.ts`
- jest tests: `web/__tests__/lib/issues.test.ts`, `web/__tests__/api/adminIssues.test.ts`, `web/__tests__/api/adminIssue.test.ts`, `web/__tests__/hooks/useIssues.test.ts`

### Modify
- **Scope**
  - `web/lib/apiKeyTypes.ts` (`ALL_RESOURCES` :29-38, `SUPERADMIN_ONLY_RESOURCES` :41)
  - `web/app/api/keys/_shared.ts` (:78-112)
  - `web/app/api/cli/device-code/authorize/route.ts` (:77-167)
  - `web/components/ApiKeyScopeFields.tsx` (:37, :220-224)
  - SDK unions `sdks/node/src/resources/keys.ts`, `sdks/python/roost/resources/keys.py`
- **Numbering and email**
  - `web/app/api/bug-report/route.ts` (write :213-231, email :235-259, response :261)
  - `web/lib/emailTemplates.server.ts`
  - `web/app/api/test-email/route.ts`
  - `web/app/admin/email/page.tsx`
  - `web/components/ReportBugDialog.tsx` (toast :123)
- **Logs route**: `web/app/api/admin/issues/[id]/logs/route.ts` (:73 scope, :60-68 host helper)
- **Audit**: `web/lib/auditLog.server.ts` (`AuditTargetKind` :56-68)
- **Agent and desktop**
  - `agent/src/configure_site.py` (`submit_report` :864-939, `_send_report` :1132-1176)
  - `desktop/src/components/ReportIssueDialog.tsx` (`ReportIssueDone` :63-68, toasts :297/:307, privacy line :396)
- **Spec**: `web/openapi.yaml` (logs :397-442, installer template :1665-1735, `Scope.resource` enum :12198), `web/lib/openapiReference.ts` (`inferAuthScopeNotes` :192-275)
- **Docs and data**
  - `firestore.indexes.json`
  - docs: `web/content/docs/api/authentication.mdx`, `web/content/docs/reference/firestore-data-model.mdx` (:700), `web/content/docs/agent/troubleshooting.mdx` (:447)
  - both changelogs
- **Privacy**: `web/app/privacy/page.tsx` (:205, :276-277, :293-295)
- **Admin nav**: `web/app/admin/navItems.ts`

### Patterns to copy
- **List**: `web/app/api/installer/route.ts` (`requirePlatformAuthAndScope` + `web/lib/pagination.ts`)
- **Audited platform write**: `web/app/api/platform/system-presets/[presetId]/route.ts:77-135` (`authorizedPlatformHandler`)
- **Counter**: `web/app/api/roosts/[roostId]/versions/route.ts:313-490`
- **Migration**: `scripts/migrations/move-webhook-secrets.mjs`
- **Tests**: `web/__tests__/api/adminIssueLogs.test.ts`, `web/__tests__/api/installer-public.test.ts`
- **e2e seeding**: `web/e2e/specs/admin/issue-logs.spec.ts`; key minting: `web/e2e/helpers/apiKey.ts`

## Decisions
1. **Resource `issue`, not `user=*:admin`.** Triage gets read/write on issues only. `user=*:admin` can promote users (`web/app/api/users/[uid]/promote/route.ts:49`).
2. **The scope is superadmin-only.** Issues are promised to owlette support alone. It sits in `SUPERADMIN_ONLY_RESOURCES`, so grants need a superadmin minter and id `*`, and every request rechecks the superadmin role.
3. **Widen existing keys** (owner, 2026-10-15). Issue read/write checkboxes appear on existing keys, so no new env vars are needed, and everything a key already does keeps working.
4. **Routes live under `/api/admin/issues`**, beside the existing logs route, with no version prefix (ADR 0008).
5. **List order is `createdAt`, not `number`.** A Firestore `orderBy('number')` drops docs without the field, so issues filed before the backfill would vanish.
6. **The description is split at read time** (`parseIssueDescription`), so every old issue renders its sections without a data migration, and the agent's wire format stays unchanged.
7. **The number is assigned in the same transaction as the issue write**, the roost-version pattern. It is per environment.
8. **Dev statuses are free and prod statuses ask** (owner, 2026-10-15). Statuses are a mutation, per CLAUDE.md.
9. **The email is short and links to the page** (owner, 2026-10-15). System info and the log tail leave the email.
10. **The skill never forwards the key to R2.** It reads `Location` without `-L`, because curl keeps custom headers across a redirect to another host.
11. **No prod triage until the privacy wording ships.** The current privacy page says no data reaches an AI provider unless hoot is enabled.

## Owner sign-off
- Privacy wording (Task 3.4): **approved by the owner 2026-10-15**. Triage runs on the owner's Claude Pro plan, a consumer plan, so the claude.ai privacy setting that allows model training ("help improve Claude") must be off before any prod issue is triaged. That is a gate in the skill and in Task 5.3. Applied on this branch, the troubleshooting line included.
  - **Privacy page, section 6, "issue logs"** (`web/app/privacy/page.tsx`)
    - before: "only owlette support staff can access them."
    - after: "only owlette support staff can access them. support staff may use an AI assistant (Anthropic's Claude) to help diagnose any issue you submit, which sends the issue and its attachments to Anthropic."
  - **Privacy page, section 7, subprocessor table**: a new row above the hoot row
    - provider "Anthropic", purpose "support triage of issues you submit (see section 6)", region "USA"
  - **Privacy page, section 8, first paragraph**
    - before: "we do not provide a shared key and we do not send your data to any AI provider unless you have supplied a key and enabled the feature."
    - after: "we do not provide a shared key, and hoot sends nothing to any AI provider unless you have supplied a key and enabled the feature. separately, when you submit an issue, owlette support may use an AI assistant (Anthropic's Claude) to help diagnose it (see section 6)."
  - **Privacy page, last updated**: "September 14, 2026" → "October 15, 2026"
  - **Desktop submit issue dialog** (`desktop/src/components/ReportIssueDialog.tsx`, under attach logs)
    - before: "kept 30 days, seen only by owlette support."
    - after: "kept 30 days. owlette support reads them and may use Anthropic's Claude to help diagnose the issue."
  - **Troubleshooting doc** (`web/content/docs/agent/troubleshooting.mdx` ~:447), not yet applied; the orchestrator replaces the sentence "only owlette support can download it, not the site's owners or admins. every download is audited." with:
    - "only owlette support can download it, not the site's owners or admins, and every download is audited. owlette support may use an AI assistant (Anthropic's Claude) to help diagnose the issue."
  - **For the owner to confirm before approving**: the wording claims nothing about Anthropic's retention or training, so it holds on any plan. But if triage runs on a consumer Claude plan with model training turned on, customer issues could be used for training, which no customer would expect. Run triage under API or Claude for Work terms, or turn that setting off.
- Email and page design: _screenshots in Task 5.2; awaiting approval_

## Next Steps
1. Run `/execute` for Wave 1 (7 parallel tasks) in this worktree.
2. Owner steps, batched at Task 5.3: tick issue read/write on the dev key, and approve the privacy wording and the design.
3. Prod: at the next promotion, deploy the index, run the backfill on prod (owner's go), and tick the boxes on `OWLETTE_API_KEY_PROD`. The privacy wording must be live first.
