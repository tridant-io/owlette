---
name: testing-guidelines
description: "How Owlette is tested and how to run each suite: web Jest, Playwright e2e on the Firebase emulators (npm run e2e), Firestore rules tests (npm run test:rules), agent pytest via agent/.venv, integration tests against dev.owlette.app, and the mocks and fixtures to reuse. Use when writing, adding or running tests, e2e, a failing or flaky test, coverage, mocks, CI test failures, or checks before a push."
---

# Testing Guidelines

**Applies To**: `web/` (Jest, Playwright), `agent/` (pytest), `test/integration/` (integration)

---

## Quick Reference — Run Commands

```bash
# Web unit tests (the whole jest suite, runs locally, no credentials needed)
cd web && npm test

# Web e2e — Playwright against the Firebase emulators (the CI gate for web, functions and Firebase config changes)
cd web && npm run e2e

# Firestore rules tests (boots its own emulator on :8080 — never run alongside e2e)
cd web && npm run test:rules

# Agent tests (from the repo root; macOS/Linux: agent/.venv/bin/python)
agent/.venv/Scripts/python -m pytest agent/tests/

# Integration tests (hits real dev.owlette.app, needs .env.test)
cd test/integration && python -m pytest -m api -v
```

Before pushing web changes, run `/preflight`: security alerts, lint, typecheck, unit, rules and e2e, in the order CI runs them. The commit/push hook (`.claude/hooks/pre-commit-check.mjs`) runs `tsc --noEmit` + the whole jest suite for web edits, and `py_compile` + `pytest agent/tests/ -x` for agent edits.

---

## Test Layers

| Layer | Location | Framework | What it tests | Credentials |
|-------|----------|-----------|---------------|-------------|
| **Web unit** | `web/__tests__/` (`api/`, `lib/`, `components/`, `hooks/`, `app/`, ...) | Jest | Route handlers, libs, components and hooks with mocked Firebase | None |
| **Rules** | `web/__tests__/rules/` | Jest + Firestore emulator | `firestore.rules` allows and denies | None |
| **E2E** | `web/e2e/specs/` | Playwright + Firebase emulators | Critical user flows in a real browser | None |
| **Agent** | `agent/tests/` (`unit/`, `integration/`, `lifecycle/`) | pytest | Agent modules with mocked HTTP/Firestore | None |
| **Integration** | `test/integration/api/` | pytest + requests | Real endpoints on dev.owlette.app | API key required |

New user-facing web behaviour ships with an e2e test.

---

## Web Testing (Jest)

### Run Commands
The scripts are in `web/package.json` (`test`, `test:watch`, `test:coverage`, `test:rules`, `e2e*`). One file: `npx jest __tests__/api/sites-machines-processes.test.ts`.

### Config
- `web/jest.config.js` — uses `next/jest`, `@/` alias works in tests
- `web/jest.setup.js` — loads jest-dom, mocks the app's `./lib/firebase` module to nulls, sets client and server env vars, and leaves `UPSTASH_*` empty so rate limiting is off
- `web/jest.rules.config.js` — the rules suite

### Mocks

**Firebase Client SDK** (`web/__mocks__/firebase.ts`) — for component/hook tests:
```typescript
import {
  mockGetDoc, mockSetDoc, mockOnSnapshot,
  createMockDocSnapshot, createMockQuerySnapshot, createMockUser,
  resetAllMocks
} from '@/__mocks__/firebase';
```

**Firebase Admin SDK** (`web/__mocks__/firebase-admin.ts`) — for API route tests:
```typescript
import {
  mockDbGet, mockDbSet, mockDbUpdate, mockDbDelete,
  mockRunTransaction, mockVerifyIdToken,
  mockGetSignedUrl, mockFileExists, mockGetMetadata,
  resetAdminMocks
} from '@/__mocks__/firebase-admin';
```

### API Route Test Pattern

Copy the nearest existing test for the route family (`web/__tests__/api/`). They share this shape (from `sites-machines-processes.test.ts`):
```typescript
/** @jest-environment node */
import { NextRequest } from 'next/server';

// Strip rate limiting
jest.mock('@/lib/withRateLimit', () => ({ withRateLimit: (handler: unknown) => handler }));
// Silence logs
jest.mock('@/lib/logger', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }, __esModule: true }));
// Mock the auth gate (override per test for 401/403 cases)
jest.mock('@/app/api/_shared', () => ({ requireMachineAuthAndScope: ..., applyAuthDeprecations: (r: unknown) => r }));
jest.mock('@/lib/apiAuth.server', () => ({ ... }));
// Mock firebase-admin (configure per test)
jest.mock('@/lib/firebase-admin', () => ({ ... }));
```
`@sentry/nextjs` and `@/lib/auditLogClient` are the other common mocks.

---

## E2E Testing (Playwright)

