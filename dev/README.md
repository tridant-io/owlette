# Development Task Tracking

This directory holds wave-based planning docs for the GSD-inspired task workflow
(see `.claude/CLAUDE.md` → "Task Workflow"). Most of it is gitignored working
state; only durable conclusions are committed.

## Structure

```
dev/
├── active/            # In-flight initiatives (gitignored; some plans are force-added and tracked)
│   └── [feature]/
│       ├── plan.md    # Strategic plan (waves, success criteria)
│       ├── context.md # Key files, decisions, integration points
│       └── tasks.md   # Wave-by-wave checklist
├── planned/           # Approved but not started (tracked)
├── completed/         # Archived finished/superseded initiatives (gitignored; some force-added)
├── handoff/           # Plan copies handed to another machine, e.g. the Mac (tracked)
├── scratch/           # Throwaway working files (gitignored)
├── video-tutorials/   # Tutorial video production pipeline (tracked)
├── findings-ledger.md # Whole-app review ledger: OWL-xx findings + triage state (local-only, gitignored)
└── codeql-triage.md   # CodeQL alert triage record
```

## Workflow

1. **`/plan`** — research the codebase, write `plan.md` / `context.md` /
   `tasks.md` into `dev/active/[feature]/`.
2. **`/execute`** — run the next wave of tasks in parallel (fresh agent context
   per task), or **`/next`** — execute the next single task in the current
   context.
3. **`/verify`** — run the checks, then a standards reviewer and a spec reviewer
   in parallel on the diff, plus evidence from where the owner looks.
4. **`/save`** — persist progress to the dev docs before context compaction;
   **`/resume`** — restore context in a new session.
5. When an initiative is fully shipped, move its folder to `dev/completed/`.

Use `/debug` for non-obvious bugs and `/build-and-fix` to build web + agent and
fix all errors. Skip `/plan` for single-file tweaks or small fixes.

## Conventions

- Keep `tasks.md` checkboxes and status headers honest — stale "in progress"
  headers on shipped work are how initiatives get re-audited months later.
- Raw agent transcripts/logs are scratch: they are gitignored and get deleted
  when an initiative is archived. Durable conclusions belong in commits (code,
  docs, an ADR) or a tracked plan. `findings-ledger.md` holds accepted-risk
  security triage, so it stays local and is never committed.
- One-off review dispatches live and die inside their initiative folder; do not
  create new loose folders at `dev/` root.

---

**Last Updated**: 2026-11-10
