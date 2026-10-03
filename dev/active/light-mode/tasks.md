# Light mode — Tasks
**Progress**: 3/21 complete · branch `feat/light-mode`

Read `plan.md` first (Approach → token architecture and migration rules). Read `DESIGN.md` at the repo root for the visual system.

**Owner brief, 2026-10-03 (overrides anything below that disagrees):**
- **Theme follows the OS.** The preference is `system` by default. It resolves through `prefers-color-scheme`, and dark is the fallback whenever there is no signal: the server renders `<html class="dark">`, so no-JS views and failed scripts land on dark, never light.
- **The switch lives only in the user's profile** (account settings → preferences). There is no header or user-menu control, and signed-out visitors simply get their OS preference. The control is understated and carefully designed, never loud.
- **Every page is in scope,** including landing, docs, the Scalar API reference, auth, admin, hoot, swoop, roosts, talons, logs and the desktop app. Emails and OG images are not pages, so they stay out.
- **The whole build lives on `feat/light-mode` and merges once, complete.** There is no dark-first interim on `dev`, and Task 6.2 is a visual review gate, not a default flip.
- **Focus stays quiet** (`DESIGN.md` → "The Quiet Focus Rule"). Light gets a quiet outline of its own, never a strong or inset ring.

**Global rules for every task:**
- **Never change a `.dark` token value.** Dark rendering must stay identical.
- **New tokens go in both `:root` and `.dark`** in `web/app/globals.css`. Desktop mirrors them in `desktop/src/globals.css` (Task 2.5).
- **Lint as you go.** After editing a web file, run `npx eslint <file>` in `web/`. Fix everything you introduced.
- **Run the relevant tests before marking a task done:**
  - web: `cd web && npm test`
  - desktop: `cd desktop && npm test && npm run lint`
  - any task touching `web/**` routes: run `/preflight` (lint, typecheck, unit, e2e) before pushing.
- **All UI copy is lowercase.**

---

## Wave 1: Foundation

- [x] **Task 1.1: Light palette and token families**
  - Files: `web/app/globals.css`, `web/app/docs/docs.css`, `DESIGN.md`, `web/__tests__/styles/theme-contrast.test.ts` (new)
  - Do:
    - **Design the light palette.** Run `/impeccable` with `DESIGN.md` as authority, as an extension of the Mission Control world, not a new one. Then fill `:root` with on-brand light values that replace the stock shadcn neutrals: a cool paper background, hue-250 navy text and borders, the same tonal-step logic as dark.
    - **Add the dark-only tokens to `:root`:** `--accent-cyan`, `-hover`, `-muted`, `--accent-warm`, `-hover`, `-muted`, `--accent-coral`, `--grid-line`, `--grid-line-accent`. They need light values. The light interactive cyan must reach at least 4.5:1 for text and links on the light `--background`, and at least 3:1 as a UI fill; expect L around 0.50–0.56. Set `--primary` and `--ring` to it, and set `--primary-foreground` to near-white.
    - **Add the new token families** to both blocks and map each to a Tailwind colour in `@theme inline`:
      - **Status:** `--danger`, `--warning`, `--success`, `--info`, each with `-surface`, `-border`, `-solid` and `-solid-foreground` variants.
      - **Usage bands:** `--band-calm`, `--band-steady`, `--band-working`, `--band-strained`, `--band-critical`.
      - **Chart series and chrome:** `--series-cpu`, `-memory`, `-disk`, `-gpu`, `-cpu-temp`, `-gpu-temp`, `-display`; `--series-nic-tx-1..3`, `--series-nic-rx-1..3`; `--series-disk-1..5`; `--series-gpu-usage-1..3`, `--series-gpu-temp-1..3`; `--series-disk-io-read`, `-write`; `--chart-grid`, `--chart-axis`, `--chart-reference`, `--sparkline-from`, `--sparkline-to` (dark = `rgb(148,163,184)` / `rgb(71,85,105)` from `SparklineChart.tsx:84-85`).
      - **Elevation:** `--elevation-shadow`, `--elevation-ring`.
      - **Chrome:** `--scrollbar-track`, `--scrollbar-thumb`, `--scrollbar-thumb-hover`, `--focus-outline`, `--dot-grid`.
    - **Make each new dark value equal the rendered colour it replaces:**
      - Status tokens: the existing ad-hoc classes, in oklch. `--danger` equals `text-red-400`, `--danger-surface` equals `red-950/30`, `--danger-border` equals `red-800`, `--danger-solid` equals `red-600`, `--warning` equals `amber-400`, and so on (see `plan.md` "migration rules").
      - Band and series values: the literals in `web/lib/usageColorUtils.ts`, `networkUtils.ts`, `diskIOUtils.ts`, `components/charts/ChartTooltip.tsx:13-19`, `MetricsDetailPanel.tsx:1303-1363`.
      - Elevation: `shadow-black/50` and `ring-white/10`.
    - **Replace every hard-coded colour in base CSS with the new tokens:** `globals.css` lines ~212, 244, 255–264, 303, 313–324, 389, and the `display-test-result-flash` keyframe 450–457.
    - **Fix `docs.css`:**
      - Remove `color-scheme: dark` from `:root, .dark` and let the app's per-theme `color-scheme` apply.
      - Scope any docs-only overrides to the docs layout root, not `:root`. Its second `@import "tailwindcss"` persists after client navigation, so a `:root` override leaks into app pages.
    - **Write `theme-contrast.test.ts`.** It parses both token blocks from `globals.css`, converts oklch to sRGB, and asserts WCAG contrast in BOTH themes.
      - Pairs: foreground/background, foreground/card, muted-foreground/background, muted-foreground/card, primary-foreground/primary, accent-cyan/background (links), and danger, warning, success and info on background and on card. Also `{status}-solid-foreground` on `{status}-solid`.
      - Thresholds: 4.5 for text, 3.0 for UI.
      - Implement the oklch→sRGB conversion inline. No new packages.
    - **Record the light palette in `DESIGN.md`.**
      - Colors: give the light tokens descriptive names, like the dark ones.
      - Do's and Don'ts: replace the "dark now, light later" lines with the two-theme rule.
      - Regenerate `.impeccable/design.json` with the generator described in the impeccable `document` reference.
  - Done when:
    - `npm test` passes, including the new contrast test.
    - `git diff` shows no changed line inside the `.dark { … }` block apart from additions.
    - With the class temporarily removed in devtools, a light page has no invisible base chrome (scrollbars, dot-grid, focus outline).
    - `DESIGN.md` documents both palettes.

