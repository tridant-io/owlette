---
number: 16
slug: logs-and-troubleshooting
title: logs & troubleshooting
est_duration: "6:00"
capture: web
scenario: control-process-restarting
voice: null
model: eleven_v3
---

# episode 16 — logs & troubleshooting

> After this you can find what happened on any machine, filter the noise, and see the screenshot from the moment a process crashed.

## [b01] the activity timeline
**SCREEN:** the logs page — a reverse-chronological list of events across the site (page header at web/app/logs/page.tsx:809; the table below it).
**NOTE:** the capture scene seeds its own eight log entries inline before recording (web/e2e/videos/13-logs-and-troubleshooting.video.ts:50-140) — don't add a fixture. One seeded string needs refreshing: the details text reads "agent online — version 3.0.0" on two entries (video.ts:114 and :124) while the agent is 3.2.0. The restart entry is already fine — it seeds `scheduled_reboot_success` (video.ts:99), a live filter value (page.tsx:173) — leave it alone.
**VOICEOVER:**
when you want the full story of what happened — and when — this is the place. the logs page
is a running timeline of everything across the site: agents starting and stopping,
processes launching, crashing, being killed, deployments finishing or failing, scheduled
restarts, talon runs. newest first.

## [b02] reading an entry
**SCREEN:** point along one row's six columns — the colored level badge, the time, the event, the machine, the process, and the details preview that carries the crash text and the camera icon (page.tsx:1126-1135, row at :289-301). The time column reads relatively ("7m ago", relativeTime() at :280-295); hover it to reveal the exact stamp in the tooltip.
**VOICEOVER:**
each line tells you the essentials at a glance: a colored badge for severity, what
happened, which machine, which process if it applies, and exactly when. cyan is routine
info, yellow is a warning, red is an error — so your eye goes straight to the red.

## [b03] filtering the noise
**SCREEN:** use the filters — the action dropdown, now a grouped list (agent, processes, commands, deployments, restarts, displays, talons — page.tsx:133-211, rendered at :1015; scroll it so the talon group with "talon triggered / succeeded / failed / skipped" is on camera), machine dropdown, level, date range (presets like last 24h / custom), and the full-text search box.
**VOICEOVER:**
a busy fleet generates a lot of lines, so the filters do the work. narrow to one action
type, one machine, one severity, or a time window like the last twenty-four hours. or just
type in the search box to find every mention of a process or a phrase. "show me only the
errors on the media server yesterday" is a few clicks.

## [b04] the crash screenshot
**SCREEN:** a "process crashed" entry with a camera indicator; open the attached crash screenshot full-size (thumbnail img[alt="Crash screenshot"] at page.tsx:411, modal at :1190).
**VOICEOVER:**
here's the detail that saves you. when a process crashes, owlette grabs a screenshot at
that moment and attaches it to the log entry. so instead of guessing, you can see exactly
what was on screen when it died — the error dialog, the frozen frame, the blue screen.
click the thumbnail to view it full size.

## [b05] expand for the full record
**SCREEN:** expand a row to reveal the full details — machine id (page.tsx:380), the absolute timestamp (:388-397), the raw details block (:399-402); show expand-all / collapse-all (:910-919).
**VOICEOVER:**
expand any row for the complete record — the full machine id, the exact timestamp, and the
raw details behind the summary. it's the difference between "something went wrong" and
knowing precisely what.

## [b06] clearing up, safely
**SCREEN:** the "clear logs" button (page.tsx:987-997 — only rendered for site admins, `canManageLogs` at :444). Open it: the "clear event logs" dialog carries its own "from (optional)" / "to (optional)" pickers (:1234-1252) and builds a live scope list above them (:1215-1228). Set both dates and show the scope list gaining the from/to lines; then clear them to show the no-filters copy, "this will permanently delete ALL event logs for this site (across all machines)".
**VOICEOVER:**
[serious] clear logs is there if you're a site admin. the dialog has its own from and to
dates — set those, and only that window gets deleted. that's the safe habit. the page's
date filter and the search box don't scope the delete. action, machine, and level do. set
nothing at all, and it wipes the site's entire log.

## [b07] when you're still stuck
**SCREEN:** the dashboard header's help menu → "docs" opening /docs in-app (web/components/PageHeader.tsx:274-289). Cut to the machine: the owlette app's ⋯ menu → "submit issue" (desktop/src/components/AppMenu.tsx:110, dialog at desktop/src/components/ReportIssueDialog.tsx:96-99); pick a category, type a line, send — toast "thanks — your feedback was sent · system info and recent logs went with it."
**VOICEOVER:**
[warm] two last resorts. in the dashboard, the help menu opens owlette's full docs, right
in the app. and on the machine, the owlette app has submit issue — it attaches system
info and the last hundred lines of the service log automatically. that's the
troubleshooting kit. one thing left: keeping every machine on the current build.
