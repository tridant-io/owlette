# Owlette

owlette keeps software running on unattended Windows, macOS and Linux machines: an agent on each machine supervises processes and reports through Firestore to a web dashboard, where operators watch and act on the whole fleet. Product and feature names are lowercase everywhere: owlette, roost, swoop, hoot, talons.

## Language

### Fleet

**Site**:
A named group of machines (a venue, a department, an installation) and the unit that membership, permissions and settings attach to; a membership can be narrowed to some of its machines (machine scope).
_Avoid_: organization, org, tenant, workspace

**Machine**:
One computer running the agent, paired to exactly one site in one environment. Its ID is its hostname at first pairing, kept from then on.
_Avoid_: device, node, host, client, endpoint

**Fleet**:
All the machines an operator looks after. Inside the team, "the dev fleet" means the owner's own test machines, which are paired to dev.
_Avoid_: cluster, estate

**Process**:
A program owlette supervises on a machine, defined by its launch target and launch mode.
_Avoid_: app, task, job, service

**Launch target**:
The file a process runs: an `.exe` on Windows, an `.app` bundle on macOS, a program on Linux, all stored in `exe_path`. Copy names it per platform through `web/lib/launchCopy.ts` and `desktop/src/lib/launchCopy.ts`.
_Avoid_: "exe" or "executable" for a Mac or Linux machine

**Launch mode**:
How owlette treats a process: `off` (not managed), `always on` (kept running and relaunched after a crash) or `scheduled` (runs only inside its schedule blocks).
_Avoid_: autolaunch, autostart

**Heartbeat**:
The agent's periodic write of its machine's state to Firestore. A machine whose heartbeat goes stale reads as offline.
_Avoid_: ping, check-in

**Command**:
An instruction the web app writes to a machine's `commands/pending` for its agent to run and answer in `commands/completed`.
_Avoid_: request, RPC, job

**Deployment**:
A software install sent from the deploy page (`/deployments`): one installer URL with a pinned SHA-256, sent to chosen machines and tracked per machine. Windows only today.
_Avoid_: using it for a roost rollout

**Talon**:
A site-scoped automation: a trigger, an optional condition such as a hoot visual check, and one or more outputs.
_Avoid_: automation rule, workflow, recipe

### On the machine

**Agent**:
The Python service on every machine that supervises processes, runs commands and reports to Firestore. Windows hosts it with owlette-host, macOS as the launchd daemon `app.owlette.agent`, Linux as the systemd unit `owlette-agent.service`.
_Avoid_: client, "the service" when you mean the program rather than its OS registration

**owlette-host**:
The Rust supervisor (`agent/host`, `owlette-host.exe`) that is the Windows service `OwletteService` and keeps the agent running. It replaced NSSM in 3.0.0.
_Avoid_: NSSM, service wrapper, "the host" on its own

**Desktop app**:
The Tauri app in `desktop/` on every machine: the local window and the tray (menu bar) icon for processes, status and joining a site. It runs in the signed-in user's session as a separate process from the agent. An operator workstation without the agent has no desktop app and may run only owlette swoop.
_Avoid_: tray app, GUI, agent window, the python interface (gone since 3.0.0)

**Streamer**:
`owlette-swoop` (`agent/swoop`), the Rust binary the agent starts on demand to capture, encode and send a machine's screen for swoop. It takes the host role in a swoop session; Linux ships none.
_Avoid_: swoop host as a binary name, owlette-host

**Installer**:
The per-platform agent package (`Owlette-Installer-vX.Y.Z.exe`, `.pkg` or `.deb`) that installs or upgrades everything on a machine. During an upgrade it is the only new code that runs on an old machine.
_Avoid_: setup, update package

**Issue**:
What a user files to reach owlette support, from the desktop app's menu or the dashboard's help menu ("submit issue"). One filed from the desktop app carries system info and the last lines of the service log. It is stored in `bug_reports` through `/api/bug-report`, names kept from before the rename.
_Avoid_: bug report, feedback, ticket

**Active hours**:
The hours, on the machine's own clock, during which Windows holds back its own update restarts and the agent refuses reboots, shutdowns and deployments unless a person overrides. The agent reads them from policy, then MDM, then the user's setting, then Windows' default 8–17. Windows only.
_Avoid_: quiet hours, show hours, maintenance window, business hours

### Pairing and access