- [x] **Task 1.2: Mount the theme provider**
  - Files: `web/app/layout.tsx`, `web/components/ThemeProvider.tsx` (new), `web/lib/theme.ts` (new)
  - Do:
    - **Create `web/lib/theme.ts`** exporting:
      - `THEMES = ['system', 'dark', 'light'] as const`
      - `type ThemeChoice`
      - `DEFAULT_THEME: ThemeChoice = 'system'`
      - `FALLBACK_THEME = 'dark'`, documented as the server-rendered class and the no-signal default
      - `THEME_STORAGE_KEY = 'owlette_theme'`
    - **Create `ThemeProvider.tsx`**, a `'use client'` wrapper around next-themes `ThemeProvider`, with:
      - `attribute="class"`, `enableSystem`, `enableColorScheme`, `disableTransitionOnChange`
      - `defaultTheme={DEFAULT_THEME}`, `storageKey={THEME_STORAGE_KEY}`
      - `themes={['dark', 'light']}` and a `nonce` prop passed through
    - **Update `layout.tsx`:**
      - Read the nonce with `(await headers()).get('x-nonce')`. The layout already awaits `headers()` at ~:87, so reuse it.
      - Wrap the body content in the provider.
      - Keep `className="dark scroll-smooth"` on `<html>` as the server-rendered fallback, and add `suppressHydrationWarning`. The next-themes head script swaps the class before first paint.
      - Remove `theme="dark"` from `<Toaster>`. The sonner wrapper already reads `useTheme`.
      - Replace `other: { 'theme-color': '#0a0f1a' }` with a `viewport` export whose `themeColor` is an array of `{ media: '(prefers-color-scheme: dark)', color: '#0a0f1a' }` and `{ media: '(prefers-color-scheme: light)', color: <light --background as hex> }`.
    - Do not touch fumadocs' `RootProvider`. Its theme stays disabled, and it reads the root provider through the re-exported `useTheme`.
  - Done when:
    - With JS disabled, the page is dark.
    - With `colorScheme: 'dark'` and no stored value, the app renders dark exactly as before.
    - With `colorScheme: 'light'` it renders light with no dark flash. Light will be partly broken until Wave 3, which is fine on this branch.
    - The page source shows the next-themes inline script carrying `nonce=`.
    - The console has no CSP violation and no hydration warning.
    - `npm test` and `npx eslint` pass on the changed files.

- [x] **Task 1.3: Pin Playwright to dark**
  - Files: `web/playwright.config.ts`, `web/playwright.screenshots.config.ts`, `web/playwright.videos.config.ts`, `web/e2e/videos/video-helpers.ts`
  - Do:
    - Add `colorScheme: 'dark'` to the `use` block of each config: main `:153-161`, screenshots `:46-55`, videos `:730-741`.
    - Add the same to the context options in `video-helpers.ts:62-66`. That file creates its own context and doesn't inherit `use`.
    - `playwright.config.desktop-sync.ts` reuses `base.use`, so confirm it inherits the setting and needs no edit.
  - Done when:
    - `npm run e2e` passes unchanged.
    - Each touched config's `use` resolves `colorScheme: 'dark'`.

## Wave 2: Plumbing and primitives

