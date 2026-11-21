# Superadmin activity monitoring — Plan
**Created**: 2026-11-15 | **Status**: Active

Owner's ask (2026-11-14): a panel that shows all activity across all users, with built-in
measures to detect suspicious behaviour and report it by email.

## Summary
An `/admin/activity` page shows one cross-site timeline of changes, refusals, sign-ins and
flagged findings. Sign-ins and failed second factors become recorded events with their
network. A scheduled job runs detection rules over new rows, stores findings and emails
hey@tridant.io: at once for high severity, a daily digest for the rest.

Recording was already strong (per-site authorization rows, hash-chained change rows, the
platform sink). What was missing: no page read any of it, nothing watched it, and sign-ins
were not events.

## Owner rulings (2026-11-14)
- Rides #420 (dev to main).
- Email goes to hey@tridant.io.
- Opening the feed is NOT itself audited.
- Design approved content-wise: https://claude.ai/artifact/VaJVXo5RtFJEFjTmCedGZB
  (desktop, phone, alert email, digest email).
- 2026-11-15: fix the environment pill's offset in the live email header too. REVERTED the
  same day on the owner's word: measured in chromium the live header was never offset
  (0.5px), the offset was in the design mock only.

## Approach
- **Web only.** No agent, installer, `firestore.rules` or functions change. One index file
  change (`firestore.indexes.json`), deployed before the web on each environment.
- **Feed.** `GET /api/admin/activity` (superadmin, key scope `user=*:read`) merges four
  sources by time: hash-chained change rows, refused or errored authorization rows,
  sign-in rows, findings. Views: all, flagged, changes, refused, sign-ins. Filters: user,
  site. Routine allowed reads are left out: every authorized call writes an allow row, so
  they would drown everything else.
- **Sign-in events.** One row per real sign-in, written at the session route into
  `global/audit_log/entries`, keyed on the Firebase sign-in time so the every-page-load
  re-POST cannot duplicate it. Failure rows at the existing second-factor, passkey and
  session failure branches. All fire-and-forget: an audit outage never blocks a sign-in.
- **Detection.** `/api/cron/activity-watch`, every 5 minutes. Pure rule functions; findings
  have deterministic ids and are written with `create()`, so overlapping runs on Railway
  and Vercel cannot duplicate; each finding is stamped before its email is sent. The same
  route sends the daily digest, so there is one schedule to register.
- **Email.** Resend, the existing layout. Recipient `ACTIVITY_EMAIL`, falling back to the
  admin address the way `ISSUE_EMAIL` does. No unsubscribe link: this is platform mail.

## Rules
| Rule | Severity |
|---|---|
| promotion to superadmin | high |
| 2FA disabled or force-reset | high |
| superadmin sign-in from a network never seen for that user | high |
| 5+ failed second factors or sign-ins for one user in 15 min | high |
| 5+ destructive actions by one actor in 15 min | high |
| site deleted | high |
| site owner or admin sign-in from a new network | digest |
| 20+ refusals for one actor in 15 min | digest |
| ownership transferred, user deleted | digest |

Thresholds are starting guesses, kept as named constants to tune after a week of data.

## Waves
Detail, files and done-when for every task: `tasks.md`.
1. Foundations: sign-in events, indexes, feed library, email templates.
2. Route and rules.
3. Page and cron.
4. E2E and docs.
5. Verify, then prove on dev (needs the owner's go to push).

## Risks
- **Failed passwords never reach Owlette.** Firebase handles them in the browser. "Failed
  sign-in" here means failed second factor, failed passkey or rejected session.
- **Indexes cannot be proven locally.** The emulator does not enforce them; the first real
  test is on dev after an index deploy.
- **A field override replaces that field's default indexes.** The override must restate
  the per-collection scopes or the existing per-site audit queries fail.
- **New-network detection has no history on day one.** It flags only users with an earlier
  sign-in row. A request that bypasses Cloudflare reads as `unknown`, which is treated as
  no information, never as a new network.
- **Failure rows are attacker-triggerable.** They are written only where the uid is known
  and the route is already rate limited (10 a minute per IP; 10 per 15 minutes per account
  for TOTP and backup codes).
- **`auditMutationCoverage` stale-exempt trap.** Adding `emitMutation(` to an exempt auth
  route fails that test; the sign-in writer must not use it.

## Not in this cut
- Kill-switch bypass and audit-write-failure rules (not stored anywhere queryable; Sentry
  already has both).
- "API key used from a new network" (key use records no network today).
- The per-site audit-log API and hoot's `get_audit_log` hiding refusals.
- Reading Google's own auth logs for failed passwords.

## Success criteria
- A superadmin opens `/admin/activity` on dev and sees real changes, refusals and their
  own sign-in, on desktop and on a phone, with nothing cut off.
- A site admin and a non-superadmin key are refused.
- A failed TOTP burst and a test promotion each produce a finding on the page and one
  email at the configured address, once, however many times the cron runs.
- A day with digest-level findings produces one digest; a quiet day produces none.
- jest, eslint, tsc, the rules tests and the Playwright suite are green.
