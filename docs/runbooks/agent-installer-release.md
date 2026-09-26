# agent installer release runbook

This runbook is for maintainers shipping the Owlette agent installers: one version carries up to three files, keyed by the fleet's own platform key.

- Windows (`windows_x64`): `Owlette-Installer-vX.Y.Z.exe`
- macOS, Apple silicon on macOS 15+ (`macos_arm64`): `Owlette-Installer-vX.Y.Z.pkg`
- Linux, Ubuntu 24.04 (`linux_x64`): `Owlette-Installer-vX.Y.Z.deb`

It covers both supported artifact paths: a local maintainer build and a CI build with SLSA L3 provenance.

It also covers the 3-step API upload that rolls a version out to agents, plus operational concerns around `setAsLatest`, demotion, smoke testing, and unsigned installer UX.

This document is only for the installer surface. For non-installer deploys, use `/docs/runbooks/production-deploy.md`.

## prerequisites

- Windows machine with admin rights, for the `.exe`.
- Inno Setup 6.x installed, or `%ISCC%` set to the compiler path.
- Node.js 22 + npm, and the Rust toolchain (rustup) with the MSVC C++ build tools — the full build compiles the desktop app.
- The `.pkg` and `.deb`: from the CI release (path b), or `agent/build/macos/build.sh` on a Mac and `agent/build/linux/build.sh` on Ubuntu 24.04.
- `/.claude/.env.local` containing `OWLETTE_API_KEY`.
- API key scope: `installer=*:write`.
- Installer upload keys must be minted by a superadmin.
- Push access to `dev` or the appropriate release branch.
- Firebase admin access for `installer_metadata` visibility, if needed.
- Access to the target base URL: `https://dev.owlette.app` or `https://owlette.app`.
- Test machines for post-release smoke testing: a Windows box, plus an Apple silicon Mac and an Ubuntu 24.04 box for the platforms the release ships.

Accepted auth headers:

```bash
x-api-key: "$OWLETTE_API_KEY"
```

```bash
Authorization: "Bearer owk_..."
```

The upload API requires a unique `Idempotency-Key` on both the `POST` and the finalize `PUT`.

## release paths: local vs ci

| path | use when | output | rollout status |
| --- | --- | --- | --- |
| local manual build | ship now, debug build issues, or release before tagging | local `.exe` (the `.pkg` and `.deb` from their own build hosts) | ready for manual API upload |
| ci build | tagged release, audit trail, SLSA L3 provenance | GitHub Release `.exe`, `.pkg` and `.deb` under one attestation | not rolled out to agents |
| both | need provenance and a separate manual rollout | CI artifact plus local or downloaded upload artifact | checksums will differ if rebuilt |

Decision guide:

- Use local when you need to ship immediately.
- Use local when the build itself is being debugged.
- Use local when the version is not ready for a tag.
- Use CI when this is a tagged release.
- Use CI when you want SLSA L3 provenance attached to the GitHub Release.
- Use CI when you want a durable audit trail.
- Use both when you want a provenanced GitHub Release and a manual agent rollout.
- If using the CI artifact for API upload, download it from the GitHub Release.
- Do not expect a local rebuild to checksum-match the CI artifact.

Local and CI installers are bit-for-bit different because of timestamps and possible Inno Setup nondeterminism.

## path a: local manual build (canonical)

This is currently the canonical release flow.

1. Pick `X.Y.Z`.

Default bump granularity is patch unless a minor or major bump is explicit.

2. Update `/docs/changelog.md` **and** `/web/content/docs/changelog.mdx` — both, same entry.

Add the release section before running the installer build:

```markdown
## [X.Y.Z] - YYYY-MM-DD
```

This is mandatory because every installer bakes the version into its filename.

3. Sync version files.

```bash
node scripts/sync-versions.js X.Y.Z
```

This bumps:

- `/VERSION`
- `/agent/VERSION`
- `/web/package.json`
- `/desktop/package.json` and `/desktop/src-tauri/tauri.conf.json`
- `/desktop/src-tauri/Cargo.toml` and `/agent/host/Cargo.toml` (the lockfiles follow on the next build)
- the version strings in `README.md`, `.claude/CLAUDE.md`, and `docs/internal/version-management.md`

4. Commit and push.

Commit the changelog and version changes, then push to `dev` or the appropriate branch.