**Pairing**:
Binding a machine to a site and an environment: the machine shows a pairing phrase, a signed-in user authorizes it from any browser, and the agent receives its own tokens.
_Avoid_: registration, enrollment, activation, logging the machine in

**Pairing phrase**:
The three-word code (`silver-compass-drift`) that stands for a pending device code. It authorizes a machine when typed on `/add` or passed as `/ADD=`, and the CLI's `owlette auth login` uses the same flow.
_Avoid_: pairing code, PIN, token

**Agent token**:
A machine's own refresh token, which never expires but an admin can revoke, kept encrypted in `.tokens.enc` under a machine-bound key and used to mint one-hour access tokens.
_Avoid_: service account, credentials file

**Site role**:
A person's standing on one site: `owner`, `admin` or `member`. Members read; admins and owners act. A swoop mode on the same row can widen or narrow swoop alone. A machine scope narrows which machines a role covers and takes away everything site-wide; it never widens what the role allows.
_Avoid_: using the global role for anything on a site

**Swoop mode**:
A person's own swoop on one site, set on their member row: `none`, `view` (watch) or `control`. Without one, the site role decides: members watch where the site lets members watch, admins and owners control. It changes swoop and nothing else, control still needs a step-up, and the owner's row never carries one.
_Avoid_: swoop role, swoop permission, swoop access level

**Site settings**:
A site's own page in the admin panel, `/admin/sites/{siteId}`: its name and timezone, members, machines with the keep screens awake switch, and deleting it. The site's owners and admins open it from the site switcher or from the site's gear on admin panel → sites. A feature with a section of its own in the admin panel keeps its site setting there: the swoop switch is on admin panel → swoop → settings (`/admin/swoop/settings`).
_Avoid_: site editor, manage sites dialog

**Machine scope**:
The machines a member row lists in `machineIds`, at most 30. Someone with one, a scoped member, sees and acts on only those machines: their site role and their swoop mode apply there and nowhere else, and nothing that spans machines reaches them. A scoped admin is a scoped member whose role is admin. The members section shows "N machines"; UI copy says "limited to some machines".
_Avoid_: allowlist, machine permissions, partial member, "scope" alone

**Whole site**:
A member row with no machine scope. It covers every machine of the site, and it is the only standing that reaches what spans machines: the site's settings, members and presets pages and APIs, deployments, roost, talons, webhooks, kill, kick and the site's swoop sessions list, and the audit log. Owners are always whole site.
_Avoid_: full member (it reads as the site role `member`), unscoped member

**Superadmin**:
The only global role that grants anything: owlette's own operators, who run platform-wide pages such as `/admin/installers`.
_Avoid_: "admin" without saying site admin or superadmin

**API key**:
A scoped, expiring `owk_live_` key whose scopes each name a resource, an ID and exact permissions. A key never grants more than its owner holds.
_Avoid_: token, secret, credential

**Step-up**:
A fresh second-factor check (passkey, authenticator code or backup code) that swoop control requires, valid for that user and machine for 7 days. A second factor passed at sign-in in the last five minutes counts as one for the machines opened in those five minutes. With network binding enforced, a window counts only from a network (ASN) the user passed a second factor on in the last 7 days, so a new network asks once.
_Avoid_: re-auth, 2FA prompt

### Environments and releases

**prod**:
The production environment: `owlette.app`, Firebase project `owlette-prod-90a12`, deployed from `main`. Customers' machines are paired here.
_Avoid_: live, production when you mean a Railway service name

**dev**:
The development environment: `dev.owlette.app`, Firebase project `owlette-dev-3838a`, auto-deployed from the `dev` branch, with its own installers and its own paired machines.
_Avoid_: staging, test, sandbox

**Latest**:
The installer version each environment hands out, per platform, to every download link and fleet update, set on `/admin/installers`.
_Avoid_: current, stable, channel

**Fleet update**:
Sending machines that are behind latest an `update_owlette` command with their own platform's installer. Agents never check for updates on their own.
_Avoid_: auto-update, self-check

**Fielded version**:
Any agent version still running on a machine somewhere. The oldest one is the fleet floor, where upgrade tests and compatibility gates start.
_Avoid_: legacy, old build

**tridant id**:
Tridant's shared identity and product service. owlette lists every installer version that becomes latest in its release log there, and yanks deleted or rolled-back versions.

### roost

**roost**:
A named project folder owlette keeps in sync on a set of target machines; every upload to it is a new version.
_Avoid_: project, folder, synced folder, distribution, project distribution

