# talons runbook

Operator reference for the talon scheduler: the once-a-minute sweep that fires schedule-triggered
talons, the missed-fire grace that keeps a stalled cron from replaying an hour of automations at
once, and the stale-run janitor. Written for whoever is on the other end of "my talon didn't run".

Design source of truth: `dev/active/talons/plan.md` and its `tasks.md`. Engine internals (cooldown,
in-flight guard, auto-disable backoff) live in `web/lib/talons/engine.server.ts`.

---

## what the sweep owns

`GET /api/cron/talons` (`web/app/api/cron/talons/route.ts`) is the ONLY thing that fires a
schedule-triggered talon. Threshold and event talons are driven by incoming agent data and never
appear here — they carry no `nextRunAt` at all.

One sweep does three things, in this order:

1. **stale-run recovery** — closes out runs abandoned mid-flight
2. **claim** — takes ownership of every due talon and re-arms it, transactionally
3. **execute** — runs each claimed talon, or records it as `missed` if it is too late

The response body is the whole story:

```json
{"ok":true,"due":4,"executed":3,"missed":0,"deferred":0,"staleRecovered":1}
```

| field | meaning |
|---|---|
| `due` | talons matched by the query this sweep (capped at 25) |
| `executed` | talons actually run |
| `missed` | talons written off as too late — see missed-fire semantics below |
| `deferred` | talons left unclaimed because the sweep ran out of wall clock; picked up next minute |
| `staleRecovered` | `running` runs closed out as `failed` / `stale` |

`due > executed + missed + deferred` is normal, not a fault: the difference is talons a concurrent
sweep claimed first, talons disabled between the query and the claim, and talons whose trigger is no
longer a schedule.

---

## where a non-schedule trigger comes from

Every event and threshold talon is fired by exactly ONE tap. The table below is the whole map — all
fifteen `TALON_EVENT_TYPES` plus the threshold kind. If a talon fires twice for one real-world event,
a second tap has been added somewhere it shouldn't be.

| trigger | fired by | source of the signal |
|---|---|---|
| threshold (cpu / memory / disk / gpu) | `POST /api/alerts/trigger` | agent metric upload |
| `process_crash`, `process_start_failed` | `POST /api/agent/alert` | agent alert POST |
| `exe_missing` | `POST /api/agent/alert` | agent alert POST |
| `machine_offline` | `GET /api/cron/health-check` | the offline scan (see trigger latency below) |
| `process_restarted` | `onTalonLogEventCreated` (`functions/src/talonLogEvents.ts`) | the agent's `sites/{siteId}/logs` write |
| the ten `display_*` events | `onTalonLogEventCreated` | the agent's `sites/{siteId}/logs` write |

`/api/agent/alert` taps on more than the four rows above — `connection_failure` included — but no
talon can subscribe to anything outside `TALON_EVENT_TYPES`, so the matcher short-circuits those
without touching firestore.

The display row is the one that needs explaining. As of agent 3.0.0 the agent ALSO posts display
events to `/api/agent/alert` — that is what drives display emails and webhooks, which were dormant
until that release. But the log write is what EVERY agent does, old and new, so the firestore trigger
stays the single source for display talons and `/api/agent/alert` deliberately skips its talon tap
for the ten routed display event types. Restoring that tap would double-fire every display talon on
an up-to-date fleet.

Consequence for latency: a display talon inherits the firestore-trigger cold start (typically a
second or two, occasionally more), not the alert POST's round trip. That is the intended trade.

---

## deploy order

Do these in order. The cron is registered LAST.

1. **deploy the firestore indexes and let them finish building.** Two collection-group indexes back
   the sweep, and both must be `Enabled` (not `Building`) in the firebase console before the route
   is scheduled:

   | collection group | scope | fields | used by |
   |---|---|---|---|
   | `talons` | `COLLECTION_GROUP` | `enabled` ASC, `nextRunAt` ASC | the due query + the `talon_dispatch` watchdog |
   | `talon_runs` | `COLLECTION_GROUP` | `status` ASC, `startedAt` ASC | the stale-run janitor |

   ```bash
   firebase deploy --only firestore:indexes --project <dev-or-prod-project>
   ```

   The `talon_runs` collection-group index is new as of talons wave 2 — the pre-existing
   `talon_runs` composites are COLLECTION-scoped and do not satisfy a collection-group query. Until
   it is live the janitor throws; the route catches that and keeps dispatching (`staleRecovered`
   stays 0), so a missing index degrades recovery rather than the scheduler.

2. **deploy the web app** to the environment.

3. **register the cron** (below), then confirm a `200` with an `ok: true` body.

---

## registering the cron

owlette's scheduled endpoints run on **cron-job.org** — not Railway, not Cloud Scheduler. Register
this one **per environment**: once against `dev.owlette.app` and once against `owlette.app`. Each
environment has its own `CRON_SECRET`; a job pointed at prod with the dev secret answers `401` and
fires nothing.

| setting | value |
|---|---|
| method | `GET` |
| url | `https://owlette.app/api/cron/talons` (dev: `https://dev.owlette.app/api/cron/talons`) |
| schedule | every minute (`* * * * *`) |
| header | `X-Cron-Secret: <that environment's CRON_SECRET>` |
| timeout | at least 60s — a sweep may use up to ~50s of wall clock |