5. Build the installer.

`build_installer_full.bat` ends with `pause` and pauses on every error branch, so run it with stdin redirected from `NUL` and invoke it by full path, or it hangs a non-interactive shell:

```powershell
cmd /c "<repo>\agent\build_installer_full.bat < NUL > %TEMP%\installer-build.log 2>&1"
```

Exit code 0 means the `.exe` was built; read the log on failure. Do not use `powershell -Command "& './build_installer_full.bat'"`, which hangs on the trailing `pause`.

Expected runtime is about 5 minutes.

Expected output, and where the other two files come from:

```text
agent/build/installer_output/Owlette-Installer-vX.Y.Z.exe   this build
agent/build/macos/Owlette-Installer-vX.Y.Z.pkg              agent/build/macos/build.sh on a Mac, or the CI release
agent/build/linux/Owlette-Installer-vX.Y.Z.deb              agent/build/linux/build.sh on Ubuntu 24.04, or the CI release
```

Tool discovery:

- Inno Setup respects `%ISCC%`, checks `PATH`, then falls back to the default install path.
- No system Python is used: the build downloads the Python 3.11.8 embeddable zip into `agent/downloads/` and verifies its SHA-256 before extracting it.
- Cargo is found through `%USERPROFILE%\.cargo\bin`, which the build prepends to `PATH`.

6. Upload the release files.

`scripts/upload-installer.mjs` runs the 3-step API upload for every file you hand it — sha256, signed URL, bytes, finalize — so the version lands as one `installer_metadata` doc whose `files` map is keyed by platform, and `latest` carries every entry:

```bash
node scripts/upload-installer.mjs --env dev --version X.Y.Z --notes "Release X.Y.Z" --set-latest \
  agent/build/installer_output/Owlette-Installer-vX.Y.Z.exe \
  agent/build/macos/Owlette-Installer-vX.Y.Z.pkg \
  agent/build/linux/Owlette-Installer-vX.Y.Z.deb
```

- The platform is the extension: `.exe` → `windows_x64`, `.pkg` → `macos_arm64`, `.deb` → `linux_x64`. One file per platform, one to three files.
- `--env dev` reads `OWLETTE_API_KEY` and `OWLETTE_DEV_API_URL`; `--env prod` reads `OWLETTE_API_KEY_PROD` and `OWLETTE_PROD_API_URL`, all from `/.claude/.env.local`.
- `--set-latest` promotes the version once the last file has finalized. Leave it off until you are ready to roll out.
- It prints each file's sha256 and finalize response, then the `files` keys on `GET /api/installer/latest`. A failure stops the run and names the files not published.
- Idempotency keys are deterministic (`installer-<step>-<version>-<platform>`), so a re-run within 24 hours replays the first result for an unchanged request.

The manual curl form is under "the 3-step api upload (in detail)" below.

7. Smoke test.

Upload success is not release success. Run the post-release smoke section before calling the release done.

## path b: ci build (slsa l3 provenance)

The CI build is `.github/workflows/build-installer.yml`.

Triggers:

- tag push matching `v[0-9]+.[0-9]+.[0-9]+`, for example `v2.11.0`
- `workflow_dispatch`

Jobs:

- `build-windows`: `windows-latest`; uses the runner's preinstalled Inno Setup 6 (installing it with Chocolatey only if absent); pins Python 3.11 with `setup-python`; runs `build_installer_full.bat`; uploads artifact `installer-windows`; retains it for 7 days.
- `build-macos`: `macos-15`, in the tag-restricted `release` GitHub environment that holds the eight `APPLE_*` secrets; imports the Developer ID certificates into a temporary keychain, runs `agent/build/macos/build.sh` to sign, notarize and staple the pkg, validates the staple, then removes the keychain and notary key; uploads artifact `installer-macos`. A dispatch run without the secrets stops here and nothing is attested.
- `build-linux`: `ubuntu-24.04`; runs `agent/build/linux/build.sh`; uploads artifact `installer-linux`.
- `digest`: one `sha256sum` line per file, base64-encoded as the SLSA subject list.
- `provenance`: uses `slsa-framework/slsa-github-generator`; creates one in-toto attestation over the three files; signs with Sigstore keyless signing; uploads the attestation as a GitHub Release asset on tag pushes.
- `release`, tag-only: uses `softprops/action-gh-release@v2` and attaches the `.exe`, `.pkg` and `.deb` to the GitHub Release.
- `verify`, tag-only: downloads the three installers and the provenance, then runs `slsa-verifier verify-artifact` over all of them.

