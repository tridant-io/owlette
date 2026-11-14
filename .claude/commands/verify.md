---
description: Two-axis review of finished work. Runs the checks, then a standards reviewer and a spec reviewer in parallel on the diff, and asks for evidence from where the owner will look. Use after /execute or /next, before a PR, or when the owner asks to verify, review or audit work.
---

Two reviewers, kept apart so neither masks the other: code can follow every convention and still build the wrong thing, or build the right thing in a way that breaks the conventions.

## 1. Pin the diff

The fixed point is whatever the owner named; otherwise `git fetch origin dev` and use `git merge-base HEAD origin/dev`. Record the diff command (`git diff <base>...HEAD`, three dots) and `git log --oneline <base>..HEAD`. Confirm the ref resolves and the diff is non-empty before going further.

## 2. Find the spec

In this order: the `dev/active/<task>/` folder for this work (plan.md Success Criteria, tasks.md "Done when" lines); issue numbers in the commit messages (`gh issue view <n>`); the owner's request in this conversation, quoted verbatim. If none exists, the spec axis reports "no spec available".

## 3. Run the checks for what the diff touches

- `web/`: `cd web && npx eslint <changed files> && npx tsc --noEmit && npx jest --bail`; for `web/**`, `firestore.rules` or `firebase.json`, run /preflight before any push.
- `agent/`: `agent/.venv/Scripts/python -m pytest agent/tests/ -q`
- `desktop/`: `cd desktop && npm run typecheck && npm run lint && npm test`
- `agent/host`: `cargo clippy --all-targets -- -D warnings && cargo test --locked` in that folder
- `.claude/`: `node scripts/check-claude-hooks.mjs`

## 4. Review on two axes

Spawn **code-architecture-reviewer** and **work-verifier** in one message, so they run in parallel. Give both the diff command and the commit list; give work-verifier the spec (path or quoted text). Wait for both.

## 5. Evidence from where the owner looks

For a user-facing change, verify it in the place the owner will see it (dev.owlette.app after the deploy, the installed agent, the desktop app) in the state they use (dark mode, their OS), and capture before/after: a screenshot or command output. If that hasn't happened, the report says "not verified in <target>"; it never says done.

## 6. Report

```
## Verification

### Checks
[each command: pass/fail, failing lines]

### Standards
[code-architecture-reviewer's report, verbatim or lightly cleaned]

### Spec
[work-verifier's report, verbatim or lightly cleaned]

### Evidence
[target, before/after, or "not verified in <target>"]

### Verdict: PASS / PASS WITH NOTES / FAIL
[findings per axis and the worst one in each; no merged ranking across axes]
```

On FAIL, list exactly what to fix. On PASS with a dev/active folder, suggest archiving it: `mv dev/active/[task-name] dev/completed/[task-name]`.