- [ ] **Task 2.1: Theme preference sync and the profile control**
  - Files: `web/contexts/AuthContext.tsx`, `web/components/ThemePreferenceSync.tsx` (new), `web/components/AppearanceControl.tsx` (new), `web/components/AccountSettingsDialog.tsx`, `web/components/PageHeader.tsx`, the file that renders children inside the auth provider (find where `LazyAuthProvider` wraps the app), `web/__tests__/components/ThemePreferenceSync.test.tsx` (new), `web/__tests__/components/AppearanceControl.test.tsx` (new)
  - Do:
    - **Add `theme?: ThemeChoice` to `UserPreferences`** (`AuthContext.tsx`, the `UserPreferences` interface). Include it in the `newPrefs` construction AND in the equality check; the comment there explains why both are required.
    - **`ThemePreferenceSync`:** a client component with no UI, mounted inside the auth tree, using `useTheme()` and `useAuth()`.
      - When `userPreferences.theme` is defined and differs from the current theme AND from the last value written locally, call `setTheme(pref)`.
      - Expose nothing else.
    - **`AppearanceControl`:** the profile setting, a three-way choice of `system` / `dark` / `light`.
      - **Design it with `/impeccable`** against `DESIGN.md`. It must be understated: it sits in the preferences list like its neighbours, never a loud toggle.
      - **The clever part is the motion and the glyph, not the size.** For example: a single owl-eye or eclipse mark that morphs between night, day and "follows your system", with a compact segmented control (`role="radiogroup"`, arrow-key navigation, `aria-checked`). Reduced motion gets a static swap.
      - **Behaviour:** selecting applies instantly through `setTheme` (live preview, no save needed), then persists with `updateUserPreferences({ ...prefs, theme }, { silent: true })`, recording the value as last-written so the snapshot echo doesn't re-apply it.
      - Lowercase copy: the label is "appearance", the options are "system", "dark" and "light". The `system` option shows which theme it currently resolves to (e.g. "system · dark").
    - **`AccountSettingsDialog.tsx`:** place `AppearanceControl` in the preferences section, matching its rows.
    - **`PageHeader.tsx`:** no theme control here.
      - Tokenise `MENU_SURFACE` (`shadow-black/50 ring-white/10` become elevation tokens; dark must resolve identically).
      - Replace the inline header fade with a token (`color-mix` of `--background` at 70%).
      - Migrate any other raw palette or `text-white` in this file per the migration rules. No Wave 3 task owns it.
    - **Unit tests:**
      - Sync applies a differing Firestore value, ignores the echo of its own write, and does nothing when `theme` is undefined.
      - `AppearanceControl` has radiogroup semantics, applies on select, persists on select, and supports arrow keys.
  - Done when:
    - Choosing light in the profile re-themes immediately, persists across reload with no flash, and writes `users/{uid}.preferences.theme`. Check in the emulator.
    - Signing in on a second browser with a different local theme adopts the Firestore value once and doesn't flip back.
    - Dark `MENU_SURFACE` and the header look unchanged.
    - Unit tests pass, and `npx eslint` is clean.
  - Depends on: Task 1.1, Task 1.2

- [ ] **Task 2.2: Web ui primitives**
  - Files: `web/components/ui/sonner.tsx`, `web/components/ui/tooltip.tsx`, `web/components/ui/checkbox.tsx`, `web/components/ui/switch.tsx`, `web/components/ui/input.tsx`, `web/components/ui/alert.tsx`, `web/components/admin/AdminButton.tsx`
  - Do:
    - Replace the dark-tuned literals with tokens:
      - **sonner** (`:29-38`): `bg-slate-800 border-slate-700 text-white` becomes `bg-popover border-border text-popover-foreground`. The error, success and warning variants use the `{status}-surface`, `-border` and fg tokens.
      - **tooltip** (`:23`): `bg-slate-950 text-slate-50` becomes `bg-popover text-popover-foreground` plus a border. Choose the dark value so the dark look holds; if `--popover` differs from slate-950, keep dark identical with a `dark:` pair.
      - **checkbox** (`:16`) and **switch** (`:16`): tokenise the unchecked fills and borders. The switch thumb `bg-white` is theme-invariant; keep it.
      - **input:** `selection:bg-blue-500` becomes `selection:bg-primary selection:text-primary-foreground`.
      - **alert:** make the destructive variant use the danger tokens.
      - **AdminButton** (`:10`): `danger` uses `ghost-destructive` semantics; `primary` uses `text-primary-foreground` instead of `text-gray-900`.
  - Done when:
    - In dark, each primitive looks as before (compare against the screenshots in `web/public/docs-screens`).
    - In light (`localStorage.owlette_theme='light'`), toasts, tooltips, checkbox, switch and alert are all legible.
    - `npm test` and `npx eslint` are clean.
  - Depends on: Task 1.1

- [ ] **Task 2.3: Data-viz on tokens**
  - Files: `web/lib/usageColorUtils.ts`, `web/lib/temperatureUtils.ts`, `web/lib/networkUtils.ts`, `web/lib/diskIOUtils.ts`, `web/components/charts/ChartTooltip.tsx`, `web/components/charts/MetricsDetailPanel.tsx`, `web/components/charts/SparklineChart.tsx`, `web/__tests__/lib/diskIOUtils.test.ts`, `web/__tests__/lib/usageColorUtils.test.ts` (new)
  - Do:
    - **`usageColorUtils`:** `getUsageColorClass` returns `bg-band-calm` … `bg-band-critical`. `getUsageColor` returns `var(--band-…)`. Keep the bands (<30, <50, <70, <85).
    - **`temperatureUtils`:** `text-warning` / `text-danger` instead of `text-yellow-500` / `text-red-500`.
    - **`networkUtils` and `diskIOUtils`:** return `var(--series-…)` strings, keeping index wrapping.
    - **`ChartTooltip`:** the series map uses `var(--series-…)`. First verify recharts renders `var()` in `stroke` and `fill`: render a line chart and inspect the computed stroke. Then delete the comment claiming CSS variables don't resolve.
    - **`MetricsDetailPanel`:** the grid, axis and reference strokes (1303, 1312, 1327, 1344, 1363) use the `--chart-*` tokens.
    - **`SparklineChart`** (`:84-85`): the gradient stops use `var(--sparkline-from)` / `var(--sparkline-to)` (defined in 1.1).
    - **Tests:** update `diskIOUtils.test.ts` to the new return values. Add a `usageColorUtils.test.ts` covering each band edge (29.9, 30, 49.9, 50, 69.9, 70, 84.9, 85).
  - Done when:
    - Charts, sparklines and usage bars look the same in dark.
    - In light, series and gridlines are visible on the light card.
    - Unit tests pass.
  - Depends on: Task 1.1

