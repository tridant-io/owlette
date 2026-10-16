# Light mode — Plan
**Created**: 2026-10-01 | **Status**: Planned (not started)

## Summary

owlette ships a light theme across the web app, docs, landing/marketing pages and the desktop tray app. Users pick dark / light / system. The default is system (follow the OS), and the choice persists across devices. Dark rendering must not change: every dark token value stays byte-identical, and the existing dark e2e/a11y suite stays green. The bulk of the work is migrating roughly 1,400 hard-coded, dark-tuned colour classes onto tokens.

## Confirmed decisions (owner, 2026-10-01)

- Default theme = **follow the OS** (`system`). The flip to `system` is the **last** task. Until then the provider defaults to `dark`, so dev never shows half-migrated light pages to OS-light users.
- Landing and marketing pages (`/`, `/download`, `/demo`, legal, privacy, terms) **follow the theme**. They need a light design pass and a second (light) screenshot set.
- The desktop tray app is **in scope**.
- The plan lives in `dev/planned/light-mode/` (git-tracked) until execution starts.

## Research findings that shape the plan

- **next-themes 0.4.6 is installed in web and desktop but no provider is mounted.** `components/ui/sonner.tsx` (both apps) and `components/mdx/mermaid.tsx` already call `useTheme()`. `.claude/skills/frontend-dev-guidelines.md:66` wrongly says it is configured.
- **Dark is pinned in several places:**
  - `<html className="dark">` in `web/app/layout.tsx:95` and `desktop/index.html:2`
  - `<Toaster theme="dark">` in `layout.tsx:144`
  - `theme-color` `#0a0f1a` in `layout.tsx:76`
  - `docs.css:7-9` sets `:root, .dark { color-scheme: dark }`
  - the fumadocs `RootProvider theme={{enabled:false}}` in `docs/layout.tsx:21,55`
  - Scalar `darkMode: true` in `docs/api/route.ts:63`
  - Tauri `"theme": "Dark"` and `"backgroundColor": "#020B16"` in `tauri.conf.json:25-26` and `tauri.macos.conf.json`
  - Turnstile `theme: 'dark'` in `TurnstileWidget.tsx:132`
- **The light token layer has holes.** `:root` is stock shadcn neutral. Nine tokens exist only in `.dark`: `--accent-cyan`, `-hover`, `-muted`, `--accent-warm`, `-hover`, `-muted`, `--accent-coral`, `--grid-line`, `--grid-line-accent`. They are used about 380 times across about 85 files, `.hl-link` depends on them, and so does docs `--color-fd-primary`.
- **Base CSS hard-codes dark oklch** for scrollbars, the focus outline, the body dot-grid, `.dot-grid`, the select scrollbar and the `display-test-result-flash` keyframe (`web/app/globals.css` 212–325, 389, 450–457; desktop mirrors them).
- **Desktop's `--btn-hover` never got web's per-theme split**, and `--surface-hover` is missing there (`desktop/src/globals.css:593`).
- **Raw palette debt:** 991 utilities in 107 files.
  - Largest: red 359, amber 178, green 80, gray 75, `text-gray-900` 65 (text on a cyan primary, which goes dark-on-dark in light).
  - Already clean: landing, docs, swoop and auth have **0**.
- **`text-white`:** 384 in 73 files. About 285 stand in for body text and will vanish on a light background; about 87 are text on a solid fill.
- **Semantic clusters to tokenise:**
  - error fg (183)
  - destructive ghost/menu items (34 lines)
  - error panels (about 22)
  - destructive solid buttons (23)
  - warning fg (116) and warning callouts (32)
  - success fg (57), success tints and solids
  - info (61)
  - raw cyan duplicating `--accent-cyan` (59)
  - the existing helpers (`form-error`, `inline-notice`, `alert`, `ghost-destructive`) cover about 10 files; ad-hoc use spans 60+.
