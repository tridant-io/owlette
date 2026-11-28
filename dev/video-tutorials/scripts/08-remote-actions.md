---
number: 8
slug: remote-actions
title: "remote actions: screenshot, restart, shutdown"
est_duration: "6:00"
capture: web
scenario: dashboard-mixed-states
voice: null
model: eleven_v3
---

# episode 8 — remote actions: screenshot, restart, shutdown

> After this you can see what's on a machine's screen and restart, shut down, or quiet it — all from the dashboard.

## [b01] the actions menu
**SCREEN:** click the "⋮" machine-options menu on a card; the menu opens.
**NOTE:** every press of the trigger must be moveCursorTo + click({force:true}) — the tooltip portal intercepts the pointer otherwise.
**VOICEOVER:**
every machine card has a three-dot menu — machine options. this is your remote control:
everything you'd normally walk over to the machine to do, you can do from here, from
anywhere.

## [b02] take a screenshot
**SCREEN:** click "screenshot"; the ScreenshotDialog captures the desktop; show the history sidebar and the download / fullscreen controls.
**VOICEOVER:**
start with screenshot. owlette grabs whatever's on that machine's display right now — the
fastest way to answer "is it actually showing the right thing?" past captures stack up in
a history sidebar, and you can download or blow any of them up full screen.

## [b04] restart
**SCREEN:** click "restart machine" (testid `machine-context-menu-reboot`) → the "restart {machine}?" confirm dialog and its copy, "this will restart the machine in 30 seconds" → click "restart" → the countdown pill takes over the card's status badge, hover it to reveal "cancel", and click to cancel.
**NOTE:** the countdown does not appear until the dialog is confirmed. The pill's cancel affordance hides in the final 5 seconds (Windows `shutdown /a` is unreliable that late) — shoot the cancel with time on the clock. The menu also swaps to "cancel restart" while a countdown is live.
**VOICEOVER:**
now the heavier hitters. restart machine asks you to confirm first — then a thirty-second
countdown starts on the card, a built-in "wait, not that one" window. let it run and the
machine restarts; owlette and your apps come back on their own. change your mind, click
the countdown, and it's cancelled.

## [b05] shutdown, and restarts on a timer
**SCREEN:** "shutdown machine" with its own confirm dialog and countdown; then the little gear on the "restart machine" row (tooltip "schedule restarts") opening RestartScheduleDialog. Cut to an offline machine's menu, where "schedule restarts" stands on its own as a full item (testid `machine-context-menu-schedule-restarts`).
**NOTE:** the gear is icon-only with no accessible name — locate it by icon or add a data-testid; `getByRole('button', { name: 'schedule restarts' })` cannot resolve.
**VOICEOVER:**
shutdown works the same way — confirm, then the same countdown. and if you'd rather not do
this by hand, the restart row has a scheduling gear: set a machine to restart itself every
monday at four am and forget about it. you can set that even while the machine's offline —
it picks the schedule up when it reconnects.

## [b06] mute alerts
**SCREEN:** click "mute alerts" on a noisy machine.
**VOICEOVER:**
doing maintenance and don't want a flurry of alerts? mute alerts silences notifications
for that machine — just for you, not your whole team — and unmutes with the same click
when you're done.

## [b07] who can do what
**SCREEN:** group the open menu by tier — members assigned to the site: screenshot, view displays; site admins: restart machine, schedule restarts, shutdown machine, revoke token, remove machine; everyone: mute alerts. Show "view displays" in place below screenshot, and open it once to reveal the display panel.
**NOTE:** revoke token is a SITE ADMIN action as of e0c8341a — the site-scoped `AGENT_TOKEN_REVOKE` capability. It used to 403 for admins because the route still demanded a superadmin capability; do not repeat the old "superadmin only" framing. The revoke dialog offers two choices: "revoke current token" (only the most-recently-used token for that hostname) and "revoke all for hostname" (every token, which disconnects any other machine sharing the name) — frame both.
**VOICEOVER:**
a quick word on permissions. any team member on a site can see what a machine is showing —
screenshot and view displays. the actions that change something — restart,
shutdown, revoking a machine's token, removing it from the site — are for site admins.
and muting alerts is open to everyone, since it only changes your own notifications.

## [b08] when an action doesn't go through
**SCREEN:** hold on the menu as rendered for a member — the admin-only block absent — then dissolve to the owlette desktop app on the machine to hand off.
**VOICEOVER:**
so if someone tells you an action isn't going through, that's usually the answer — they
need admin on that site. next, we leave the browser entirely and look at owlette's own
app, running on the machine itself.
