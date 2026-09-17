<div align="center">

<img src=".github/images/icon.svg" alt="owlette" width="120"/>

# owlette

### ai-powered fleet management for Windows applications

[![Version](https://img.shields.io/badge/version-3.1.1-blue)](https://github.com/theexperiential/Owlette/releases)
[![License](https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-green)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)](https://owlette.app)

[live app](https://owlette.app) &nbsp;&bull;&nbsp; [documentation](https://theexperiential.github.io/owlette/) &nbsp;&bull;&nbsp; [download agent](https://owlette.app/download)

</div>

---

owlette is a cloud-connected system for monitoring, managing, and deploying software across fleets of Windows machines — from anywhere. a lightweight Python agent runs on each machine as a Windows service, reporting metrics and executing commands. a modern web dashboard gives you real-time visibility and control over your entire fleet, backed by Firebase and Cloud Firestore.

built for teams running **digital signage**, **media servers**, **kiosks**, **TouchDesigner installations**, and any Windows application that needs to stay running.

<div align="center">
<img src="web/public/dashboard.png" alt="owlette dashboard" width="100%"/>
<p><em>real-time fleet monitoring and control from the owlette web dashboard</em></p>
</div>

## features

**real-time monitoring**
live CPU, memory, disk, GPU, and network metrics. process health tracking with crash detection. remote screenshots and live view. historical metrics with sparkline charts.

**remote deployment**
push software silently to any number of machines. supports NSIS, InnoSetup, MSI, and custom installers. save deployment templates, track progress in real-time, and cancel mid-install.

**cortex ai**
LLM-powered fleet management with natural language. AI executes commands on agents via tool-calling across 3 tiers — from read-only diagnostics to privileged operations. screenshot analysis, autonomous crash investigation, and multi-provider support (Anthropic + OpenAI).

**multi-site management**
organize machines by location, department, or project. three-tier role-based access control (member / admin / superadmin) with site-level permissions. multi-user accounts, per-site admin delegation, and platform-wide administrator roles.

**project distribution**
sync project files (ZIPs, .toe files, media assets) across your fleet from any URL — Dropbox, Google Drive, your own hosting. zero infrastructure cost. automatic extraction and file verification.

**alerts & notifications**
configurable threshold alerts for system metrics. email notifications with branded templates. webhook integrations for external platforms. activity logging across your entire fleet.

> **[full documentation →](https://theexperiential.github.io/owlette/)**

## architecture

all communication flows through Cloud Firestore — there is no direct connection between agents and the dashboard. Firestore acts as the message bus.

```
agents                    cloud                     dashboard
+--------------+     +----------------+     +-----------------+
|  machine a   | --> |                | <-- |                 |
|  machine b   | --> |   Firestore    | --> |  Next.js web    |
|  machine c   | <-- |                |     |  application    |
+--------------+     +----------------+     +-----------------+
                            |
                     +----------------+
                     | Firebase Auth  |
                     +----------------+
```

- **agent** — Python Windows service. monitors processes every 10s, sends heartbeats every 30s, reports metrics every 60s, executes commands, works offline.
- **dashboard** — Next.js 16 web app. real-time Firestore listeners, 63+ API endpoints, OpenAPI documentation.
- **firestore** — real-time NoSQL database. all data sync, command relay, and state management.
- **cortex ai** — LLM chat with tool-calling capabilities relayed through Firestore to agents.

## quick start

For a new maintainer cloning this repo, start with the [maintainer quickstart](docs/maintainer-quickstart.md).

### hosted (fastest)

1. create an account at [owlette.app](https://owlette.app)
2. create a **site** to organize your machines
3. download the agent installer from the dashboard
4. run the installer on your target Windows machine
5. a **3-word pairing phrase** appears — authorize it from the dashboard or your phone
6. your machine appears in the dashboard within 30 seconds

### self-host

**agent (Windows service):**
```bash
git clone https://github.com/theexperiential/Owlette.git
cd Owlette/agent
pip install -r requirements.txt
cd src && python configure_site.py       # pair this machine with a site
python owlette_service.py install && python owlette_service.py start
```

**desktop app (tray + configuration window):**
```bash
cd Owlette/desktop
npm install
npm run tauri dev                        # or: npx tauri build --no-bundle
```

**web dashboard:**
```bash
cd Owlette/web
npm install
cp .env.example .env.local               # configure Firebase credentials
npm run dev                               # http://localhost:3000
```

> **[full setup guide →](https://theexperiential.github.io/owlette/getting-started/)**

## screenshots

<div align="center">

<img src="web/public/dashboard.png" alt="owlette dashboard" width="100%"/>
<p><em>web dashboard — monitor machines, manage processes, deploy software</em></p>

<br/>

<img src="web/public/agent.png" alt="owlette agent" width="100%"/>
<p><em>Windows agent — system tray application with configuration GUI</em></p>

</div>

## tech stack

| component | technology |
|-----------|-----------|
| **dashboard** | Next.js 16, React 19, TypeScript, Tailwind CSS 4, shadcn/ui |
| **agent** | Python 3.9+, Windows service hosted by `owlette-host` (Rust), psutil, pywin32 |
| **desktop app** | Tauri 2 (Rust), React 19, TypeScript, Tailwind CSS 4 |
| **database** | Cloud Firestore (real-time NoSQL) |
| **auth** | Firebase Auth, WebAuthn/Passkeys, TOTP 2FA, device code pairing |
| **ai** | Anthropic + OpenAI via AI SDK, MCP tool-calling |
| **email** | Resend (branded dark-theme templates) |
| **hosting** | Railway (web), Firebase (backend) |

## documentation

full documentation is available at **[theexperiential.github.io/owlette](https://theexperiential.github.io/owlette/)**.

- [getting started](https://theexperiential.github.io/owlette/getting-started/) — first machine in under 5 minutes
- [agent guide](https://theexperiential.github.io/owlette/agent/) — installation, configuration, system tray, troubleshooting
- [dashboard guide](https://theexperiential.github.io/owlette/dashboard/) — monitoring, process management, views
- [remote deployment](https://theexperiential.github.io/owlette/dashboard/deployments/) — silent software installation across machines
- [project distribution](https://theexperiential.github.io/owlette/dashboard/roost/) — sync project files across your fleet
- [cortex ai & tools](https://theexperiential.github.io/owlette/reference/cortex-tools/) — AI capabilities and tool reference
- [API reference](https://theexperiential.github.io/owlette/api/reference/) — 63+ endpoints with OpenAPI docs
- [architecture](https://theexperiential.github.io/owlette/architecture/) — system design and data flow
- [authentication](https://theexperiential.github.io/owlette/reference/authentication/) — auth methods, device code pairing, tokens

## contributing

contributions are welcome! please open an issue or submit a pull request.

**guidelines:**
- fork the repo and create a feature branch from `dev`
- use [conventional commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, etc.)
- run tests before submitting: `cd web && npm test`
- use `node scripts/sync-versions.js X.Y.Z` for version bumps
- all PRs merge to `dev` first, then `dev` → `main` for production

**[open an issue →](https://github.com/theexperiential/Owlette/issues)**

## license

this project is licensed under the [Functional Source License, Version 1.1, Apache 2.0 Future License](LICENSE) (FSL-1.1-Apache-2.0). you may freely use, modify, and self-host owlette for any purpose other than a competing commercial product or service. two years after each release, that version automatically converts to Apache License 2.0.
