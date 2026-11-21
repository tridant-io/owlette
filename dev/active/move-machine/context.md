# Move a machine between sites — Context
**Last updated**: 2026-11-17

## Why this exists

The owner asked on 2026-11-04 (session a15f077b): "superadmin should have the ability to move machines from site to site directly from this manage panel", and for an endpoint to move machines remotely. That session recommended machine-scoped membership (ADR 0016) instead and dropped the move without the owner agreeing. The owner re-raised it on 2026-11-17. Do not drop or narrow any part of this without the owner's explicit yes.

## Key files

Create:
- `web/lib/agentCredentials.server.ts`, `web/lib/machineMoves.server.ts`, `web/lib/machineMove.ts`
- `web/app/api/sites/[siteId]/machines/[machineId]/move/route.ts`
- `web/app/api/agent/auth/move/route.ts`, `web/app/api/agent/auth/move/confirm/route.ts`
- `web/hooks/useMachineMove.ts`, `web/components/admin/sites/MoveMachineDialog.tsx`
- `agent/src/site_move_commands.py`
- `web/e2e/specs/sites/move-machine.spec.ts`, `web/e2e/helpers/agentToken.ts`
- `docs/adr/0020-a-machine-moves-sites-when-its-agent-confirms.md`

Modify:
- web: `device-code/authorize/route.ts`, `device-code/poll/route.ts`, `lib/actions/removeMachine.server.ts`, `lib/actions/deleteSite.server.ts`, `lib/versionUtils.ts`, `app/api/agent/site/route.ts`, `app/api/sites/[siteId]/machines/route.ts`, `hooks/useSiteMachines.ts`, `components/SiteMachinesList.tsx`, `openapi.yaml`, `e2e/helpers/seed.ts`
- agent: `secure_storage.py`, `auth_manager.py`, `firebase_client.py`, `owlette_service.py`
- docs: GLOSSARY, ADR 0016, the docs pages in task 3.2, both changelogs, README

## Facts verified in code (2026-11-17, dev bce9342b)

- The site lives locally: `config.json` `firebase.site_id` selects every Firestore path (owlette_service.py, `_initialize_or_restart_firebase_client`), and the token store's copy addresses alerts. Remote config sync and `update_config` restore the local `firebase` section; no command re-pairs; `/api/agent/site` returns no site id; self-update passes no `/ADD=`. So a server-only rebind strands the agent (403 on every write, never unpairs).
- The refresh route re-mints the `site_id` claim hourly from `agent_refresh_tokens/{hash}.siteId`. agentUid is per site: `agent_${siteId}_${machineId}`.
- The agent already reinitialises when config.json's site changes, and restarts swoop; an absent config doc on the new site is seeded from the local config, so processes survive.
- #326 removal detection (`_on_removed_from_site`, firebase_client.py:400) unpairs when the source config doc vanishes: the source is cleaned only on the agent's confirm from the target, and the guard in task 1.5 covers a stale client.
- removeMachine prunes member `machineIds` and the fleet grant; it does NOT prune talon scopes or roost targets (the talon engine skips missing machines). The owner ruled the move matches remove.
- `assertUserHasSiteCapability` admits a superadmin with no member row on the target (sitePolicy.server.ts:230 returns ok for `globalRole === 'superadmin'`).
- The e2e web server runs with `FIREBASE_AUTH_EMULATOR_HOST` (playwright.config.ts:172), so an emulator-minted agent token verifies.
- The real mint calls Google's endpoint (poll/route.ts), so the credential fetch is covered by jest, not e2e.
- The deploy-agent hook (`.claude/hooks/deploy-agent.mjs`) fires on any path containing `agent/src/` ending `.py`.

## Decisions

1. Design B, the agent confirms (owner, 2026-11-17).
2. Superadmins and anyone admin of both sites may move (owner): MACHINE_REMOVE on the source, MACHINE_ENROLL on the target.
3. History starts fresh: the source is cleaned exactly as remove machine cleans it (owner); talons untouched (owner).
4. A pending move expires after 7 days (owner); a switching move never expires, because expiring it would delete the target token and the agent would unpair; remove machine is the way out.
5. Release 4.2.3 on dev; whether it rides #420 is the owner's call at #420.
6. The move record is `machine_moves/{sourceSiteId}:{machineId}`, server-only, not a field on the machine doc (agents can write their own machine doc).
7. Both agent channels carry only `moveId`; credentials come only from the agent route with the agent's refresh token.
8. The agent keeps its move phase in `.tokens.enc` (SYSTEM/root only, untouched by the installer), not a marker in `tmp\`.
9. Refused: API keys (ADR 0015), a same-id machine on the target, a busy machine (install, uninstall, update, roost sync, deployment in flight), an agent without `capabilities.siteMove` or below 4.2.3, the target's plan limit.
10. dev↔prod moves are out of scope (separate Firebase projects).

## Next steps

Run wave 0 (`/execute`): five parallel tasks, on opus (sonnet's weekly limit resets 2026-11-17 8pm PT). Tell owlette-f8 the footprint (agent + web, release 4.2.3).
