---
hide:
  - navigation
---

# changelog

All notable changes to owlette are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/) and this project adheres to [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

## [4.2.6] - 2026-11-25

### changed

- a Mac with swoop on stays awake on mains power, so swoop reaches it locked. [more](https://owlette.app/docs/dashboard/swoop#on-macos)

## [4.2.5] - 2026-11-24

### added

- the site switcher, in the header and in owlette swoop, shows how many machines you can reach on each site.

### changed

- hoot is in the AI tools of every paired Windows and Mac machine, and says how to turn it on. [more](https://owlette.app/docs/agent/hoot-mcp)
- uninstalling owlette takes hoot out of the AI tools again. [more](https://owlette.app/docs/agent/installation#uninstall-on-windows)
- everything is free until 1 April 2027, then a 14-day pro trial; owlette free stays free. [more](https://owlette.app/docs/plans)
- **site settings** → **billing** and **settings** → **plan** show the plan, rate and end date tridant bills.
- an account gets one pro trial, even if its first tridant account was closed.
- deleting a site removes it from your tridant account after its final invoice.
- **admin** → **activity** filters take up to 10 users and 10 sites; an x clears one.
- menu rows and the header's site, page and user controls sweep like buttons, and a menu's button stays lit while it is open.
- the privacy policy covers sign-in records, deleted after 400 days, and owlette staff reading activity across sites. [more](https://owlette.app/privacy)
- if you self-host, deploy the functions before the web app.
- if you self-host with plans on, register `GET /api/cron/plan-settle` on cron-job.org daily at 06:00 UTC. [more](https://owlette.app/docs/setup/web-deployment)

### fixed

- expandable panels, such as **log tail** and **version history**, slide open and closed instead of jumping.
- network rates average over each heartbeat; a Mac on wi-fi no longer reads 0 B/s.
- and 6 smaller fixes.

## [4.2.4] - 2026-11-20

### added

- Macs that go to sleep show **asleep**, not **offline**, and no longer page. [more](https://owlette.app/docs/dashboard/admin/email-alerts#asleep-machines)
- for a Mac, **machine offline alerts** become **machines asleep** after 5 minutes, then **machines awake**.
- **admin** → **activity** gets a date range and searchable user and site filters.

### fixed

- a pending reboot emails as **reboot pending**, not `[ALERT] owlette agent error`.
- focus outlines are no longer cut off in **add process** and other scrolling forms.
- activity rows slide open and name the machine a command went to.
- the activity page no longer shows **nothing here** when hoot mcp session renewals fill it.

## [4.2.3] - 2026-11-17

### added

- move a machine to another site: site settings → **machines** → **move to another site**.
- the machine needs owlette 4.2.3 or later; its history on the old site is deleted.
- **admin** → **activity** shows superadmins one timeline of changes and sign-ins across every site.
- risky changes and sign-ins are flagged, and emailed at once or in a daily digest.
- superadmins choose who gets these emails under **admin** → **alerts** → **platform**.
- if you self-host, flagging and its emails need the `activity-watch` scheduled job.

### changed

- **admin** → **sites** drops its site count card.

### fixed

- **settings** → **hoot** explains the hoot mcp switch instead of a removed menu item.

## [4.2.2] - 2026-11-14

### changed

- the desktop app has a settings window, holding appearance and start on login from the menu.
- a **hoot mcp** switch there replaces **connect an ai agent**, except on Linux.
- once a site admin allows it, hoot appears in Claude Code, Cursor and other AI tools.
- the Windows installer has an optional **AI tools** page to allow hoot after pairing.

### fixed

- a Mac with a dot in its machine name can send logs and screenshots.

## [4.2.1] - 2026-11-14

### changed

- the swoop **allow control of this machine?** and sign-in pages are one compact card.
- links are accent-coloured, with a highlight on hover, instead of underlined.

### fixed

- a Mac comes back online after an update, instead of staying offline until reinstalled.

## [4.2.0] - 2026-11-12

### added

- hoot mcp lets an AI agent on one machine use hoot's tools on the others. [more](https://owlette.app/docs/agent/hoot-mcp)
- the owlette icon turns yellow while someone is connected through swoop.

### changed

- hoot asks before it changes what a machine launches, and never does so unattended.
- swoop text stays sharp at any window size and on slow links; portrait displays arrive upright.
- changing your password or 2FA signs out your other sessions.
- send API keys in a header, not `?api_key=`; raise a key's tier for hoot tools that change things.
- API scripts on a 2FA account need an API key; webhooks no longer follow redirects; uninstall needs `software_name`.
- self-hosting: move the `plan-daily` job to `30 23 * * *` UTC.

### fixed

- cancelling a deployment stops it on the machine, and apps close only right before installing.
- hoot acts only on the machines you name, not every machine in the chat.
- and 71 smaller fixes.

## [4.1.28] - 2026-11-10

### added

- site admins can limit a member to up to 30 machines: **change access...** → **some machines**.
- that member sees and gets alerts for only those machines, and nothing site-wide.
- the members API sets the same limit with `machineIds`.

### changed

- swoop's connection pill fades in and out instead of popping on and off.
- swoop bar warnings are an icon, with plainer advice on hover.
- searches in menus, such as the site switcher and timezone picker, share one search row.
- owlette swoop's window buttons cover less of the picture; close asks first mid-session.

### fixed

- swoop no longer drops typed keys on a connection that loses packets.
- caps lock from a Mac stays in step with the machine you control.

## [4.1.27] - 2026-11-04

### added

- site owners and admins set each member's swoop: no swoop, watch or control.
- each site has a settings page under **admin panel → sites**.
- adding a member suggests people from your other sites as you type.
- a person's pill in swoop's bar lights up while they move the pointer.
- site owners and admins can **kick** someone out of a live swoop session.
- swoop's machine picker names who is in each machine's session.
- with more than ten sites, the site switcher opens on a filter.

### changed

- owners and admins change a member's site role with **change access...**.

### removed

- the manage sites dialog: use **admin panel → sites**. `/admin/members` redirects there.

### fixed

- a site admin's admin page in a new tab no longer says "access denied".
- and 5 smaller fixes.

## [4.1.26] - 2026-11-04

### added

- swoop's bar shows a pill per person in the session; hover for their full name.

### fixed

- a second viewer joins the running swoop session instead of ending the first one's.
- removing someone, or their control, takes effect in their open swoop session at once.
- swoop says when a machine has left the site, instead of "machine is restarting".

## [4.1.25] - 2026-11-02

### added

- the Windows installer and owlette's programs are signed by Tridant, Inc.; SmartScreen may still warn.
- the dashboard and desktop app warn when a saved path won't launch, and offer **browse**.

### fixed

- on Windows, arguments in `path / args` reach the program as typed.
- swoop shows "connection lost" or "machine is restarting" instead of a frozen picture.

### security

- library updates in the web app, desktop app and swoop close known vulnerabilities.

## [4.1.24] - 2026-10-27

### added

- swoop works on a phone: tap to click, hold to magnify, pinch to zoom.
- the phone keyboard types on the machine, plus esc, tab and arrows; no accents yet.

### changed

- on a phone, a machine card's metrics show as icons, so all of them fit.
- on a phone, the menu's site list starts closed; help is in the top bar.

### fixed

- display auto-restore recovers a panel stuck in a fallback mode such as 640x480.
- the changelog's list of releases opens at once on a phone.
- a machine rolled back below 4.1.21 is no longer offered a restart after active hours.

## [4.1.23] - 2026-10-26

### added

- a machine's menu on the dashboard has **hoot**, opening a conversation about that machine.
- the **update owlette** dialog and every download menu link to the release notes.

### changed

- owlette swoop's windows open at a size where a 16:9 machine fills the picture.
- on a Mac, owlette swoop's Dock icon fills its tile like owlette's.

### fixed

- swoop's pointer keeps its size while you drag a window on a Windows machine.
- hoot offers a restart after active hours only on machines that can hold one.

## [4.1.22] - 2026-10-25

### added

- **capture the mouse in fullscreen** turns capture back on, for games and 3D views.

### changed

- swoop's fullscreen leaves your mouse free, so your pointer moves without lag.
- the desktop app wears owlette's full eye; re-pin it on the taskbar to update.
- hoot's thread line shimmers while it works, and the chat scrolls smoothly.
- **new hoot** puts the cursor in the message box.

## [4.1.21] - 2026-10-25

### added

- owlette won't reboot, shut down or deploy to a Windows machine during its active hours.
- the dashboard asks first: cancel, restart after active hours, or restart now with a reason.
- API and CLI scripts need an override to reboot, shut down or deploy in active hours.

### changed

- owlette swoop wears its own smaller eye; re-pin it on the taskbar to update.

### fixed

- on a Mac, owlette swoop's window buttons sit centred on its bar.
- on a slow link, swoop's pointer follows your mouse at once, not the machine's reply.
- **shortcuts match** maps a Mac's control to the Windows key, and back.
- a modifier key such as ctrl no longer sticks down on the machine.

### security

- library updates in the web app and agent close known vulnerabilities.

## [4.1.20] - 2026-10-21

### fixed

- a token file the agent can't read for a moment no longer unpairs the machine.
- updating from 3.2.0 no longer shows a Windows permission prompt on screen.
- the download menu offers only the platforms the latest release has a build for.

## [4.1.19] - 2026-10-20

### added

- hover the owlette swoop mark to see the installed version.

### fixed

- swoop draws the machine's pointer at its real size, including on Retina Macs.
- your own pointer no longer vanishes while connecting or when the machine hides its pointer.

## [4.1.18] - 2026-10-16

### added

- each issue gets a number; quote it when you follow up with owlette support.
- the dashboard's submit issue dialog takes screenshots and videos, like the desktop app's.

### fixed

- swoop says why a machine can't show a picture, instead of "connecting" forever.
- swoop starts reliably on a busy Mac and on a machine re-paired in place.
- **cancel and sign out** on the two-factor screen goes to the login page.
- macOS and Linux agent logs no longer repeat Windows-only errors.

## [4.1.17] - 2026-10-15

### added

- submit issue takes videos and up to 10 screenshots, 100 MB in all.

### changed

- the sent confirmation lists what went with the issue, such as logs and screenshots.

## [4.1.16] - 2026-10-15

### added

- the desktop app's submit issue dialog takes up to 5 screenshots, picked or pasted.

## [4.1.15] - 2026-10-14

### added

- attached logs also include owlette swoop's log, installer logs and crash reports, never tokens.

### changed

- submit issue shows its progress in the button row.

## [4.1.14] - 2026-10-14

### added

- the desktop app's submit issue shows each step as it sends.

### changed

- the desktop app's menu is reordered, with leave site last on its own.
- swoop's stats button stays pressed while the stats are open.

### fixed

- swoop keeps its picture sharp on a busy screen instead of lowering quality.

## [4.1.13] - 2026-10-13

### added

- desktop app issues can **attach logs**: the last 14 days, seen only by owlette support.

### changed

- "submit bug report" is **submit issue**, in the desktop app and the dashboard.

### fixed

- swoop's picture no longer smears, and NVIDIA machines encode on the GPU again.

## [4.1.11] - 2026-10-13

### added

- pricing for after the beta: owlette free, core and pro. nothing is billed yet.
- every account will start with a 14-day pro trial, no card.
- email-and-password sign-ups get a link to verify their address.

### fixed

- a Mac shows its own disks and network, not simulator volumes or VPN tunnels.
- two Macs on one network no longer pair as one machine.
- two Macs that shared one machine: leave the site on each and pair again.
- swoop stops retrying after ten minutes without a picture and says what to check.

## [4.1.10] - 2026-10-12

### fixed

- a machine re-paired or moved to another site shows its hardware details again.
- owlette swoop's first launch opens the server its computer's agent is paired with.

## [4.1.9] - 2026-10-12

### added

- swoop hosts on Windows machines without an NVIDIA GPU, using Intel, AMD or the CPU.

### changed

- a second factor passed at sign-in counts as swoop's step-up for the next five minutes.
- a swoop step-up covers a machine for 7 days, up from 12 hours.

### fixed

- owlette swoop has its own minimal sign-in card, with browser sign-in first.
- owlette swoop's loading notice sits centred with a spinner.
- the verify and approve pages offer "not you? sign in as someone else".

### security

- sign-in and pairing rate limits are harder to get around.

## [4.1.8] - 2026-10-10

### added
- owlette swoop, an app that opens swoop sessions in their own window.
- the swoop bar can sit on the left or right edge; its buttons have tooltips.
- **download codes** saves your 2FA backup codes to a file.

### changed
- installers come from `download.tridant.io`; host-filtering firewalls must allow it on port 443.
- with swoop off, a machine's menu offers site admins **turn on swoop…**.
- pages fade in row by row as they open.

### fixed
- swoop connects from strict networks via the relay; machines need UDP out on port 3478.
- **revoke token** cuts the machine off within a minute.
- **remove machine** sticks; on agent 4.1.7 or earlier, repeat it after an hour.
- swoop recovers a frozen picture, keeps control on reload, and says why it can't start.
- and 12 smaller fixes.

## [4.1.7] - 2026-10-07

### changed
- swoop sends at most 60 frames a second, even on faster displays.
- the machine's swoop log says why a picture stalled.

## [4.1.6] - 2026-10-04

### changed
- swoop won't open the machine you are sitting at, and greys it out there.

## [4.1.5] - 2026-10-04

### fixed
- **win + l** in swoop's special keys menu locks the Windows machine.

## [4.1.4] - 2026-10-04

### added
- **ctrl + alt + del** in swoop's special keys menu opens the Windows security screen.

### fixed
- swoop shows UAC prompts and lets you answer them; mouse and keyboard no longer go dead.

## [4.1.3] - 2026-10-03

### added
- swoop connects across the internet through most home and office routers.

### changed
- after 20 seconds without a path, swoop says it can't reach the machine.
- on macOS 26 the app icon follows the Mac's light or dark icon style.

## [4.1.2] - 2026-10-03

### added
- light mode for the dashboard, docs and desktop app: **account settings → preferences → appearance**.

### changed
- the desktop app follows the computer's light or dark appearance by default.

### fixed
- **keep screens awake** works on Windows, including with nobody signed in.

## [4.1.1] - 2026-10-03

### added
- **keep screens awake**, on by default for every site; switch it off in **manage sites**.
- a new **swoop** admin page lists live sessions and who is in them, and ends them.
- the machine menu shows how many people are in its swoop session.

### changed
- a site's swoop switch moved to its edit panel in **manage sites**.

### fixed
- the desktop app no longer says the service stopped while it updates.
- on Linux, `systemctl stop owlette-agent` no longer gets undone.
- the macOS app window has macOS 26 rounded corners.
- the dashboard list view shows its metric cells again.
- keyboard focus in the dashboard no longer draws a heavy ring.
- on Linux, notifications carry the app's icon and name.
- and 3 smaller fixes.

## [4.1.0] - 2026-10-02

### added
- a Mac can host swoop: Apple silicon, macOS 15+, a user logged in, desktop app running.
- the macOS desktop app warns when Accessibility, which swoop control needs, is off.
- swoop's clipboard syncs with a Mac, depending on its **Paste from Other Apps** setting.

### changed
- ctrl acts as cmd when controlling a Mac; the keyboard menu's **keys match** turns it off.
- a Mac streams at full resolution and 60 fps, up to 100 Mbps.
- the swoop quality menu shows one row per setting.

### security
- the web app is patched against a denial-of-service hole.

### fixed
- pasting in swoop no longer overwrites a copy made on the machine.
- on macOS and Linux, quitting the desktop app ends swoop instead of leaving a dead keyboard.
- and 4 smaller fixes.

## [4.0.6] - 2026-09-28

### fixed
- a process that exits with code 0 is relaunched, not booked as a crash.
- pasting from your computer into a swoop session works, with no permission prompt.
- an image pasted into swoop is the one that pastes, not the previous copy.
- a Mac pairs without `.local` in its id; re-pair an already paired Mac to drop it.

## [4.0.5] - 2026-09-27

### changed
- swoop copies and pastes images both ways up to 15 MB, including into Paint.

### fixed
- over the bars around a swoop picture your own pointer shows, and clicks go nowhere.

## [4.0.4] - 2026-09-26

### fixed
- swoop sessions survive network hiccups and reconnect on their own, with no 12-hour cap.
- a reconnect keeps control without asking for your passkey again.
- an agent update or restart reconnects viewers instead of ending their swoop session.

## [4.0.3] - 2026-09-26

### changed
- the macOS menu bar icon is tinted to match the bar; errors still show red.

### fixed
- the desktop app's menu shows the machine name on macOS and Linux, not "unknown".

## [4.0.2] - 2026-09-26

### fixed
- a Mac shows its GPU on the machine card and list instead of N/A.
- a Mac or Linux machine shows its full RAM, not about half.

## [4.0.1] - 2026-09-26

### fixed
- the macOS installer always puts the app in /Applications, so the login item works.

## [4.0.0] - 2026-09-25

### added
- owlette runs on Windows, Apple silicon Macs (macOS 15+) and Ubuntu; the API reports each machine's OS.
- swoop, remote screen and control, ships with owlette 4.
- downloads pick your platform, and fleet updates send each machine its own installer.
- remote screenshots work on a Mac, and notifications on macOS and Linux.
- the macOS desktop app says when Screen Recording is off.

### changed
- one passkey check covers a machine for 12 hours; a tab keeps control while open.
- your screen stays awake during a swoop session, and its bar shows just the machine name.
- the swoop latency overlay names the codec.
- the macOS desktop app uses native window buttons, with a Dock icon only while open.

### fixed
- a swoop session whose machine goes silent reconnects instead of hanging.

## [3.3.15] - 2026-09-24

### fixed
- the swoop cursor is drawn smoothly at full detail instead of blocky.

## [3.3.14] - 2026-09-24

### fixed
- large swoop cursors draw at true size, and a title-bar drag shows one cursor, not two.
- the fullscreen letterbox is black.

## [3.3.13] - 2026-09-24

### fixed
- a swoop session whose picture, cursor and stats froze for good now reconnects and recovers.

## [3.3.12] - 2026-09-24

### changed
- swoop sessions ride out a lost signalling connection and keep reconnecting until they get through.
- the machine's cursor shows in fullscreen.

### fixed
- swoop audio no longer cuts out a second into a session.
- swoop sessions no longer end after five and a half minutes.

## [3.3.11] - 2026-09-24

### fixed
- swoop connects to a machine that has a VPN up.

## [3.3.10] - 2026-09-23

### changed
- with debug logging on, swoop's log records how each connection was set up.

## [3.3.9] - 2026-09-23

### added

- keyboard menu in the swoop toolbar sends Ctrl+Alt+Del, the Windows key, Alt+Tab and similar.
- ended or failed swoop sessions offer **reconnect**.

### changed

- the swoop streamer's debug counters follow the agent's `logging.level` setting.

### fixed

- swoop keeps its full bitrate and no longer smears the picture.
- swoop audio no longer drops most of its frames.

## [3.3.8] - 2026-09-23

### added

- `swoop.logLevel` set to `debug` turns on the streamer's counters for support.

### changed

- turning swoop on or off for a site adds or removes its firewall rule on each machine.
- the machine list's OS line sits under the hostname and abbreviates when narrow.

### fixed

- swoop sessions no longer freeze at the five-minute mark.
- swoop sessions survive a VPN or virtual network path the host cannot reach.

## [3.3.7] - 2026-09-23

### security

- hardened how the install folder's permissions are repaired.

### changed

- machines report their operating system, and the swoop streamer ships switched off.

### fixed

- docs search lists the page named for your query first.

## [3.3.6] - 2026-09-21

### security

- the install folder and credential file are no longer open to every local account; upgrade every machine.
- re-pair machines where an account you do not trust could sign in.

### added

- swoop, the remote screen: watch a machine live or take control with a second factor; off by default.
- machines report their operating system on the card and list.
- filter logs by several actions at once.
- click a stat card under the metrics chart to pin that metric.

### changed

- machine cards are easier to read: aligned metrics, colour only on crossed thresholds.
- you can no longer demote or remove yourself as site owner or admin.
- after a permission repair, re-pairing from a remote session needs the console or an elevated prompt.
- and 3 smaller fixes.

### fixed

- every line on a metrics chart has a readable scale, including temperature.
- a restart-pending banner on an unreachable machine can be dismissed.

## [3.3.5] - 2026-09-15

### changed

- support is now support@tridant.io everywhere.

### fixed

- the dashboard reopens the last site you viewed.
- fixed a sideways-scrolling machine list and an overlapping roost timestamp.

## [3.3.4] - 2026-09-12

### changed

- hoot runs on a current Claude Code CLI; machines pick it up on their next hoot start.

### fixed

- opening a saved hoot conversation shows its messages again.

## [3.3.3] - 2026-09-12

### added

- tick the machines a hoot chat talks to; changing ticks continues the conversation.
- type `@machine` in hoot to aim one message at that machine.
- share a hoot conversation as a read-only public link, expiring after 30 days by default.

### changed

- a machine with hoot off now gets nothing from any chat, talon or API call, site-wide included.
- hoot defaults to Claude Sonnet 5 and can consult Claude Opus 5 on hard problems.
- a privileged approval runs only on the machines its turn named.

### fixed

- the hoot power toggle can switch hoot back on.
- a process you close by hand no longer keeps showing as running.
- offline machines and status badges are easier to read.
- email and pairing links always point to owlette.app.
- and 5 smaller fixes.

### security

- passkey registration checks attestation certificates more strictly.

## [3.3.2] - 2026-09-09

### fixed

- a failed display read no longer sends alerts that every monitor was removed.
- Defender no longer quarantines the service host; if a 3.2.3 to 3.3.1 machine lost `OwletteService`, install 3.3.2 over it.

## [3.3.1] - 2026-09-08

### changed

- site roles are per site: owner, admin or member; an account-level admin grants nothing on a site.
- enrolling a machine now needs site admin; members who run installers get 403, so promote them.
- self-hosters: run `scripts/migrations/backfill-per-site-membership.mjs` before promoting the web release.

### removed

- the by-URL project distribution is gone; use a roost instead.

### fixed

- the roost kill switch now actually halts roost work on agents.
- a stalled display read no longer makes a machine read offline.
- a screenshot request no longer freezes process monitoring for most of a minute.

## [3.3.0] - 2026-09-05

### changed

- owlette only kills or restarts processes it launched or inherited, and verifies each first.
- on upgrade, an instance owlette cannot identify is left running unmanaged; close it by hand or set path and args first.

### fixed

- a deployment's close list no longer kills every same-named process on the machine.
- a process that cannot be launched shows as failed.

## [3.2.4] - 2026-09-05

### changed

- maintenance release, no visible changes.

## [3.2.3] - 2026-08-30

### fixed

- self-updates no longer raise a UAC prompt on every machine.

## [3.2.2] - 2026-08-30

### changed

- kill and restart follow whether a process is running, not its launch mode.
- restarting a process set to off relaunches it once.
- the desktop app's process form has three collapsible sections: what, when and how to run.

### fixed

- the desktop app no longer says "no running instance" for a running process.
- the desktop kill button is red, matching the dashboard.

## [3.2.1] - 2026-08-29

### fixed

- the service starts on freshly imaged machines without the Visual C++ runtime.

## [3.2.0] - 2026-08-24

### added

- temperature monitoring can be switched off with `"temperature": { "enabled": false }` in `config.json`.

### changed

- temperatures no longer use the WinRing0 driver; upgrading removes it and uses PawnIO instead.
- the installer retracts the Defender exclusions earlier versions added.

## [3.1.0] - 2026-08-22

### added

- a passkey counts as your second factor and signs you in in one step.
- backup codes for any account, regenerated from account settings.
- account settings lists your second factors, with add and remove controls.
- superadmins can **reset 2FA** on a locked-out account from the admin users page.
- pairing screens show which owlette server they use, with a `dev` badge off production.

### changed

- pairing happens in the owlette window, not a console.
- the service is installed even if pairing fails.
- 2FA setup offers a passkey or an authenticator app, on desktop as well as mobile.
- removing your last second factor re-arms 2FA setup.
- and 3 smaller fixes.

### fixed

- the dashboard's silent-install command targets the server the phrase came from.

### removed

- the `/OPENBROWSER=` installer flag; nothing opens a browser by itself now.

## [3.0.2] - 2026-08-20

### changed

- new processes get unique default names such as "untitled process 2".
- shutting down can take up to 20 seconds longer while the agent saves state.

### fixed

- config edits made in the desktop app reach the cloud and survive reboots.
- a clean Windows shutdown is no longer reported as an unexpected reboot.
- the tray icon no longer sticks on the gray disconnected owl after a reboot.
- editing a process no longer fails with "duplicate process name" over old duplicates.
- display-capture times show instead of "never".

## [3.0.1] - 2026-08-17

### added

- a hoot tool and a talons preset, **update guard**, turn off Windows post-update setup screens on every profile.

### fixed

- the tray icon no longer flashes red on a machine that is connected.
- recovering from an internet outage clears the connection error.
- an unregistered machine reports "authentication required" instead of a network error.
- a machine whose cloud client failed to start retries every five minutes and recovers by itself.
- roost's hourly maintenance no longer fails on databases from interim 3.0.0 builds.
- the local status file shows the real time of the last heartbeat.

## [3.0.0] - 2026-08-16

### added

- a new desktop app replaces the old agent window: drag in a process, edit schedules inline, watch live status.
- talons: automations built as trigger, condition, outputs, with presets and your own LLM key per site.
- the dashboard works on a phone.

### changed

- breaking: the agent runs under a new service host instead of NSSM; upgrades migrate in place; agents older than 3.0.0 are not compatible.
- cortex is now hoot; `/cortex` links redirect.

### removed

- the legacy Python interface and site tiers are gone; every feature is open to all sites.

### fixed

- starting a process that is already running no longer launches a second copy.
- restarting a `.bat` or `.cmd` process no longer leaves the old one running.
- display alerts arrive again by email and webhook (needs the new agent).
- roost deployments finish, roll back to the exact previous files, and report failures honestly.
- and 8 smaller fixes.

## [2.12.21] - 2026-08-12

### fixed

- machines come online seconds after power-on, not minutes.
- restarting the agent no longer flickers the machine offline.
- one slow heartbeat no longer greys out a healthy machine; offline now waits five minutes.

## [2.12.20] - 2026-08-08

### security

- bundled agent libraries are updated and trimmed, with 17 fewer packages and a smaller installer.
- only a fresh install reports library versions accurately to a vulnerability scanner; upgrading in place leaves stale records.

## [2.12.19] - 2026-08-07

### added

- duplicate a process from the agent app or dashboard; the copy starts with launch mode off.

### changed

- when several machines go offline together, you get one consolidated alert email with matching counts.

### fixed

- hidden window mode works for `.bat`, `.cmd` and console apps.
- the agent file browser lets you pick `.bat` and `.cmd` scripts.
- kill works whatever the launch mode, and restart no longer launches a duplicate.
- **trust this device for 30 days** works at the 2FA prompt.
- no more daily 2FA prompts; verified sessions survive reloads and new tabs.
- 2FA codes autofill in password managers and phone keyboards.
- and 3 smaller fixes.

### security

- the bundled cryptography library is updated; none of the advisories were reachable from owlette.

## [2.12.18] - 2026-07-09

### fixed

- cancelling a running hoot tool now stops it within seconds.

## [2.12.17] - 2026-07-08

### fixed

- agents with an older roost sync database upgrade it themselves and pass the hourly check.

## [2.12.16] - 2026-07-07

### fixed

- cancelling a running tool now works for `run_powershell` and `run_command`, not only `execute_script`.

## [2.12.15] - 2026-07-07

### added

- hoot chat keeps long-running tools going when the tab closes or the connection drops, and reattaches on reload.
- running tool calls show a cancel control.
- the stop control halts the whole turn, not only your view.

### fixed

- an interrupted tool call no longer breaks the conversation.
- cancelled or restarted commands no longer re-run or strand a deployment.

### security

- only the owner of a hoot chat can send to it or stop it.

## [2.12.14] - 2026-07-03

### added

- `--open-browser` pairing option restores the old immediate browser open.

### fixed

- pairing no longer opens a browser unasked; the installer offers **press Enter** to open the page.

## [2.12.13] - 2026-07-03

### added

- the pairing phrase is copied to your clipboard during install.
- the agent-tokens admin can be searched, filtered by version, and pruned of expired tokens.

### fixed

- the desktop app's **join site** button shows the pairing phrase, opens owlette.app/add and pairs the machine.
- revoking a token can target just the current token, leaving machines that share the hostname connected.

## [2.12.12] - 2026-06-15

### fixed

- Windows Defender no longer disables temperature monitoring on some Windows 11 machines.

## [2.12.11] - 2026-06-15

### fixed

- the display **events** tab shows the newest events.
- auto-restore no longer stays paused after a monitor is turned off.

## [2.12.10] - 2026-06-14

### added

- `--no-browser` pairing option (or `OWLETTE_NO_BROWSER=1`) for kiosks and headless machines.

### fixed

- pairing no longer stalls behind an unanswered prompt; authorizing from any device completes it.

## [2.12.9] - 2026-06-09

### fixed

- roost deploy, rollback, resync and delete need the manage permission; read-only members can no longer use them.
- deleted users no longer get alert emails or keep access.
- removing a machine revokes its agent session.
- roost rollback re-sends the version to machines.
- the one-click unsubscribe link turns off all alert categories.
- and 4 smaller fixes.

### security

- several access checks are tightened so deleted users and read-only members are blocked.

## [2.12.8] - 2026-06-07

### added

- site members can view screenshots and live view.
- hoot asks for in-chat approval before running the most powerful tools.
- full-text search on the logs page, and clearing logs by date range.
- site admins can remove machines on their sites.
- any signed-in user can create API keys from account settings.
- a themed date picker.
- and 6 smaller additions.

### fixed

- no more false "machines offline" emails during scheduled reboots.
- members no longer see process controls they can't use.
- the "missing or insufficient permissions" error on the dashboard is gone.
- and 7 smaller fixes.

## [2.12.7] - 2026-06-02

### fixed

- scheduled restarts are no longer skipped for 30 minutes after a boot.
- an agent paired to dev can be switched to prod with the installer.
- a stale cloud config can no longer split dev and prod routing.

### changed

- the installer defaults to production when `/SERVER` is omitted; the docs said dev.

## [2.12.6] - 2026-05-31

### fixed

- relaunching **Owlette** from the Start menu after exiting starts the stopped service, with one UAC prompt.
- tray **restart** works when the service is fully stopped.
- hoot process kill, restart and start work again.
- roost `cancel_sync` interrupts an active sync.
- and 2 smaller fixes.

### changed

- upgrades remove the stale "Owlette Tray Icon" Start-menu shortcut.

## [2.12.5] - 2026-05-28

### fixed

- upgrading with the app or service running no longer fails with "DeleteFile failed: code 5".

## [2.12.4] - 2026-05-27

### fixed

- machines paired with a dashboard code and `/ADD=` now connect instead of being denied; machines already paired this way must re-pair.

## [2.12.3] - 2026-05-19

### added

- a `/api/health` readiness check for the planned failover origin; it does nothing until failover is set up.

### fixed

- agent screenshot capture works again and the dashboard updates live.
- the login page no longer hits a hydration error.
- alert emails send again, with timestamps in the machine's timezone.

## [2.12.2] - 2026-05-19 [superseded by 2.12.3]

### fixed

- interim fix for screenshot capture, replaced in 2.12.3.
- the timezone chip shows PST or PDT instead of a city name.
- the login page works under the stricter security policy.

## [2.12.1] - 2026-05-18

### fixed

- healthy monitors are no longer flagged **not connected** after remote desktop sessions.
- virtual and remote displays no longer trigger display drift events.
- existing stored layouts keep working; no need to store them again.

## [2.12.0] - 2026-05-17

### security

- 2FA and passkey sign-in are enforced by the server and can't be skipped; passkeys need a PIN or biometric.
- agent tokens rotate on every refresh and only work for their own machine.
- legacy api keys without scopes are rejected, and **revoke key** now really revokes.
- deleting your account no longer wipes sites you only belong to.
- users deleted by an admin lose access immediately.
- internal cloud functions are locked down.

### fixed

- roost webhooks now deliver.
- the roost kill switch now halts uploads.
- local hoot chat on a machine works again.

### changed

- self-hosters: set `CORTEX_INTERNAL_SECRET` in `functions/.env`, or those functions return 503.
- and 13 smaller fixes.

## [2.11.3] - 2026-05-08

### added

- hoot can add, edit and delete processes from chat.
- a process whose executable is missing shows a toast with suggested paths and a one-click **use path**.

### fixed

- missing executables are no longer a silent failure.

## [2.11.2] - 2026-05-06

### added

- restart process works from the API, CLI and agent.
- the desktop app asks for confirmation before killing a process.

### changed

- roost and webhooks are labeled developer preview.

### fixed

- the desktop app process panel follows launch mode changes made elsewhere.
- changing launch mode in the desktop app no longer flashes a command prompt.
- processes no longer get stuck killed after a launch mode change.
- hoot launch mode changes now save and use the mode you asked for.
- metrics charts refresh when you return to the tab.

### security

- remote installers must pass a checksum, and several routes now check permissions before changes.

## [2.11.1] - 2026-05-05

### fixed

- display layout apply and auto-restore now work when the signed-in Windows user isn't an admin.

## [2.11.0] - 2026-04-25

### added

- display alerts: emails and webhooks when a monitor is removed, an apply fails, a layout auto-reverts or sync is lost.
- monitor removed and auto-revert emails arrive in seconds; other display events are batched.
- no emails for drift caused by your own apply.
- **display alerts** toggle in account settings, plus an **events** tab on the display panel.
- per-machine auto-restore reapplies your layout when displays drift, and stops after 3 failures until you reset it.
- **test_display_apply** checks the apply path without changing anything.

### changed

- remote display apply is off by default: set `displays.remoteApplyEnabled` to `true` per machine after upgrading.
- self-hosters: call `/api/cron/display-alerts` every 3 minutes with the `X-Cron-Secret` header.

## [2.10.0] - 2026-04-24

### changed

- roost **manifests** are now **versions** everywhere; upgrade agents together with the web app.
- three roles: **member**, **admin** (site-scoped) and **superadmin** (platform-wide), with a redesigned user page and a superadmin badge.
- self-hosters: run `node scripts/migrate-roles.mjs`, then deploy rules, then web; also `scripts/migrate-manifest-to-version.mjs`.

### added

- roost: upload files from the dashboard with resume, a pre-upload summary and a rollback dialog with file diff.
- every roost version gets a number (`v3`) and an optional description.
- reference versions by number, `#3`, `v3`, id, or `current` / `previous` / `first`.
- roost rows show the current version, with history and **new version** inside.
- canary-first rollouts, per-site roost kill switch and storage quotas.
- and 4 smaller fixes.

## [2.9.0] - 2026-04-18

### added

- disk read and write speeds per drive, on machine cards, list rows and the detail chart.
- the detail panel shows friendly GPU names.

### changed

- network shows `↑` and `↓` instead of TX and RX.
- clicking a metric swaps the detail panel instead of adding to it.
- you can deselect every chart toggle.

### fixed

- detail charts no longer render offset after the tab was in the background.
- a hung disk query no longer stalls metrics.
- the agent no longer crash-loops on its first metrics tick.
- disk activity no longer drops out during Windows Update.
- and 2 smaller fixes.

## [2.8.1] - 2026-04-14

### added

- multi-GPU, multi-disk and multi-network machines show every device, not just the first.
- the dashboard remembers which device you picked per machine.
- the metrics detail panel remembers your selected tabs across refreshes and site switches.

### fixed

- sparklines and threshold alerts keep working while the fleet moves to the new metrics format.
- dual-socket workstations report CPUs correctly.

## [2.8.0] - 2026-04-12

### added

- turn hoot off on a single machine from the hoot header.
- upload or remove a profile photo in account settings.
- copy button on every hoot chat message.

### changed

- relicensed from AGPL-3.0 to FSL-1.1-Apache-2.0; self-hosting and internal use stay free.
- `run_powershell` no longer has an allow-list; every script is logged for audit, with a longer preview.
- hoot can run tool calls in parallel without being rate limited.

### fixed

- hoot's agent health check works again.
- filtered event log searches with no matches return an empty list.

## [2.7.0] - 2026-04-11

### added
- 14 new hoot admin tools: processes, services, GPU timeouts, windows update, power plan, scheduled tasks.
- more hoot tools: network reset, registry, disk cleanup, fast event log search, windows features, on-screen messages.
- the dashboard alerts **reboot pending** on a machine, checked every 15 minutes, with email and webhook alerts.

### changed
- hoot reaches for these tools first and runs free-form scripts only for unusual tasks.

### security
- the new tools refuse critical system processes, protected registry areas and features owlette needs.

## [2.6.6] - 2026-04-11

### fixed
- screenshots work again: the dashboard panel, hoot, crash screenshots and live view broke in 2.6.5.

## [2.6.5] - 2026-04-11

### security
- hoot's command, script and file tools are locked down against injection and access to system folders.
- hoot's tool calls are written to an audit log.
- pairing codes and token refresh are more reliable and safer against concurrent requests.
- api errors no longer reveal internals, and stricter firestore rules and redirect checks protect sign-in and sites.
- added an HSTS header and replay protection for autonomous hoot calls.

### changed
- updated web and agent dependencies for security fixes.

## [2.6.4] - 2026-04-10

### added
- after a restart the dashboard warns about external reboots, unexpected reboots and crashed agents; owlette's own restarts stay silent.
- hover long event log entries to read the full text.

### changed
- reboot log entries lead with readable details and a shorter entry id.

## [2.6.3] - 2026-04-09

### fixed
- scheduled reboots more than 5 minutes late are skipped and logged, never fired hours late.
- failed scheduled reboots are no longer retried automatically.
- scheduled reboot times use each machine's own timezone, not the site's.
- tray icon **Exit** now really stops the owlette service.
- machine status no longer flickers offline after flag writes or cached heartbeats.
- the reboot countdown and cancel button appear on the dashboard right away.

### changed
- reboot countdown now counts to the actual restart time: announce, short pause, then 60 seconds.

## [2.6.2] - 2026-04-08

### added
- a red pulsing `MM:SS` countdown on a machine's status pill during a reboot or shutdown, synced across viewers.
- hover the countdown to cancel; the right-click menu also offers **cancel reboot** or **cancel shutdown**.
- scheduled reboots show the same countdown and cancel.

### fixed
- confirmation dialogs now say you have 30 seconds to cancel from the dashboard.
- the **rebooting…** pill now actually shows on the dashboard.

## [2.6.1] - 2026-04-05

### added
- crash alerts are batched for 2 minutes into one digest email per site.

### fixed
- owlette's own restart of a hung process no longer sends a false crash email.
- planned reboots and shutdowns no longer send crash alert emails.

## [2.6.0] - 2026-04-04

### added
- error monitoring for the dashboard and agent, off by default on agents.

### fixed
- config sync from the dashboard no longer overwrites a machine's local-only settings.

## [2.5.9] - 2026-04-03

### added
- the agent log now records a detailed system snapshot and startup timings on every start.

## [2.5.8] - 2026-04-03

### fixed
- admin api routes accept both api keys and sign-in tokens.
- removed leftover qr code wording from device pairing.
- used pairing codes are deleted instead of marked.

## [2.5.7] - 2026-04-02

### added
- faq and pricing sections on the landing page.

### fixed
- update log entries are cleaner and lowercase, and the dashboard shows **updating owlette** during an update.

## [2.5.6] - 2026-04-02

### added
- docs: api and webhooks are now a top-level section.

## [2.5.5] - 2026-04-02

### added
- each user gets alert emails for their own assigned machines.
- email alerts show timezones and a centered unsubscribe link.

## [2.5.4] - 2026-04-01

### added
- redesigned process schedule editor with overnight schedules, such as 22:00 to 06:00.

### fixed
- site members can use machine controls without being admin.

## [2.5.3] - 2026-04-01

### fixed
- auto-update reliably replaces the agent's files.

## [2.5.2] - 2026-03-31

### changed
- maintenance release, no visible changes.

## [2.5.1] - 2026-03-31

### changed
- the agent is hardened for 24/7 uptime, with fewer leaks and better shutdown handling.

### fixed
- the dashboard shows a machine going online or offline in about 4 seconds, down from 27.
- killed processes are no longer treated as crashes and relaunched.
- hoot asks for your confirmation before deploying software, and keeps older installed versions.
- upgrade installs no longer fail on a stopped service.
- landing page loads faster.

## [2.4.4] - 2026-03-31

### added
- hoot can deploy software and use your saved software presets.
- 12h or 24h time format preference, applied across schedule editors and the dashboard.

### fixed
- network charts no longer flicker, and the process list detects running processes.
- config now syncs both ways between agent and dashboard.
- hoot sidebar categories sort by recency, and the schedule time picker opens upward near the bottom.
- the time format preference now persists.

## [2.4.2] - 2026-03-27

### added
- report a bug from the dashboard or the desktop app tray menu, with logs attached.
- branded dark-theme emails and a redesigned landing page.
- demo mode: a dashboard preview with simulated data, no login.
- process rows show file path, arguments and PID.
- download link in the landing page nav.

### fixed
- email template and landing page layout glitches.

## [2.4.1] - 2026-03-26

### changed
- agents pair with a 3-word phrase shown by the installer, replacing browser sign-in.
- installer pairing opens the browser automatically and handles failure gracefully.

### fixed
- button and status badge hover states.

### removed
- browser-based OAuth sign-in for agents.

## [2.4.0] - 2026-03-25

### added
- network monitoring with per-adapter throughput charts and history.
- per-process GPU memory usage on NVIDIA, AMD and Intel.
- hoot can run PowerShell scripts, with confirmation, and analyze screenshots.
- hoot chat renders markdown, sorts conversations into categories and knows your processes.
- **live view**: a real-time screenshot stream on the dashboard.
- recurring scheduled reboots.
- alerts when CPU, memory or disk usage passes a threshold.
- slack, teams and discord formatting for webhooks.
- api docs at `/docs/api`, plus rest endpoints for every hoot tool.
- logs get infinite scroll and date range filters.

### fixed
- screenshots go up to 8K at smaller file sizes.

## [2.3.1] - 2026-03-24

### changed
- maintenance release, no visible changes.

## [2.3.0] - 2026-03-22

### added
- hoot ai chat with 29 tools to read, manage and control machines in plain language.
- hoot can investigate crashes on its own and email admins when it cannot resolve one.
- per-user and per-site ai key management.
- passkey sign-in with biometrics or a device pin, no email or 2FA step.
- manage your passkeys: list, rename, delete.
- webhooks for process events, machine status and deployments.
- process scheduling with launch modes **off**, **always** and **scheduled**, plus reusable presets.
- remote screenshots with multi-monitor support.
- health probes and software inventory reported by the agent.
- deployments that never finish are marked failed automatically.
- rewritten documentation.

### changed
- the agent checks processes every 5 seconds, down from 10.
- launch mode replaces the autolaunch toggle.

## [2.1.8] - 2026-03-15

### added
- remote reboot and shutdown from the dashboard.
- process crash email alerts.

### fixed
- setup and site lists load faster.

## [2.0.49] - 2025-11-28

### fixed
- hidden process launches no longer hit "file in use" errors.
- quieter agent logs.

## [2.0.48] - 2025-11-26

### fixed
- the installer adds a Windows Defender exclusion for the owlette folder, removed on uninstall.
- **join site** takes seconds instead of two minutes.
- no more flashing command windows during sign-in.

## [2.0.47] - 2025-11-24

### fixed
- "agent not authenticated" errors after a restart are gone.

## [2.0.46] - 2025-11-19

### added
- admin page at `/admin/test-email` to test email notifications.

### changed
- cleaner spacing in the machine update dialog.

## [2.0.44] - 2025-11-13

### added
- **config** and **logs** buttons in the desktop app footer.
- the service restarts its connection when you re-enable it.

### changed
- **join site** and **leave site** are one button.
- deployments time out after 40 minutes, up from 20.
- uninstalling closes running owlette apps for you.

### fixed
- reconnection errors after enabling or disabling the connection.

## [2.0.29] - 2025-11-12

### fixed
- new installs get the correct config version.

## [2.0.28] - 2025-11-12

### added
- `environment` setting in config.json: production or development.

### fixed
- the tray icon launches reliably.
- **join site** defaults to the production url.
- sign-in no longer hits a port conflict on retry.

## [2.0.27] - 2025-11-11

### fixed
- the software inventory sync after install works.
- deployment status updates live instead of sticking on **downloading**.

## [2.0.26] - 2025-11-11

### added
- processes launch through Task Scheduler and survive service restarts.
- more event logging: agent start and stop, crashes, and kills from the desktop app.

### fixed
- manually killed processes no longer log as crashes.
- the agent logs a clean stop on shutdown.

## [2.0.15] - 2025-11-11

### added
- event logs page with filters, pagination and color-coded severity.
- console apps can launch fully hidden.
- process starts, kills, crashes and commands are logged automatically.

## [2.0.0] - 2025-01-31

### added
- web dashboard for remote monitoring and control.
- real-time sync through Firebase.
- remote silent software deployment across machines, with reusable templates.
- reconnect to running processes after a service restart.
- multi-site management.

### changed
- owlette is now cloud-connected; gmail and slack notifications give way to dashboard alerts.

## [0.4.2b] - legacy

### added
- windows service with process monitoring and auto-restart.
- tray icon and gui configuration.
- gmail and slack notifications.
- local json configuration, process priority and visibility control.

---

## migration guide: v0.4.2b to v2.0.0

| v0.4.2b feature | v2.0.0 equivalent |
|-----------------|-------------------|
| Gmail notifications | Web dashboard alerts + email via Resend |
| Slack notifications | Web dashboard alerts |
| Local GUI only | GUI + Web dashboard |
| Manual configuration | GUI or web-based config |
| Single machine | Multi-machine, multi-site |
| N/A | Remote deployment |
| N/A | Project distribution |
| N/A | Cortex AI chat |
