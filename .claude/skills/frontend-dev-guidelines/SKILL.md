---
name: frontend-dev-guidelines
description: "Patterns for the Owlette Next.js dashboard in web/: the auth context and the proxy.ts route guard, Firestore read hooks, writes through API routes backed by lib/actions, shadcn/ui primitives we own (button.tsx variants), theme tokens for light and dark, toasts, lucide icons. Use when building or fixing a page, component, dialog, form, hook, button, styling, layout, theme or dark mode in the web app."
paths:
  - "web/**"
---

# Frontend Development Guidelines

**Applies To**: Owlette Web Dashboard (`web/` directory)

---

## Project-Specific Patterns

### Directory Layout
```
web/
├── app/                          # App Router (dashboard, deployments, roosts, admin, settings, login, logs, docs, api)
│   ├── layout.tsx                # Root layout (providers, theme, toaster)
│   └── globals.css               # Global styles + CSS variables (theme tokens)
├── components/
│   ├── ui/                       # shadcn/ui primitives — ours to edit (see below)
│   └── [Feature].tsx             # Project components
├── contexts/AuthContext.tsx      # Firebase auth (single context for the app)
├── hooks/                        # Firestore read hooks (useFirestore.ts, useDeployments.ts, ...)
├── lib/                          # Utilities (firebase.ts, errorHandler.ts, validators.ts); actions/*.server.ts for writes
├── proxy.ts                      # Route protection, MFA redirects, CSP
├── __mocks__/firebase.ts         # Comprehensive Firebase mock (use this, don't reinvent)
└── __tests__/                    # Jest tests
```

### Auth Pattern

All authenticated pages use `AuthContext`. Don't create alternative auth flows:

```tsx
const { user, loading, signOut } = useAuth()  // from @/contexts/AuthContext
```

The route guard is server-side in `web/proxy.ts`: `PROTECTED_PATHS` plus the session and MFA redirects. A new top-level protected route must be added to that list; pages under an existing prefix (`/dashboard`, `/admin`, `/settings`, ...) inherit it.

### Data Fetching

Firestore reads go through custom hooks in `hooks/`. Don't call Firestore directly from components:

- `useFirestore.ts` — `useSites`, `useMachines(siteId)`, `useSiteMemberships`, `useMachineHardware`
- `useDeployments` — deployment-specific operations
- `useRoosts` — roost (project distribution) data

These hooks handle loading states, error states, and listener cleanup internally.

Writes never use the client SDK: ESLint (`noClientFirestoreWritesRule` in `web/eslint.config.mjs`) rejects `setDoc`/`updateDoc`/`addDoc`/... imports. Route a write through an API handler backed by `web/lib/actions/*.server.ts`.

### shadcn/ui Rules

- `web/components/ui/*` are shadcn primitives **copied into the repo — we own them.** Editing them for theming, variants, hover/focus states and standardization is the intended workflow.
- Changes there are app-wide, so verify broadly. Re-running `npx shadcn@latest add <component>` **overwrites** that file — port upstream fixes by hand.
- **`button.tsx` variants are the single source of truth for button styling.** Standardize there; don't sprinkle per-instance `hover:*`/`bg-*` overrides on individual `<Button>`s.

### Toast Notifications

Use the wrapper (`<Toaster />` from `@/components/ui/sonner` is already in the root layout):
```tsx
import { toast } from '@/lib/toast'
toast.success('done')
toast.error('failed to update machine')
```
It adds sequential display, hover pause and burst dedupe on top of sonner; don't import `toast` from `sonner` directly.

### Icons

Use `lucide-react` exclusively — don't add other icon libraries.

### Copy

All user-facing copy is lowercase (titles, buttons, labels, toasts, empty states); acronyms, proper nouns and user-entered strings keep their casing.

### Theming

Two themes, dark and light. `web/components/ThemeProvider.tsx` wraps next-themes; the choices and storage key are in `web/lib/theme.ts`. The app follows the OS until the user picks one in profile → preferences (synced to `users/{uid}.preferences.theme` by `ThemePreferenceSync`), and the server renders `<html class="dark">` so no-JS views stay dark. Every colour is a token in `web/app/globals.css`: `:root` is light, `.dark` is dark, and each token is defined in both. Use the token classes (`text-danger`, `bg-raised`, `bg-card-sunken`, ...) and a `dark:` pair only where a token can't express it. ESLint rejects raw palette utilities (`text-red-400`, `text-white`); the rule is `RAW_PALETTE` in `web/eslint.config.mjs`. `web/__tests__/styles/theme-contrast.test.ts` and `composited-contrast.test.ts` hold both themes to WCAG AA. `DESIGN.md` (repo root) has the system.

---

## Owlette-Specific Gotchas

1. **Real-time listeners must clean up** — every `onSnapshot` needs a return `() => unsubscribe()` in useEffect. We've had memory leak bugs from this.
2. **Server Components can't use Firebase** — Firebase Client SDK requires browser APIs. Any component using auth or Firestore must be `'use client'`.
3. **Site-scoped data** — almost all Firestore paths are `sites/{siteId}/...`. Always scope queries to the user's current site.
4. **Deployment and roost targets are machine lists** — a deployment stores `targets: [{ machineId, status }]`, a roost `targets: string[]` of machine ids; neither targets a site.
5. **Process status comes from agent heartbeats** — don't try to query process status directly. The agent writes it to the machine doc's `metrics.processes` on its adaptive heartbeat (5s while the desktop window is open, 30s while processes run, 120s idle).
6. **User preferences include alert toggles** — `healthAlerts` (machine offline), `processAlerts` (process crash) and the other `*Alerts` booleans in `UserPreferences` default to `true`. They're edited in `web/app/settings/alerts/page.tsx` (health/process also in `AccountSettingsDialog.tsx`) and written via `AuthContext.updateUserPreferences()`. The server-side alert routes filter recipients by these preferences.
