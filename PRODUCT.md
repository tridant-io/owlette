# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

two primary users, served equally. neither outranks the other:

- **creative technologists**: the people who build and look after experiential installations (TouchDesigner, media servers, show computers). they know one machine deeply and get the 3am call when it dies.
- **fleet ops / IT**: teams running many unattended signage and kiosk screens across locations with no on-site staff. they need to see the whole fleet at once and act on many machines together.

the job they share is keeping software running on machines nobody sits in front of, and fixing them remotely when it stops. they respond to failures at any hour and often from a phone: pairing can be authorized "from the dashboard or your phone".

## Product Purpose

owlette is a cloud-connected system for monitoring, managing and deploying software across fleets of unattended Windows, macOS and Linux machines. a lightweight agent runs on each machine as a system service. it watches processes every 5 seconds, restarts crashes, reports metrics and runs commands. the web dashboard gives real-time visibility and control over the whole fleet.

success means the installation stays up, and when it doesn't, the operator finds out first and fixes it without travelling to the machine.

## Positioning

**one agent closes the whole loop.** a single outbound-only agent covers monitoring, auto-recovery, deployment (roost), remote control (swoop) and automation (talons). each neighbouring product covers only a slice of that. the claim is the combination.

**AI that acts.** hoot investigates and operates machines through tool-calling, in three tiers from read-only diagnostics to privileged operations. it is not a chat window over metrics.

## Operating Context

- **web dashboard** (owlette.app; dev.owlette.app is the dev environment): real-time fleet view, machine detail, process management, deployments, roost, hoot, logs, alerts, admin. used on desktop browsers and on phones.
- **desktop tray app** (`desktop/`, Tauri) on each managed machine: the local UI for config, processes and site membership. it uses the same design system as the web dashboard.
- **pairing**: an installer shows a 3-word pairing phrase, which is authorized from the dashboard, from a phone, or passed silently (`/ADD=<phrase> /SILENT`) for bulk installs.
- **organization**: sites (by location, department or project) hold machines. roles are member, admin and superadmin, with site-level permissions.
- **public and developer surfaces**: landing page, docs at `/docs`, OpenAPI reference at `/docs/api`, machine-facing `/llms.txt` and `/for-ai`, the REST API with scoped keys, the `@owlette/cli` CLI and the TypeScript SDK.
- **out-of-app touchpoints**: alert emails (branded templates via Resend) and webhooks.

## Capabilities and Constraints

- **terminology** (feature names are always lowercase): **site**, **machine**, **process**, **roost** (content-addressed project distribution with immutable versions and one-click rollback), **hoot** (the built-in AI assistant, a feature of owlette rather than a separate product), **swoop** (remote control / KVM), **talons** (automations: trigger, condition, outputs, with AI visual checks), **pairing phrase**.
- **capabilities**: live CPU/memory/disk/GPU/network metrics; crash detection and auto-recovery; remote screenshots and live view; silent software deployment (NSIS, Inno Setup, MSI, custom); display topology management with auto-revert; threshold alerts, email and webhooks; activity logs; passkeys and TOTP 2FA.
- **agent platforms** (checked against the live API on 2026-10-01): owlette.app (prod) serves only the Windows installer, 3.3.7. dev serves 4.0.6 for Windows, macOS (Apple silicon, macOS 15+) and Linux (Ubuntu 24.04). `web/lib/product-facts.ts` still says Windows-only. public claims must match what prod actually serves, so the macOS/Linux claim waits for the dev→prod promotion.
- **architecture constraints**: there is no direct link between agent and dashboard; Firestore is the message bus. the agent connects outbound on port 443 only, with no inbound ports or VPN, and keeps recovering locally while offline.
- **unattended by definition**: nothing on a managed machine may demand a human. no unattended UAC prompts, no dialogs that block recovery.
- **status and pricing**: in beta and free during beta. tier prices and the founders rate are single-sourced in `web/lib/product-facts.ts`, and every surface composes from it. `docs/roadmap.md` quotes older numbers and is not the authority.
- **license**: FSL-1.1-Apache-2.0.

## Brand Commitments

- the name is **owlette**, always lowercase. the maker is Tridant ("a tridant system", tridant.io).
- all user-facing copy is lowercase. the exceptions are acronyms, proper nouns, code identifiers and user-entered strings.
- the owl-themed feature names (roost, hoot, swoop, talons) stay lowercase everywhere.
- voice: watchful, terse, a little wry, never cute at the expense of clarity. the reference is the rotating hero headlines in `web/lib/heroHeadlines.ts` ("awake at 3am", "the night shift", "no blind spots"). each one reads as a promise above "owlette keeps your installations running 24/7".
- mark: the owlette eye (`web/public/owlette-eye.svg`, `.github/images/icon.svg`, `desktop/public/owlette-eye.svg`).

## Evidence on Hand

- **product screenshots**: `web/public/*.png` (dashboard, deployments, control, monitor, logs, cortex), `web/public/landing-screens/`, and `web/public/docs-screens/` (machine card and detail, process management, roost, webhooks, email alerts, agent tray states).
- **shipped proof claims** (`web/components/landing/ProofStrip.tsx`): ~10s auto-recovery; runs offline and syncs on reconnect; no inbound ports, outbound 443 only.
- **docs and reference**: `web/content/docs`, `web/openapi.yaml`, `docs/changelog.md`.
- **absent, so never fabricate**: customer testimonials, logos, case studies, user or machine counts, uptime figures and third-party benchmarks.

## Product Principles

1. **two users, one tool.** every surface has to work for the person debugging one show machine and for the team watching a hundred screens. depth must not cost scale, and scale must not cost depth.
2. **the loop is the product.** monitor, recover, deploy, control and automate should hand off to each other: from a crash to a live view, from a metric to a hoot investigation, from a version to a rollback. no feature should be a dead end.
3. **AI acts in the open.** hoot operates real machines. what it can do is tiered, what it did is visible, and privileged actions are gated.
4. **nobody is at the machine.** design for the operator who is somewhere else, often at night, often on a phone. everything must be doable remotely, and nothing on the machine may wait for a person.
5. **honest claims.** beta is labelled beta, prices come from one source, platform claims match what prod serves, and proof is only what we actually have.