CI does not push the installers to Firebase Storage, write `installer_metadata`, update the app's `latest` installer pointer, or replace the manual 3-step API upload.

To roll out CI-built installers to agents, download the exact files from the GitHub Release and hand them to `scripts/upload-installer.mjs` (path a, step 6).

Do not rebuild locally for the upload unless you intend to roll out different bytes.

## the 3-step api upload (in detail)

`scripts/upload-installer.mjs` runs these three steps for every file it is given (see path a, step 6). Use the manual form below only when the script cannot run. The platform (`windows_x64`, `macos_arm64`, `linux_x64`) is derived from the file's extension (`.exe`, `.pkg`, `.deb`); `platform` may also be sent explicitly on step 1 and must then match the extension. Each platform's file is its own three steps under the same version; finalize merges it into the version's `files` map and, for a `.exe`, refreshes the top-level `download_url` alias.

Canonical endpoint:

```text
POST /api/installer/upload
PUT /api/installer/upload
```

Removed endpoint:

```text
/api/admin/installer/upload
```

Use the canonical endpoint only.

The route wraps `withIdempotency(..., { requireKey: true })`, so missing keys hard-fail.

Use a different unique idempotency key for step 1 and step 3.

Do not send an idempotency key to the signed GCS URL in step 2.

### step 1: post /api/installer/upload

Purpose:

- create an upload intent
- validate auth and metadata
- return a signed GCS URL
- record whether finalize should set this version as latest

```bash
API_KEY=$(grep OWLETTE_API_KEY .claude/.env.local | cut -d= -f2)
BASE_URL="https://dev.owlette.app"
VERSION="X.Y.Z"
FILE_NAME="Owlette-Installer-vX.Y.Z.exe"   # or the .pkg / .deb: the three steps run once per file

curl -s -X POST "$BASE_URL/api/installer/upload" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -H "Idempotency-Key: installer-upload-$VERSION-$(date +%s)" \
  -d "{\"version\":\"$VERSION\",\"fileName\":\"$FILE_NAME\",\"releaseNotes\":\"Release $VERSION\",\"setAsLatest\":true}"
```

Use this base URL for production:

```bash
BASE_URL="https://owlette.app"
```

Return shape:

```json
{
  "uploadUrl": "https://storage.googleapis.com/...",
  "uploadId": "...",
  "platform": "windows_x64",
  "storagePath": "...",
  "expiresAt": "..."
}
```

The signed URL has a 15-minute window. If it expires, request a new one.

### step 2: put to signed gcs url

Purpose:

- upload the exact installer bytes to the signed GCS destination

```bash
INSTALLER="agent/build/installer_output/Owlette-Installer-vX.Y.Z.exe"   # or the .pkg / .deb this run is for

curl -X PUT "$UPLOAD_URL" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @"$INSTALLER"
```

Rules:

- use `Content-Type: application/octet-stream`
- use `--data-binary`
- upload the same bytes whose sha256 will be finalized
- do not send `Idempotency-Key`
- do not send the Owlette API key to GCS

### step 3: put /api/installer/upload (finalize)

Purpose:

- finalize the uploaded object
- compute or verify sha256
- write installer metadata
- update `latest` when the upload was created with `setAsLatest:true`

```bash
UPLOAD_ID="<uploadId from step 1>"
SHA256="<hex sha256>"

curl -s -X PUT "$BASE_URL/api/installer/upload" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -H "Idempotency-Key: installer-finalize-$VERSION-$(date +%s)" \
  -d "{\"uploadId\":\"$UPLOAD_ID\",\"checksum_sha256\":\"$SHA256\"}"
```

`checksum_sha256` is optional, but supplying it is preferred.

If supplied and bytes differ, finalize returns `412 checksum_mismatch`.

If omitted, the server computes the checksum.

### common errors

- `400` missing idempotency key: add `Idempotency-Key` to step 1 or step 3.
- `403` wrong scope: confirm `installer=*:write` and superadmin-minted key.
- `412 checksum_mismatch`: recompute sha256 for the exact uploaded file and retry with a new key.
- Expired upload URL: signed URLs last 15 minutes; restart from step 1.
- Wrong route: use `/api/installer/upload`, not `/api/admin/installer/upload`.
- Missing remote checksum: current agents reject installers without `sha256_checksum`.