- **Prereqs** (once): JDK 21 on PATH, `npm i -g firebase-tools@15`, `cd web && npx playwright install chromium --with-deps`.
- `npm run e2e` builds the app, starts the Auth :9099 / Firestore :8080 / Storage :9199 emulators, serves the app on :3100, and runs `web/e2e/specs` on chromium and mobile-chromium. Report: `web/e2e/.output/report/`.
- Variants: `e2e:ui`, `e2e:functions`, `e2e:desktop-sync`. Full guide: `web/e2e/README.md`.
- CI: the `playwright e2e` workflow (`.github/workflows/e2e.yml`) runs on PRs and on pushes to `dev`/`main` touching `web/**`, `functions/**`, `firestore.rules`, `firestore.indexes.json`, `storage.rules` or `firebase.json`, alongside the rules tests and the lint/types/unit job.

## Rules Testing

`npm run test:rules` runs jest over `web/__tests__/rules/*.test.ts` against a Firestore emulator. It is the only regression gate on `firestore.rules`: run it whenever the rules or those tests change.

---

## Agent Testing (pytest)

### Run Commands
```bash
powershell -File scripts/bootstrap-windows.ps1 -InstallAgentDeps        # first time: agent/.venv + requirements*.txt
agent/.venv/Scripts/python -m pytest agent/tests/                       # everything (what the commit hook runs)
agent/.venv/Scripts/python -m pytest agent/tests/unit/test_connection_manager.py   # single file
agent/.venv/Scripts/python -m pytest agent/tests/ --cov=agent/src       # with coverage
agent/.venv/Scripts/python -m pytest agent/tests/ -m "not windows"      # skip Windows-specific
```

### Config: `agent/pytest.ini` (`--strict-markers`; warnings are errors except UserWarning/DeprecationWarning), fixtures in `agent/tests/conftest.py`

### Available Fixtures (`conftest.py`)
```python
mock_config              # Standard config dict with processes[]
mock_firebase_credentials  # Mock service account
mock_firestore_db        # MagicMock Firestore client
mock_firebase_app        # MagicMock Firebase app
mock_system_metrics      # CPU/memory/disk/GPU/processes dict
```

### Custom Markers
```python
@pytest.mark.windows     # Windows-only (conftest auto-skips it on other platforms)
@pytest.mark.unit        # Unit tests
@pytest.mark.integration # Integration tests
@pytest.mark.slow        # Long-running
@pytest.mark.firebase    # Firebase-related (should use mocks)
```

CI: the `agent tests` workflow (`agent-tests.yml`) runs the suite on Windows, macOS and Linux. The rest of the suite stubs the Claude Agent SDK; `agent/tests/unit/test_claude_agent_sdk_surface.py` is the one file that checks the real installed SDK.

---

## Integration Testing (pytest + requests)

### Setup (one-time)
```bash
cd test/integration
cp .env.test.example .env.test
# Edit .env.test:
#   OWLETTE_API_URL=https://dev.owlette.app
#   OWLETTE_API_KEY=owk_your_key_here    # Generate from settings > api keys
#   OWLETTE_SITE_ID=your-site-id
#   OWLETTE_MACHINE_ID=your-machine-id
pip install -r requirements.txt
```

### Run Commands
```bash
cd test/integration
python -m pytest -m api -v              # All API tests
python -m pytest api/test_processes.py -v  # Single file
python -m pytest -m readonly -v          # Safe read-only tests only
python -m pytest -m "api and not destructive" -v  # Skip create/delete tests
```

**Stale:** `test_auth.py`, `test_commands.py`, `test_deployments.py`, `test_machines.py`, `test_processes.py` and the `process_cleanup` fixture still call `/api/admin/*`, which was removed in 644c57f2 (the routes now live under `/api/sites/{siteId}/...`). Expect those to fail against current dev until they are ported.

### Markers
```python
@pytest.mark.api         # All API tests
@pytest.mark.readonly    # Safe — only reads data
@pytest.mark.destructive # Creates/modifies data (has cleanup fixtures)
@pytest.mark.integration # Integration tests
@pytest.mark.slow        # Large downloads, long installs (pytest-timeout is 600s)
```

### Cleanup

Tests that create resources append their ids to the `process_cleanup` / `deployment_cleanup` fixtures (`test/integration/api/conftest.py`), which delete them in teardown.

---

## Principles

1. **Mock Firebase, not business logic** — Firebase is the I/O boundary
2. **Use existing mocks** — `web/__mocks__/firebase.ts`, `web/__mocks__/firebase-admin.ts`, and `agent/tests/conftest.py` have what you need
3. **Test error paths** — Firebase operations fail in production
4. **Don't test shadcn/ui** — test your composition of primitives, not the primitives
5. **API route tests use `/** @jest-environment node */`** — server code, not jsdom
6. **Integration tests need `.env.test`** — never commit credentials
7. **A bug fix starts with a failing test**
