# legal + production-readiness — tasks
**Progress**: 0/5 (deferred — cost-gated)

five production-readiness items deferred from `dev/active/project-distribution-v2/`. revive when funding is available. see [context.md](context.md) and [plan.md](plan.md).

---

## phase 1 — external procurement (when revived)

- [ ] **Task 1.1: lawyer engagement** [user]
  - **Originally**: `dev/active/project-distribution-v2/tasks.md` wave 0.1
  - **Cost**: $3-8k retainer
  - **Lead time**: 2-4 weeks for first draft
  - Do: engage startup-focused firm (cooley go / gunderson / fractional gc) for tos + privacy + aup + dmca policy as a coherent package.
  - Done when: signed engagement letter; first draft tos in review.

- [ ] **Task 1.2: insurance** [user]
  - **Originally**: `dev/active/project-distribution-v2/tasks.md` wave 0.3
  - **Cost**: $1.5-5k/yr at seed stage
  - **Lead time**: days after policy quoted
  - Do: tech e&o + cyber + media liability rider. vouch / embroker / coalition recommended brokers.
  - Done when: policies bound, certificate of insurance on file.

- [x] **Task 1.3: EV code-signing cert procurement** [dropped]
  - **Originally**: `dev/active/project-distribution-v2/tasks.md` wave 0.7
  - Not needed: owlette signs with tridant's Azure Artifact Signing account (2026-11-02). see "code signing context" in `docs/runbooks/agent-installer-release.md`.

- [ ] **Task 1.4: OFAC sanctions screening** [autonomous after vendor pick]
  - **Originally**: `dev/active/project-distribution-v2/tasks.md` wave 0.4
  - **Cost**: $100-500/mo (vendor) + ~1 day engineering integration
  - **Lead time**: days after vendor account created
  - **Required when**: any public signup form is opened. internal-only / invite-only operation can defer indefinitely.
  - Do: pick vendor (complyadvantage or sanctions.io). create account + obtain api credentials. integrate into signup flow — check email domain + ip geolocation against OFAC sanctioned countries (cuba, iran, north korea, syria, crimea, plus comprehensive lists). block matches with 403 + clear message.
  - Done when: integration live; test signup from blocked country returns 403 with clear message; sanctioned-entity match also returns 403.

---

## phase 4 — engineering

- [x] **Task 4.1: authenticode signing in build pipeline** [done differently]
  - **Originally**: `dev/active/project-distribution-v2/tasks.md` wave 5.9
  - `OWLETTE_SIGN=1` in `agent/build_installer_full.bat`, and CI on a `v*` tag. no certificate to store. no signature grants day-one SmartScreen trust, so "no warning on first download" is not a criterion any more.

---

## log

### 2026-04-26
- Plan created. Four items moved from `dev/active/project-distribution-v2/` (waves 0.1, 0.3, 0.7, 5.9) into this dedicated planned-but-not-started bucket. Reason: cost-gated, no funding currently. Roost v2 internal launch can proceed without these. External customer launch is blocked until all four land. Adjacent `dev/planned/status-page/` is also cost-gated; ideally revive together. EV cert is the longest external lead time at 6-8 weeks — that's the critical-path item when funding arrives.
- **2026-04-26 update**: added Task 1.4 (OFAC sanctions screening, originally wave 0.4) — also cost-gated at $100-500/mo for vendor (complyadvantage / sanctions.io). Required only when a public signup form opens; internal/invite-only operation can defer indefinitely. Bundled here so all compliance-gated items live in one plan.
