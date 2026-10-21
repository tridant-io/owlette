# roost cut over cleanly: no version prefix, no header negotiation, no v1 compatibility

When roost replaced v1 distribution we locked three refusals: no `/api/v2/` prefix (`/api/chunks/*` and `/api/roosts/*` are the API), no `Accept`-header version negotiation (format versions live in the payload's `mediaType` and `schemaVersion`), and no compatibility with v1 agents (the 2.10.0 agent is a hard requirement, with no dual-write window, shadow read or `project_url` fallback). The reason for the clean break is not recorded beyond "clean cutover"; the record does show a phased dual-write plan was written and then dropped (`docs/internal/v1-v2-migration.md`).

## Consequences

- v1 was deleted outright on 2026-09-05: routes, rules block and agent handlers, with no deprecation window. The manifest-to-version rename in 2.10.0 was the same kind of clean break, with no redirects or shims.
- Deferred to roost v3, not to be rebuilt now: bidirectional sync, LAN swarm, Ed25519/TUF version signing (integrity rests on TLS, Firebase Auth, signed URLs and content addressing) and FastCDC. "v2" and "v3" here are roost generations, not agent versions. The public CLI was on this list once and has since shipped.
