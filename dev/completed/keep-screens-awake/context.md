# keep screens awake — Context
**Last updated**: 2026-10-03

## Key Files

Create: `web/lib/display/settings.server.ts`, `web/lib/actions/setDisplaySettings.server.ts`,
`web/app/api/sites/[siteId]/display-settings/route.ts`, `web/hooks/useDisplaySettings.ts`,
`agent/src/site_commands.py`, `agent/src/keep_awake.py`, `desktop/src-tauri/src/awake.rs`, and their tests.

Modify: `web/app/api/agent/site/route.ts`, `web/components/ManageSitesDialog.tsx`, `web/components/SiteMachinesList.tsx`,
`web/hooks/useFirestore.ts`, `web/app/api/sites/[siteId]/machines/route.ts`, `web/openapi.yaml`,
`agent/src/firebase_client.py`, `agent/src/owlette_service.py`, `desktop/src-tauri/src/lib.rs`, `paths.rs`,
`Cargo.toml`/`Cargo.lock`, docs (`swoop.mdx`, the manage-sites page, `firestore-data-model.mdx`), changelogs.

Untouched: `firestore.rules`, `firestore.indexes.json`, `display_manager.py`.

## Decisions

See plan.md "Decisions": default on; own settings doc; `MACHINE_CONFIG_WRITE`; two layers (daemon + session);
switches act immediately; no new packages beyond direct deps already in the lock.

## Next Steps

Wave 1's four tasks touch disjoint files: run them in parallel (Opus workers), review each diff, commit per task.
Then 2.1 + 2.2, then 3.1 + 3.2, then the 4.1.1 release (3.3), which also carries the ten fixes already on the branch
since 4.1.0. The Mac and kiosk builds of the desktop crate are the lead's job (sync with `macsync-task.sh`, kiosk via
the `kiosk` git remote).