**Version**:
An immutable, content-addressed snapshot of a roost's files, numbered per roost (`v1`, `v2`, ...). The roost's current pointer names exactly one version.
_Avoid_: manifest (renamed in 2.10.0), release, snapshot, upload

**Chunk**:
A 4 MiB piece of a file named by its SHA-256: the unit roost stores in R2 and never uploads twice.
_Avoid_: block, part, blob

**Target**:
A machine a roost syncs to.
_Avoid_: subscriber, destination

**Extract path**:
Where a roost's files land on a target. The agent writes only inside its allowed extract roots.
_Avoid_: install path, destination folder

**Rollout**:
One version's journey to a roost's targets as `sync_pull` commands, canary machines first; `POST /api/roosts/{roostId}/deploy` starts one.
_Avoid_: deployment, distribution, push

**Rollback**:
Moving a roost's current pointer back to an existing version, after which its targets pull it. It never creates a new version.
_Avoid_: revert, restore

**Re-sync**:
Telling every current target of a roost to pull its current version again.
_Avoid_: redeploy, refresh

### swoop

**swoop**:
owlette's remote desktop: a live, controllable view of a machine's screen in a browser tab or an owlette swoop window, streamed peer-to-peer from the streamer. It is off until a site turns it on.
_Avoid_: remote control, KVM, VNC, live view

**Live view**:
The older screenshot slideshow that swoop replaces on machines that can stream. It is still offered where the agent cannot, or the site has swoop off.
_Avoid_: using it as a synonym for swoop

**Session**:
One streamer's time on one machine, shared by everyone viewing that machine: a browser tab or owlette swoop window that opens swoop on a machine already in a session joins it, with a viewer ID, lease and audit rows of its own, rather than starting another. It lasts while anyone is in it. A viewer's end, closed tab or refused lease takes only that viewer out; a kill ends it for everyone, and so does removing someone in it from the site, taking their control or kicking them, after which everyone in it reconnects on their own as what they may now do.
_Avoid_: stream, connection, call

**Viewer**:
The side of a session that watches or is in control, in a browser tab or an owlette swoop window. Which one is the person's swoop mode, or by default their site role (members watch, owners and admins control), on a machine their access covers; control also needs a step-up.
_Avoid_: client, guest

**owlette swoop**:
The desktop viewer app (`desktop/viewer`, binary `owlette-swoop-viewer`, macOS bundle `owlette swoop.app`): owlette.app's own swoop viewer in native windows, with fullscreen, OS-shortcut capture and `owlette-swoop://` links on top. Every agent installer carries it, and it needs no agent, so an operator workstation can run it alone.
_Avoid_: viewer client, native viewer, sidecar (that is the bundled macOS streamer)

**Lease**:
The 5-minute grant a viewer renews while its tab or window is open. Authorization is re-checked at every renewal.
_Avoid_: token, timeout

**Kill**:
A whole-site owner's or admin's stop of every swoop session on a machine, whatever their own swoop mode. It also closes every step-up window on that machine. The desktop app's tray item "kill all swoop sessions on this machine" (Windows) is a local stop any user at the machine can click: it ends the sessions through the streamer but closes no step-up window.
_Avoid_: end (which only takes you out of the session), disconnect

**Kick**:
Taking one other person out of a live swoop session, which a whole-site owner or admin can do whatever their own swoop mode. One streamer serves everyone on the machine and cannot drop one viewer, so a kick ends the session for everyone in it: the one it was for is told a site admin took them out and stays out until they reconnect, and everyone else reconnects on their own. It is not a ban (keeping someone out is their swoop mode) and closes no step-up window.
_Avoid_: kill (which stops every session on the machine), ban, remove (which takes someone off the site)

**Doorbell**:
The idle WebSocket each agent holds to the swoop signalling worker, through which a new session rings the machine to start its streamer.
_Avoid_: signalling socket, push channel

**Quality ladder**:
The streamer's ordered frame-rate and resolution caps below the viewer's chosen preset. A rung is one step on it, and a healthy session sits on the preset's own rung.
_Avoid_: bitrate tiers

**Encoder tier**:
One encoder serving every viewer who shares a codec class. A machine runs as many as the fewer of its viewers' codec classes and its measured encoder budget.
_Avoid_: quality tier

### hoot