- **Data-viz literals** that must move to tokens: `ChartTooltip.tsx:13-19`, `lib/networkUtils.ts:45-75`, `lib/diskIOUtils.ts:13-14`, `lib/usageColorUtils.ts`, `lib/temperatureUtils.ts`, the recharts strokes in `MetricsDetailPanel.tsx` 1303–1363, the gradient in `SparklineChart.tsx:84-85`, and the header fade in `PageHeader.tsx:511`.
- **Persistence:**
  - **Firestore rules:** `users/{uid}.preferences` is allowlisted with no sub-key validation (`firestore.rules:768-777`). `preferences.theme` needs **no rules change**, and a rules test already writes `preferences: { theme: 'dark' }` (`wave-hardening.test.ts:200-204`).
  - **AuthContext copies prefs field by field.** Its `newPrefs` (`AuthContext.tsx:584-605`) and equality check (`:619-636`) must both list `theme`.
  - **Firestore arrives too late for first paint.** It loads after auth, so the browser value (next-themes localStorage) carries first paint. The hybrid pattern to copy is `owlette_current_site` (`AuthContext.tsx:1009`).
- **CSP:** `script-src 'nonce-X' 'strict-dynamic'` (`web/proxy.ts:94`). The root layout already awaits `headers()` (`layout.tsx:87`), so it can pass `x-nonce` to `ThemeProvider nonce`. Every HTML route renders per request and gets a nonce.
- **Desktop:**
  - It has no Firestore access. UI prefs live in `%APPDATA%\app.owlette.desktop\layout.json` (`src-tauri/src/window_state.rs`), a namespaced document that preserves unknown keys, exposed through IPC (`desktop/src/lib/ipc.ts:249-299`).
  - The window is created hidden and shown from Rust before the first frame (`src-tauri/src/lib.rs:160-170`, `tray.rs:481-492`).
  - The Tauri CSP is `null`.
  - `capabilities/default.json` grants no theme or background permissions.
- **Tests:**
  - **Playwright defaults to `colorScheme: 'light'`.** The pinned class hides that today. Its `use` blocks are in `playwright.config.ts:153-161`, `playwright.screenshots.config.ts:46-55`, `playwright.videos.config.ts:730-741`, plus the context in `e2e/videos/video-helpers.ts:62-66`.
  - **No pixel baselines exist.** `e2e/specs/a11y/route-smoke.spec.ts` runs axe wcag2a/aa (which covers contrast) across about 10 routes, dark only. `e2e/specs/visual/button-hover.spec.ts` asserts that `--btn-hover` resolves.
  - **Desktop vitest and oxlint never run in CI.** `rust-build.yml` runs cargo only.
  - **Unit tests assert colour classes** in `MachineCardView.rebootPending.test.tsx` and `diskIOUtils.test.ts` on web, and in desktop `ProcessDetail.test.tsx`, `ProcessList.test.tsx` and `design-system.test.tsx` (an exact `MENU_SURFACE` string).
  - **No lint rule bans hard-coded colours.**
- **Screenshots:** every capture is dark.
  - `public/landing-screens/` (10)
  - `public/*.png` (`dashboard.png` is the landing LCP image)
  - `public/docs-screens/` (26, referenced from about 25 MDX files)
  - `scripts/refresh-docs-screens.mjs` writes `captured.json` with no theme dimension.

## Approach

### Theme runtime (web)
- Mount `next-themes` `ThemeProvider` at the root:
  - `attribute="class"`
  - `nonce` from `x-nonce`
  - `enableSystem`
  - `enableColorScheme`
  - `storageKey="owlette_theme"`
  - `defaultTheme={DEFAULT_THEME}` (a single exported constant; `'dark'` until Wave 6)
  - `disableTransitionOnChange`
- Remove the hard-coded `dark` class and add `suppressHydrationWarning` to `<html>`.
- Keep the fumadocs `RootProvider` theme **disabled**. fumadocs re-exports next-themes' `useTheme`, so the root provider feeds it with no second provider.
- `theme-color` moves to `viewport.themeColor` with per-`prefers-color-scheme` entries.

### Persistence
- **First paint:** localStorage (next-themes) owns it.
- **Cross-device:** Firestore `users/{uid}.preferences.theme` (`'dark' | 'light' | 'system'`) is the source of truth.
- **Sync rule:** a `ThemePreferenceSync` component inside the auth tree applies Firestore's value when it is set and differs from the local one. A user change writes through `updateUserPreferences(..., { silent: true })`. No API route, no rules change.

