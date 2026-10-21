# owlette web

The Next.js 16 application behind [owlette.app](https://owlette.app): the dashboard, the public REST API, the endpoints the agents talk to, and the documentation site at `/docs`. It manages Windows, macOS and Linux machines through the owlette agent (`../agent`).

## What's in it

- **Dashboard**: machines and live metrics, processes and their launch modes and schedules, restart schedules, displays, keep screens awake, deployments (`/deployments`), roost (`/roosts`), swoop (`/swoop/{siteId}/{machineId}`), hoot (`/hoot`), talons (`/talons`), activity logs (`/logs`), account settings, and the admin panel (`/admin`)
- **Public API**: scoped API keys, webhooks, idempotency and pagination, described by [`openapi.yaml`](openapi.yaml) and served at `/api/openapi`, with the interactive reference at `/docs/api`
- **Agent endpoints**: device-code pairing, token exchange and refresh (`app/api/agent/auth/`), screenshot uploads, alerts and swoop under `app/api/agent/`
- **Scheduled endpoints**: `app/api/cron/*` and `/api/hoot/escalation`, called by an external scheduler
- **Docs**: the MDX under [`content/docs`](content/docs), rendered by Fumadocs and shipped with every build
- **Auth**: Firebase Auth (email/password, Google, passkeys), a required second factor (passkey or TOTP), encrypted session cookies, and Cloudflare Turnstile on sign-up and password reset

## Stack

- **Framework**: Next.js 16 (App Router), React 19, TypeScript
- **Styling**: Tailwind CSS 4, shadcn/ui on Radix; light, dark and system themes
- **Data**: Cloud Firestore (client SDK for listeners, `firebase-admin` on the server), Firebase Storage, Cloudflare R2 over the S3 API for roost
- **Auth**: Firebase Auth, SimpleWebAuthn (passkeys), iron-session, Cloudflare Turnstile
- **AI**: the AI SDK with Anthropic and OpenAI providers (hoot)
- **Rate limiting**: Upstash Redis + `@upstash/ratelimit`
- **Email**: Resend
- **Docs**: Fumadocs (MDX), Scalar (API reference), Mermaid
- **Errors**: Sentry
- **Tests**: Jest, `@firebase/rules-unit-testing`, Playwright

## Getting started

### Prerequisites

- Node.js 22.x and npm 10 (`engines` in `package.json`; `.nvmrc` at the repo root)
- A Firebase project with Authentication, Firestore and Storage enabled; see [Firebase setup](https://owlette.app/docs/setup/firebase)
- For the e2e suite only: JDK 21 and `firebase-tools@15` installed globally

### Install and run

```bash
cd web
npm ci
cp .env.example .env.local
npm run dev                 # http://localhost:3000
```

`.npmrc` sets `legacy-peer-deps`, so a plain `npm ci` works; `postinstall` generates the docs source.

Fill in `.env.local` before starting. `.env.example` lists every key with a comment; [environment variables](https://owlette.app/docs/setup/environment-variables) explains each one, and [`scripts/env-manifest.json`](../scripts/env-manifest.json) is the canonical registry of keys and which deployment carries each. Neither holds a value, and `.env.local` must never be committed. For local work you need the Firebase client and Admin values, `SESSION_SECRET` and `MFA_ENCRYPTION_KEY`; the rest switch on their features (R2 for roost, the `SWOOP_*` keys for swoop, Resend for email, Upstash for distributed rate limiting).

To reach the dev server from another device on your network, list its origin in `NEXT_ALLOWED_DEV_ORIGINS`.

## Scripts

| script | what it does |
|--------|--------------|
| `npm run dev` | dev server on :3000 |
| `npm run build` | generates the docs source, then `next build` |
| `npm start` | serves the production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Jest unit tests (`test:watch`, `test:coverage` too) |
| `npm run test:rules` | Firestore rules tests against the emulator (JDK 21) |
| `npm run e2e` | builds, starts the Firebase emulators, and runs the Playwright suite |
| `npm run e2e:ui` | the same, in Playwright's UI mode |
| `npm run e2e:install` | installs Playwright's Chromium |
| `npm run validate:api` | checks `openapi.yaml` against the route files: every documented path must exist, and undocumented public routes are flagged |
| `npm run smoke:dev` | drives a real browser against live dev.owlette.app ([`e2e-live/README.md`](e2e-live/README.md)) |
| `npm run screenshots` | regenerates the docs screenshots in `public/docs-screens` |

## Tests

- **Unit**: `npm test`. Jest specs live in `__tests__/` and beside the code they test.
- **Rules**: `npm run test:rules` boots the Firestore emulator and runs `__tests__/rules/`.
- **End to end**: `npm run e2e` runs Playwright against a production build on **:3100** (so it coexists with `npm run dev`) and the Firebase emulators (Auth :9099, Firestore :8080, Storage :9199). It needs JDK 21 on PATH, `npm i -g firebase-tools@15`, and Chromium once: `npx playwright install chromium --with-deps`. The HTML report lands in `e2e/.output/report/`. [`e2e/README.md`](e2e/README.md) covers fixtures, debugging and the other suites.

The `playwright e2e` workflow runs the suite on every pull request and on pushes to `dev` and `main` that touch `web/`, `functions/`, the Firestore or Storage rules, the indexes or `firebase.json`. Every new user-facing behaviour ships with an e2e test.

## Layout

```
web/
├── app/                  # routes: pages, app/api/* route handlers, app/docs (Fumadocs + the API reference)
├── components/           # app components; components/ui/ holds the shadcn primitives, which we own and customize
├── hooks/                # every Firestore read and listener a component uses
├── contexts/             # AuthContext and the demo's DemoContext
├── lib/                  # shared logic; *.server.ts files are server-only
├── content/docs/         # the published documentation (MDX)
├── public/               # static assets, including the docs screenshots
├── __tests__/            # Jest unit and rules tests
├── e2e/                  # Playwright suite against the emulators
├── e2e-live/             # smoke suite against live dev
├── proxy.ts              # Next 16 proxy (was middleware.ts): session and second-factor gates, and the content security policy
├── instrumentation.ts    # Sentry, plus boot warnings for missing Upstash and Turnstile config
├── openapi.yaml          # the public API contract
├── railway.toml          # Railway build and start
└── nixpacks.toml         # Node 22 + npm ci for the Railway build
```

## Conventions

- Components never call Firestore directly; they go through a hook in `hooks/`.
- Colors come from the CSS variables in `app/globals.css` and the Tailwind theme, never hardcoded values. Button styling lives in the variants in `components/ui/button.tsx`.
- Icons come from `lucide-react` only.
- User-facing copy is lowercase, apart from proper nouns, acronyms and identifiers.
- Lint what you edit: `npx eslint <file>`.

## Deploy

Railway deploys this directory on every push: `dev` to [dev.owlette.app](https://dev.owlette.app), `main` to [owlette.app](https://owlette.app). `railway.toml` and `nixpacks.toml` hold the build (`npm ci --legacy-peer-deps`, `npm run build`, `npm start`). Production also runs on a Vercel standby behind a Cloudflare load balancer (`../infra/cloudflare`), which fails over when Railway's `/api/health` check fails; `/api/health` answers 200 only while the origin can reach Firestore.

A push deploys only this app and its docs. Firestore rules and indexes, Storage rules and Cloud Functions deploy separately with `firebase deploy`, every scheduled endpoint must be registered on the scheduler (`../infra/cron-jobs.json`), and environment variables are kept in step across Railway and Vercel with `node scripts/sync-env.mjs` from the repo root. `NEXT_PUBLIC_*` values are compiled in, so redeploy after changing one.

[Web deployment](https://owlette.app/docs/setup/web-deployment) is the full guide: Railway, Vercel, generic Node hosting, the failover load balancer, and the scheduled endpoints. The maintainer release procedure is [`docs/runbooks/production-deploy.md`](../docs/runbooks/production-deploy.md).
