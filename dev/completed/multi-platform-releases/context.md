# multi-platform releases — Context
**Last updated**: 2026-09-25

## Key Files

### Create
- `web/lib/installerPlatform.ts` — the one pure module for platform keys, labels, extension mapping, UA / navigator detection, `normalizeInstallerFiles`
- `web/__tests__/lib/installerPlatform.test.ts`, `web/__tests__/api/installer-files.test.ts`, `web/__tests__/components/DownloadButton.test.tsx`, `web/__tests__/hooks/useOwletteUpdates.test.tsx`
- `scripts/upload-installer.mjs` — n-file upload → finalize flow

### Modify — record and API
- `web/app/api/installer/upload/route.ts` (platform key, three extensions, storage path per extension, transactional merge on finalize, alias refresh, latest from the merged doc)
- `web/lib/installerVersionResponse.server.ts`, `web/app/api/installer/[version]/set-latest/route.ts`, `web/openapi.yaml`
- `web/app/download/route.ts` (`?os=`, User-Agent, 404 for a missing platform file)

### Modify — consumers
- `web/hooks/useInstallerVersion.ts`, `web/components/DownloadButton.tsx`, `web/app/dashboard/page.tsx`, `web/app/dashboard/components/AddMachineButton.tsx`
- `web/lib/firebase.ts` (`getLatestOwletteVersion`, `sendOwletteUpdateCommand` — stop overwriting the URL), `web/hooks/useOwletteUpdates.ts`, `web/components/UpdateOwletteButton.tsx`
- `web/components/admin/UploadInstallerDialog.tsx`, `web/hooks/useInstallerManagement.ts`, `web/app/admin/installers/page.tsx`
- `cli/src/commands/installer.ts`, `sdks/node/src/resources/installer.ts`, `sdks/python/roost/resources/installer.py`

### Modify — builders and release
- `agent/build/linux/build.sh` (one merged deb, tarball sha256), `agent/build/macos/build.sh` (API-key notarization flags, tarball sha256)
- `.github/workflows/build-installer.yml`, `scripts/env-manifest.json`, `docs/internal/slsa-build-l3.md`
- Docs: `web/content/docs/agent/{installation,self-update}.mdx`, `web/content/docs/dashboard/admin/installer-management.mdx`, `web/content/docs/cli/reference/installer.mdx`, `web/content/docs/{getting-started,dashboard/getting-started}.mdx`, `docs/runbooks/agent-installer-release.md`, `.claude/skills/build-system.md`, `README.md`

### Unchanged on purpose
- `web/app/api/sites/[siteId]/machines/[machineId]/commands/route.ts` — the four `update_owlette` params are the contract; the agent reads them as today
- `agent/src/owlette_service.py` self-update, `agent/src/installer_utils.py` — the `.pkg`/`.deb` paths already exist and are tested
- `firestore.rules` — `installer_metadata/**` is already public-read, service-account-write

## Decisions

1. **Keys are the fleet's own values** — `windows_x64`, `macos_arm64`, `linux_x64`; not `x86_64`/`amd64`, because the agent writes `x64` and the dashboard must build the key from the machine record without a translation table. `linux_arm64` is reserved (no arm64 runner, no arm64 fleet).
2. **The flat fields stay and mean Windows** — every reader today (dashboard hook, `/download`, CLI, both SDKs, the VM verify script, the OpenAPI `required` list) reads `download_url`; keeping it as an alias of `files.windows_x64` means no reader breaks and no backfill runs.
3. **A doc without `files` normalises to `windows_x64`** in one shared pure module used by the server builder and the client hook, because the hook reads Firestore directly and the two must agree byte for byte.
4. **Finalize merges in a transaction** — the current `.set()` would erase the other platform; set-latest writes the builder output so `files` survives promote/rollback.
5. **`/download` falls back to Windows for an unknown User-Agent** (curl, bots, scripts, existing links) and returns 404 for a platform the version lacks — a silent exe on a Mac is worse than an error.
6. **Intel Macs** cannot be told apart by User-Agent. The UI labels macOS "apple silicon", disables the item where Chromium client hints report `x86`, and the pkg's `hostArchitectures="arm64"` refuses the install everywhere else. No server-side Intel detection.
7. **One merged Linux deb** — the agent's self-update installs one file and the agent deb's `Depends: owlette (>= v)` on the app deb fails the simulate check on every version skew; `Provides/Replaces/Conflicts: owlette` carries the kiosk across from the two-package install.
8. **Filenames** are `Owlette-Installer-v<ver>.{exe,pkg,deb}` for all three, so the digest step, the release assets and the storage path share one convention. apt and `installer` need the extension, not the name.
9. **The fleet update never overwrites the URL it is given** — the re-read of `latest.download_url` in `sendOwletteUpdateCommand` is the line that would send a Mac an exe. A machine whose platform has no file is skipped and named, not sent the wrong file.
10. **CI stays out of Firebase** — the workflow builds, signs, notarizes, attests and attaches; publishing to the installer catalog remains the runbook step, now one script for n files. The Apple secrets live in a tag-restricted `release` environment; a `workflow_dispatch` by a write-access user can still reach it, which is acceptable and stated.
11. **The silent-install snippet stays Windows-only** — `/ADD= /SILENT` are Inno flags and the e2e video asserts the exact string; macOS and Linux pair from the app (postinstall preseed exists for both).

## Next Steps

1. Wave 1 in parallel: 1.1 (the shared module, everything else imports it), 1.2 (merged deb on the kiosk VM — the riskiest piece, start it first), 1.3 (macOS notarization flags, verify with the MBA LaunchAgent build).
2. Owner-side, can start now: add the eight Apple secrets and the `release` environment on GitHub (task 4.2 blocks on them); install the notarized pkg on the MBA with sudo (task 5.1 needs a Mac that self-updates).
3. Wave 2 once 1.1 lands; the dev upload in 2.4 waits for the owner's go.