## preflight checklist

- [ ] Release version `X.Y.Z` is chosen.
- [ ] Bump granularity is patch by default, or minor/major by explicit choice.
- [ ] `/docs/changelog.md` has `## [X.Y.Z] - YYYY-MM-DD`.
- [ ] `/web/content/docs/changelog.mdx` has the SAME entry — this is the one customers read.
- [ ] Agent docs screenshots recaptured against THIS build: `node scripts/refresh-docs-screens.mjs`, and `node scripts/refresh-docs-screens.mjs --check` exits 0. NOT the bare `npm run screenshots:desktop` — that photographs whatever version is already installed.
- [ ] Changelog is updated before `build_installer_full.bat`.
- [ ] `node scripts/sync-versions.js X.Y.Z` has been run.
- [ ] `/VERSION` is bumped.
- [ ] `/agent/VERSION` is bumped.
- [ ] `/web/package.json` is bumped.
- [ ] Version and changelog changes are committed and pushed.
- [ ] Inno Setup 6.x is installed, `%ISCC%` is set, or `PATH` can find `ISCC`.
- [ ] Node.js 22 + npm and the Rust toolchain are available (the build compiles `desktop/`).
- [ ] Every file the release ships is built, one per platform:
  - `agent/build/installer_output/Owlette-Installer-vX.Y.Z.exe`
  - `agent/build/macos/Owlette-Installer-vX.Y.Z.pkg` (when the release ships macOS)
  - `agent/build/linux/Owlette-Installer-vX.Y.Z.deb` (when the release ships Linux)
- [ ] `--env` names the intended environment.
- [ ] `OWLETTE_API_KEY` (dev) or `OWLETTE_API_KEY_PROD` (prod) is loaded from `/.claude/.env.local`.
- [ ] API key scope is `installer=*:write`.
- [ ] `node scripts/upload-installer.mjs` is given one file per platform, with `--set-latest` only when ready to roll out.
- [ ] The run ends with a `latest:` line naming every platform uploaded.
- [ ] Manual curl fallback only: unique `Idempotency-Key` on the POST and the finalize PUT, none on the GCS PUT; `--data-binary` with `Content-Type: application/octet-stream`; `checksum_sha256` supplied on finalize.
- [ ] Any new `self.*` attribute is set in `OwletteService._init_state()`.
- [ ] `agent/tests/unit/test_service_shutdown.py::test_the_hosted_instance_carries_every_shutdown_attribute` passes.
- [ ] `service.log` will be tailed for at least 30 seconds after restart.
- [ ] No blocking IO was added to the 10-second main service loop at `agent/src/owlette_service.py:6557`.
- [ ] ConnectionManager backoff remains `BACKOFF_BASE=30s`.
- [ ] ConnectionManager backoff remains `BACKOFF_MAX=3600s`.
- [ ] ConnectionManager still never gives up.
- [ ] `firebase_admin` is not imported.
- [ ] `agent/src/firebase_client.py` remains the only Firestore REST client path.
- [ ] Token values are not interpolated in log lines.
- [ ] `scripts/check-no-token-logs.mjs` has not been bypassed.
- [ ] Remote installer metadata includes `sha256_checksum`.
- [ ] Maintainer understands `9dccd12`: agents now require `sha256_checksum`.
- [ ] If using CI artifact, it was downloaded from the GitHub Release.
- [ ] If using local artifact, no checksum match with CI is expected.
- [ ] A test machine per platform the release ships is ready for smoke testing (Windows; Apple silicon Mac; Ubuntu 24.04).
- [ ] The cortex CLI pin the shipped agent actually reads exists in the target environment and pins the CLI version the shipped SDK expects (`claude_agent_sdk/_cli_version.py`). A 3.4+ agent reads `installer_metadata/cortex_cli_<osFamily>_<arch>` — `cortex_cli_windows_x64` for a Windows installer — and never the unsuffixed `installer_metadata/cortex_cli`, which every pre-3.4 agent in the field still reads and which must stay current alongside it until the fleet floor is 3.4. Since 3.0.0 the installer no longer bundles `claude.exe`; a missing or stale pin leaves Cortex dead on every fresh install. See `/docs/internal/cortex-cli-provisioning.md`.

