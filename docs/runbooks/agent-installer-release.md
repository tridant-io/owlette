# agent installer release runbook

This runbook is for maintainers shipping the Owlette Windows agent installer. It covers both supported artifact paths: a local maintainer build and a CI build with SLSA L3 provenance.

It also covers the 3-step API upload that rolls a version out to agents, plus operational concerns around `setAsLatest`, demotion, smoke testing, and unsigned installer UX.

This document is only for the installer surface. For non-installer deploys, use `/docs/runbooks/production-deploy.md`.

## prerequisites

- Windows machine with admin rights.
- Inno Setup 6.x installed, or `%ISCC%` set to the compiler path.
- Node.js 22 + npm, and the Rust toolchain (rustup) with the MSVC C++ build tools — the full build compiles the desktop app.
- `/.claude/.env.local` containing `OWLETTE_API_KEY`.
- API key scope: `installer=*:write`.
- Installer upload keys must be minted by a superadmin.
- Push access to `dev` or the appropriate release branch.
- Firebase admin access for `installer_metadata` visibility, if needed.
- Access to the target base URL: `https://dev.owlette.app` or `https://owlette.app`.
- A Windows test machine for post-release smoke testing.

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
| local manual build | ship now, debug build issues, or release before tagging | local `.exe` | ready for manual API upload |
| ci build | tagged release, audit trail, SLSA L3 provenance | GitHub Release `.exe` and attestation | not rolled out to agents |
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

This is mandatory because the installer bakes the version into the EXE filename.

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

Expected output:

```text
agent/build/installer_output/Owlette-Installer-vX.Y.Z.exe
```

Tool discovery:

- Inno Setup respects `%ISCC%`, checks `PATH`, then falls back to the default install path.
- No system Python is used: the build downloads the Python 3.11.8 embeddable zip into `agent/downloads/` and verifies its SHA-256 before extracting it.
- Cargo is found through `%USERPROFILE%\.cargo\bin`, which the build prepends to `PATH`.

6. Compute sha256.

Bash:

```bash
sha256sum agent/build/installer_output/Owlette-Installer-vX.Y.Z.exe
```

PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 agent/build/installer_output/Owlette-Installer-vX.Y.Z.exe
```

Keep the hex sha256 for finalize. Supplying it is preferred because corruption fails with `412 checksum_mismatch`.

7. Run the 3-step API upload.

Set variables:

```bash
API_KEY=$(grep OWLETTE_API_KEY .claude/.env.local | cut -d= -f2)
BASE_URL="https://dev.owlette.app"
VERSION="X.Y.Z"
FILE_NAME="Owlette-Installer-vX.Y.Z.exe"
INSTALLER="agent/build/installer_output/Owlette-Installer-vX.Y.Z.exe"
SHA256="<hex sha256>"
```

Use `BASE_URL="https://owlette.app"` for production.

Step 1: request a signed upload URL.

```bash
curl -s -X POST "$BASE_URL/api/installer/upload" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -H "Idempotency-Key: installer-upload-$VERSION-$(date +%s)" \
  -d "{\"version\":\"$VERSION\",\"fileName\":\"$FILE_NAME\",\"releaseNotes\":\"Release $VERSION\",\"setAsLatest\":true}"
```

Save `uploadUrl`, `uploadId`, `storagePath`, and `expiresAt`.

Step 2: upload the binary to GCS.

```bash
curl -X PUT "$UPLOAD_URL" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @"$INSTALLER"
```

Do not send `Idempotency-Key` to GCS.

Step 3: finalize.

```bash
UPLOAD_ID="<uploadId from step 1>"

curl -s -X PUT "$BASE_URL/api/installer/upload" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -H "Idempotency-Key: installer-finalize-$VERSION-$(date +%s)" \
  -d "{\"uploadId\":\"$UPLOAD_ID\",\"checksum_sha256\":\"$SHA256\"}"
