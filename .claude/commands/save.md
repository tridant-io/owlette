---
description: "Write this session's progress, decisions and next steps into the active plan's files in dev/active/, so a fresh session can pick the work up. Use when the owner says save, save progress, checkpoint or hand off, before stopping in the middle of a plan, or when the context is about to be compacted."
---

Save current progress to dev docs so work can resume seamlessly in a fresh session.

## Process

### Step 1: Find Active Task

```bash
ls dev/active/
```

If no active task exists, report "No active dev docs — nothing to save." and stop.

### Step 2: Update tasks.md

In `dev/active/[task-name]/tasks.md`:

1. Mark completed tasks with `[x]` (if not already marked)
2. Add any **new tasks discovered** during implementation
3. Update the progress counter
4. Add a log entry:
   ```
   ### [date]
   - Completed: [list tasks finished this session]
   - In progress: [current task, % done if applicable]
   - Discovered: [any new tasks added]
   - Next: [what to do when resuming]
   ```

### Step 3: Update context.md

In `dev/active/[task-name]/context.md`:

1. Add new **architectural decisions** made this session
2. Update **Key Files** with any new files created/modified
3. Rewrite **Next Steps** to reflect current state — this is the most important section for resuming
4. Add any **important discoveries** or gotchas found during implementation
5. Update timestamp

### Step 4: Update plan.md (only if approach changed)

If the implementation approach diverged significantly from the plan, add at the bottom:
```
## Plan Updates
### [date]
- Changed: [what changed and why]
- Impact: [how this affects remaining work]
```

### Step 5: Confirm

```
Progress saved to dev/active/[task-name]/
- [X]/[Y] tasks complete ([Z]%)
- Next steps written to context.md

Safe to compact. Resume with /resume.
```

## What to Capture
- Completed tasks, new tasks, decisions made, files changed, blockers, next steps
- Be specific in "Next Steps" — future you has zero context

## What NOT to Capture
- Code snippets (the code is in the files)
- Routine details (focus on decisions and state)
