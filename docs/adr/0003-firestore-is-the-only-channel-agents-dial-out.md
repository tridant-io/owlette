# Firestore is the channel between dashboard and agent, and agents only dial out

The dashboard never connects to a machine. It writes commands and config to Firestore; the agent polls them, writes back status, heartbeats and results, and calls the owlette API for tokens and signed URLs, all outbound over HTTPS with no inbound port and no VPN. That is a public promise ("no inbound ports — outbound 443 only. no vpn. no firewall holes." in `web/components/landing/ProofStrip.tsx`), and it is why a machine keeps supervising its processes while offline. No trade-off analysis behind it is recorded beyond that promise and the architecture constraints in PRODUCT.md.

## Consequences

- Never add a listening socket or a direct dashboard-to-agent path. A new machine action is a new command, or a new outbound connection the agent opens itself.
- Customer firewalls allow hosts by name: `owlette.app` or `dev.owlette.app`, the Firebase APIs, the R2 endpoint for roost and `download.tridant.io`. A new host the agent must reach is a customer-facing change and needs notice first.
- swoop is the one deliberate exception. Its media flows peer-to-peer over WebRTC, and when a site turns swoop on, the Windows agent adds a UDP firewall rule itself (ADR 0009).