```

Finalize writes installer metadata. If step 1 used `setAsLatest:true`, finalize updates `latest`.

8. Smoke test.

Upload success is not release success. Run the post-release smoke section before calling the release done.

## path b: ci build (slsa l3 provenance)

The CI build is `.github/workflows/build-installer.yml`.

Triggers:

- tag push matching `v[0-9]+.[0-9]+.[0-9]+`, for example `v2.11.0`
- `workflow_dispatch`

Jobs:

- `build`: Windows runner; uses the runner's preinstalled Inno Setup 6 (installing it with Chocolatey only if absent); pins Python 3.11 with `setup-python`; runs `build_installer_full.bat`; computes sha256 in hex and base64; uploads artifact `owlette-installer`; retains it for 7 days.
- `provenance`: uses `slsa-framework/slsa-github-generator`; creates an in-toto attestation; signs with Sigstore keyless signing; uploads the attestation as a GitHub Release asset on tag pushes.
- `release`, tag-only: uses `softprops/action-gh-release@v2` and attaches the `.exe` to the GitHub Release.
- `verify`, tag-only: downloads the installer and provenance, then runs `slsa-verifier verify-artifact`.

CI does not push the installer to Firebase Storage, write `installer_metadata`, update the app's `latest` installer pointer, or replace the manual 3-step API upload.

To roll out a CI-built installer to agents, download the exact `.exe` from the GitHub Release and use it in the 3-step API upload.

Do not rebuild locally for the upload unless you intend to roll out different bytes.

## the 3-step api upload (in detail)

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
FILE_NAME="Owlette-Installer-vX.Y.Z.exe"

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
  "storagePath": "...",
  "expiresAt": "..."
}
```

The signed URL has a 15-minute window. If it expires, request a new one.

### step 2: put to signed gcs url

Purpose:

- upload the exact installer bytes to the signed GCS destination

```bash
INSTALLER="agent/build/installer_output/Owlette-Installer-vX.Y.Z.exe"

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
- [ ] Build output is `agent/build/installer_output/Owlette-Installer-vX.Y.Z.exe`.
- [ ] sha256 is computed for the exact installer being uploaded.
- [ ] `BASE_URL` points at the intended environment.
- [ ] `OWLETTE_API_KEY` is loaded from `/.claude/.env.local`.
- [ ] API key scope is `installer=*:write`.
- [ ] Step 1 uses `POST /api/installer/upload`.
- [ ] Step 1 has a unique `Idempotency-Key`.
- [ ] Step 1 uses `setAsLatest:true` only when ready to roll out.
- [ ] Step 2 uses `Content-Type: application/octet-stream`.
- [ ] Step 2 uses `--data-binary`.
- [ ] Step 2 does not include `Idempotency-Key`.
- [ ] Step 3 uses `PUT /api/installer/upload`.
- [ ] Step 3 has a different unique `Idempotency-Key`.
- [ ] Step 3 supplies `checksum_sha256` when possible.
- [ ] MockService and OwletteService constructor state are in parity.
- [ ] Any new `self.*` attribute is added to both classes.
- [ ] `agent/src/owlette_runner.py` hosted startup path still works with MockService.
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
- [ ] A Windows test machine is ready for smoke testing.
- [ ] `installer_metadata/cortex_cli` exists in the target environment and pins the CLI version the shipped SDK expects (`claude_agent_sdk/_cli_version.py`). Since 3.0.0 the installer no longer bundles `claude.exe`; a missing or stale pin leaves Cortex dead on every fresh install. See `/docs/internal/cortex-cli-provisioning.md`.

## post-release smoke

1. Verify the installer is downloadable from `https://owlette.app/download` or the environment equivalent.
2. Confirm the downloaded filename and version.
3. Pair a controlled Windows test machine using the new installer.
4. Watch `service.log` for at least 30 seconds after restart.
5. Look for `AttributeError`, crash-loop entries in `logs\service_host.log`, startup failures, connection failures, and update loop failures.
6. Treat log stability as a release gate because MockService and OwletteService parity has caused repeated crash loops before.
7. Confirm the dashboard shows the agent online.
8. Confirm the dashboard shows the released version.
9. Confirm normal service traffic works.
10. Confirm no token values appear in visible logs.
11. With Firebase admin visibility, confirm the version exists in `installer_metadata`.
12. Confirm `sha256_checksum` is present.
13. Confirm `latest` points at the intended version.
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

Installers are not Authenticode-signed today.

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
- If using CI artifact for rollout, download it from the GitHub Release.
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