- [ ] **Task 2.4: Third parties and odds**
  - Files: `web/components/TurnstileWidget.tsx`, `web/components/DownloadButton.tsx`, `web/app/hoot/components/ChatWindow.tsx`, `web/components/hoot/HootMarkdown.tsx`, `web/components/hoot/SharedConversation.tsx`, `web/components/mdx/mermaid.tsx`, `web/app/not-found.tsx`, `web/components/FallingFeather.tsx`, `web/app/docs/api/route.ts`
  - Do:
    - **Turnstile** (`:132-134`): pass `theme: resolvedTheme === 'light' ? 'light' : 'dark'` from `useTheme()`, and re-render the widget when it changes. Remove the comment about `'auto'`.
    - **DownloadButton** (`:31-34`): drop the "header is always dark" assumption. `text-white` becomes `text-foreground`, or primary-foreground on the cyan fill.
    - **Hoot:** in `ChatWindow.tsx:439` and `SharedConversation.tsx:97`, `prose-invert` becomes `dark:prose-invert`, matching `app/privacy/page.tsx:22`.
    - **mermaid** (`:80-87`): theme the hex fallbacks per `resolvedTheme`, since a missing token previously fell back to dark values.
    - **not-found:** make the canvas rain, glow and glitch read `getComputedStyle` tokens (`--muted-foreground`, `--accent-cyan`) instead of literals, and re-read on theme change.
    - **FallingFeather:** keep the warm drop-shadow, but check it reads on light; reduce its alpha in light only if it smears.
    - **Scalar API reference** (`web/app/docs/api/route.ts`): a standalone HTML page outside the root layout.
      - Stop forcing `darkMode: true`, hide Scalar's own dark-mode toggle, and make the page follow the user's choice.
      - Its inline bootstrap script (it already stamps the nonce) reads `localStorage.owlette_theme`, falling back to `prefers-color-scheme`, then dark. It sets Scalar's mode before Scalar mounts.
      - Check the option names against the installed `@scalar/*` version.
      - Theme its custom `--scalar-color-*` CSS for both modes from the app tokens' values.
  - Done when:
    - The Turnstile widget matches the theme on login and register in both themes.
    - Hoot markdown is legible in both themes.
    - The 404 page works in both.
    - `/docs/api` matches the user's choice (and the OS when the choice is `system`) with no flash.
    - `npx eslint` is clean.
  - Depends on: Task 1.1, Task 1.2

- [ ] **Task 2.5: Desktop tokens**
  - Files: `desktop/src/globals.css`, `desktop/src/lib/surfaces.ts`, `desktop/src/test/design-system.test.tsx`
  - Do:
    - **Port Task 1.1's token work** from `web/app/globals.css` into `desktop/src/globals.css`: the light `:root` values, the new families, and the tokenised base CSS (scrollbars, focus outline, dot-grid, select scrollbar, flash keyframe).
    - **Move `--btn-hover` and `--surface-hover` into the `:root` and `.dark` blocks** with web's values (dark: the blue hue-250 tint), and delete the local `--btn-hover` in `.btn-sweep` (~:593). This also fixes the known drift recorded in `DESIGN.md`.
    - **Update `MENU_SURFACE`** in `surfaces.ts` to the same token recipe as web (Task 2.1).
    - **Update `design-system.test.tsx`:**
      - `:93-98` asserts the exact `MENU_SURFACE` string; change it to the new recipe.
      - Add an assertion that every token in `.dark` also exists in `:root`.
  - Done when:
    - `cd desktop && npm test && npm run lint` pass locally (they do not run in CI yet).
    - The desktop app looks unchanged in dark: `npm run tauri dev`, then compare with `web/public/docs-screens/agent-*.png`.
  - Depends on: Task 1.1

## Wave 3: Web migration sweeps + desktop theme runtime

Apply `plan.md` → "migration rules". These tasks touch disjoint files. If you find a file not listed in your task, leave it and note it in the Log; don't edit it. Each sweep finishes with `grep` showing zero raw palette or `text-white` / `text-gray-900` utilities in its files, except theme-invariant items listed in `plan.md` (scrims, brand marks, swoop letterbox).

- [ ] **Task 3.1: Dashboard and machines**
  - Files:
    - everything under `web/app/dashboard/**`
    - `web/components/MachineContextMenu.tsx`, `MachineStatusPill.tsx`, `UpdateOwletteButton.tsx`, `RestartScheduleDialog.tsx`, `ScheduleEditor.tsx`, `LiveViewModal.tsx`, `ScreenshotDialog.tsx`, `RemoveMachineDialog.tsx`, `UninstallDialog.tsx`, `SiteMachinesList.tsx`, `WeekSummaryBar.tsx`, `DayPillSelector.tsx`, `TimezoneChip.tsx`, `OsLabel.tsx`
    - `web/components/charts/DisplayLayoutPanel.tsx`, `DisplayEditorDialog.tsx`, `DisplayMonitorTable.tsx`, `TimeRangeSelector.tsx`, `DisplayCanvas.tsx`
    - `web/lib/scheduleDefaults.ts`
    - `web/__tests__/components/MachineCardView.rebootPending.test.tsx`
  - Do:
    - Migrate per the rules.
    - **Status pill:** offline and restarting use `bg-danger-solid text-danger-solid-foreground`; the online dot uses `bg-success`.
    - **`scheduleDefaults.BLOCK_COLORS`:** give each hue a light pairing (solid fill plus its foreground) that keeps the eight hues distinct on a light card.
    - **`UpdateOwletteButton`** already has `dark:` pairs: normalise them onto tokens.
    - **`MachineCardView.rebootPending.test.tsx`** asserts the class contains `'amber'`; change it to the warning token class.
  - Done when:
    - Grep is clean for these files.
    - The dashboard list, card and machine-detail views look unchanged in dark.
    - They are fully legible in light.
    - `npm test` passes and `npx eslint` is clean.
  - Depends on: Task 2.1, Task 2.2, Task 2.3

