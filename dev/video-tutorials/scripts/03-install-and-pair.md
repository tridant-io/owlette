---
number: 3
slug: install-and-pair
title: install owlette & pair your first machine
est_duration: "6:00"
capture: mixed
scenario: dashboard-mixed-states
model: eleven_v3
voice: null
---

# episode 3 — install owlette & pair your first machine

> After this you can install the agent on a fresh windows machine and pair it to your dashboard — authorizing it from any signed-in browser, not by setting up credentials on the machine.

## [b01] cold open
**SCREEN:** a clean windows 11 desktop over parsec; the installer exe (Owlette-Installer-v3.2.0.exe) sitting on the desktop. surface: native (obs).
**NOTE:** record the install run on the fresh demo machine via parsec + obs. capture preconditions that now matter: the demo image must already have the WebView2 evergreen runtime, or let the installer's own bootstrapper install it first — without it the installer falls back to the old console pairing path (agent/owlette_installer.iss:841) and b05/b06 will not match. decide the VM's starting state before rolling, because the progress captions in b04 only appear on machines missing those components.
**VOICEOVER:**
[warm] let's get owlette running on a brand-new machine. start to finish this takes
about two minutes — and here's the part people don't expect: you don't set up any logins
or credentials on the machine itself. it gets authorized from your dashboard.

## [b02] where the installer comes from
**SCREEN:** the dashboard header — the download icon button (tooltip "download owlette agent v<current version>"). Click it; the installer downloads. Note the copy-link button right beside it. surface: web (playwright).
**NOTE:** the same download link also lives inside the "+ add machine" modal's "enter code" tab, and there's a public owlette.app/download permalink — but the header button is the simplest path to show.
**VOICEOVER:**
you get the installer right from your dashboard — there's a download button up in the
header. grab it once and you can reuse that same installer file on every machine you set
up. there's a copy-link button next to it too, which is handy when you're about to remote
into a machine and just want to paste the link over.

## [b03] running the installer
**SCREEN:** double-click the installer; the windows user-account-control prompt appears; click yes. surface: native (obs).
**VOICEOVER:**
double-click it. windows asks for administrator rights — that's expected, and it's
important. owlette installs itself as a windows service so it can keep your apps alive
even across reboots and logouts. click yes.

## [b04] what it's installing
**SCREEN:** the installer progress screen. on a machine that needs them, the status caption cycles through "Installing the WebView2 runtime..." and "Installing the PawnIO driver..." before "Installing Owlette service..." — hold on those captions if the demo VM shows them; skip the hold if it doesn't. surface: native (obs).
**ON-SCREEN:** installs as a service • auto-starts on boot
**VOICEOVER:**
it's laying down three things: the agent itself, the owlette app you'll use on the
machine, and a service host that runs the agent at boot, whether or not anyone's logged
in. two more go on only if this machine doesn't already have them — the webview runtime
the app draws in, and a signed driver for reading temperatures.

## [b05] the pairing phrase
**SCREEN:** the owlette app window opens over the installer's progress page, on the "join a site" dialog: a big three-word phrase rendered as a click-to-copy button (e.g. "silver-compass-drift") with "click to copy" underneath, an amber status line reading "waiting for authorization", and the line "approve this machine at owlette.app/add — from here or from any other device". a `dev` badge sits next to the dialog title on anything non-production. zoom in on the phrase. surface: the owlette desktop app, captured via CDP.
**NOTE:** no console window appears on an interactive install any more. the installer's own finished page now reads: service and tray start automatically, and "if this machine is not paired yet, finish pairing in the Owlette window that opened, or open Owlette from the Start menu."
**VOICEOVER:**
during setup, owlette shows you a pairing phrase — three simple words — in a little
pairing window. this is how the machine proves it's allowed to join your dashboard. think
of it like a one-time handshake; it expires in ten minutes if it isn't used.

