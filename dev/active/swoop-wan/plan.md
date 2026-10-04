# swoop across the internet — Plan
**Created**: 2026-10-04 | **Status**: Active

Worktree `C:\Users\admin\Documents\Git-restored\Owlette-swoop-mac-wt`, branch `swoop/macos`. Owner, 2026-10-03 night:
"do what you can to get swoop ready for WAN -- not just LAN only. lay the groundwork and then execute everything, one
piece at a time. verify everything as you work."

## Summary

swoop connects on a LAN and fails across the internet. The host streamer gathers one candidate, its private address,
and the agent's session bundle carries no ICE servers at all when the TURN mint fails, which is always on dev (the
Cloudflare TURN key is empty). This plan makes a direct connection work across the common NATs with STUN on both ends,
builds the host-side TURN relay so a symmetric NAT or a UDP-hostile network works once the owner adds a TURN key, and
tells the viewer plainly when no path exists.

## Research findings (2026-10-04, file:line in the worktree)

- **Host IO.** One IPv4 UDP socket per viewer, bound toward the viewer's first host or srflx candidate, port 0
  (`session/mod.rs:2026-2036, 4078-4136`; `transport/rtc.rs:491-497`). The session thread polls every peer on a 2 ms
  tick; each poll does one `recv_from` and feeds str0m (`rtc.rs:803-831`). `Output::Transmit` is sent with
  `t.source` ignored (`rtc.rs:767-779`). str0m `=0.23.1`, ICE crate `is` 0.11.0; full ICE, host is controlled.
- **Candidates.** `Candidate::host` on the first `accept_offer` (`rtc.rs:636-642`); `add_local_candidate` already
  trickles new local candidates to the viewer (`rtc.rs:653-673`, `session/mod.rs:2743-2755`). str0m accepts srflx and
  relayed local candidates in full ICE; srflx pairs are pruned to the host base, so the host's own checks punch the
  hole. Relayed inbound must be fed as `Receive{source: peer, destination: relay_addr}`; outbound whose
  `t.source == relay_addr` must be wrapped (`is` agent.rs:1446-1449, 1742).
- **str0m STUN codec gaps.** `StunMessage::parse` rejects a Binding success without MESSAGE-INTEGRITY, so a plain STUN
  server's reply must be decoded by hand. No REQUESTED-TRANSPORT encoder, no ChannelData. HMAC-SHA1 is available
  through str0m's crypto provider; MD5 (long-term credential key) is not in the tree.
- **Bundle.** `Bundle.ice_servers` exists and parses (`bundle.rs:228-271`), nothing reads it. The web bundle route sends
  `[]` when the mint fails (`web/app/api/agent/swoop/bundle/route.ts:173-185`) while the viewer route falls back to
  `stun:stun.cloudflare.com:3478` (`sessions/route.ts:80, 436`). Entries are `deny_unknown_fields`: a STUN-only entry is
  safe for fielded streamers, new fields are not.
- **Viewer.** STUN-only first, browser TURN as a stage-2 restart 3 s after the answer when relay servers exist
  (`peer.ts:366-379, 708-760`). No ICE-failed error; an endless restart ladder; the page says "connecting" forever
  (`SwoopStage.tsx:146`, `useSwoopSession.ts:624, 643`).
- **Signaling** relays trickle both ways with ample limits; no change needed (`infra/swoop-signal`).
- **TURN credentials.** Minted by Cloudflare `generate-ice-servers` (`web/lib/swoop/turn.server.ts`), 12 h TTL, key
  `CLOUDFLARE_TURN_KEY_ID` / `CLOUDFLARE_TURN_KEY_API_TOKEN`, empty on Railway since 2026-09-22. Only the owner can
  create a key in the Cloudflare account.
- **Relay budget.** `budget.rs` has the relay caps, but `Governor::set_path_profile` has no caller and status `path` is
  hard-coded `Direct` (`session/mod.rs:3337`).

## Decisions

1. STUN server `stun.cloudflare.com:3478`, the one the viewer already uses; free, no key. Shared constant in
   `turn.server.ts`, used by both routes.
2. The host's STUN binding goes out from each viewer's own socket (the mapping must be that socket's), with
   retransmits on the existing poll, and the reply is intercepted before str0m by transaction id and source.
3. The srflx candidate is added through `add_local_candidate`, so it trickles; skipped when the mapped address equals
   the local one (no NAT).
4. TURN is host-side (plan D13: only server-to-client egress is billed, so the host's allocation is ~100x cheaper),
   over UDP 3478 first. TLS 443 is a later task.
5. No new crates (Task 7.4: "do not add crates"; owner rule: no new packages without asking). MD5 for the long-term
   key is written in the crate against RFC 1321's test vectors; HMAC-SHA1 comes from str0m's provider. The owner may
   swap MD5 for the `md-5` crate later.
6. TURN switches on only when the bundle carries a `turn:` entry with credentials. Until the owner adds a key, the
   relay code is built, unit-tested and tested live against a lab TURN server (coturn on the kiosk VM).
7. Permissions only for public peer IPs, rate-limited under Cloudflare's 5 new peer IPs per second.
8. When the ICE relay pair is nominated, the governor gets the relay path profile and status reports `path: relay`.
9. The viewer gets a deadline: no media path after 20 s shows "can't reach this machine from your network" (and, with
   no relay configured, says so) instead of an endless "connecting".
10. The signaling worker and the bundle schema do not change.

## Risks

- A symmetric NAT or CGNAT on both ends defeats STUN; only TURN fixes it (the owner's Cloudflare key).
- An end-to-end test across two real networks needs a signed-in viewer, which only the owner has: the owner runs one
  session from a phone hotspot in the morning. Everything else is verified on the machines here.
- MD5 written by hand: correctness is pinned by RFC 1321 vectors and by a real TURN server accepting the credential.

## Success criteria

- A host behind a home NAT gathers and trickles a srflx candidate whose address is the network's public address
  (checked on B4A and the Mac against `stun.cloudflare.com`).
- The agent's bundle carries STUN when TURN is not configured; route tests assert both bundles.
- The host's TURN client allocates, binds a channel and relays a datagram both ways through a real TURN server.
- With a relay nominated, status says `relay` and the governor caps the bitrate.
- The viewer stops saying "connecting" forever and says what is wrong.
- Owner, in the morning: one swoop session from a phone on a cellular network connects.
