---
description: Build both web and agent, then fix all errors
---

Build both projects and fix any errors found. Repeat until zero errors.

## Steps

1. **Build web** (TypeScript check):
   ```bash
   cd web && npx tsc --noEmit
   ```

2. **Build agent** (Python syntax check):
   ```bash
   agent/.venv/Scripts/python -m py_compile agent/src/*.py
   ```

3. If errors found:
   - Read the file, understand context, fix the error
   - Follow the frontend-dev-guidelines / backend-dev-guidelines skills
   - Fix root causes first — one fix may resolve multiple errors
   - Work in order: imports > syntax > types > logic

4. **Re-run builds** to verify. Repeat steps 3-4 until zero errors.

5. **Report results**:
   ```
   ## Build & Fix Complete
   - Web: X errors found, all fixed
   - Agent: Y errors found, all fixed
   - Files changed: [list]
   ```

If more than 20 errors, ask the user before proceeding — it may indicate a deeper issue.
