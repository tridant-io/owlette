---
description: Run next wave of planned tasks in parallel with fresh context per task
---

Execute the next wave of tasks from the active plan. Each task runs in a **fresh agent context** to prevent context rot.

## Process

### Step 1: Load Plan

```bash
ls dev/active/
```

If multiple tasks exist, ask the user which one. Read `dev/active/[task-name]/tasks.md`.

### Step 2: Find Next Wave

Parse tasks.md and identify the next wave where ALL tasks are still unchecked (`- [ ]`). Skip waves that are fully complete (`- [x]`). If a wave is partially complete, execute only the remaining unchecked tasks in that wave.

If all waves are complete, report "All tasks complete. Run /verify to check the work." and stop.

### Step 3: Execute Wave

For each unchecked task in the wave, spawn a **task-executor** agent (it carries the execution rules) with a prompt that includes, copied verbatim from tasks.md:

```
## Task: [Task name]

**Files to read/modify**: [Files list]

**What to do**: [Do description]

**Success criteria**: [Done when]
```

**Spawn all agents for the wave in a single message** so they run in parallel.

### Step 4: Review Results

After all agents complete:
1. Review each agent's response for success/failure/blockers
2. If any agent reports a blocker, flag it to the user
3. Run a quick build check: `cd web && npx tsc --noEmit 2>&1 | head -20` and `agent/.venv/Scripts/python -m pytest agent/tests/ -x -q` when the wave touched agent/

### Step 5: Update Progress

Mark completed tasks in `dev/active/[task-name]/tasks.md`:
- Change `- [ ]` to `- [x]` for each successfully completed task
- Add a log entry with the date and what was completed
- Update the progress counter at the top

### Step 6: Report

```
## Wave [N] Complete

**Executed**: [X] tasks
**Succeeded**: [Y]
**Failed/Blocked**: [Z] (if any — list details)

**Build status**: [pass/fail]
**Progress**: [completed]/[total] tasks ([%])

Next: [description of next wave, or "All waves complete — run /verify"]
```

If there are more waves and no blockers, ask: **"Continue with Wave [N+1]?"**

## Rules
- NEVER execute tasks from different waves simultaneously — waves must run in order
- Each agent gets a FRESH context — include all necessary information in the prompt
- If a task fails, do NOT automatically retry — report the failure and let the user decide
- Do not skip the build check between waves
- If agents report conflicting edits to the same file, stop and flag it — the plan has a dependency error