### Token architecture
- Every token is defined in both `:root` (light) and `.dark`. All existing `.dark` values stay byte-identical.
- **New families:**
  - **Brand accents in light:** a deeper interactive cyan, because signal cyan oklch(0.75 0.18 195) is about 2:1 on white and fails AA. On a light cyan fill, `--primary-foreground` flips to near-white.
  - **Status:** `--danger`, `--warning`, `--success`, `--info`, each with `-surface`, `-border`, `-solid` and `-solid-foreground` variants. Tailwind utilities come through `@theme inline`, for example `text-danger`, `bg-danger-surface`, `border-danger-border`, `bg-danger-solid`, `text-danger-solid-foreground`.
  - **Usage bands:** `--band-calm`, `--band-steady`, `--band-working`, `--band-strained`, `--band-critical`.
  - **Chart series:** `--series-cpu`, `-memory`, `-disk`, `-gpu`, `-cpu-temp`, `-gpu-temp`, `-display`, plus indexed `--series-nic-{tx,rx}-{1..3}`, `--series-disk-{1..5}`, `--series-gpu-{usage,temp}-{1..3}`, `--series-disk-io-{read,write}`.
  - **Chart chrome:** `--chart-grid`, `--chart-axis`, `--chart-reference`.
  - **Elevation:** `--elevation-shadow`, `--elevation-ring`, used by `MENU_SURFACE` and landing cards.
  - **Chrome:** `--scrollbar-thumb`, `--scrollbar-thumb-hover`, `--scrollbar-track`, `--focus-outline`, `--dot-grid`, `--grid-dot`.
- recharts accepts `var(--…)` in `stroke` and `fill`. The `ChartTooltip.tsx` comment claiming otherwise must be verified, then deleted.
- **Contrast is enforced by a unit test.** It parses both token blocks and asserts WCAG AA (4.5:1 text, 3:1 large text and UI) for the named fg/bg pairs in both themes.

### Migration rules
These are mechanical, applied per area:

| Today | Becomes |
|---|---|
| `text-white` as body text | `text-foreground` |
| `text-white` on a solid fill | the fill's `-solid-foreground` (or `text-primary-foreground`, `text-destructive-foreground`) |
| `text-gray-900` on cyan | `text-primary-foreground` |
| red / amber / green / emerald / blue fg | `text-danger`, `text-warning`, `text-success`, `text-info` |
| `bg-*-950/30` + `border-*-800` panels | `bg-{status}-surface border-{status}-border` |
| `bg-red-600 hover:bg-red-700 text-white` | `variant="destructive"` |
| ad-hoc destructive ghost | `variant="ghost-destructive"` |
| raw `cyan-*` | `accent-cyan` tokens |
| `slate-*` in primitives | `popover`, `secondary`, `input` tokens |
| `prose-invert` | `dark:prose-invert` |

- **Categorical palettes** (`BLOCK_COLORS`, deployment `statusColors`, alert `SEVERITY_COLORS`, desktop process and footer tones) get explicit `dark:` pairs or tokens. These are judgement calls, not mechanical swaps.
- **Theme-invariant, left alone:**
  - the OwletteEye logo and feather hex
  - the Google, Slack and Discord brand marks
  - scrims (`bg-black/50`, and so on)
  - the swoop fullscreen letterbox (`bg-black`)
  - emails, OG images, webhook embeds
  - the scroll-fade `#000` masks

### Landing and screenshots
- The landing page gets a designed light variant: the hero and background glows, ValuePropSection's sheen and shadow, and card elevation. Run it through `/impeccable` against `DESIGN.md`.
- Screenshots become theme-paired, with the light file using a `-light.png` suffix.
  - **Landing:** a `ThemedImage` component renders both images and hides one with `dark:hidden` / `hidden dark:block`. The hidden one is `loading="lazy"` so the LCP image doesn't double up.
  - **Docs:** an MDX `img` override in `web/mdx-components.tsx` picks the `-light` variant when it exists.
  - **Capture:** the screenshots config gains a light project.
  - **`captured.json`:** gains a `themes` dimension, and `--check` verifies both themes.

### Desktop
- The theme lives in `layout.json` under `appearance.theme` (`'dark' | 'light' | 'system'`, default `system` from Wave 6).
- **The window theme is the single switch.** Rust reads the stored value before the window shows and calls `set_theme(Some(Dark|Light))`, or `None` for `system`. It also sets a matching `backgroundColor` (dark `#020B16`; light equals the light `--background` in hex), so there is no flash.
- The window theme drives the webview's `prefers-color-scheme`. That is why sonner's "system" resolves dark today under `"theme": "Dark"`.
- The webview runs next-themes **always in `system` mode**, and the class follows `prefers-color-scheme`. There is no IPC read before first paint and no init script.
- The `AppMenu` toggle calls a new IPC command. Rust persists the value to `layout.json` and calls `set_theme`, the media query changes, and next-themes re-applies the class.
- Verify on all three OSes. WebView2 and WKWebView honour the window theme. On Linux webkitgtk it is the least certain; if it doesn't follow there, fall back to an initialization script on that OS only.