- [ ] **Task 3.2: Shared dialogs and account surfaces**
  - Files: `web/components/AccountSettingsDialog.tsx`, `DeploymentDialog.tsx`, `SystemPresetDialog.tsx`, `SchedulePresetDialog.tsx`, `ApplyScheduleToMachinesDialog.tsx`, `ManageSitesDialog.tsx`, `ManageUserSitesDialog.tsx`, `CreateSiteDialog.tsx`, `WebhookSettingsDialog.tsx`, `ApiKeysManager.tsx`, `ApiKeyCreateForm.tsx`, `ApiKeyScopeEditor.tsx`, `ApiKeyScopeFields.tsx`, `MfaFactorsSection.tsx`, `PasskeyManager.tsx`, `BackupCodesPanel.tsx`, `ConfirmDialog.tsx`, `ReportBugDialog.tsx`, `InstallerChecksumStatus.tsx`, `SecurityVersionBanner.tsx`, `NoSitesEmptyState.tsx`, `InAppBrowserNotice.tsx`, `TimezoneSelect.tsx`, `CopyButton.tsx`, `UserAvatar.tsx`, `TalonSuccessorPicker.tsx`, `ErrorBoundary.tsx`, `RequireAdminAccess.tsx`, `LoadingWord.tsx`
  - Do:
    - Migrate per the rules.
    - `AccountSettingsDialog` has 70 `text-white`; most become `text-foreground`.
    - The Slack and Discord brand badges in `WebhookSettingsDialog` (`:313,316,589,594`) are theme-invariant; keep them.
  - Done when:
    - Grep is clean for these files.
    - Each dialog opens legibly in light and unchanged in dark.
    - `e2e/specs/account/preferences.spec.ts` still passes.
    - `npx eslint` is clean.
  - Depends on: Task 2.1, Task 2.2

- [ ] **Task 3.3: Admin, settings, deployments, logs, talons, misc routes**
  - Files: `web/app/admin/**`, `web/components/admin/**` (except `AdminButton.tsx`, done in 2.2), `web/app/settings/**`, `web/app/deployments/**`, `web/app/logs/**`, `web/app/talons/**`, `web/app/cli/**`, `web/app/add/**`, `web/app/demo/**`, `web/app/legal/**`, `web/app/setup/**`, `web/app/share/**` (page UI only; leave `opengraph-image.tsx`), `web/app/unsubscribe/**`
  - Do:
    - Migrate per the rules.
    - Deployment `statusColors` (`deployments/page.tsx:50`) and alert `SEVERITY_COLORS` (`admin/alerts/page.tsx:70`) become status tokens or explicit light/dark pairs.
    - `logs/page.tsx:1032` has a redundant `dark:hover:bg-red-950/50`; remove it.
  - Done when:
    - Grep is clean for these paths.
    - The admin, settings, deployments, logs and talons pages are legible in light and unchanged in dark.
    - `npm test` and `npx eslint` are clean.
  - Depends on: Task 2.2