## post-release smoke

1. Verify each file is downloadable from `https://owlette.app/download?os=windows`, `?os=macos` and `?os=linux` (or the environment equivalent); a platform the version has no file for answers `404 no <os> build in vX.Y.Z`.
2. Confirm the downloaded filenames and version.
3. Pair a controlled test machine per platform the release ships (Windows; Apple silicon Mac; Ubuntu 24.04) using the new installer.
4. Watch `service.log` for at least 30 seconds after restart.
5. Look for `AttributeError`, crash-loop entries in `logs\service_host.log` (Windows), startup failures, connection failures, and update loop failures.
6. Treat log stability as a release gate because missing service state has caused repeated crash loops before.
7. Confirm the dashboard shows the agent online.
8. Confirm the dashboard shows the released version.
9. Confirm normal service traffic works.
10. Confirm no token values appear in visible logs.
11. With Firebase admin visibility, confirm the version exists in `installer_metadata`.
12. Confirm `sha256_checksum` is present.
13. Confirm `latest` points at the intended version and its `files` map names every platform uploaded (`owlette installer latest` prints one line per file).
14. Confirm active versions still satisfy the deletion floor.

## demote / rollback

Finalize can move `latest` when step 1 used `setAsLatest:true`.

Known demotion path:

- rerun the 3-step flow for the previous good version
- set `setAsLatest:true` in step 1
- finalize that upload

If the older version already exists in `installer_metadata`, an admin endpoint may exist for set-latest-only. That path is unknown and needs maintainer input before use.

Soft-delete is gated by `min-active-versions >= 2`; the system should not delete the only active version.

Rollback caveat:

- customers already auto-updated to a broken version continue running it
- demoting `latest` prevents additional agents from selecting that version
- a higher-version forward fix is the only certain way to reach already-updated agents

Practical sequence:

1. Demote `latest` to stop further rollout.
2. Confirm download metadata points to the previous good version.
3. Smoke test a fresh install against the demoted version.
4. Prepare and ship a higher-version forward fix.

## code signing context

The Windows installer is not Authenticode-signed today. The macOS pkg is Developer ID signed, notarized and stapled by the CI `build-macos` job; a local `agent/build/macos/build.sh` run without the signing identities produces an unsigned pkg.

CI-built installers do ship with SLSA L3 provenance through a Sigstore-keyless in-toto attestation in `build-installer.yml`.

SLSA provenance is not Windows publisher signing.

Current install UX: Windows SmartScreen can warn `Unknown publisher`, users may need to click through the warning, and enterprise environments may treat unsigned installers differently.

Approximate signing costs: EV Authenticode certificate about `$300-700/year`; OV Authenticode certificate about `$100-300/year`; SignPath signing-as-a-service about `$240/year` base.

The signing decision is deferred. Treat it as a business and product call, not a missing runbook step.

## known caveats

- CI does not push to Firebase Storage.
- CI does not write `installer_metadata`.
- CI does not update `latest`.
- Manual API upload is still required after CI to roll out to agents.
- Local-built and CI-built installers checksum-differ.
- If using CI artifacts for rollout, download them from the GitHub Release.
- The signed, notarized pkg comes only from CI: the Apple secrets live in the tag-restricted `release` environment, and a run without them stops at `build-macos` with nothing attested.
- The fleet update sends each machine the file for its own platform; a machine whose platform the version has no file for is skipped and named. A version missing a platform's file leaves that platform's machines on their current version.
- The silent install (`/ADD=`) is Windows only; macOS and Linux pair from the app after installing.
- Demoting to an older version may require rerunning the 3-step finalize.
- A set-latest-only admin endpoint may exist, but this runbook does not confirm it.
- Soft-delete is gated by a minimum of 2 active versions.
- Agents already on a bad version need a higher-version forward fix.
- Since `9dccd12`, agents reject installers without `sha256_checksum`.
- `/api/admin/installer/upload` was removed; use `/api/installer/upload`.

## further reading

- `/docs/runbooks/production-deploy.md`
- `/docs/runbooks/hotfix-rollback.md`
- `/docs/internal/version-management.md`
- `/docs/internal/cortex-cli-provisioning.md`
- `/agent/BUILD.md`
- `/CLAUDE.md`
