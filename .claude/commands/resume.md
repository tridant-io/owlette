---
description: "Load the active plan's context, tasks and plan from dev/active/ and report where the work stands. Use at the start of a session when the owner says resume, pick up where we left off, continue the plan or where were we."
---

Load dev docs and resume implementation from where you left off.

## Process

### Step 1: Find Active Task

```bash
ls dev/active/
```

If empty: "No active dev docs found." and stop.
If multiple: list them with progress from each tasks.md, ask which to resume.

### Step 2: Load All Three Files

Read in this order:
1. `dev/active/[task-name]/context.md` — **read "Next Steps" first** — this was written specifically for this moment
2. `dev/active/[task-name]/tasks.md` — current progress and remaining work
3. `dev/active/[task-name]/plan.md` — full plan for reference

### Step 3: Report State

```
## Resuming: [Feature Name]

**Progress**: [X]/[Y] tasks ([Z]%)
**Last updated**: [date from context.md]

### Completed
- [x] Task 1.1: [name]
- [x] Task 1.2: [name]

### Next Up
- [ ] Task 2.1: [name] — [brief from context.md next steps]
- [ ] Task 2.2: [name]

### Key Context
- [Important decisions or discoveries from context.md]
- [Any blockers or notes]

Ready to continue. Run /next for the next task, or /execute for the next wave.
```

### Step 4: Proceed

If the path forward is clear from "Next Steps", ask if the user wants to continue. Otherwise ask what to work on next.