**hoot**:
owlette's built-in AI assistant: an LLM on a user's own Anthropic or OpenAI key that investigates and operates machines through tool calls. It is a feature of owlette, not a separate product.
_Avoid_: cortex (its name before 3.0.0), copilot, chatbot, AI chat

**Tool tier**:
hoot's risk grouping of its tools: tier 1 reads, tier 2 makes bounded changes, tier 3 runs privileged actions (shell, files, deployments, reboot) and pauses for in-chat approval while the site's tier-3 approval is on.
_Avoid_: permission level

**Local hoot**:
hoot's model loop running on the agent itself through the Claude CLI, close to the machine and outside the web server's approval gate. Only the public conversations API reaches it.
_Avoid_: agent hoot, offline hoot

**hoot CLI pin**:
The per-platform Firestore document (`installer_metadata/cortex_cli_<osFamily>_<arch>`) naming the Claude CLI build and SHA-256 that local hoot downloads. `scripts/upload-cortex-cli.mjs` refreshes it.
_Avoid_: "cortex CLI" in prose

**Visual check**:
A talon condition in which hoot judges a screenshot of the machine against a plain-language expectation.
_Avoid_: screenshot check, AI check

## Flagged ambiguities

- **cortex is hoot.** "cortex" was the AI feature's name until 3.0.0. It survives only in internal identifiers: the `/api/cortex/*` routes kept for old CLI and SDK clients, `owlette_cortex.py`, `cortex_cli_fetch.py`, `scripts/upload-cortex-cli.mjs`, `installer_metadata/cortex_cli*`, `sites/{siteId}/settings/cortex`, the `cortex_*` system actors and old screenshot file names. Say hoot. Name a cortex identifier only when someone has to type or open it.
- **web app, desktop app, agent.** The web app is the Next.js deployment in `web/` (dashboard, API routes, docs, landing page) at owlette.app and dev.owlette.app. The desktop app is the Tauri window and tray icon in `desktop/` on each machine. The agent is the background Python service, with no UI of its own since 3.0.0. `owlette.app` is both the production domain and, on macOS, the desktop app's bundle (`/Applications/owlette.app`), so say which.
- **dev vs prod.** Two separate deployments with separate Firebase projects, installers and paired machines. A phrase minted on one server fails on the other, which is why installers take `/SERVER=dev`. Three traps: Railway's prod service `owlette-prod` sits in the Railway environment named `dev`; an `owk_live_` key is not a prod key (every key is minted `live`, and `owk_test_` never meant a sandbox); and "staging" in Tridant's hostnames (`download-staging.tridant.io`) is owlette's dev.
- **host.** owlette-host is the Windows service host. The swoop host is the streamer's role in a session (it holds the host token). The desktop app's Rust side is its Tauri host. The download host is `download.tridant.io`. A machine is not a host. Never write "the host" alone.
- **deploy and deployment.** A deployment is a software install from the deploy page. Sending a roost version to its targets is a rollout, even though its route is `/deploy`. API keys carry both a `deploy` resource and a `deploy` permission, and the permission is what roost rollouts and re-syncs need.
- **manifest is version.** roost's snapshot was renamed from manifest to version in 2.10.0 on every API, field, event and CLI flag. "manifest" survives only in the spec's file name (`docs/internal/manifest-format.md`) and an R2 key prefix (`project-manifests/`).
- **v2 and v3 in roost docs.** These are generations of project distribution (v1 was the single-URL ZIP), not agent versions. "Deferred to v3" means a later roost generation, not agent 3.x.
- **tier.** hoot's tool tiers (risk), swoop's encoder tiers (one encoder per codec class), and the core/pro site tiers that 3.0.0 removed. Say which.
- **rung.** Not a domain term on its own: the code uses it for one step of any ladder, including swoop's quality ladder, the encoder preference order, API-key expiry notices (14, 3 and 0 days) and reconnect backoff. Name the ladder.
- **admin.** The global `admin` role grants nothing since roles moved onto sites. "admin" means site admin unless it says superadmin.
- **provisioning.** It means two different things: publishing hoot CLI pins (`scripts/upload-cortex-cli.mjs`) and pushing a user's LLM key to a machine's local hoot (`/api/hoot/provision-key`). Name which.
- **scope.** An API key's scopes (`site=<id>:read`), a talon's `scope.machineIds`, and a member's machine scope (`machineIds` on the member row) are three different things. Say which.
