---
description: Research codebase and create wave-based implementation plan
---

You are planning a feature or task. Follow this process strictly.

## Phase 1: Research (Parallel Agents)

Before writing a single line of plan, **research the codebase**. Spawn 2-3 codebase-researcher agents in parallel:

1. **Existing patterns**: How similar features are implemented in this repo
2. **Affected code**: Read the files you'll need to modify; understand their current state
3. **Dependencies**: What code depends on what you're changing; what breaks if you get it wrong

Also check:
- `git log --oneline -20` for recent related work
- Relevant skills in `.claude/skills/` for domain-specific patterns
- Firestore data structure implications (if applicable)

Do NOT skip research. Do NOT plan from memory. Read the code first.

## Phase 2: Plan

Synthesize research into a plan with these sections:

### Summary
2-3 sentences: what you're building and why.

### Approach
- Architecture and data flow
- Integration points with existing code
- Key technical decisions with rationale

### Waves
Break ALL work into **waves** — groups of tasks that can run in parallel. Tasks within a wave have no dependencies on each other. Each wave depends on all previous waves completing first.

**Critical rule**: Tasks in the same wave must NOT modify the same files. If two tasks touch the same file, put them in different waves.

For each task:
- **Files**: Exact paths to create or modify
- **Do**: Enough detail that a fresh agent with NO conversation context could execute this task by reading only the task description and the referenced files
- **Done when**: Concrete, verifiable success criteria

Keep tasks atomic — one concern per task, clear boundaries. Include testing tasks within the waves (not as a separate afterthought).

### Risks
Non-obvious things that could go wrong. Skip if straightforward.

### Success Criteria
How do we know the whole feature is done and correct?

## Phase 3: Present & Confirm

Present the plan and ask: **"Ready to create the task files, or changes needed?"**

Do NOT proceed to file creation until the user approves.

## Phase 4: Create Files

After approval, create files in `dev/active/[task-name]/` (use kebab-case for task-name):

### 1. `plan.md`
```markdown
# [Feature] — Plan
**Created**: [date] | **Status**: Active

[Full plan content from Phase 2]
```

### 2. `tasks.md`
```markdown
# [Feature] — Tasks
**Progress**: 0/N complete

## Wave 1: [Short Description]

- [ ] **Task 1.1: [Name]**
  - Files: `path/to/file.ts`, `path/to/other.py`
  - Do: [Self-contained description — enough for a fresh agent]
  - Done when: [Verifiable success criteria]

- [ ] **Task 1.2: [Name]**
  - Files: ...
  - Do: ...
  - Done when: ...

## Wave 2: [Short Description]

- [ ] **Task 2.1: [Name]**
  - Files: ...
  - Do: ...
  - Done when: ...
  - Depends on: Task 1.1, Task 1.2

[...more waves as needed...]

## Log
### [date]
- Plan created, ready for execution
```

### 3. `context.md`
```markdown
# [Feature] — Context
**Last updated**: [date]

## Key Files
[All files involved, grouped by create/modify]

## Decisions
[Numbered list of key technical decisions + rationale]

## Next Steps
[What to do first when starting execution]
```

Report completion:
```
Plan created in dev/active/[task-name]/
- plan.md: Full implementation plan
- tasks.md: N tasks across M waves
- context.md: Key context and decisions

Run /execute to start wave-based execution, or /next to work through tasks one at a time.
```

## Rules
- Research FIRST, plan SECOND — never plan from assumptions
- Tasks must be self-contained: a fresh agent reading only the task description and referenced files should be able to execute it
- Wave ordering must respect dependencies — independent tasks in the same wave, dependent tasks in later waves
- Consider both web/ and agent/ if the feature spans both
- Don't over-plan trivial work — if it's < 3 tasks, one wave is fine
- Be specific: exact file paths, concrete actions, not vague descriptions
