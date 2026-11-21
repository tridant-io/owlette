# tridant contract adoption — Plan
**Created**: 2026-11-20 | **Status**: Active

## Summary

Owlette adopts tridant id's 2026-11-16 contract additions (tridant-id #226 answers; the list in
#284 "What Owlette changes on its side") before plans go on in prod: A17 `trial_already_used`,
A6 payer on PATCH/DELETE, A8 tier/founders/trial end from the site answer, A11 site removal,
A4 key check, A9 trial preview in the bulk dry run, A14 batch reads in the daily job, A2 the
morning-after settle retry, and the A7 cleanup (no PATCH after an add). Web only, on local branch
`feat/tridant-contract`; nothing is pushed without the owner's go.

## Approach

- **Client layer first** (wave 1): every new tridant call and answer field lands in
  `tridantBilling.server.ts`, `tridant.server.ts` and `tridantEntitlements.server.ts`, with the
  e2e fake kept faithful (playwright blanks `TRIDANT_LICENSE_KEY`, so every new call needs its
  fake branch or it answers `not_configured`).
- **Callers** (wave 2): site billing (payer, A7, A8, stranded fix), trial (A17, dry run), site
  removal on delete, the batch read.
- **Jobs and the plan page** (wave 3), then the **settle pass** (wave 4), **docs and e2e**
  (wave 5), **merge, changelogs and the full gate** (wave 6).
- Decisions and the contract are in `context.md`. The two research findings that shaped them:
  sending the payer on every stop would break real stops (a new owner stopping the previous
  owner's billing, a stop before delete), and the same change fixes a live bug where the stranded
  repair can stop the current owner's own billing.

## Waves

See `tasks.md`: 13 tasks across 6 waves; tasks in one wave never share a file, test files
included.

## Risks

- **Fixture drift:** `tsc` excludes `__tests__`, so a stale fixture passes typecheck. One owner
  for `planEnforcement.ts` (task 1.2); each task updates the mock factories it is assigned.
- **Batch read cost:** 100 sites per call is unmeasured from here; a 15 s timeout, and a failed
  call primes nothing, so each site falls back to its single read.
- **The settle path is proven only in jest** until the test-clock run with Davor (P3 on #284).
- **ADR 0018 amendments** argue three reversals in the ADR itself.
- **Changelog conflicts** with whatever lands on dev meanwhile: written last, after a dev merge.
- **Owner steps:** registering `plan-settle` on cron-job.org (dev after merge, prod when plans go
  on).

## Success Criteria

- All nine items in, each with a unit test; e2e covers the owner-visible ones.
- Lint, typecheck, full jest, rules tests, local e2e suite and the security gate green.
- `/verify`: standards and spec reviewers pass.
- After the owner's go to push: proof on dev against staging — a hand run of `plan-daily`
  (batch, keys, removals in its summary) and a `plan-trials` dry run (preview counts, key check).
