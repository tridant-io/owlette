---
number: 15
slug: display-layouts
title: "display layouts: capture a wall, put it back"
est_duration: "7:00"
capture: web
scenario: display-layout-editor
voice: null
model: eleven_v3
---

# episode 15 — display layouts: capture a wall, put it back

> After this you can store a machine's monitor arrangement, spot it drifting, and push it back from the dashboard without anyone standing at the wall.

## [b01] the wall came back wrong
**B-ROLL:** a 2×2 video wall where one panel shows the wrong slice of the desktop and the content breaks across the seams; cut to the dashboard.
**VOICEOVER:**
[warm] a windows update restarts a media server overnight, and the wall comes back
wrong — one panel mirrored, another parked on the far side of the desktop, content
spilling across the seams. nobody's on site until monday. owlette can hold on to what
that wall is supposed to look like, and put it back from here.

## [b02] the display panel
**SCREEN:** dashboard, the `mainstage-led` card; click the small monitor button in the card header (tooltip "view displays"); the display panel opens on the `live` tab — canvas with four rects (Mainstage 1–4) beside the monitor table (# / name / resolution @ refresh / scale / position / port).
**NOTE:** the same panel opens from the machine "⋮" menu → "view displays" — worth a second of B-roll.
**VOICEOVER:**
every machine card has a small monitor button — view displays. the live tab is what the
machine is reporting right now: every monitor drawn to scale where windows thinks it
sits, with resolution, refresh, scaling and port. anyone on the site can look at it;
changing anything is for site admins.

## [b03] store the arrangement
**SCREEN:** on the live tab click "store" → confirm dialog "store current arrangement?" → the `stored` tab now holds the layout; then click "edit", drag a monitor on the canvas, double-click one to open the per-monitor editor (resolution, refresh, rotation, scale, position, primary), then "store" / "discard".
**VOICEOVER:**
when the wall looks right, press store. that captures the current arrangement as the
stored layout — the target everything gets compared against from here on. not quite
right? the stored tab has an edit mode: drag monitors on the canvas, or double-click one
to set its resolution, refresh, rotation, scale, or make it primary.

## [b04] what drift looks like
**SCREEN:** patch the machine's live display doc so one monitor moves (the seeded fixture has live matching stored, so nothing drifts as-shipped); the card's monitor button picks up an amber dot, the `stored` tab shows its amber badge, and the drifted cells tint amber in the table.
**VOICEOVER:**
now something changes it. the agent re-checks the displays every thirty seconds, and once
live stops matching stored, the machine card picks up an amber dot. open the panel and
it tints exactly what moved. worth knowing: a monitor's identity includes the port it's
plugged into — re-cable it somewhere else and owlette reads it as a different monitor.

## [b05] turn restore on
**SCREEN:** re-seed with **both** `displays.remoteApplyEnabled` false **and** `displays.autoRestore.enabled` false so the "test" and "enable restore" buttons render; click "test" → inline result banner ("self-test ok — 4 monitors, query Nms, validate Nms"); then "enable restore" → confirm dialog.
**NOTE:** the fixture ships both flags true. auto-restore matters as much as remote apply here: the action bar's last slot is a three-way choice — auto chip if auto-restore is on, else "enable restore" if remote apply is off, else "restore" — so leaving auto-restore enabled hides "enable restore" behind the green chip. the header auto-restore switch can't be used to turn it off on camera either; it's disabled while remote apply is off.
**VOICEOVER:**
pushing a layout back is switched off until you turn it on, machine by machine. run test
first — a read-only self-check that proves owlette can talk to that machine's display
stack without moving a single pixel. if it comes back clean, click enable restore. that's
the switch that lets an admin move real monitors.

## [b06] restore, and the thirty-second undo
**SCREEN:** `stored` tab → "restore" → confirm dialog ("monitors will rearrange in a few seconds…") → toast "restore dispatched" → amber banner "keep this layout? auto-revert in 30s" with the "keep" button.
**NOTE:** auto-restore must stay off through this whole beat — the "restore" button is the *third* branch of that same slot and only renders when auto-restore is off and remote apply is on (which is the state the previous beat's "enable restore" click leaves behind). the auto chip goes on screen in the next beat, where it belongs.
**VOICEOVER:**
now restore. the monitors rearrange a few seconds later, and a banner starts counting:
keep this layout? you get thirty seconds. click keep and it sticks. [reassuring] do
nothing — because you're staring at a black screen, or you're not there at all — and the
machine quietly puts itself back.

## [b07] let it fix itself
**SCREEN:** flip the "auto-restore" switch in the panel header — live now that a layout is stored and restore is enabled — and the slot that held "restore" becomes the green "auto" chip; cut to the red banner "auto-restore paused — 3 attempts failed. last error: …" with its "reset" button.
**VOICEOVER:**
once you trust it, turn on auto-restore and the agent fixes drift on its own. it waits
for the change to hold across two checks, so a cable wiggle can't set it off. and if
three restores fail in a row it stops trying, shows you the last error, and waits for you
to press reset. no machine flapping its monitors all night.

## [b08] the events tab
**SCREEN:** the `events` tab: rows of monitor added / monitor removed / drift / apply failed / auto-reverted with level badges and relative times; then account settings → alerts → the "display events" toggle.
**VOICEOVER:**
the events tab is the history — monitor added, monitor removed, drift, apply failed,
auto-reverted — newest first, with a severity on every row. and you don't have to be
watching. switch on display events in your alert settings: a monitor that disappears or
an auto-revert emails you straight away, and the quieter stuff arrives batched.

## [b09] hand it to a rule
**SCREEN:** the talons editor — trigger "event" with display drift + monitor removed ticked, "then wait" 5 minutes, condition "visual check" with an expectation sentence, outputs below. Close on the logs page filtered to the `displays` action group (`web/app/logs/page.tsx:183-199`) as the handoff lands.
**VOICEOVER:**
last piece: hand it to a rule. those same display events can trigger a talon — wait a few
minutes for things to settle, then have owlette grab a screenshot and check it against a
sentence you wrote, like "the wall shows the show content, no error dialogs." the wall
watches itself. next up: the written record of everything that happened — your logs.
