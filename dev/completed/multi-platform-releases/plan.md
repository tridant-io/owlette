# multi-platform releases — Plan
**Created**: 2026-09-25 | **Status**: Active

## Summary

One installer version carries a `files` map keyed by the fleet's own platform key (`windows_x64`, `macos_arm64`, `linux_x64`; `linux_arm64` reserved), so a release ships the Windows exe, the Apple silicon pkg and one Linux deb under one version, one latest pointer and one changelog entry. The flat Windows fields (`download_url`, `checksum_sha256`, `file_size`) stay as an alias of `files.windows_x64`, so every existing reader keeps working. Downloads auto-detect the platform with an explicit override, and the fleet update sends each machine the file for its own platform.

## Owner rulings (do not relitigate)

- Apple silicon only for macOS (`hostArchitectures="arm64"`, macOS ≥ 15). An Intel Mac is "not supported", never a download.
- Linux is one `.deb` link. The agent and desktop packages merge into one package.
- One link per platform.

## What research settled

- The agent reports `arch` as `x64` | `arm64` (never `x86_64`/`amd64`) and `osFamily` as `windows` | `macos` | `linux` (`agent/src/shared_utils.py:257-287`). A missing `osFamily` is a pre-3.4 Windows agent. The machines API exposes both since PR #237.
- The agent already self-updates from a `.pkg` (run-once launchd job, `installer -pkg`) and a `.deb` (`apt-get install --simulate` then `systemd-run … apt-get install -y`) — `agent/src/installer_utils.py:462-466, 665-814`. It refuses the wrong artifact by magic bytes. Nothing agent-side changes except the Linux package shape.
- Linux ships two debs and `owlette-agent` depends on `owlette (>= v)`, so a single-file self-update fails its simulate check on every version skew (`agent/build/linux/build.sh:85, 100-106`). One merged deb is required.
- Finalize replaces the whole version doc with `.set()` (`web/app/api/installer/upload/route.ts:318-335`) and set-latest rebuilds `latest` from a fixed field list (`installerVersionResponse.server.ts`, `set-latest/route.ts:83-90`). Both erase a second platform's entry. These are the two server seams.
- `sendOwletteUpdateCommand` re-reads `latest.download_url` and overwrites the URL it was handed (`web/lib/firebase.ts:211-221`); `useOwletteUpdates` never looks at `osFamily`/`arch`; the commands route copies exactly four `update_owlette` params (`installer_url`, `deployment_id`, `target_version`, `checksum_sha256`) — the contract does not change.
- A User-Agent cannot tell an Intel Mac from Apple silicon. Chromium exposes it via `navigator.userAgentData.getHighEntropyValues(['architecture'])`; Safari does not. The pkg refuses Intel itself, so: the UI labels macOS "apple silicon", disables it where client hints say x86, and the installer is the backstop elsewhere.
- `useInstallerVersion` reads `installer_metadata/latest` straight from Firestore (public read), so the client normaliser and the server builder must agree exactly: one shared pure module.
- The release workflow builds one exe on `windows-latest` with one SLSA subject (`.github/workflows/build-installer.yml`). The macOS and Linux builders exist but no workflow runs them. Apple secrets are not registered anywhere yet (eight names in `dev/active/tri-platform-agent/tasks.md:56`).

## Approach

### Record
```
installer_metadata/data/versions/{v}
  version, release_notes, uploaded_at, uploaded_by, release_date, deletedAt   (version-level, unchanged)
  download_url, checksum_sha256, file_size                                     (alias of files.windows_x64, unchanged)
  files: {
    windows_x64: { download_url, checksum_sha256, file_size, file_name, uploaded_at },
    macos_arm64: { … },
    linux_x64:   { … },
  }
installer_metadata/latest   — the same shape (release_date as ISO string, plus promoted_at/promoted_by)
```
A doc without `files` normalises to `{ windows_x64: <top-level fields> }`. No backfill.

### Upload (3-step flow, same verbs)
- POST accepts `platform` (one of the keys) or derives it from the `fileName` extension: `.exe → windows_x64`, `.pkg → macos_arm64`, `.deb → linux_x64`. Storage path `agent-installers/versions/{v}/Owlette-Installer-v{v}.{ext}` (`-arm64.deb` for `linux_arm64` when it exists).
- PUT finalize runs a transaction: creates the version doc with the version-level fields if absent, merges `files.<key>`, refreshes the alias when `<key> === 'windows_x64'`, writes `latest` from the merged doc when `setAsLatest`.
- Response shapes stay valid for existing callers; `files` is added.

### Downloads
- `/download?os=windows|macos|linux` overrides; otherwise the User-Agent decides; unknown → windows; no file for that platform → 404 problem, never a silent exe.
- The dashboard `DownloadButton`, the getting-started card and the "+" modal show the detected platform as the primary action, the other two as explicit links, "apple silicon" on macOS, disabled where client hints say Intel. The landing header keeps `/download`.

### Fleet update
- `useOwletteUpdates` picks `files[osFamily_arch]` per machine (missing → `windows_x64`), skips a machine whose platform has no file in the latest version and lists it with the reason, and `sendOwletteUpdateCommand` sends the URL and checksum it was given. Command params unchanged.

### Release
- `build-windows` (as today), `build-macos` (macos-15, temp keychain from the p12 secrets, API-key notarization, staple check), `build-linux` (ubuntu-24.04, one deb) → `digest` (n `sha256sum` lines, base64) → `provenance` (unchanged generator, one `.intoto.jsonl`) → `release` and `verify` over every file. Apple secrets in a tag-restricted GitHub Environment. CI does not push to Firebase; `scripts/upload-installer.mjs` runs the n-file upload from the runbook.

## Waves

See `tasks.md`. Wave 1 foundations (helper module, merged deb, notarization flags) → Wave 2 API (upload, builder, `/download`, upload script) → Wave 3 consumers (download button, fleet update, admin, CLI/SDK types) → Wave 4 surfaces and release (add-machine modal, workflow, docs) → Wave 5 proof on dev.

## Risks

- The merged deb changes the package name the kiosk already has installed. `Provides/Replaces/Conflicts: owlette` handles the upgrade, but the kiosk VM is the only proof rig — prove the upgrade there first (task 1.2).
- The first Mac install of the pkg is still the owner's sudo on the laptop; self-update works only after that.
- Apple secrets in a public repo: a fork PR cannot reach a tag-restricted environment; a `workflow_dispatch` by anyone with write access can. Acceptable for this team, stated in the workflow header.
- The client normaliser and the server builder must agree exactly — one shared pure module, tested once (task 1.1).
- `file_name` in the record is display only; the agent names its download by `UPDATE_ARTIFACT_NAMES` and apt/installer need the extension, which the storage path guarantees.

## Success Criteria

- One version on dev holds three files; `GET /api/installer/latest` and `GET /api/installer` return `files` and the unchanged flat fields.
- `/download` serves the right file with and without `?os=`; a Mac UA gets the pkg, curl gets the exe.
- The dashboard download button and the "+" modal show the detected platform and the other two.
- One "update N machines" click self-updates B4A (Windows), the MBA (macOS) and the kiosk (Linux).
- A tag run produces three artifacts under one provenance and `slsa-verifier` passes on each.
- No existing caller of `download_url` changes behaviour; every test in `web/__tests__/api/installer-public.test.ts` that existed before still passes.