### Guardrails
- After migration, an ESLint `no-restricted-syntax` rule bans raw palette utilities (`(text|bg|border|ring|fill|stroke|from|to|via|outline|divide|shadow|decoration|placeholder)-(red|…|fuchsia)-\d{2,3}`) and `text-white` / `text-gray-900` in JSX string literals in web, with a small allowlist for brand marks.
- Desktop vitest and oxlint get added to CI.

## Waves

The full task specs are in `tasks.md`. Tasks within a wave touch disjoint files.

| Wave | Tasks | Theme |
|---|---|---|
| 1 | 1.1 light palette and tokens · 1.2 theme provider · 1.3 pin Playwright dark | foundation, ships invisibly (default still dark) |
| 2 | 2.1 preference sync and controls · 2.2 web ui primitives · 2.3 data-viz tokens · 2.4 third parties and odds · 2.5 desktop tokens | plumbing and primitives |
| 3 | 3.1 dashboard and machines · 3.2 shared dialogs · 3.3 admin, settings, deployments, logs, talons · 3.4 hoot, roost, swoop, auth · 3.5 landing light design · 3.6 desktop theme runtime | web migration sweeps and desktop runtime |
| 4 | 4.1 desktop component migration · 4.2 themed screenshot pipeline | desktop and screenshots |
| 5 | 5.1 e2e theme and light a11y · 5.2 lint guardrail and stragglers · 5.3 desktop checks in CI | verify and guard |
| 6 | 6.1 docs · 6.2 flip the default to `system` | docs and release gate |

## Risks

- **Brand vs AA.** Signal cyan can't carry text or links on white. The light interactive cyan is a new brand value, decided in 1.1 and recorded in `DESIGN.md`. Don't ship light with dark-mode cyan on a white background.
- **Post-login flip.** If localStorage says light and Firestore says dark, the page flips once after login. That is acceptable for a cross-device change, but it must never ping-pong. Sync only reacts to a Firestore value that differs from the last value it wrote.
- **The `docs.css` second `@import "tailwindcss"`** persists after a client-side navigation into `/docs`. Its `:root` overrides can leak into app pages. 1.1 scopes overrides to the docs root (`#nd-docs-layout` or similar) rather than `:root`.
- **Hydration.** `<html>` needs `suppressHydrationWarning`. The next-themes script must carry the nonce, or the CSP blocks it and every page flashes.
- **Dark regressions in the sweeps.** About 1,400 edits. Every sweep task must keep the dark e2e and a11y suite green. Token pairs are chosen so that dark resolves to the same rendered colour as the class it replaces. Where it can't, the task notes it.
- **The landing LCP.** Rendering two images must not fetch both. Verify only one is requested in each theme.
- **The OS flip at release.** OS-light users see light for the first time on the release that ships 6.2. Everything before it must be green in light, including the axe light pass. Nothing ships `system` early.
- **Desktop has no CI coverage** until 5.3. Waves 2.5, 2.6 and 4.1 must run `npm test` and `npm run lint` in `desktop/` locally and say so.
- **Upgrade path.** Desktop ships through the agent installer. Old desktop builds stay dark-only, which is harmless: no fleet-behaviour change is involved, so no installer-side half is needed.

## Success criteria

- Dark / light / system is selectable from the user menu and account settings on web, and from `AppMenu` on desktop. The default is `system`.
- The choice persists across reloads with no flash, and across devices via `preferences.theme`.
- In light mode, every route covered by `e2e/specs/a11y/route-smoke.spec.ts` (app, docs, landing) passes axe wcag2a/aa with zero serious or critical findings. The dark pass stays green.
- The token contrast unit test passes for both themes. No `.dark` token value has changed.
- The ESLint guardrail passes with zero raw palette or `text-white` / `text-gray-900` utilities outside its allowlist.
- Landing and docs show theme-matched screenshots, and `captured.json --check` verifies both themes.
- Desktop opens in the stored or OS theme with no flash at window show, and desktop vitest and oxlint run in CI.
- `DESIGN.md`, the frontend guide, the account-settings and data-model docs, `desktop/README.md` and the changelog describe light mode.