## [b06] opening the pairing page
**SCREEN:** in the pairing window, click the footer button labelled "open owlette.app/add"; the default browser opens the add page with the phrase already filled in from the link. hold a beat on the host name in both places — the dialog names the server it will authorize against, and the add page says "authorizing on owlette.app" under its title. (alternative b-roll: leaving the pairing window open on the machine and typing the three words into owlette.app/add on a laptop — click-to-copy on the phrase means the operator never has to retype it locally.) surface: mixed — pairing window via CDP, add page via web.
**NOTE:** capture precondition for the on-machine take: /add sends a signed-out visitor to /login?redirect=/add (web/app/add/page.tsx:128-132) and that redirect carries only the path, so the `?code=` pre-fill is lost across the login (web/app/login/page.tsx:179-181). sign the demo machine's browser in to owlette before rolling so the phrase really is pre-filled on screen — otherwise the honest take is the laptop route, or pasting the phrase with the dialog's click-to-copy button.
**VOICEOVER:**
[reassuring] the pairing window has a button that opens the add-a-machine page for you —
phrase already filled in. or leave it sitting there and authorize from your own laptop
instead: open owlette dot app slash add and type the three words in. you sign in to
owlette once, in a browser. do it from the laptop and this machine never sees a login at
all.

## [b07] choosing a site
**SCREEN:** the add page — a "site" dropdown; pick "main gallery"; the authorize button lights up. surface: web (playwright).
**VOICEOVER:**
now pick a site. a site is just a group of machines — one per venue, or per client, or
per room, however you like to organize. i'll drop this one into "main gallery." then
click authorize.

## [b08] the machine appears
**SCREEN:** cut to the dashboard; within ~30 seconds a new machine card pops in, status pill turns green, heartbeat starts. surface: web (playwright).
**NOTE:** on the machine, the pairing dialog settles from "waiting for authorization" to "paired" at the same moment; a quick two-shot of both surfaces sells it if the capture allows. (that is the string a fresh install produces — pairing runs before the service is installed, so there is no service restart to report; agent/owlette_installer.iss:1199-1221, desktop/src/components/JoinSiteDialog.tsx:131-140.)
**VOICEOVER:**
[satisfied] and that's it. switch back to your dashboard, and within about thirty
seconds the new machine shows up — green status, a live heartbeat, ready to go. behind
the scenes its credentials were saved in an encrypted, machine-locked file; you never had
to touch a config file or copy a key.

## [b09] recap & the other two ways
**SCREEN:** back to the add-machine modal showing both tabs: "enter code" and "generate code". on the "generate code" tab, show the copied command — `Owlette-Installer-v<version>.exe /ADD=<phrase> /SILENT`, with `/SERVER=dev` included automatically when the dashboard is dev. surface: web (playwright).
**NOTE:** this is the LAST beat in the cut — its audio ends on the next-episode handoff. the recovery beat (b10) is cut in ahead of it, between b08 and this one. the /ADD= silent path is verified working on current code — the phrase is pre-authorized in the dashboard and the token is minted against the real machine id at poll time. a silent install with no /ADD= phrase now skips pairing outright rather than hanging; that's the recovery case b10 covers.
**VOICEOVER:**
so that's the browser flow — perfect for a single machine. there are two more ways to
add machines: you can type the pairing phrase straight into the dashboard, or, for bulk
rollouts, generate a code first and feed it to a silent install — no clicking at all.
we'll come back to bulk deployment later in the series. next up: the dashboard itself.

## [b10] if pairing doesn't go through
**SCREEN:** on the machine: close the pairing window while it still reads "waiting for authorization", then start menu → Owlette → the app's hamburger menu → "join site" → the join-a-site dialog reopens with a fresh phrase. surface: native (obs) into the owlette desktop app via CDP.
**NOTE:** cut this BETWEEN b08 and b09 — beat ids are render slots, not timeline order, and b09's rendered audio ends on the next-episode handoff, so b09 has to stay last. do not fold this into b09; b09's audio is already rendered. do not try to shoot the installer's "Pairing was not completed" dialog (agent/owlette_installer.iss:788-800): on this episode's path the GUI handoff always reports success (agent/owlette_installer.iss:816, :855), so that msgbox only fires on the console fallback — a machine without WebView2, or an /ADD= install.
**VOICEOVER:**
[reassuring] and if pairing doesn't go through — wrong phrase, no network, whatever —
the service still gets installed. that machine just has nothing to talk to yet. open
owlette from the start menu, hit the menu, choose join site, and you'll get a fresh
phrase to authorize. nothing to reinstall.
