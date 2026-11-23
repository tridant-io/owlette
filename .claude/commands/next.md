---
description: "Do the next unchecked task of the active plan in dev/active/ in this context, one task at a time, and tick it off. Use when the owner asks for the next task, wants to step through a plan and look at each result, or the plan is too small for parallel agents."
---

Execute the next uncompleted task from the active plan. Unlike /execute (which runs full waves in parallel), this runs one task at a time in the current context.

## Process

### Step 1: Load Plan

```bash
ls dev/active/
```

If multiple tasks exist, ask the user which one. Read `dev/active/[task-name]/tasks.md`.

### Step 2: Find Next Task

Find the first unchecked task (`- [ ]`) in the lowest incomplete wave. Display it:

```
## Next Task: [Task N.M — Name]
Wave [N] | Task [M] of [total in wave]

**Files**: [file list]
**Do**: [description]
**Done when**: [criteria]

Proceeding...
```

If all tasks are complete, report "All tasks done. Next: tridant:verify to check the work." and stop.

### Step 3: Execute

1. Read every file listed in the task's **Files** field
2. Execute the task as described in **Do**
3. Verify against **Done when** criteria

### Step 4: Update Progress

In `dev/active/[task-name]/tasks.md`:
- Change the task's `- [ ]` to `- [x]`
- Update the progress counter
- Add a log entry

### Step 5: Report

```
Task [N.M] complete. [brief summary of what was done]
Progress: [X]/[Y] tasks ([Z]%)
Next up: [Task N.M+1 name] — run /next to continue
```

## When to Use /next vs /execute
- **/next**: Small-to-medium features, when you want to review each task's output before proceeding
- **/execute**: Large features with many independent tasks, when you want maximum throughput
