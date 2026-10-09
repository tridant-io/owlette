# Agent installers are served from Tridant's shared download host

Installers lived in Firebase Storage behind signed links that expire in 2030 and die with a key rotation. Since PR #316 (2026-10-08) they publish to R2 behind Tridant's shared download Worker, `download.tridant.io/owlette/` for prod and `download-staging.tridant.io/owlette/` for dev, under permanent public links that never change, and every version that becomes latest is registered in tridant id's release log.

## Consequences

- Customer firewalls allow hosts by name, so `download.tridant.io` must be on their list before prod cuts over, or self-updates fail there. Customers get notice first.
- A published installer is never replaced, because the Worker caches each name as immutable: a fix needs a new version number (`409 installer_published`).
- Fielded agents needed no change: they download any `installer_url` with a SHA-256 the dashboard sends.
- A tridant id failure never fails a promote; the version shows the failure and can be registered again.
- hoot's Claude CLI binaries stay in Firebase Storage, off the shared host.
