# g2 — first picture over a real network (2026-09-23)

**gate:** a frame from a dev-site machine reaches a browser canvas through the real api and the real
signaling service. **met**, with one workaround that is now wave b's first task.

## the session

- viewer: TEC-A4D, brave (chromium) on dev.owlette.app, owner signed in with a passkey; step-up passed.
- host: TEC-B4A, agent 3.3.7 from the dev catalog, streamer `owlette-swoop.exe` 3.3.7, no wave a wiring
  (no firewall rules on the host), site `default_site` with swoop enabled.
- path: dev api (`fc5f0647`) → `signal-dev.owlette.app` (worker deploy `34fcfe4b`) → doorbell on B4A →
  bundle minted (dev log 16:43:27 utc) → browser offer, host answer → ice.
- turn: not configured on dev (`turn mint failed; offering stun only`), so every pair was host or srflx.

## attempt 1 — 16:43 utc: black picture, `ice_failed`

`sites/default_site/machines/TEC-B4A/swoop_sessions/f9256ae5…` stayed `pending`. the toolbar said
"connected" because `onTrack` fired (the answer was applied), then the page reported "the connection to this
machine failed" (`peer.ts:705`, ice state `failed`). no candidate pair worked between two machines on one lan.

## attempt 2 — 17:1x utc: picture, with the browser's mdns obfuscation off

`#enable-webrtc-hide-local-ips-with-mdns` set to disabled in the viewer's browser, relaunch, same session
flow: B4A's desktop rendered on A4D, keyboard and mouse reached it (the owner typed into a command prompt on
B4A from the swoop page). **connect took 10–15 s by the owner's clock**, against plan.md's < 2 s budget.

## what this proves and what it does not

- proves: doorbell, bundle, room, offer/answer, capture, nvenc encode, srtp to a browser, input injection, all
  through the deployed dev stack with no local patches. g2's substance.
- does not prove: latency (no measurement taken), the connect budget (10–15 s measured only by hand), audio,
  a second viewer, anything off-lan (no turn), lock screen / uac (0.3's human half).

## findings, for wave b

1. **the host cannot resolve the browser's `.local` mdns candidates on this lan.** `ice_policy.rs` resolves
   them through the windows dns client (`session/mod.rs:3649`), and on B4A that returned nothing usable —
   the only pairs left were srflx↔srflx behind one nat, which failed. candidates, to be tested on B4A: the
   network profile is public (windows blocks inbound udp 5353 there, and the resolver's answer never
   arrives), or the resolver call itself does not perform mdns for `.local`. either way the fix is on the
   host: un-defer 7.7's inbound udp 5353 rule and/or send the mdns query from the streamer itself rather than
   through the os resolver. until then the viewer's browser needs the flag off, which is not a product.
2. **10–15 s to connect.** unmeasured stages. suspects from the log: the stage-2 turn probe "waits a fixed
   3 s and always runs", the one-shot relay→direct promotion timer at t+3 s, srflx gathering against stun
   with no turn, and streamer start-up (nvenc init) after the doorbell rings. wave b's connect-budget
   measurement (choose → first frame, p50 ≤ 1.5 s warm doorbell) needs stage timestamps in the stats
   overlay or the host log before anything is tuned.
3. **turn is not configured on dev**, so the lan is the only place this works at all. the owner is creating
   the cloudflare turn key (7.4 / 6.8 unblock).
