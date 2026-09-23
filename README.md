<div align="center">

<img src=".github/images/icon.svg" alt="owlette" width="120"/>

# owlette

### ai-powered fleet management for Windows applications

[![Version](https://img.shields.io/badge/version-3.3.6-blue)](https://github.com/tridant-io/owlette/releases)
[![License](https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-green)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)](https://owlette.app)

[live app](https://owlette.app) &nbsp;&bull;&nbsp; [documentation](https://owlette.app/docs) &nbsp;&bull;&nbsp; [download agent](https://owlette.app/download)

</div>

---

owlette is a cloud-connected system for monitoring, managing, and deploying software across fleets of Windows machines — from anywhere. a lightweight Python agent runs on each machine as a Windows service (hosted by a small Rust supervisor, `owlette-host`), reporting metrics and executing commands. a modern web dashboard gives you real-time visibility and control over your entire fleet, backed by Firebase and Cloud Firestore.

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

**hoot ai**
LLM-powered fleet management with natural language. AI executes commands on agents via tool-calling across 3 tiers — from read-only diagnostics to privileged operations. screenshot analysis, autonomous crash investigation, and multi-provider support (Anthropic + OpenAI).

**multi-site management**
organize machines by location, department, or project. three-tier role-based access control (member / admin / superadmin) with site-level permissions. multi-user accounts, per-site admin delegation, and platform-wide administrator roles.

**roost — project distribution**
drag a project folder onto the dashboard and it syncs to your fleet. files are split into 4 MiB content-addressed chunks, hashed in the browser, and uploaded once — re-deploys and machines that already hold a chunk skip it entirely. every deploy is an immutable version you can roll back to in one click, and agents verify every chunk by SHA-256 before assembling files atomically into an allowlisted destination.

roost is the only distribution system — the legacy by-URL path (point the fleet at a hosted ZIP and let the agent download and extract it) has been removed.

**alerts & notifications**
configurable threshold alerts for system metrics. email notifications with branded templates. webhook integrations for external platforms. activity logging across your entire fleet.

> **[full documentation →](https://owlette.app/docs)**

## architecture

control and state flow through Cloud Firestore — there is no direct connection between agents and the dashboard. Firestore acts as the message bus, with Next.js API routes handling authenticated control actions.

bulk file bytes do **not** go through Firestore. roost chunks and version bodies live in object storage (Cloudflare R2); browsers and agents read and write them directly using short-lived, single-object signed URLs minted by the API.

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

- **agent** — Python Windows service hosted by `owlette-host`. monitors processes every 5s, sends heartbeats + metrics on an adaptive interval (5s with the desktop window open, 30s while processes run, 120s idle), executes commands, works offline.
- **dashboard** — Next.js 16 web app. real-time Firestore listeners, a REST API with [OpenAPI documentation](https://owlette.app/docs/api).
- **firestore** — real-time NoSQL database. state sync, command relay, and roost version pointers.
- **object storage** — Cloudflare R2. content-addressed roost chunks and version bodies under a per-site prefix, reachable only through signed URLs.
- **hoot ai** — LLM chat with tool-calling capabilities relayed through Firestore to agents.

## quick start

### hosted (fastest)

1. create an account at [owlette.app](https://owlette.app)
2. create a **site** to organize your machines
3. download the agent installer from the dashboard
4. run the installer on your target Windows machine
5. a **3-word pairing phrase** appears — authorize it from the dashboard or your phone
6. your machine appears in the dashboard within 30 seconds

> **[full setup guide →](https://owlette.app/docs/getting-started)**

### self-host / develop from source

setting up the repo — toolchain, the agent's Python venv, local env files, and running the agent, desktop app, and dashboard from source — is covered in the **[maintainer quickstart](docs/maintainer-quickstart.md)**.

## screenshots

<div align="center">

<img src="web/public/dashboard.png" alt="owlette dashboard" width="100%"/>
<p><em>web dashboard — monitor machines, manage processes, deploy software</em></p>

</div>

## tech stack

| component | technology |
|-----------|-----------|
| **dashboard** | Next.js 16, React 19, TypeScript, Tailwind CSS 4, shadcn/ui |
| **agent** | Python 3.11, Windows service hosted by `owlette-host` (Rust), psutil, pywin32 |
| **desktop app** | Tauri 2 (Rust), React 19, TypeScript, Tailwind CSS 4 |
| **database** | Cloud Firestore (real-time NoSQL) |
| **auth** | Firebase Auth, WebAuthn/Passkeys, TOTP 2FA, device code pairing |
| **ai** | Anthropic + OpenAI via AI SDK, tool-calling |
| **email** | Resend (branded dark-theme templates) |
| **hosting** | Railway (web, with a Vercel standby behind Cloudflare load balancing), Firebase (Auth, Firestore, Cloud Functions), Cloudflare R2 (roost storage) |

## documentation

full documentation is available at **[owlette.app/docs](https://owlette.app/docs)**.

- [getting started](https://owlette.app/docs/getting-started) — first machine in under 5 minutes
- [agent guide](https://owlette.app/docs/agent) — installation, configuration, system tray, troubleshooting
- [dashboard guide](https://owlette.app/docs/dashboard) — monitoring, process management, views
- [remote deployment](https://owlette.app/docs/dashboard/deployments) — silent software installation across machines
- [roost](https://owlette.app/docs/dashboard/roost) — content-addressed project sync, versions, rollback
- [hoot tools](https://owlette.app/docs/reference/hoot-tools) — AI capabilities and tool reference
- [API reference](https://owlette.app/docs/api) — interactive OpenAPI reference
- [architecture](https://owlette.app/docs/architecture) — system design and data flow
- [authentication](https://owlette.app/docs/reference/authentication) — auth methods, device code pairing, tokens

## contributing

contributions are welcome! please open an issue or submit a pull request.

**guidelines:**
- fork the repo and create a feature branch from `dev`
- use [conventional commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, etc.)
- run the tests for what you changed before submitting — see the [maintainer quickstart](docs/maintainer-quickstart.md)
- use `node scripts/sync-versions.js X.Y.Z` for version bumps
- all PRs merge to `dev` first, then `dev` → `main` for production

**[open an issue →](https://github.com/tridant-io/owlette/issues)**

## license

this project is licensed under the [Functional Source License, Version 1.1, Apache 2.0 Future License](LICENSE) (FSL-1.1-Apache-2.0). you may freely use, modify, and self-host owlette for any purpose other than a competing commercial product or service. two years after each release, that version automatically converts to Apache License 2.0.
