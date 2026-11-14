# version management

every component carries the one product version, `X.Y.Z`. `scripts/sync-versions.js` is the only thing that should change it:

```bash
node scripts/sync-versions.js          # print every version surface
node scripts/sync-versions.js X.Y.Z    # set them all to X.Y.Z (plain X.Y.Z only; it refuses a pre-release suffix)
```

the release around a bump (both changelogs, a local `release: X.Y.Z` commit, then build and upload before anything is pushed or tagged) is in [the agent installer release runbook](../runbooks/agent-installer-release.md).

## what the script writes

- `VERSION` and `agent/VERSION`
- `web/package.json` and `desktop/package.json`, with the `version` fields of their `package-lock.json`
- `desktop/src-tauri/tauri.conf.json` and `desktop/viewer/tauri.conf.json`
- the `[package]` version of `desktop/src-tauri/Cargo.toml`, `desktop/viewer/Cargo.toml`, `agent/host/Cargo.toml` and `agent/swoop/Cargo.toml`; each `Cargo.lock` follows on the next build
- the version badge in `README.md`, and `**Version**` and `**Last Updated**` in `.claude/CLAUDE.md`

the list in the script (`VERSION_FILES`, `LOCKFILES`, `CARGO_TOMLS`, `DOC_FILES`) is the authority; this page only describes it.

## firestore rules are versioned on their own

`firestore.rules` carries its own `// Version:` line at the top. it moves only when the rules or the data model they guard change, never with a release, and the script leaves it alone.

## tags

`vX.Y.Z`, pushed on the release's merge commit into `dev`, runs `.github/workflows/build-installer.yml`, which builds all three installers and attaches them to the GitHub Release; it rolls nothing out to agents. `cli-v*`, `node-sdk-v*` and `py-sdk-v*` publish the CLI and the SDKs, so do not use them for a product release.