The one-minute cadence is the scheduler's resolution. A talon set to fire at 09:30 fires within a
minute of 09:30; anything slower would visibly miss fixed clock times. See the scheduled-endpoints
table in `web/content/docs/setup/web-deployment.mdx` for the rest of the fleet's crons.

Unscheduled, this route fails **silently**: no error, no email, no run records — every scheduled
talon simply never fires. That is what the watchdog below exists to catch.

---

## claiming and the caps

A talon is claimed inside a `runTransaction` that re-reads it, verifies it is still `enabled` and
still due, and advances `nextRunAt` in the same commit. Two overlapping sweeps therefore cannot fire
the same talon twice: the loser sees the advanced `nextRunAt` and skips silently.

Caps, both deliberate:

- **25 claims per sweep.** A fleet-wide budget of 25 executions/minute. A backlog drains across
  subsequent sweeps.
- **~50s wall clock.** Past the budget the sweep stops claiming NEW talons and returns. Deferred
  talons keep their untouched `nextRunAt`, so the next minute resumes exactly where this one
  stopped. A talon already executing is allowed to finish — the budget gates claiming, not running.

A persistent nonzero `deferred` means the fleet is asking for more than 25 talons/minute. That is a
capacity signal, not an error; raise `MAX_CLAIMS_PER_SWEEP` in the route only after checking that
the backlog isn't one pathological talon (a visual check on a slow machine can hold a sweep for
45s+).

---

## missed-fire semantics

If a talon comes due and the sweep does not reach it within **10 minutes**, it is NOT executed. A
run is recorded with `status: 'missed'` and `error: 'missed_fire_window'`, and `nextRunAt` is
advanced to the next real slot.

This is the scheduler's most important safety property, inherited from the reboot scheduler: a cron
that was down for an hour must not fire a burst of stale automations the moment it recovers. Twelve
machines do not get restarted at once because a deploy took a while.

What this looks like in practice:

- **after an outage** — one `missed` run per affected talon, then normal firing from the next slot.
  Nothing to clean up.
- **on a healthy sweep** — `missed` should be 0. A nonzero `missed` on an otherwise-healthy
  environment means the sweep is running but not keeping up; check `deferred` in the same response.

A `missed` run is not a failure: it does not count toward the engine's `consecutiveFailures`
auto-disable backoff and never disables a talon.

---

## stale-run recovery

A run is written `running` up front and finalized in place. If the process that owned it is killed
(deploy, OOM, host restart), the record stays `running` forever and the engine's in-flight guard
refuses to start the next execution of that talon.

Each sweep closes out up to 50 runs older than `STALE_RUN_MS` (10 minutes) as `failed` with
`error: 'stale'`. The engine does the same thing for a talon that executes again on its own; the
janitor is for the talon that never does.

The janitor runs first and in its own error boundary — a janitor failure is logged and dispatch
continues. If `staleRecovered` is 0 while the run list shows old `running` records, check that the
`talon_runs` collection-group index finished building.

---

## watchdog: the `talon_dispatch` status component

`talonDispatchHealth()` in `web/lib/healthChecks.server.ts` reports **degraded** when any enabled
talon has been due for more than **15 minutes** without being claimed — i.e. the sweep is not
running. Published by `/api/cron/status-ping` alongside the other status components.

15 minutes is deliberately wider than the sweep's own 10-minute missed-fire grace, so a single
skipped minute never pages.

Its instatus component id (`INSTATUS_COMPONENT_TALON_DISPATCH_ID`) is **optional**, like
`alert_delivery` — a missing id does not flip the status page to "not configured".

When it goes degraded, in order:

1. is the cron-job.org job enabled, and is it green? a paused job is the usual cause
2. hit the route by hand with the environment's secret — a `401` means the job's header no longer
   matches `CRON_SECRET`
3. check the deploy: a route error surfaces as a `500` with `instance: "cron/talons"`
4. check the `talons` collection-group index is still `Enabled`

---

## trigger latency

Worth setting expectations before someone files "the talon fired late".

- **schedule triggers** fire within a minute of their slot (the sweep cadence).
- **`machine_offline` event triggers** are worst-case **≈17 minutes** behind the machine actually
  going quiet. The chain is `/api/cron/health-check`, not this sweep: a 5-minute offline threshold,
  plus a 5-minute stale-confirm debounce (a machine must still be silent on a later scan), plus a
  7-minute site-level settle window that coalesces a staggered shutdown into one event. That is by
  design — every one of those windows exists to stop a transient heartbeat gap from paging a fleet —
  and it cannot be tuned from the talon side.

If a customer needs faster machine-down reaction than that, the answer is not a talon.

---

## quick triage

| symptom | look at |
|---|---|
| no talon fires anywhere | cron-job.org job disabled/failing, or `CRON_SECRET` rotated without updating the job |
| one talon never fires | is it `enabled`? does it have a `nextRunAt`? a trigger edited away from a schedule drops the field on the next sweep |
| a talon fires late every time | `deferred` in the response — the 25/minute cap, or a slow talon holding the budget |
| a burst of `missed` runs | the sweep was down; expected, self-healing |
| a talon is stuck, no new runs | a run wedged `running` — the janitor clears it within 10 minutes; check the `talon_runs` index if it doesn't |
| a talon disabled itself | 10 consecutive failed runs (engine auto-disable). the disable is audited with `reason: 'repeated_failures'` |
