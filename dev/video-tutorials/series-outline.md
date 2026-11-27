# Owlette tutorial series — outline (v2, scoped 2026-08-25)

Layperson-facing, for support + training. **Excludes** the REST API, CLI, and SDK
(developer surfaces) and **all pricing/tier/trial talk** (billing was removed from the
product in 3.0.0; nothing may imply a paid tier until the user's go-live flips the copy).

v2 supersedes the original 13-episode outline after the 2026-08 drift audit
(`DRIFT-AUDIT-2026-08.md`): four episodes added (day zero, talons, display layouts,
fleet maintenance), ep12 retitled hoot, ep09 rewritten for the desktop app.

Two batches: **core essentials** (1–9, ship first) and **power features** (10–17).
Each episode is one discrete capability, 2–10 minutes, and only assumes the episodes
before it.

The `scenario` column is the `seedScreenshotFixtures(...)` fixture the web-capture
harness seeds before recording (`web/e2e/screenshots/fixtures.ts`). Native episodes
are captured per the audit's settled strategy: pywinauto for the installer wizard +
tray, WebView2 CDP (video sibling of `web/e2e/desktop-screenshots/`) for the desktop
app.

---

## Renumbering map (old → new)

| old | new | change |
|---|---|---|
| 01 | 01 | touch-up (add hoot/talons/roost/displays to the capability montage) |
| — | **02** | **NEW — day zero** |
| 02 | 03 | partial rewrite (pairing now in the desktop-app window) |
| 03 | 04 | touch-up (6-item nav) |
| 04 | 05 | touch-up |
| 05 | 06 | touch-up (local editing beat inverted) |
| 06 | 07 | touch-up |
| 07 | 08 | touch-up (reboot→restart) |
| 08 | 09 | full rewrite (Tkinter → the owlette desktop app) |
| 09 | 10 | touch-up (checksums, in-place retry) |
| 10 | 11 | clean |
| 12 | **12** | partial rewrite (cortex → hoot) — **number unchanged on purpose**: keeps `out/12-cortex/`, the scene id, and the slug (wire name stays `cortex`, display copy says hoot) |
| — | **13** | **NEW — talons** |
| 11 | 14 | touch-up (moved after talons so the talons handoff lands) |
| — | **15** | **NEW — display layouts** |
| 13 | 16 | touch-up (closes the series at docs + report issue) |
| — | **17** | **NEW — fleet maintenance (optional; cut first if trimming)** |

**Migration mechanics (do once, at rewrite time):** renumbering an episode means
renaming the script (`git mv`), the scene file, the `out/NN-slug/` folder, the
`epNN-bNN.mp3` filenames inside it, and the manifest's `episode`/`file` fields —
scriptable; surviving MP3s' audio is untouched. Ep12 was deliberately kept at 12 so
the largest surviving-asset episode needs no migration.

---

## Batch 1 — core essentials

| # | Title | ~Time | Capture | Scenario / surface | Viewer can… |
|---|---|---|---|---|---|
| 1 | what is owlette? | 2:30 | web (b-roll) | `dashboard-mixed-states` | explain what owlette does and decide if it fits |
| 2 | day zero: sign up, 2fa, and your first site | 5:00 | web | auth pages + empty dashboard | create an account, enroll a passkey/2FA, save backup codes, create a site and set its timezone |
| 3 | install owlette & pair your first machine | 6:00 | native (wizard) + CDP (pairing dialog) + web | installer + join-site dialog + `/add` | get the agent running and paired on a fresh machine |
| 4 | the dashboard, end to end | 5:00 | web | `dashboard-mixed-states` | navigate sites, machines, card vs list, panels — on desktop and phone |
| 5 | keep a process alive | 6:00 | web | `control-process-restarting` | add a process and have it auto-restart on crash |
| 6 | run apps on a schedule | 6:00 | web + CDP b-roll | `automate-schedule-editor` | launch/stop apps on a days+times schedule — from the dashboard or the machine |
| 7 | reading machine health | 5:00 | web | `dashboard-mixed-states` + `monitor-single-machine` | read metrics, sparklines, thresholds, temps |
| 8 | remote actions: screenshot, restart, shutdown | 6:00 | web | `dashboard-mixed-states` | restart/shutdown, capture screenshots, schedule restarts |
| 9 | the owlette app on the machine | 6:00 | CDP + tray (pywinauto) | installed desktop app | manage processes, schedules, and the tray from the machine itself |

## Batch 2 — power features

| # | Title | ~Time | Capture | Scenario / surface | Viewer can… |
|---|---|---|---|---|---|
| 10 | deploy software to many machines | 9:00 | web | `deploy-roost-rolling` | push an installer to a fleet with checksums, silent flags, retry |
| 11 | distribute project folders with roost | 9:00 | web | `deploy-roost-rolling` | upload once, sync to targets, roll back a version, re-sync |
| 12 | hoot: manage machines by chat | 8:00 | web | `diagnose-cortex-chat` | ask hoot to diagnose and act, with tier-3 approvals, async turns, the kill switch |
| 13 | talons: rules that watch and act | 8:00 | web | `automate-talons-list` | build trigger → condition → outputs automation, use presets, read run history |
| 14 | team & alerts | 9:00 | web | `automate-schedule-editor` + admin | assign roles/sites and configure alert rules + personal prefs |
| 15 | display layouts: capture a wall, put it back | 7:00 | web | `display-layout-editor` / storyboard frames | capture a monitor topology, re-apply it remotely, alert on drift |
| 16 | logs & troubleshooting | 6:00 | web | `control-process-restarting` | read the timeline, filter/search, date-scoped clear, escalate via docs + report issue |
| 17 | keeping the fleet current *(optional)* | 6:00 | web | admin/tokens + deployments | roll agent updates, manage tokens, retire a machine |

---

## Per-episode beat sketches

Sketches for the four NEW episodes and the three REWRITES; unchanged episodes keep
their existing scripts amended per `DRIFT-AUDIT-2026-08.md`. Full drafts land in
`scripts/` during the rewrite wave, grounded + reviewed before rendering.

### 2 — day zero: sign up, 2fa, and your first site `[NEW]`
Cold open (you can't reach the dashboard without a second factor — two-minute
version) → sign up (passwordless-first, email verify) → the choice: passkey
(recommended — windows hello / touch id / security key / password manager) or
authenticator app → enroll; sign out/in to show one ceremony clearing both steps →
backup codes (save the sheet; regenerating asks you to prove a factor) → "trust this
device for 30 days" → dashboard empty state: create your first site → **set the site
timezone** (defaults to the creator's browser zone; the dashboard reads site times
on it — schedule editor chips/banners, date-scoped log clears — while agents
evaluate schedule windows on each machine's own clock; site-time evaluation is
deliberately deferred, see drift-audit item 8) →
locked out? a superadmin can reset 2FA from the admin users row.

### 3 — install & pair `[REWRITE of old 2]`
Cold open → run installer (UAC) → what it installs (agent + the owlette desktop app +
an always-on service via owlette-host; WebView2/PawnIO added only when missing) →
the owlette window opens on "join a site" over the wizard: three-word phrase,
click-to-copy, the server named on screen → click "open owlette.app/add" (or type the
phrase on any other device) → pick a site → authorize → machine appears in the
dashboard within 30s → recovery: the service installs even if pairing fails — pair
later from Start menu → owlette → join site → recap (3 ways to add a machine, silent
`/ADD=` teaser).

### 9 — the owlette app on the machine `[REWRITE of old 8]`
The tray icon (a small amber owl eye; recolors by state, flashes red when the service
stops) → tray menu (version/hostname/service/status rows, open owlette, restart
service, start on login, exit — exit stops the service) → the app window: `processes`
sidebar + detail pane; auto-save, no save button → add a process — or just drag an
app/file onto the window (`.toe` opens in the newest TouchDesigner) → the three
groups: what to run / when to run (schedule editor in every launch mode) / recovery;
advanced disclosure → row actions: drag to reorder the launch sequence, duplicate,
restart/kill with launch-mode-aware confirms → the footer sentence + hamburger menu
(join/leave site, config, logs, docs, report issue) → local edits sync to the cloud in
about a second.

### 12 — hoot `[REWRITE of old 12; number/slug unchanged]`
What hoot is → one-time setup: account settings → hoot (provider, model, key — your
key, spent by your chats, talons visual checks, and autonomous runs) → pick a machine
or all machines (a new conversation per target) → read-only diagnosis (inline tool
cards) → tier-2 action runs directly; tier-3 pauses with an approve/deny card naming
the tool and machine (default-on per site; admin shield toggle) → async turns: close
the tab mid-tool, come back, the result is there; stop/cancel controls → guardrails:
role tier cap, the approval gate, the per-machine hoot on/off switch → autonomous
investigations appearing in the sidebar + escalation emails.

### 13 — talons: rules that watch and act `[NEW]`
Hook (a wall goes black at 3am — talons watches when you don't) → anatomy on the
pipeline editor: trigger → condition → outputs → build one live: process crashed →
restart it + email me; force a crash, watch the run row → presets: instantiate
"morning wall check" and read what it does → the AI visual check: hoot judges a
screenshot against your expectation — pass/fail with a reason → "let hoot act"
(tier 2) explained honestly: what an unattended run may and may never do → run
history: succeeded/failed/skipped, auto-disable after repeated failure, cooldowns →
closer: the built-in "update guard" (re-asserts setup-screen suppression every
sunday).

### 15 — display layouts `[NEW; promoted from optional]`
Why (windows rearranged the wall after an update; nobody on site) → the displays
panel on a machine card: monitors as owlette sees them, drift dots → capture the
current topology as a layout → break it on the machine → re-apply remotely, watch the
ack (auto-revert if nothing acks) → the events tab (monitor added/removed, drift,
apply failed) → turn on "display events" alerts → hand off to talons: display-change
trigger + delay + visual check. *Constraint: identity is still port/cable-derived —
never promise a re-cabled monitor is recognized (identity-v2 unshipped).*

### 16 — logs & troubleshooting `[AMEND old 13]`
Existing beats plus: talon events in the filter walkthrough; full-text search; the
clear dialog's own from/to pickers as THE safe way to clear a window (page date
filter and search do not scope deletion); closing beat — the docs site in-app, and
the desktop app's "report issue" which attaches system info + a log tail
automatically.

### 17 — keeping the fleet current `[NEW; optional — cut first]`
Framing (paired and running — keep it that way) → version visibility; why 3.x is a
hard cutover from the NSSM-era agent → roll an update to one machine from the
dashboard, then the rest → agent tokens admin: search, filter, prune → revoke
correctly: current token vs all-for-hostname (cloned-hostname story) → retire a
machine: remove (revokes its refresh token) vs remote uninstall → the monthly
maintenance rhythm.

---

## Why this order

2 gets a human an account, a second factor, and a site — the prerequisites 3 silently
assumed in v1. 3 gets a machine online; 4 orients; 5–8 are the daily-driver loop
(keep alive → schedule → monitor → act); 9 closes the local-machine story. Batch 2 is
opt-in depth: distribution (10–11), intelligence and automation (12–13 — hoot before
talons so the visual-check and "let hoot act" beats have a referent), people and
signals (14–15), and the troubleshooting + upkeep close (16–17). A viewer who stops
after 9 can already run owlette productively; 17 is deliberately last so trimming it
costs no renumbering.

## Demo capture preconditions (learned the hard way)

- hoot's machine-side tools fetch a ~241 MB pinned Claude CLI on FIRST use — pre-warm
  any machine that will run a live hoot/talons take, or the demo fails silently.
- Machines without the PawnIO driver show blank CPU temps (3.2.0) — the health
  episode's demo fleet must have it installed.
- A non-production server config puts an environment chip in every desktop-app frame
  — capture against prod config.
- The roost page currently wears a "developer preview" badge — resolve before
  filming ep11 (user decision).
