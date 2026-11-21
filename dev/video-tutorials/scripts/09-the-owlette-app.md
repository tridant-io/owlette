---
number: 9
slug: the-owlette-app
title: the owlette app on the machine
est_duration: "6:00"
capture: native
scenario: null
model: eleven_v3
voice: null
---

# episode 9 — the owlette app on the machine

> After this you can run owlette from the machine itself: read its status from the tray, add and configure processes, edit schedules, and reorder the launch sequence — all of it syncing back to the dashboard.

**NOTE (whole episode):** capture on the paired demo machine via OBS. The tray icon and its menu are native (muda/Win32) and stay pywinauto-drivable; everything inside the window is one WebView2 host with `decorations: false`, so drive it by coordinates/keyboard or record live hands. Start the app with `--tray` and open the window from the tray — the window starts hidden and the app is single-instance. Default window is 1060x640, forced dark theme. Capture against production or the footer carries an environment chip in every frame.

## [b01] the amber eye in the tray
**SCREEN:** native capture. The Windows taskbar; expand the overflow arrow; hover the owlette icon — a small amber owl eye — and show the tooltip (owlette v3.2.0 / hostname / service / status).
**B-ROLL:** the three icon states side by side: amber (connected), dim/muted (running but offline), red (flashing, service stopped) + the "owlette — service stopped" toast.
**VOICEOVER:**
[warm] most of the time you'll drive owlette from the dashboard. but there's a presence on
the machine itself too. down in the taskbar tray — sometimes under the overflow arrow — a
small amber owl eye. amber means connected. dim means running, but offline. flashing red
means the service has stopped, and you'll get a notification to match.

## [b02] the tray menu
**SCREEN:** right-click the tray icon. Header rows first (owlette v<version>, hostname: <name>, service: running, status: connected to <site>; a fifth health row appears only on a failed probe), then the clickable items in this order: open owlette, restart service, start on login (a checkbox), exit.
**NOTE:** don't actually click exit on camera unless you want the UAC prompt and a stopped service in the shot — shoot it as a hover.
**VOICEOVER:**
right-click the eye and the top of the menu is a read-out: the owlette version, the
machine's name, whether the service is running, and what it's connected to. under that —
open owlette, restart service, start on login, and exit. [pause] one warning: exit doesn't
just close a window. it stops the service, so nothing is watching the machine until you
start it again.

## [b03] the window
**SCREEN:** click "open owlette" (or left-click the icon). The window opens: custom dark titlebar with the owl eye, the "owlette" wordmark, the hamburger menu and window controls; a "processes" sidebar on the left with a + button and a status dot per row; the detail pane on the right with the name, live status word and the restart / kill buttons; the one-line footer at the bottom. Then close the window and show it hiding back to the tray.
**VOICEOVER:**
choose open owlette — or just left-click the eye — and the window opens. the owlette
wordmark and a hamburger menu across the top, your processes down the left, each with a
live status dot, and the details of the selected one on the right. close it and it tucks
back into the tray; the service keeps running either way.

## [b04] adding a process
**SCREEN:** click the + above the list — a new "untitled process" appears and is selected. Then drag a .toe file from Explorer onto the window: the drop overlay lights up, the "add process" confirm card shows name / exe (the newest TouchDesigner) / path / cwd, and the line "it is added with its launch mode off". Confirm; the toast reads "<name> was added".
**B-ROLL:** the same drop with a .bat, a .py, and a Unity player-build folder.
**VOICEOVER:**
two ways to add a process. the plus button above the list makes a blank one. or drag the
thing straight onto the window — an app, a script, a touchdesigner project, a unity build
folder. owlette works out how to launch it. a project file opens in the newest
touchdesigner on the machine. confirm the card, and it arrives with its launch mode off.

## [b05] the fields
**SCREEN:** the detail pane, group by group: "what to run" (exe, path / args, cwd — each with a browse button), "when to run" (the off / always on / scheduled segmented control). Expand the collapsed "how to run" disclosure to reveal relaunch attempts, priority and visibility — dimmed while the mode is off. Type in a field, tab away, and cut to config.json changing on disk — no save button anywhere in the pane.
**VOICEOVER:**
the details pane is two short groups, plus one you open when you need it. what to run — the
exe, a file or arguments, and the folder to start in, each with a browse button. when to
run — off, always on, or scheduled. and behind how to run: relaunch attempts, priority, and
visibility — dimmed until you've set a launch mode, because until then none of it applies.
there's no save button; every field saves as you leave it.

## [b06] schedules, right here
**SCREEN:** the pencil button next to the launch-mode control; click it with the mode still on "off" to show it is not gated. The schedule editor opens — week summary bar, day pills, time blocks — identical to the dashboard's. Add a block, save, then flip the mode to "scheduled" and show the summary line beside the control.
**VOICEOVER:**
that little pencil beside the launch modes opens the schedule editor — the same week bar
and time blocks as the dashboard, right here on the machine. and it's offered in every
launch mode, not just scheduled. build the windows first, switch the mode on when you're
ready. the scheduling episode goes deep on the windows themselves.

## [b07] reordering, and the row menu
**SCREEN:** hover a row so the grip appears; drag it up two places — the blue drop indicator tracks the gap — and release. Then right-click a row: restart process, kill process, separator, duplicate, separator, delete. Pick restart on a live entry and read the confirm text aloud on screen; then right-click a stopped entry to show restart and kill greyed out — run controls follow liveness, not the launch mode.
**VOICEOVER:**
the order of that list is the launch order — drag a row by its grip to change it.
right-click for the rest: restart process, kill process, duplicate, delete. restart and
kill only light up while the process is actually running — they follow what's live, not
what the launch mode says. and restart, kill and delete all ask you to confirm, with
wording that tells you what happens next.

## [b08] the footer, the menu, and the cloud
**SCREEN:** the footer sentence with its tone dot ("<HOSTNAME> is connected to <site>") and the service version on the right; cut to a machine with the service stopped to show the "start service" button, and an unpaired one to show "join site". Open the hamburger: join or leave site, config, logs, docs, submit issue, start on login, restart service, reload window. Split screen: edit a launch mode in the app, and the dashboard's machine card updating about a second later.
**VOICEOVER:**
along the bottom, one line: is this machine connected, and to which site — plus a button
when it needs one, start service or join site. the hamburger menu has the rest — join or
leave a site, the config file, the logs folder, docs, and submit an issue. edit
anything here and it's in the cloud about a second later. next: getting software onto a
whole fleet.