- [ ] **Task 3.4: Hoot, roost, swoop and auth**
  - Files: `web/app/hoot/**` (ChatWindow was done in 2.4; don't revert it), `web/components/hoot/**`, `web/app/roosts/**`, `web/components/roost/**`, `web/components/Roost*.tsx`, `web/components/ProjectDistributionDialog.tsx`, `web/components/FolderDropzone.tsx`, `web/components/PreUploadSummary.tsx`, `web/components/MinimizedUploadCard.tsx`, `web/components/EmptyStateUpload.tsx`, `web/app/swoop/**`, `web/components/swoop/**`, `web/app/login/**`, `web/app/register/**`, `web/app/forgot-password/**`, `web/app/reset-password/**`, `web/app/setup-2fa/**`, `web/app/verify-2fa/**`, `web/components/auth/**`
  - Do:
    - Migrate per the rules.
    - **Hoot contrast:** re-measure the comments in `MachineTargetPicker.tsx:51` and `ToolCallCard.tsx:150` for the light theme, and update `__tests__/components/MachineTargetPicker.test.tsx:320-337` if the class changes.
    - **Swoop:** keep `[&:fullscreen]:bg-black` and the letterbox black; that is a video surface, not chrome. Presence tints already use `text-chart-*`; verify they read in light.
    - **Auth:** the brand panel vignette uses `--card-recessed`. Check it in light; the light value exists from 1.1. The Google logo hex is invariant.
  - Done when:
    - Grep is clean for these paths.
    - Hoot, roost, swoop and auth are legible in light and unchanged in dark.
    - `npm test` and `npx eslint` are clean.
  - Depends on: Task 2.2, Task 2.4

- [ ] **Task 3.5: Landing light design**
  - Files: `web/components/landing/**`, `web/components/Footer.tsx`, `web/components/ThemedImage.tsx` (new), `web/app/page.tsx` (only if section wrappers need it), `web/app/download/**`, `web/app/for-ai/**` (page UI), `web/app/privacy/page.tsx`, `web/app/terms/page.tsx`
  - Do:
    - **Run `/impeccable` on the landing page** for a light variant of the Mission Control world, with `DESIGN.md` as authority. Persuade mode.
    - **Replace the inline literals with tokens or theme-aware values:**
      - hero and background glows: `HeroSection.tsx:28`, `InteractiveBackground.tsx:109-137`
      - `ValuePropSection.tsx:61,101,119`: the white sheen, black shadows, ring
      - card elevation `shadow-black/30 ring-white/5` in DeveloperSection, DisplaySection and UseCaseSection becomes the elevation tokens
    - **Check the owlette eye mark** (`OwletteEye.tsx`) on light. It is a self-contained dark disc. Decide with the owner whether it needs a light-ground variant. Default: keep the mark, adjust only the surrounding glow.
    - **Create `ThemedImage`**: given `{ dark: string; light: string; alt; …next/image props }`, render both. The dark image gets `className="hidden dark:block"`, the light one `className="dark:hidden"`. Only the visible one may be `priority`; the other is `loading="lazy"`.
      - Use it for `dashboard.png` and every `landing-screens/*` image.
      - Until Task 4.2 produces the light PNGs, pass the dark path for both.
  - Done when:
    - The landing page is designed and legible in light and unchanged in dark.
    - In each theme, devtools Network shows only one hero screenshot requested.
    - Lighthouse LCP doesn't regress against dark.
    - `npx eslint` is clean.
  - Depends on: Task 2.2

- [ ] **Task 3.6: Desktop theme runtime**
  - Files: `desktop/src-tauri/src/window_state.rs`, `desktop/src-tauri/src/lib.rs`, `desktop/src-tauri/src/tray.rs` (only if the window is built or shown there), `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/tauri.macos.conf.json`, `desktop/src-tauri/capabilities/default.json` (only if a JS-side permission is truly needed), `desktop/src/lib/ipc.ts`, `desktop/index.html`, `desktop/src/main.tsx`, `desktop/src/components/AppMenu.tsx`, `desktop/src/lib/theme.ts` (new), `desktop/src/components/AppMenu.test.tsx` (new or extended)
  - Do:
    - **Rust side:**
      - **`window_state.rs`:** add an `appearance` section with `theme: "dark" | "light" | "system"`. Keep the "preserve unknown sections" behaviour. The default when absent is `DEFAULT_THEME` from a Rust const, `"system"` (the window follows the OS), with dark as the fallback when the OS gives no signal.
      - **Before the window is shown** (`lib.rs:160-170` / `tray.rs:481-492`): read the value. Call `window.set_theme(Some(Theme::Dark|Theme::Light))`, or `None` for system. Set the background colour to match: dark `#020B16`; light equals the light `--background` as hex; for system, decide from the OS theme.
      - **Add a `set_appearance_theme` command** that persists the value and calls `set_theme` plus the background update on the live window. Add `appearance_theme` to read it back.
      - **`tauri.conf.json` and `tauri.macos.conf.json`:** remove `"theme": "Dark"`. Keep `backgroundColor` as the dark value for the pre-setup frame; the Rust code overrides it before show.
    - **Webview side:**
      - **`index.html`:** keep `class="dark scroll-smooth"` as the fallback before next-themes runs, and let next-themes swap it.
      - **`main.tsx`:** wrap the app in next-themes `ThemeProvider` with `attribute="class"`, `defaultTheme="system"`, `enableSystem`, `enableColorScheme`, and never call `setTheme` in the webview. The class then always follows `prefers-color-scheme`, which the window theme drives. Put that rationale in a lowercase comment.
      - **`desktop/src/lib/theme.ts`:** the `ThemeChoice` type and labels.
      - **`ipc.ts`:** typed wrappers for the two commands.
      - **`AppMenu.tsx`:** a "theme" radio group (dark / light / system, lowercase, lucide `Moon` `Sun` `Monitor`) calling `set_appearance_theme`.
    - **Verify the webview follows the window theme on each OS.** If Linux webkitgtk doesn't, add a Linux-only initialization script that sets the class from the stored value, and note it in a comment.
    - **Test:** `AppMenu` renders the three options and calls the IPC wrapper. Mock IPC as the existing desktop tests do.
  - Done when:
    - On Windows (and on macOS via the `mba` remote, see `reference_mba_access` memory) the app opens in the stored theme with no flash at show, and switching in `AppMenu` re-themes live and persists across restart.
    - With `system`, toggling the OS theme re-themes the app.
    - `cd desktop && npm test && npm run lint` pass.
    - `cargo clippy` and `cargo test` pass in `desktop/src-tauri`.
  - Depends on: Task 2.5

## Wave 4: Desktop components and screenshots

- [ ] **Task 4.1: Desktop component migration**
  - Files: `desktop/src/components/**` (except `AppMenu.tsx`, done in 3.6), `desktop/src/App.tsx`, `desktop/src/lib/processStatus.ts`, `desktop/src/lib/serviceHealth.ts`, `desktop/src/lib/scheduleDefaults.ts`, `desktop/src/components/ProcessDetail.test.tsx`, `desktop/src/components/ProcessList.test.tsx`
  - Do:
    - Apply the web migration rules. The desktop ui primitives (sonner, tooltip, checkbox, switch) mirror Task 2.2.
    - `processStatus.ts:201-221` and `serviceHealth.ts:78-88` become status tokens.
    - `scheduleDefaults` mirrors 3.1's light pairing.
    - Update the colour assertions in `ProcessDetail.test.tsx:251,255` and `ProcessList.test.tsx:221-222`.
  - Done when:
    - Grep is clean in `desktop/src` (outside the brand eye and feather).
    - `cd desktop && npm test && npm run lint` pass.
    - The app is legible in light and unchanged in dark.
  - Depends on: Task 2.5, Task 3.6

- [ ] **Task 4.2: Themed screenshot pipeline**
  - Files: `web/playwright.screenshots.config.ts`, `web/e2e/screenshots/docs-helpers.ts`, `web/e2e/screenshots/*.spec.ts` (output path only), `web/scripts/refresh-docs-screens.mjs`, `web/mdx-components.tsx`, `web/components/landing/*` (only the `ThemedImage` `light` paths), `web/e2e/screenshots/README.md`, `web/playwright.desktop-screenshots.config.ts`, `web/e2e/desktop-screenshots/agent-app.spec.ts`, `web/e2e/desktop-screenshots/README.md`
  - Do:
    - **Screenshots config:** two projects, `dark` (`colorScheme: 'dark'`) and `light` (`colorScheme: 'light'`). Both seed `preferences.theme` to match, via `pinAdminSiteContext` in `docs-helpers.ts:9-29`, and `localStorage.owlette_theme` via `addInitScript`.
      - The light project writes `<name>-light.png` next to the dark file.
      - Expose the output path helper in `docs-helpers.ts` so specs don't hand-build names.
    - **Desktop screenshots:** set the app theme through the new IPC command (or `layout.json`) before capture, and write `agent-*-light.png`.
    - **`refresh-docs-screens.mjs`:** `captured.json` gains `"themes": ["dark","light"]`, and `--check` fails if any dark shot lacks its light pair or vice versa.
    - **`mdx-components.tsx`:** override `img`. For `/docs-screens/x.png`, render a `ThemedImage` with `light: /docs-screens/x-light.png` when that file exists at build time. Use a manifest generated by the refresh script, not a runtime `fs` call.
    - **Landing:** point the `ThemedImage` `light` props at the new files.
    - Run the web capture: `npm run screenshots`.
    - Run the desktop capture where an installed exe is available. If not, leave `--check` reporting the missing desktop light shots and note it in the Log; it is a release-time step.
  - Done when:
    - `public/landing-screens/*-light.png`, `public/dashboard-light.png` and `public/docs-screens/*-light.png` exist (web set).
    - Landing and docs swap images with the theme.
    - `node web/scripts/refresh-docs-screens.mjs --check` passes, or reports only the desktop light shots pending a release build.
    - The READMEs describe the light capture.
  - Depends on: Task 3.1, Task 3.2, Task 3.3, Task 3.4, Task 3.5, Task 3.6

## Wave 5: Verify and guard

- [ ] **Task 5.1: e2e — theme behaviour and a light a11y pass**
  - Files: `web/e2e/specs/account/theme.spec.ts` (new), `web/e2e/specs/a11y/route-smoke.spec.ts`, `web/playwright.config.ts`, `web/e2e/specs/account/preferences.spec.ts`
  - Do:
    - **`theme.spec.ts`:**
      - Open account settings → preferences and choose light in the appearance control: `<html>` gets `class` containing `light` and not `dark`.
      - `users/{uid}.preferences.theme === 'light'`, read through the Admin SDK as `preferences.spec.ts` does.
      - Reload, and assert the class is present at `DOMContentLoaded`, before hydration. Check it from `addInitScript` with a `MutationObserver`, or by reading `document.documentElement.className` in a `page.on('domcontentloaded')` evaluate.
      - In a fresh context with no localStorage but Firestore `light`, after login the page converges to light and stays there for 5s. That covers the no ping-pong rule.
      - A signed-out visitor follows the OS: `colorScheme: 'light'` renders light and `colorScheme: 'dark'` renders dark. With JS disabled, the page is dark.
      - A user with no `preferences.theme` follows the OS the same way, and `system` in the profile tracks an OS change live (`page.emulateMedia({ colorScheme })`).
      - Restore the user's theme in `afterEach`.
    - **`route-smoke.spec.ts`:** parameterise over `['dark', 'light']`. Seed `localStorage.owlette_theme` via `addInitScript`. Keep axe `wcag2a`/`wcag2aa`, failing on serious or critical. Add `/` (landing) and a `/docs` page to the route list if they aren't there.
    - **`preferences.spec.ts`:** its `afterEach` (`:22-34`) restores `theme` too.
    - **`playwright.config.ts`:** add nothing unless the light pass needs its own project; prefer the parameterised spec.
  - Done when:
    - `npm run e2e` passes, including both theme passes of route-smoke with zero serious or critical findings in light.
    - Total CI e2e time stays under the 30-minute job limit; note the delta in the Log.
  - Depends on: Task 3.1, Task 3.2, Task 3.3, Task 3.4, Task 3.5

- [ ] **Task 5.2: Lint guardrail**
  - Files: `web/eslint.config.mjs`, `web/__tests__/eslint/no-raw-palette.test.ts` (new)
  - Do:
    - **Add a `no-restricted-syntax` rule** for `web/app/**`, `web/components/**` and `web/lib/**` (`*.ts`, `*.tsx`). It flags `Literal` and `TemplateElement` values matching `\b(?:[a-z-]+:)*(?:text|bg|border|ring|fill|stroke|from|to|via|outline|divide|shadow|decoration|placeholder|caret|accent)-(?:red|green|emerald|amber|yellow|orange|blue|sky|cyan|teal|violet|purple|pink|rose|slate|gray|zinc|neutral|stone|lime|indigo|fuchsia)-\d{2,3}\b` and `\btext-(?:white|gray-900)\b`.
      - Message: "use a theme token (see DESIGN.md), not a raw palette colour".
      - Allowlist via `ignores`: the server-only email and webhook files, OG image routes, `OwletteEye.tsx`, `OwletteFeather.tsx`, and the Google-logo sections (use inline `eslint-disable-next-line` with a reason there).
    - **Fix the stragglers.** Any file the rule flags that no Wave 3 task listed gets migrated here per the migration rules. List those files in the Log.
    - **Unit test**, in the style of `__tests__/eslint/no-client-firestore-writes.test.ts`:
      - the rule flags a sample `className="text-red-400"`;
      - it passes `className="text-danger"`.
  - Done when:
    - `npm run lint` passes on the whole web tree.
    - The test passes.
    - Reintroducing `text-red-400` in any component fails lint.
  - Depends on: Task 3.1, Task 3.2, Task 3.3, Task 3.4, Task 3.5

- [ ] **Task 5.3: Desktop checks in CI**
  - Files: `.github/workflows/rust-build.yml` (or a new `.github/workflows/desktop.yml` if cleaner)
  - Do:
    - Add a job that runs on changes to `desktop/**`: `npm ci`, `npm run lint` (oxlint), `npm test` (vitest), `npm run typecheck` in `desktop/`, on Node 22 per `.nvmrc`.
    - Match the trigger and cache style of the existing workflows.
    - Don't touch the cargo jobs.
  - Done when:
    - The job runs green on a push to a branch.
    - Breaking a desktop test makes it red; try it on a scratch branch, then revert.
  - Depends on: Task 4.1

## Wave 6: Docs and release gate

- [ ] **Task 6.1: Docs**
  - Files: `DESIGN.md`, `.impeccable/design.json`, `.claude/skills/frontend-dev-guidelines.md`, `web/content/docs/dashboard/account-settings.mdx`, `web/content/docs/reference/firestore-data-model.mdx`, `desktop/README.md`, `docs/changelog.md`, `web/content/docs/changelog.mdx`
  - Do:
    - **`DESIGN.md`:** finalise the two-theme system: the Overview line, light names for every token, status, band and series families, the theme-switch mechanics. Regenerate `.impeccable/design.json`.
    - **`frontend-dev-guidelines.md:66`:** replace the stale next-themes claim with the real setup: `web/components/ThemeProvider.tsx`, `web/lib/theme.ts`, tokens in `globals.css`, the lint guardrail.
    - **`account-settings.mdx`:** document the theme setting and the user-menu toggle.
    - **`firestore-data-model.mdx` (`:412-432`):** add the `preferences` map to the `users/{userId}` table, including `theme`. It is currently missing entirely.
    - **`desktop/README.md`:** update `:46` (no static `dark` class), `:277-288` (tokens), `:321-326` (the window theme is set from `layout.json` before show), and `:309-318` (tests now in CI).
    - **Changelogs:** an unreleased "light mode" entry in both.
  - Done when:
    - Every listed doc matches the shipped behaviour.
    - The docs build passes (`npm run build` in `web/`).
  - Depends on: Task 5.1, Task 5.2


- [ ] **Task 6.2: Visual review of every page in both themes**
  - Files: `web/e2e/screenshots/theme-review.spec.ts` (new, review-only and not part of `npm run e2e`), plus fixes in whichever files the review finds
  - Do:
    - **Capture every route** in dark and light, at 1280×800 and 390×844. Seed realistic data the same way the docs screenshot specs do.
      - Routes: landing, download, for-ai, privacy, terms, legal, demo, login, register, forgot/reset password, 2FA setup and verify, add, dashboard (card and list, machine detail panel open), deployments, roosts (list and detail), hoot (chat, share), swoop shell, talons, logs, settings (api keys, webhooks, alerts), every admin page, docs (index, an article, mermaid, code blocks, /docs/api), 404.
      - Also capture the menus, dialogs and toasts that matter: machine menu, account settings with the appearance control, deployment dialog, screenshot dialog, a toast of each status.
    - **Review every capture by eye** against `DESIGN.md` and the craft floor.
      - Look for: contrast, hierarchy, depth, chart legibility, status colours, borders that vanish on white, glows or sheens that smear on light, and screenshots or images that clash.
      - Fix everything found in one batch, then re-capture once to confirm.
    - **Publish the captures as a gallery artifact** (both themes side by side) for the owner's review before merge.
    - **Desktop:** do the same for the tray app's main screens on Windows, plus macOS via the `mba` remote.
  - Done when:
    - No capture shows a defect.
    - `/preflight` is green.
    - The gallery link is in the PR description.
  - Depends on: every Wave 1–5 task and Task 6.1

## Log
### 2026-10-03
- Wave 1 done. Light palette "the same room by day" is in the `:root` block, with the status, band, series, chart, elevation and chrome families defined in both themes; every original `.dark` line is unchanged. Dark `success-solid` moved to green-700, because white on green-600 was 3.3:1. `theme-contrast.test.ts` holds both themes to AA. The provider follows the OS, with dark as the server-rendered fallback. Playwright (and the live smoke) are pinned dark.
- Owner brief: build light mode fully, on every page. It follows the OS with dark as the fallback, and the switch is concealed in the profile. The plan was amended above (Tasks 1.2, 2.1, 2.4, 5.1 and 6.2). It moved to `dev/active/` (force-added, so it stays tracked) and runs on `feat/light-mode`.

### 2026-10-01
- Plan created from the `/impeccable document` session (`DESIGN.md` + `PRODUCT.md` at the repo root). Owner decisions: default follows the OS, landing in scope, desktop in scope, plan tracked in `dev/planned/`.
