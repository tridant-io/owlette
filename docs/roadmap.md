# owlette roadmap

Roughly prioritized. Not a commitment — just a living list of what's next.

---

## next up — right after swoop on macOS ships

- **native swoop viewer (#325): landed on dev** as owlette swoop, the desktop viewer app (ADR 0012); still owed: Windows key capture, a published standalone download (`/download/swoop-viewer` points at the docs until then), a session tried on Linux, the viewer's HEVC check fixed for WebKit, and full-size cursor bitmaps from the streamer so the cursor is sharp.

- **hoot drives a machine through swoop.** *Extremely important: the owner's pick for the sprint that follows
  swoop on macOS (2026-09-30).* With an admin's explicit authorization, hoot sees a machine's screen and sends it
  clicks and keys through the swoop streamer, so it can operate any app on the machine, not only the processes
  owlette manages. Swoop already has what this needs on Windows and macOS: screen capture, input injection, the
  machine's own permission model (Screen Recording and Accessibility on a Mac), and an agent that starts the
  streamer on demand. The shape to design: hoot as a special viewer in a swoop session or a local API on the
  streamer; screenshots on request rather than video; actions as structured calls (click at, type, key chord,
  scroll). The rules decide whether it is safe, so they are in the plan from the start:
  - off by default, enabled per machine by an admin, and revocable;
  - a visible indicator on the machine while hoot is in control, and a one-click stop there and in the dashboard;
  - every action logged with the user who authorized the session;
  - limits hoot cannot lift itself: no passkey step-up on its own, no change to its own authorization.

  Plan it with `/plan` as its own initiative once swoop on macOS (`dev/active/swoop-macos`) is released.

---

## infrastructure / ops

- **Log TTL** — site event logs (`sites/{id}/logs`) and machine logs (`machines/{id}/logs`) have no expiry. Add a cleanup cron to delete entries older than 30-90 days. Low urgency (negligible cost), good hygiene.

- **Reduce single-points-of-failure across the stack.** 2026-05-19 Railway platform outage took both `owlette.app` and `dev.owlette.app` offline simultaneously — *every* API route returned 404, agents went into deep token-refresh backoff, and customers had no operational dashboard. Audit each vendor relationship for what happens when they go down, then prioritize the cheapest reductions in blast radius. Specific lines to think through:
  - **Hosting (Railway)** — currently the entire web app. Cheapest improvement: have a static-fallback page (Cloudflare Worker?) at `owlette.app` that explains the outage + links to a status page, instead of leaving Railway's "Application not found" as the customer-facing message. Bigger move: practice a portability test — can the Next.js app build + deploy on Vercel or Fly.io as a warm standby? No need to dual-deploy continuously, just verify the runbook works.
  - **Firestore + Firebase Auth (GCP)** — agent → web auth flow assumes Firebase. A hard GCP outage is rare but total. Mitigation here is architectural and expensive (multi-cloud identity); document as accepted-risk for now but think about it before scale.
  - **DNS (current provider unknown — Cloudflare?)** — if DNS goes, everything goes. Lowest-hanging fruit: confirm we have a secondary DNS provider configured for `owlette.app` (e.g. Cloudflare + AWS Route 53 on the same zone).
  - **Cron-job.org** — schedules the prod `/api/cron/*` endpoints (see `docs/runbooks/manual-infrastructure.md`). Free-tier, no SLA. If it dies silently we lose health alerts and status pings until manual recovery. Mirror critical schedules on a second provider (GitHub Actions cron is free and reliable) or migrate to Cloudflare Workers cron triggers (also free, better SLA).
  - **Cloudflare R2 + email-decoding edge feature** — R2 is the only object store for roost. Outage = no new content syncs to agents. Recovery design (re-sync from agent local cache) is in scope already, but verify the SLO is right.
  - **Resend (transactional email)** — outage = no alerts delivered. Multi-provider fallback (Postmark / SES as backup) is feasible.
  - **Sentry + Instatus** — observability outages don't take prod down but degrade incident response. Multi-region or self-hosted alternatives possible.

  Action: cut a follow-up issue tagging each line above with effort + value, then schedule one quarter per release window. The goal isn't five-9s — Owlette is fundamentally a control-plane for unattended machines, and a Railway outage means customers can't issue *new* commands but existing agents keep running their workloads. So the bar is "graceful degradation + clear customer comms during outages," not "100% uptime."

---

## notifications

- **SMS alerts** — email is live. SMS (via Twilio or similar) is the main gap vs sudoSignals Standard tier.

---

## observability

- **Process reports** — weekly/monthly uptime and crash summaries per machine or site, delivered by email.

---

## support

- **Send logs** — "Send logs to Owlette" button on the agent tray/GUI that pushes recent agent logs to Firestore, viewable in the dashboard. Eliminates back-and-forth asking users to find log files.
- **In-app chat** — embed a support chat widget (Intercom, Crisp, or Plain) in the web dashboard. Automatically attach user + machine context so support has full visibility without asking.

---

## testing

- **Cortex API route tests** — complex async flows (tool execution, streaming, conversation management). Needs mocking for SSE streams and tool call chains.
- **Alert system tests** — email dispatch + webhook dispatch for process crash alerts and threshold breaches. Mock external HTTP calls, verify retry logic.
- **Screenshot API tests** — storage CRUD, concurrent upload handling, history cleanup. Low risk, good for expanding coverage.
- **Agent service main loop tests** — `owlette_service.py` (4400 lines). Needs integration testing framework with mocked Firestore + psutil. Large effort, high value.
- **React component/hook tests** — hooks (`web/hooks/`), pages, contexts. Requires React Testing Library + Firebase context providers.
- **E2E tests** — Playwright for critical user flows (login, add machine, dashboard). Requires test Firebase project with seeded data.

---

## billing

- **Stripe integration** — two tiers behind a unified 14-day free trial (no card to start; existing beta orgs join the same clock at go-live): core at $10/machine/month (single site, no API), pro at $50/machine/month with a 3-machine minimum (unlimited sites, public API + CLI + SDK + webhooks, roost with 1 TB included storage per site, $0.05/GB overage). Metered billing keyed off active machine count + per-tier flag on each site doc. See `dev/active/billing-system/plan.md` for the implementation track.
- **Usage dashboard** — show machine count, current tier, projected bill, and roost storage usage vs cap in account settings.
