# Light mode — Context
**Last updated**: 2026-10-01

## Key Files

### Create
- `web/lib/theme.ts`: `THEMES`, `ThemeChoice`, `DEFAULT_THEME`, `THEME_STORAGE_KEY`
- `web/components/ThemeProvider.tsx`: the next-themes wrapper (nonce, class attribute)
- `web/components/ThemePreferenceSync.tsx`: Firestore ↔ next-themes sync
- `web/components/ThemeMenuItems.tsx`: the dark / light / system radio group
- `web/components/ThemedImage.tsx`: a theme-paired image with no double fetch
- `web/__tests__/styles/theme-contrast.test.ts`: WCAG contrast over both token blocks
- `web/__tests__/lib/usageColorUtils.test.ts`
- `web/__tests__/components/ThemePreferenceSync.test.tsx`
- `web/__tests__/eslint/no-raw-palette.test.ts`
- `web/e2e/specs/account/theme.spec.ts`
- `desktop/src/lib/theme.ts`
- a desktop CI job (in `.github/workflows/rust-build.yml` or a new `desktop.yml`)

### Modify: foundation
- `web/app/globals.css`: light `:root`, the new token families, tokenised base CSS
- `web/app/docs/docs.css`: drop the forced `color-scheme: dark`; scope overrides off `:root`
- `web/app/layout.tsx`: provider, nonce, `suppressHydrationWarning`, Toaster, `viewport.themeColor`
- `desktop/src/globals.css`, `desktop/src/lib/surfaces.ts`
- `web/playwright.config.ts`, `playwright.screenshots.config.ts`, `playwright.videos.config.ts`, `e2e/videos/video-helpers.ts`

### Modify: preference and controls
- `web/contexts/AuthContext.tsx`: `UserPreferences.theme`, `newPrefs` and the equality check
- `web/components/PageHeader.tsx`: the user-menu theme group, tokenised `MENU_SURFACE`, the header fade
- `web/components/AccountSettingsDialog.tsx`: the preferences theme select
- `desktop/src-tauri/src/window_state.rs`, `lib.rs`, `tray.rs`, `tauri.conf.json`, `tauri.macos.conf.json`
- `desktop/src/lib/ipc.ts`, `index.html`, `main.tsx`, `components/AppMenu.tsx`

### Modify: migration
About 1,400 class edits across about 110 web files and 14 desktop files. Each Wave 3 task and Task 4.1 has an exact file list. The largest files:

| File | Raw palette | `text-white` |
|---|---|---|
| `MachineContextMenu.tsx` | 46 | – |
| `admin/users/page.tsx` | 41 | – |
| `MachineCardView.tsx` | 37 | 13 |
| `ProjectDistributionDialog.tsx` | 35 | 17 |
| `MachineListView.tsx` | 34 | 14 |
| `AccountSettingsDialog.tsx` | 28 | 70 |
| `DeploymentDialog.tsx` | – | 34 |

### Modify: data-viz and third parties
- `web/lib/usageColorUtils.ts`, `temperatureUtils.ts`, `networkUtils.ts`, `diskIOUtils.ts`
- `web/components/charts/ChartTooltip.tsx`, `MetricsDetailPanel.tsx`, `SparklineChart.tsx`
- `web/components/TurnstileWidget.tsx`, `DownloadButton.tsx`, `mdx/mermaid.tsx`
- `web/app/not-found.tsx`
- hoot `ChatWindow.tsx`, `SharedConversation.tsx`

### Modify: screenshots, guard and docs
- `web/scripts/refresh-docs-screens.mjs`, `web/mdx-components.tsx`, `web/e2e/screenshots/docs-helpers.ts`, `web/e2e/desktop-screenshots/agent-app.spec.ts`
- `web/eslint.config.mjs`
- `DESIGN.md`, `.impeccable/design.json`, `.claude/skills/frontend-dev-guidelines.md`
- `web/content/docs/dashboard/account-settings.mdx`, `web/content/docs/reference/firestore-data-model.mdx`
- `desktop/README.md`, `docs/changelog.md`, `web/content/docs/changelog.mdx`

### Deliberately untouched
- `firestore.rules`: no change needed. `preferences` is allowlisted, and `wave-hardening.test.ts:200-204` already writes `preferences.theme`.
- Emails (`lib/emailTemplates.server.ts`), webhook embeds, OG image routes.
- The Scalar API reference (`app/docs/api/route.ts`): it keeps its own dark toggle. Syncing it would need a cookie mirror; that is a possible follow-up.
- Brand marks (the OwletteEye and feather hex; Google, Slack and Discord), scrims, and the swoop video letterbox.

## Decisions

1. **The default is `system`, but it is flipped last (Task 6.2).** `DEFAULT_THEME` stays `'dark'` through the migration, so dev never shows OS-light users a half-migrated light theme. Owner decision, 2026-10-01.
2. **Landing, marketing and docs follow the theme.** They get a light design pass (3.5) and paired screenshots (4.2). Owner decision, 2026-10-01.
3. **The desktop app is in scope** (2.5, 3.6, 4.1). It keeps its own preference in `layout.json`, because it has no Firestore access. Owner decision, 2026-10-01.
4. **next-themes is the runtime.** It is already installed in both apps, sonner and mermaid already call `useTheme`, it supports `nonce`, and fumadocs re-exports its `useTheme`, so the root provider feeds the docs with no second provider.
5. **Persistence is hybrid.** localStorage (`owlette_theme`) owns first paint, and Firestore `preferences.theme` is the cross-device source of truth. This follows the `owlette_current_site` pattern. Sync applies Firestore only when it differs from the last value it wrote, which prevents ping-pong.
6. **Dark is immutable.** No `.dark` value changes. New tokens take dark values equal to the classes they replace, so the sweeps are visually no-ops in dark, and the existing dark e2e/a11y suite is the regression gate.
7. **Light interactive cyan is a new brand value.** Signal cyan is about 2:1 on white, so light uses a deeper cyan (L about 0.50–0.56) with near-white `--primary-foreground`. It is decided in 1.1 and recorded in `DESIGN.md`.
8. **Status colour is semantic tokens:** danger, warning, success, info, each with surface, border, solid and solid-foreground. The ad-hoc red, amber, green and blue clusters (about 450 utilities) map onto them, and `variant="destructive"` / `ghost-destructive` absorb the ad-hoc destructive buttons.
9. **On desktop, the window theme is the single switch.** Rust sets `set_theme` and the background before show. The webview runs next-themes in `system` and follows `prefers-color-scheme`. There is no async IPC read before first paint. Linux webkitgtk must be verified, with an init-script fallback on that OS only.
10. **The guardrail is ESLint `no-restricted-syntax`**, not a new package, and lands after the sweeps (5.2). Desktop vitest and oxlint join CI (5.3) because they never ran there.
11. **The plan lives in `dev/planned/light-mode/`.** It is tracked in git, so it has a backup. Move it to `dev/active/` when execution starts.

## Next Steps

1. When execution starts, move the folder to `dev/active/light-mode/` and keep a tracked copy. `dev/active/` is gitignored; force-add it, or keep `dev/planned/` in sync.
2. Commit `PRODUCT.md`, `DESIGN.md` and `.impeccable/design.json` first. Task 1.1 builds on `DESIGN.md`.
3. Start Wave 1 with `/execute`. Task 1.1 is a design task: run `/impeccable` for the light palette before writing any values, and get the owner's eye on the light cyan before the sweeps begin.
