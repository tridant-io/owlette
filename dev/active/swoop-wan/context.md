# swoop across the internet — Context
**Last updated**: 2026-10-04

## Key Files

Create: `agent/swoop/src/transport/stun.rs`, `agent/swoop/src/transport/turn/{alloc,md5,wire}.rs`,
`dev/active/swoop-wan/proof.md`.

Modify: `web/lib/swoop/turn.server.ts`, `web/app/api/agent/swoop/bundle/route.ts`, the viewer sessions route,
`web/lib/swoop/peer.ts`, `web/hooks/useSwoopSession.ts`, `web/components/swoop/SwoopStage.tsx`,
`agent/swoop/src/transport/{mod,rtc}.rs`, `agent/swoop/src/transport/turn/mod.rs`, `agent/swoop/src/session/mod.rs`,
`web/content/docs/dashboard/swoop.mdx`, changelogs.

Untouched: `infra/swoop-signal`, the bundle schema, `firestore.rules`, Cargo dependencies.

## Decisions

See plan.md "Decisions": STUN from each viewer's own socket, srflx through `add_local_candidate`, host-side TURN over
UDP first, no new crates (MD5 in-crate), relay only with bundle credentials, public-IP permissions only, a 20 s
viewer deadline with plain copy.

## Next Steps

Wave 1 first: 1.1 (web) and 1.2 (host) touch disjoint files. 1.3 measures 1.2 on B4A and the Mac.
