---
description: Root-cause a bug by first building one command that reproduces it red, then fixing it under a regression test and proving the fix where the owner saw the bug. Use when something is broken, still broken, throws, crashes, hangs, regressed, is slow, shows the same error again, or the owner says debug or fix this.
---

A theory before a reproduction is the failure this command exists to prevent. If you catch yourself reading code to build a theory and you have no red command yet, stop and go back to step 1.

Redact before you show anything: tokens, API keys and `x-api-key` values become `<REDACTED>` (CLAUDE.md: never log OAuth tokens, not even partially). Build loops against env vars so secrets stay out of the command line.

## 1. Build a red loop

This is the whole job; the rest is mechanical. Find one command that goes red on **this** bug, roughly in this order:

1. A failing test at the seam that reaches the bug: `cd web && npx jest <path>`, `agent/.venv/Scripts/python -m pytest agent/tests/<file>`, `cd web && npm run e2e -- <spec>` (Playwright on the emulators), `cargo test` in `agent/host`, `cd desktop && npm test`.
2. `curl` against the running dev server or `$OWLETTE_DEV_API_URL` (read-only GETs; key in `.claude/.env.local`, header `x-api-key`; curl, not python urllib).
3. A Playwright script that drives the real page and asserts on DOM, console or network, in the state the owner uses (dark mode, their viewport, their browser).
4. The installed agent: `C:\ProgramData\Owlette\logs`, or `owlette_runner.py --debug` (see CLAUDE.md Build Commands).
5. A replay of a captured payload (a Firestore doc, a command, a request body) through the code path in isolation.
6. `git bisect run <loop>` when the bug appeared between two known states; a differential run (old build vs new) when outputs drift.
7. Last resort, a step only the owner can perform: ask for all of it in one message, with the exact clicks and what to send back, never one step at a time.

Then tighten it: faster (narrow the scope), sharper (assert the exact symptom, not "didn't crash"), deterministic (pin time, seed randomness). For an intermittent bug, raise the reproduction rate (loop it, add load) until it fails often enough to debug.

**Done when** you have run one command at least once and shown its red output, and it asserts the owner's exact symptom (not a nearby failure), gives the same verdict every run, takes seconds, and runs without a human. If you cannot build one, say so, list what you tried, and ask for the access or captured artifact you need. Do not hypothesise without it.

## 2. Minimise

Cut inputs, config, data and steps one at a time, re-running the loop after each cut. **Done when** removing any remaining piece turns the loop green.

## 3. Hypothesise

Write 3-5 ranked, falsifiable hypotheses: "if X is the cause, changing Y makes the loop go green". Show the list to the owner and keep going; they may re-rank it from what they know. Test one variable at a time. If the top three are all eliminated, go back and re-observe rather than inventing a fourth.

## 4. Instrument

A debugger or targeted logs at the boundaries that separate the hypotheses. Tag every debug line `[DEBUG-xxxx]` (one random tag per session) so cleanup is one grep. For a performance bug, measure a baseline first and bisect; logs mislead there.

## 5. Fix under a regression test

1. Turn the minimised repro into a failing test at a seam that exercises the real bug pattern. If no such seam exists, that is a finding: say so in the report rather than writing a shallow test that would pass anyway.
2. Watch it fail. If you forced the red by mutating code or a fixture, diff against a clean copy to prove the mutation landed.
3. Apply the smallest fix for the root cause. Watch the test pass.
4. Re-run the step 1 loop against the original, un-minimised scenario.
5. Check it where the owner saw it: dev.owlette.app after the deploy, the installed service, the desktop app, the same theme and OS state. A local or headless pass alone is not "fixed".

## 6. Clean up and report

- [ ] the original loop is green, and the regression test passes (or the missing seam is reported)
- [ ] `grep -r "DEBUG-xxxx"` comes back empty; throwaway scripts are deleted
- [ ] the commit message states the confirmed cause

```
## Debug complete
**Symptom**: [the owner's words]
**Loop**: [the command] — red before, green after (output excerpts)
**Root cause**: [the confirmed hypothesis and the evidence that confirmed it]
**Fix**: [what changed and why]
**Verified where the owner looks**: [target + before/after evidence, or "not verified in <target>"]
```

Changes beyond the bug go in the report as follow-ups, not into the fix.
