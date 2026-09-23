# Swoop research 04 — NAT traversal, Cloudflare TURN, signaling, security

Research date: 2026-09-17. Claims are marked `[verified: <source>]` (read from a primary
source this session) or `[inference]` (reasoned from verified facts / prior art, not directly
sourced). Every source URL carries the date shown on the page, or the date of the document.

---

## 0. Executive shape of the recommendation

1. **Give the TURN allocation to the Windows host, not the browser.** Cloudflare bills only
   `TURN server → TURN client` egress; the `TURN server ↔ peer` leg is explicitly "not part of
   billing". Because the video flows host→browser, putting the allocation on the host makes the
   expensive direction free and bills only the browser's tiny upstream. This is a ~100× cost
   difference. `[verified: Cloudflare Realtime TURN FAQ]`
2. **Browser gets `stun.cloudflare.com` only (free and unlimited), plus its own mDNS host
   candidates.** Add browser-side TURN as a second-stage fallback via `setConfiguration()` +
   `restartIce()` only when ICE fails (browser network blocks UDP entirely).
3. **Signaling: a Cloudflare Durable Object WebSocket room per session**, with the agent holding
   a hibernated warm WebSocket (protocol pings are free and do not wake the object). Auth via a
   short-lived JWT minted by the existing Next.js API.
4. **Connect budget:** 400–900 ms click→first frame with a pre-warmed encoder and a warm control
   socket; 1.2–2.0 s worst case (relay over TLS/443). `[inference]`

---

## 1. Cloudflare Realtime TURN, as of September 2026

Cloudflare renamed "Calls" to "Realtime"; the TURN docs live at
`developers.cloudflare.com/realtime/turn/`, but the **management API is still under the `calls`
namespace** (`/accounts/{account_id}/calls/turn_keys`) and the Terraform resources are still
named `cloudflare_calls_turn_app`. `[verified: docs + API reference + Terraform reference]`

### 1.1 Creating a TURN key

- Dashboard, or `POST /accounts/{account_id}/calls/turn_keys` with an API token carrying the
  **`Calls Write`** permission. Optional body: `{"name": "<description, not shown to end users>"}`.
  Response `result`: `uid` (32 chars — this is the `$TURN_KEY_ID`), `key` (64 chars — the bearer
  token, i.e. `$TURN_KEY_API_TOKEN`), `name`, `created`, `modified`.
  `[verified: https://developers.cloudflare.com/api/resources/calls/subresources/turn/methods/create/ — fetched 2026-09-17]`
- The TURN key is a **long-term secret that must stay server-side**; it mints unlimited
  short-lived credentials. `[verified: generate-credentials docs]`
- **Up to 1,000 TURN keys per account**, with **no limit on end-user credentials per key**.
  Cloudflare recommends separating test/staging/production by key.
  `[verified: https://developers.cloudflare.com/realtime/turn/replacing-existing/]`
- The docs do not say whether `key` can be re-read after creation; the `GET`/list endpoints
  return `uid`/`name`/`created`/`modified` only, which implies the bearer token is shown once.
  `[inference]`

### 1.2 Minting credentials

Two variants, same auth:

```bash
# Variant A — ICE-servers shaped (what you want for a browser)
curl https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/generate-ice-servers \
  --header "Authorization: Bearer $TURN_KEY_API_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{"ttl": 86400}'
```

`201 Created`:

```json
{
  "iceServers": [
    { "urls": ["stun:stun.cloudflare.com:3478"] },
    {
      "urls": [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
        "turn:turn.cloudflare.com:80?transport=tcp",
        "turns:turn.cloudflare.com:5349?transport=tcp",
        "turns:turn.cloudflare.com:443?transport=tcp"
      ],
      "username": "<96 hex chars>",
      "credential": "<96 hex chars>"
    }
  ]
}
```

```bash
# Variant B — raw credential, supports customIdentifier for per-tenant metering
curl https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/generate \
  --header "Authorization: Bearer $TURN_KEY_API_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{"ttl": 864000, "customIdentifier": "user4523958"}'
```

`[verified: https://developers.cloudflare.com/realtime/turn/generate-credentials/ and
https://developers.cloudflare.com/realtime/turn/replacing-existing/ — fetched 2026-09-17]`

- **Revocation:** `POST https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/$USERNAME/revoke`
  → `204 No Content`. `[verified: generate-credentials docs]`
- **Max TTL: 48 hours.** "You can set a expiration time for a credential up to 48 hours in the
  future." Longer allocations require refreshing credentials via
  `RTCPeerConnection.setConfiguration()`. `[verified: TURN FAQ]`
- **Credential issuance rate:** "There is no defined limit… Start at 500 credentials/sec and scale
  up linearly. Ensure you use more than 50% of the issued credentials." `[verified: TURN FAQ]`
- **On expiry mid-allocation:** "Cloudflare Realtime will immediately stop billing and recording
  usage for analytics. After a short delay, the connection will be disconnected."
  `[verified: TURN FAQ]`
- The response is *similar to* but not identical to the expired `draft-uberti-behave-turn-rest-00`
  (it omits `ttl`). If a client library expects that shape, reshape it server-side.
  `[verified: TURN FAQ]`
- The docs show `customIdentifier` only on `/credentials/generate`. **Unverified** whether
  `generate-ice-servers` accepts it — test before depending on it for metering. If it does not,
  call `/generate` and build the `iceServers` array yourself.

### 1.3 Transports, ports, anycast

| Protocol | Hostname | Primary port | Alternate port |
|---|---|---|---|
| STUN over UDP | `stun.cloudflare.com` | 3478/udp | — |
| TURN over UDP | `turn.cloudflare.com` | 3478/udp | — |
| TURN over TCP | `turn.cloudflare.com` | 3478/tcp | 80/tcp |
| TURN over TLS | `turn.cloudflare.com` | 5349/tcp | 443/tcp |

`[verified: https://developers.cloudflare.com/realtime/turn/ — page "Last updated 2026-09-09"]`

- **Nothing on port 53.** Ports 80 and 443 are the firewall-evasion ports.
- `turn.cloudflare.com` also answers plain STUN Binding requests. `[verified: TURN FAQ]`
- **STUN is free and unlimited** at `stun.cloudflare.com`. `[verified: TURN FAQ]`
- **TLS:** TLS 1.1/1.2/1.3. 1.3 offers AES-GCM and ChaCha20-Poly1305 AEADs; 1.2 offers
  ECDHE-ECDSA/RSA-AES128-GCM and some legacy non-PFS suites. `[verified: TURN index docs]`
- **Anycast:** clients land in the topologically nearest Cloudflare data center via BGP anycast.
  Cloudflare solves the "stateful protocol over anycast" problem with their Unimog L4 load
  balancer for client→server affinity, and forwards packets that land at the wrong data center
  over their private backbone rather than the public Internet.
  `[verified: https://blog.cloudflare.com/webrtc-turn-using-anycast/ — 2024-09-25]`
- Cloudflare claims ~95% of the Internet-connected population is within ~50 ms of a Cloudflare
  location, across ~330 cities. `[verified: same blog, 2024-09-25]`
- **No China Network.** Traffic from China connects to locations outside China.
  `[verified: TURN FAQ]`
- **MTU:** "There is no specific MTU limit." `[verified: TURN index docs]`

### 1.4 What TURN does *not* do

- **No TCP relaying** (RFC 6062 not implemented; `REQUESTED-TRANSPORT` ignored). The
  client↔server leg can be TCP/TLS, but the **relay↔peer leg is always UDP**.
  `[verified: TURN FAQ]`
- **No IPv6 relay addresses** (`REQUESTED-ADDRESS-FAMILY` ignored, RFC 6156 not honoured).
  Client↔server works over IPv4 **and** IPv6; the relayed transport address is always IPv4.
  `[verified: TURN FAQ]`
- **CreatePermission / ChannelBind are denied for private IP ranges** (loopback, link-local,
  multicast) and for Cloudflare BYOIP ranges. You cannot relay into a LAN. `[verified: TURN FAQ]`

### 1.5 Pricing and free tier

- **$0.05 per GB.** Billed on **data sent from the Cloudflare edge to the TURN client**, per
  RFC 8656 Figure 1 — "including TURN overhead, following successful authentication."
- **Free tier: 1,000 GB**, and Realtime bills as **one line item covering both SFU and TURN**
  (i.e. one shared 1,000 GB, not two).
- **Ingress (client → server) is free.**
- **`TURN server ↔ Peer A` is labelled "Not part of billing"** in the official pricing diagram.
- **TURN is free when used together with Realtime SFU**, and TURN↔SFU and TURN↔Stream
  (WHIP/WHEP) traffic is not charged.
- No performance or feature difference between self-serve and enterprise; enterprise buys
  priority support, flat-rate pricing, an SLA, and IP-stability guarantees.

`[all verified: https://developers.cloudflare.com/realtime/turn/faq/ — fetched 2026-09-17 from
the docs source at raw.githubusercontent.com/cloudflare/cloudflare-docs]`

**Cost consequence for Swoop (the single most important finding in this report):**

| Who holds the allocation | Billed traffic | 10 Mbps session | 25 Mbps session |
|---|---|---|---|
| Browser is the TURN client | video (server→client) ≈ 4.5 GB/h | **$0.225/h**, free tier ≈ 222 h/mo | **$0.56/h**, free tier ≈ 89 h/mo |
| **Host is the TURN client** | only the browser's upstream (input + RTCP), ≈ 0.05–0.14 GB/h | **≈$0.003/h**, free tier ≈ 7,000–22,000 h/mo | same |

`[inference from the verified billing rule]` — this is a large bet on one documented sentence
plus a diagram. **Validate empirically** with a metered 10-minute relayed session and a
`callsTurnUsageAdaptiveGroups` query before designing the business model around it.

### 1.6 Limits and quotas

Per **TURN allocation** (per user), **not account-wide**:

- Unique peer IPs per allocation: **> 5 new IP/sec** triggers drops (port-scan heuristic).
- Packet rate in/out of the allocation: **> 5–10 kpps** may be dropped.
- Data rate in/out of the allocation: **> 50–100 Mbps** may be dropped ("Realtime TURN might be
  dropping packets to signal you to slow down").
- Burst rates are higher than documented; hitting the limits causes **packet drops**, not errors.

`[verified: https://developers.cloudflare.com/realtime/turn/ and TURN FAQ]`

**Swoop implication:** a 30 Mbps desktop stream at ~1,200-byte payloads is ~3.1 kpps — inside the
limit but within 2× of it. A 4K60 stream at 60–80 Mbps would be *above* the documented data-rate
limit and is likely to be shaped. **Cap relayed sessions at ~25–30 Mbps and prefer larger
packets**; let direct P2P sessions go higher. `[inference]`

Maintenance: "in certain scenarios TURN allocations may be disrupted… **ICE restart support by
clients is highly recommended**." `[verified: TURN FAQ]` — budget for mid-session ICE restarts.

### 1.7 IP allow-listing (matters for locked-down customer networks)

Allow-list all four (both families are required):

```
2a06:98c1:3200::1/128
2606:4700:48::1/128
141.101.90.1/32
162.159.207.1/32
```

Cloudflare "tries to, but cannot guarantee" these do not change without an enterprise contract;
if you hard-code or allow-list, you **must** alert on A/AAAA changes to `turn.cloudflare.com` and
update within 14 days. `[verified: TURN FAQ]`

This is a genuine selling point for signage/kiosk customers: four addresses, two ports (443/3478),
versus a typical TURN provider's /16s.

### 1.8 Analytics and per-customer attribution

- GraphQL only, at `https://api.cloudflare.com/client/v4/graphql`, dataset
  **`callsTurnUsageAdaptiveGroups`**. API token needs the **Account Analytics** permission.
- Metrics: `egressBytes`, `ingressBytes`, `concurrentConnections` (each with `sum` and `avg`).
- Dimensions: `datetimeMinute` / `datetimeFiveMinutes` / `datetimeFifteenMinutes` / `datetimeHour`,
  data-center city/country/region, **TURN key ID**, **username**, **`customIdentifier`**.
- Filters: date range, key ID, username, `customIdentifier`.
- **Usage appears in analytics within 30 seconds.**
- **Sampling caveat that breaks naïve billing:** adaptive sampling applies both at collection and
  at query time. "Querying TURN usage for multiple customers in a single query can lead to
  inaccurate results because the usage pattern of one customer could affect the sampling rate
  applied to another customer's data." **Write one query per customer per period returning a
  single summed value.**
- Cloudflare bills you only on `egressBytes`.

`[verified: https://developers.cloudflare.com/realtime/turn/analytics/ and
https://developers.cloudflare.com/realtime/turn/replacing-existing/]`

**Swoop implication:** set `customIdentifier` to something like `site:<siteId>|machine:<machineId>`
(or a hash if machine IDs are sensitive — the identifier is visible to anyone with account
analytics access). Per-session granularity would need one query per session, which does not
scale; aggregate at machine or site level, and mint one credential per session tagged with the
machine. `[inference]`

### 1.9 Terraform

- Resource **`cloudflare_calls_turn_app`** — required `account_id`; optional `key_id`, `name`;
  computed `created`, `key` (**the bearer token — it lands in Terraform state**), `modified`, `uid`.
- Data sources `cloudflare_calls_turn_app` (needs `key_id`) and `cloudflare_calls_turn_apps`.
- SFU equivalents: `cloudflare_calls_sfu_app` with computed `secret`.

`[verified: https://developers.cloudflare.com/api/terraform/resources/calls/ — fetched 2026-09-17]`

Since `infra/cloudflare/` already exists in this repo, adding the TURN key there is natural —
**but the `key` attribute is a long-term secret in state**. Either accept encrypted remote state,
or create the key out of band and only reference `uid` in Terraform. `[inference]`

### 1.10 Other Cloudflare Realtime facts worth knowing

- FAQ (new as of the 2026 docs revision) explicitly blesses this exact shape: *"If your use case
  is one-to-one communication, such as a teleoperation link between an operator and a remote
  device, TURN by itself is usually sufficient. Adding an SFU is unnecessary complexity."*
- *"If both peers relay through Cloudflare Realtime TURN, the traffic between the two Cloudflare
  edges can use the Cloudflare backbone… The more consistent improvement from using TURN on both
  ends is reliability and packet loss behavior, not raw latency."*
- *"There is no meaningful latency or throughput penalty"* choosing SFU vs TURN — same fleet,
  same data path. Relevant if Swoop ever needs multi-viewer fan-out: **TURN is free with the SFU**.
- Cloudflare suggests evaluating their **Media over QUIC (MoQ)** implementation for teleoperation
  where you control both ends.

`[all verified: TURN FAQ, fetched 2026-09-17]`

---

## 2. ICE strategy: "works anywhere, prefers P2P"

### 2.1 Realistic direct-connection rates

Published numbers vary widely because populations vary:

- Consumer/open-Internet WebRTC: roughly **75–85% direct, 15–25% relayed**; one conference
  dataset reported ~22% of conferences needing a relay.
  `[source quality: secondary/aggregated — GetStream, BlogGeek.me, ExpressTURN, 2025–2026 posts
  surfaced via search; treat as a range, not a measurement]`
- Whereby/appear.in measured **mean RTT 367 ms relayed vs 227 ms direct over 100k calls** — a
  **~140 ms** penalty, dominated by relay placement, not by relaying per se.
  `[verified: https://medium.com/the-making-of-whereby/webrtc-and-turn-latency-around-the-world-4d172dd59e8e]`
- Tailscale (WireGuard, not ICE, but the same NAT physics plus UPnP/PCP/NAT-PMP and birthday-paradox
  punching) reports direct-connection success **"well north of 90%"**.
  `[source: Tailscale blog "How NAT traversal works" / "How Tailscale is improving NAT traversal";
  surfaced via search, not fetched this session]`
- Symmetric NAT / CGNAT / restrictive firewalls: commonly cited at **15–30%** of users.
  `[secondary sources]`

**Calibrated expectation for Swoop's population** (managed Windows boxes on *business* networks —
signage, kiosks, media servers — plus operators often on corporate Wi-Fi/VPN): direct-connect
rate will be **worse than consumer WebRTC**, likely **60–80%**, with UPnP/PCP pushing the top end
higher on SMB networks and essentially never helping on enterprise ones. `[inference]`

Corporate networks that block outbound UDP entirely are the hard case and are exactly why
`turns:turn.cloudflare.com:443` matters.

### 2.2 The ICE configuration to ship

**Browser (viewer):**

```js
const pc = new RTCPeerConnection({
  iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }], // free + unlimited
  iceTransportPolicy: "all",
  iceCandidatePoolSize: 1,        // pre-gather before setLocalDescription
  bundlePolicy: "max-bundle",
  rtcpMuxPolicy: "require",
});
pc.addTransceiver("video", { direction: "recvonly" });
pc.addTransceiver("audio", { direction: "recvonly" });
pc.createDataChannel("input", { ordered: true, maxRetransmits: 0 }); // or ordered:false
```

- `iceCandidatePoolSize` "instructs the PeerConnection to gather ICE candidates before
  `setLocalDescription` occurs as a performance optimization."
  `[verified: MDN RTCPeerConnection() constructor / RTCConfiguration]`
- `bundlePolicy: "max-bundle"` collapses everything onto one ICE component/one DTLS association —
  fewer candidate pairs, one consent-freshness stream, one TURN allocation. `[inference]`

**Windows host (native):**

- ICE servers: `stun:stun.cloudflare.com:3478`, plus **its own TURN allocation** on
  `turn:turn.cloudflare.com:3478?transport=udp` **and** `turns:turn.cloudflare.com:443?transport=tcp`.
- Gather: host candidates on all interfaces (including the UPnP/PCP-mapped external address),
  server-reflexive, relay.
- Host is the **answerer** (see §4.5), so it is the ICE **controlled** agent.

**Do not use ICE-TCP host candidates.** RFC 6544 (TCP candidates with ICE, March 2012) exists,
but Chrome and Firefox do not gather *direct* TCP host candidates — their only TCP candidates are
`tcptype active` toward TURN-TCP servers. A passive TCP listener on the host is therefore
unreachable from a browser. `[inference — well-established browser behaviour; RFC date verified at
https://www.rfc-editor.org/rfc/rfc6544]`

### 2.3 Connecting fast

- **Trickle ICE (RFC 8838, January 2021)** — mandatory. Send each candidate as it is gathered;
  do not wait for gathering-complete. `[verified: https://datatracker.ietf.org/doc/rfc8838/]`
- **Pre-gathering** on both sides: browser sets `iceCandidatePoolSize` on page load; host keeps a
  warm STUN mapping and can pre-open a TURN allocation (TTL up to 48 h) so relay candidates are
  available instantly. `[inference]`
- **Aggressive nomination is deprecated.** RFC 8445 (July 2018) retains only regular nomination;
  "the nomination process that was referred to as 'aggressive nomination' in RFC 5245 has been
  deprecated." Do not design around it.
  `[verified: https://www.rfc-editor.org/rfc/rfc8445.html]`
- Practical floor: ICE check pacing plus 1 RTT for a successful STUN binding on a srflx pair, then
  DTLS. See the budget in §4.6.

### 2.4 Will ICE start on relay and later move to a direct pair?

Two answers — spec and practice.

**Spec (RFC 8445, July 2018):** No. Relay candidates carry the lowest type preference, so a
direct pair, *if it validates during the checking phase*, wins on priority and is what the
controlling agent nominates. But once ICE reaches Completed, §8.1.2 says "the agent SHOULD stop
sending checks for a data stream once the ICE state for that data stream is Completed", and there
is no standard in-band way to nominate a different pair afterwards. §2.4: "Once ICE is concluded,
it can be restarted at any time for one or all of the data streams by either ICE agent."
→ **promotion after completion requires an ICE restart.**
`[verified: https://www.rfc-editor.org/rfc/rfc8445.html]`

**`draft-thatcher-ice-renomination-01`** was written precisely because of this gap ("an agent
nominates a cellular connection, then discovers Wi-Fi, but cannot renominate"). It is **expired,
dated 2016-09-19, with no formal standing**, and was superseded by `draft-thatcher-tsvwg-renomination`.
Chrome exposes it as a non-default `enable_ice_renomination` flag. Do not depend on it.
`[verified: https://datatracker.ietf.org/doc/html/draft-thatcher-ice-renomination-01]`

**Practice:** libwebrtc's `P2PTransportChannel` has `SwitchSelectedConnection()` /
`SwitchSelectedConnectionInternal()` and a `regathering_task_handle_`, and locally re-points its
*sending* path at a better connection; `RTCIceTransport`'s `selectedcandidatepairchange` event
exists to surface exactly that. But this is an implementation behaviour on the *sending* side of
each agent, not a spec guarantee, and the controlled agent still follows the nominated pair.
`[verified: webrtc `p2p/base/p2p_transport_channel.h`; MDN selectedcandidatepairchange — but the
end-to-end promotion behaviour is `[inference]`]`

**Recommendation:** connect on whatever wins, then run **one deliberate promotion attempt**:
if `getStats()` shows the selected pair is `relay` at T+3 s, call `restartIce()` with refreshed
candidates (including any UPnP/PCP mapping that came up late). MDN: `restartIce()` "resets ICE to
create all new candidates using new credentials, while allowing existing media transmissions to
continue uninterrupted", and it drives renegotiation through `negotiationneeded`, so the
interruption is negligible. Cap it at one attempt to avoid thrash.
`[verified: https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/restartIce]`

### 2.5 ICE restart on network change, and consent freshness

- Call `restartIce()` on `iceConnectionState === "failed"`, and on host-side network-interface
  change events (Windows `NotifyIpInterfaceChange` / Wi-Fi↔Ethernet flips, VPN up/down).
  `[verified: MDN restartIce]`
- **Consent freshness (RFC 7675, October 2015):** STUN binding requests every ~5 s (randomised
  0.8–1.2×, i.e. 4–6 s; never below 4 s), and **consent expires after 30 s** without a valid
  response — "the endpoint MUST cease transmission on that 5-tuple."
  `[verified: https://www.rfc-editor.org/rfc/rfc7675]`
  → A laptop lid-close or a roaming Wi-Fi event silently kills media in ≤30 s. Swoop's UI should
  detect `iceConnectionState` `disconnected` within a couple of seconds and start an ICE restart
  rather than waiting for `failed`.
- Cloudflare separately warns that allocations may be disrupted by their own maintenance or by
  Internet topology changes, and that ICE restart support is "highly recommended."
  `[verified: TURN FAQ]`

### 2.6 mDNS-obfuscated browser host candidates (same-LAN direct paths)

Chrome/Firefox replace private IPv4 host candidates with randomly generated `*.local` mDNS names
for privacy. A remote peer "will resolve these names to IP addresses and perform ICE processing as
usual" — but **only if it implements mDNS resolution**.
`[verified: https://datatracker.ietf.org/doc/html/draft-ietf-mmusic-mdns-ice-candidates-03]`

- **libwebrtc** has full registration and resolution support.
- **Pion** ships mDNS candidate support (`pion/mdns`, `SettingEngine`), and **webrtc-rs** inherits
  the same design.
  `[verified: https://docs.rs/webrtc/latest/webrtc/api/setting_engine/struct.SettingEngine.html
  and https://github.com/pion/mdns]`
- **Caveats:** mDNS does not cross subnets; Windows Firewall and many enterprise switches block
  multicast (UDP 5353); Firefox had a long-standing bug where mDNS candidates broke same-LAN P2P
  (`bugzilla 1698141`).

**Swoop implication:** this is *the* path for "operator and signage player on the same LAN", which
is a common Owlette deployment. The host **must** resolve `.local` candidates, and the installer
should add a Windows Firewall rule for inbound UDP 5353. Expect to have to document this for
customers whose switches suppress multicast. `[inference]`

### 2.7 NAT hairpinning

If both peers are behind the same NAT and the NAT does not hairpin, the srflx↔srflx pair fails.
The mDNS/host-candidate path (§2.6) is the mitigation and is strictly better anyway (LAN RTT,
LAN bandwidth, no Internet egress). Without mDNS resolution on the host, a same-LAN session on a
non-hairpinning NAT falls all the way back to relay — the worst possible outcome for the most
favourable network. `[inference]`

### 2.8 UPnP / NAT-PMP / PCP port mapping on the host

This is what Parsec does. Parsec's own support docs: *"By default, the Parsec app leverages UPnP to
establish a peer-to-peer (P2P) session between a client and host computer"*, with a NAT mode
alternative (manual/static port forwarding) and a separate **High Performance Relay (HPR)** server
for enterprise/restrictive networks that "removes reliance on UPnP or complex firewall rules."
`[source: support.parsec.app "Components and Connection Sequence", "Parsec Connectivity
Requirements", "Deployment Considerations and Options" — surfaced via search; direct WebFetch
returned HTTP 403, so the quotes are from search extracts, not a page I read]`

Mechanisms, in preference order:

1. **PCP (RFC 6887, April 2013)** — the modern one; supersedes NAT-PMP and includes a NAT-PMP
   transition appendix (a PCP server returning version 0 in `UNSUPP_VERSION` is a NAT-PMP server).
   `[verified: https://www.rfc-editor.org/info/rfc6887]`
2. **NAT-PMP** — Apple-origin, still common on consumer routers.
3. **UPnP IGD** — most widely deployed, most often disabled on business networks.

Value: a successful mapping converts an endpoint-dependent (symmetric) mapping into a stable,
inbound-permitting external `IP:port`, which the host advertises as a host/srflx candidate. That
turns a guaranteed-relay case into a direct case. Libraries: `miniupnpc` (C), `libplum` (C, does
all three), `igd-next`/`rupnp` (Rust). `[inference]`

Guardrails: opening inbound ports is a security posture change on the customer's network. Make it
a **per-site opt-in** with a clear description, always request a **short lease with renewal**
(never a permanent mapping), and release the mapping on session end and on service stop.
`[inference]`

---

## 3. What relaying costs in latency, and TCP/TLS head-of-line blocking

### 3.1 Anycast relay latency

- Measured relay penalty in the wild: **~140 ms mean RTT** (367 ms relayed vs 227 ms direct) —
  but that dataset used a handful of regional TURN servers.
  `[verified: Whereby/appear.in blog]`
- Cloudflare anycast should do much better: **~95% of users within ~50 ms of a Cloudflare PoP**,
  ~330 cities, and misrouted packets are carried on the Cloudflare backbone rather than the public
  Internet. `[verified: blog.cloudflare.com/webrtc-turn-using-anycast/, 2024-09-25]`
- **Expected added RTT for a single-sided Cloudflare relay between two peers in the same
  metro/country: ~5–25 ms.** Cross-continent, the relay adds roughly the detour distance — but
  with one-sided TURN the relay sits next to the *host*, so the browser-to-relay leg is the long
  one and is not much worse than browser-to-host direct. `[inference]`
- Cloudflare's own framing: with TURN on **both** ends the inter-edge hop rides their backbone and
  the reliable win is **packet loss, not raw latency**. `[verified: TURN FAQ]`

For a Parsec-class target (sub-30 ms glass-to-glass on LAN, sub-60 ms regional), a same-metro
Cloudflare relay is acceptable; a relayed transcontinental session is not going to feel like
Parsec regardless of what you do.

### 3.2 TURN over TCP/TLS: head-of-line blocking

When the client leg is TCP (3478/80) or TLS (5349/443), every lost segment on that leg stalls
*all* subsequent RTP for a retransmission RTT, because TCP will not deliver out of order. For
real-time video this converts a single packet loss into a multi-frame stall and a growing jitter
buffer. Additionally, TCP's congestion control fights WebRTC's own (GCC/transport-cc), and RTP
retransmission (NACK/RTX) becomes redundant work on top of TCP's.
`[well-established; the specific sources surfaced were secondary — HTTP/3-vs-HTTP/2 HOL explainers
and streaming-protocol write-ups. Treat the mechanism as verified engineering consensus, the
framing as [inference]]`

Mitigations, in the order they matter for Swoop:

1. **Detect it and change the encode.** `getStats()` exposes the selected candidate pair's
   `protocol`. When it is `tcp`/`tls`, immediately: cap bitrate (~4–8 Mbps), lower the frame rate
   target (30 fps, not 60), and raise the jitter buffer (`jitterBufferTarget` ≈ 120–200 ms) to
   trade latency for smoothness. Tell the user the session is in "compatibility mode."
2. **Turn off FEC** on the TCP leg — it is pure waste when the transport already retransmits.
   Also disable RTX/NACK aggressiveness for the same reason.
3. **Smaller frames / more frequent keyframes** so a stall recovers quickly; prefer intra-refresh
   over periodic IDRs so a stall never costs a whole keyframe.
4. **Prefer TCP 3478 over TLS 443 when both work** — TLS adds a record layer and a handshake, and
   many inspecting proxies will kill it anyway (§6, risk 2).
5. **Never choose TCP when UDP works.** Because relay pairs are lowest-priority and TCP-relay
   candidates are lower still, standard ICE already does this; verify it in `getStats()`.

`[all mitigations: [inference], standard practice]`

---

## 4. Signaling options

Constraint that shapes everything: the Owlette agent talks to Firestore over **REST**, and
Firestore's `Listen` is a **gRPC bidirectional stream only — it is not exposed over REST**. So a
Firestore mailbox means the agent *polls*. `[source: Firestore REST/gRPC docs + discuss threads via
search; the absence of a REST Listen method is `[verified: Firestore REST API reference has no
listen method]`, the phrasing is `[inference]`]`

### 4.1 (a) Firestore documents as a signaling mailbox

- **Browser side is fine** — the JS SDK's WebChannel listener delivers snapshots in a few hundred
  ms. **Agent side is the problem**: polling. At the service's `SLEEP_INTERVAL = 5` that is up to
  5 s of dead time; at 1 s it is ~500 ms average plus a read per poll per machine.
- **Write-rate hazard:** a single signaling document hammered with trickle candidates will hit
  Firestore's sustained per-document write limit (~1 write/sec). Use a `candidates` subcollection
  with one doc per candidate. `[inference — the 1 write/s/document soft limit is documented by
  Google but I did not re-verify it this session]`
- **Cost:** negligible. Free tier is 50,000 reads / 20,000 writes / 20,000 deletes per day.
  `[verified: https://firebase.google.com/docs/firestore/pricing]` Snapshot-listener updates are
  billed as reads ("you are charged for a read each time a document in the result set is added or
  updated"). `[verified: same page]` Exact per-100k prices could not be re-verified this session.
- **Rules:** a signaling doc must be readable/writable only by (the authorised user, the target
  machine). Given `firestore.rules` is a guarded file in this repo, this is a real cost.
- **Verdict:** usable as a **bootstrap / last-resort** channel (it is already authenticated and
  already reaches every agent), not as the primary. Click→first-frame with 1 s polling:
  **2.0–3.5 s**. `[inference]`

### 4.2 (b) WebSocket relay on the Next.js/Railway backend

- Next.js App Router route handlers cannot do a WebSocket upgrade; you need a custom Node server
  or a sidecar service. Railway supports WebSockets.
- **Fan-out problem:** with >1 instance, the host's socket and the browser's socket can land on
  different instances → you need Redis pub/sub or sticky routing.
- **Failover problem:** the Vercel standby origin cannot hold WebSockets, and the Cloudflare LB in
  front would have to be taught which origin can. A failover event drops every warm agent socket
  at once — a thundering-herd reconnect across the fleet.
- **Latency:** good (single region, one hop each side), ~20–60 ms per signaling message.
- **Burden:** high. It puts a stateful, fleet-wide long-lived-connection service into the
  deployment that currently auto-deploys from `dev`.
- **Verdict:** the worst fit for *this* architecture, despite being the most conventional answer.

### 4.3 (c) Cloudflare Durable Object WebSocket room — **recommended**

- One DO per (machine) or per (session) is a natural rendezvous: single-threaded, addressable by
  name, no shared state needed, no sticky routing, no Redis.
- **Hibernation API:** the object is evicted from memory while idle and reinitialised on the next
  event; per-connection state survives via `serializeAttachment()` (max 16,384 bytes).
  **Incoming ping frames get automatic pong responses without waking the handler**, and
  **incoming WebSocket protocol pings are not billed**. So a warm agent socket costs ~nothing.
  `[verified: https://developers.cloudflare.com/durable-objects/best-practices/websockets/ —
  "Last updated 2026-06-19" — and the DO pricing page]`
- **Cost** `[verified: https://developers.cloudflare.com/durable-objects/platform/pricing/ —
  "Last updated 2026-08-25"]`:
  - Free plan: 100,000 requests/day, 13,000 GB-s/day.
  - Paid: 1M requests/month included then **$0.15/million**; 400,000 GB-s/month included then
    **$12.50/million GB-s**.
  - **Incoming WebSocket messages are billed at a 20:1 ratio** (1M incoming messages = 50,000
    billed requests = **$0.0075**). Outgoing messages and protocol pings are **free**.
  - Hibernation-eligible objects incur **no duration charge**, even before actual eviction.
  - Outbound connections keep an object alive up to 15 minutes and do incur duration charges.
  - SQLite storage: 5 GB-month included, $0.20/GB-month; you can keep storage at zero.
  - **Not documented on those pages:** a max-concurrent-WebSockets-per-DO limit.
- **Signaling volume per session:** ~2 SDPs + ~10–30 trickle candidates + a few control messages
  ≈ 40 incoming messages ⇒ 2 billed requests ⇒ effectively free.
- **Auth:** the agent and the browser each present a short-lived JWT minted by the existing
  Next.js API (the agent already holds a 1 h Firebase ID token + refresh token; mint a separate,
  narrower *session* JWT). The DO verifies it — either against Firebase's JWKS (cacheable) or, for
  speed and independence, against an HMAC/Ed25519 key shared between the API and the Worker via a
  Worker secret. Reject on `exp`, `aud`, `machineId` mismatch, or replayed `jti`.
- **Latency:** browser → nearest CF PoP → DO home location → agent. A DO is pinned to where it was
  first created, so **create the DO from the agent's connection** so it homes near the host. One
  message hop ≈ 20–80 ms. `[inference]`
- **Burden:** one Worker + DO binding, `wrangler`, and Terraform-able. Cloudflare is already in
  the stack.
- **Landmine for the Python agent:** a persistent WebSocket must run on its own thread. The
  5-second main service loop must never block on it, and reconnect/backoff must live inside
  `ConnectionManager`, per this repo's guardrails.

### 4.4 (d) WHIP/WHEP-style HTTP signaling

- **WHIP is now RFC 9725** (Proposed Standard, **March 2025**); **WHEP is still a draft**
  (`draft-ietf-wish-whep-03`, 2025-08-18, expired 2026-02-19) though widely shipped.
  `[verified: https://www.rfc-editor.org/info/rfc9725/ and
  https://datatracker.ietf.org/doc/draft-ietf-wish-whep/]`
- Shape: `POST` the offer, get `201` with the answer and a `Location` resource; `PATCH` for trickle
  and ICE restart; `DELETE` to tear down.
- **It does not solve the host-push problem.** The host is behind NAT; something still has to tell
  it a session is starting. So WHIP/WHEP is a *browser-facing façade* over (b) or (c), not an
  alternative to them.
- It **is** an excellent browser-facing shape: one HTTPS POST through the existing API (already
  behind Cloudflare LB, already authenticated, already rate-limited), no second transport for the
  viewer, trivially compatible with the Vercel failover origin.
- Cost: whatever the POST costs. Latency: one RTT, but **no trickle unless you implement PATCH**,
  which means the browser must finish gathering first. With browser-side TURN removed (§0), the
  browser's gathering is host+mDNS+srflx only and completes in ~50–200 ms, so non-trickle is
  tolerable. `[inference]`

### 4.5 (e) MQTT and others

MQTT over WSS gives you retained messages and QoS, but it is a whole broker to run (or a vendor:
HiveMQ/EMQX/AWS IoT). It buys nothing over a DO room for a two-party rendezvous and adds a
dependency outside the existing Cloudflare/Firebase/Railway footprint. **Not recommended.**
`[inference]`

### 4.6 Recommended composite, and the connect-time budget

**Transport:** DO WebSocket room (c) as the canonical channel. The agent holds one hibernated WS
per machine. The browser joins the same room over WSS; if WSS is blocked, it falls back to the
WHIP-style HTTPS POST (d) through the Next.js API, which forwards over the agent's WS.

**Warm control connection:** the agent's DO WebSocket is the warm path — session setup never waits
on a poll interval. Keepalive with **protocol-level pings** (free, auto-answered, do not wake the
DO). Keep the Firestore path only for machine state and as a cold-boot rendezvous.

**Offerer/answerer:** **browser offers, host answers.**
- The browser can build a complete `recvonly` offer with no knowledge of the host
  (`addTransceiver('video'|'audio', {direction:'recvonly'})` + a data channel), so the offer can be
  generated — and even pre-posted — *before* the user clicks, removing a full round trip.
- The host answers by picking a codec from the browser's offer (H.264 / VP9 / AV1 by browser
  capability), which is the right direction for the decision anyway.
- The browser becomes ICE **controlling**. That is fine; the host still gathers the relay
  candidate it pays nothing for.

**Glare:** use MDN's **perfect negotiation** pattern, with the **host as the polite peer**
(it rolls back). Mid-session renegotiations — monitor switch, resolution change, adding audio —
come from the host and must never stall the browser's user-visible setup. The pattern needs
`negotiationneeded`, SDP rollback, and collision detection in `setRemoteDescription`.
`[verified: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation and
the Mozilla "Perfect negotiation in WebRTC" post]`

**Multiple viewers:** each viewer gets its **own** `RTCPeerConnection`, its own DTLS-SRTP session
and its own ICE state — never share one. On the host, encode once and fan the encoded frames out
to N SRTP senders if the stack allows it; otherwise, at N ≥ 3, publish once to **Cloudflare
Realtime SFU** and have viewers subscribe — **TURN is free when used with the SFU**, and the FAQ
says there is "no meaningful latency or throughput penalty" versus TURN. Accept that SFU mode is
always-relayed. `[verified: TURN FAQ; the encode-once design is [inference]]`

**Click → first frame budget** `[inference throughout]`:

| Step | Warm path | Cold / relay-TLS path |
|---|---|---|
| Authorize + mint session JWT + TURN creds (1 API RTT) | 60–150 ms | 150–300 ms |
| Offer to host over warm WS | 20–80 ms | 80–200 ms |
| Host answer + first trickle candidates | 20–60 ms | 100–300 ms |
| ICE: first successful check (srflx pair, 1 RTT) | 20–80 ms | 100–400 ms (TURN alloc + TLS handshake) |
| DTLS handshake (2 RTT) | 40–160 ms | 150–500 ms |
| Encoder first keyframe (pre-warmed vs cold) | 20–60 ms | 200–500 ms |
| Decode + paint | 30–80 ms | 50–120 ms |
| **Total** | **≈ 0.4–0.9 s** | **≈ 1.2–2.3 s** |

To hold p95 under 1.5 s: pre-warm capture+encoder on the host when the machine page opens (not on
click), pre-gather on both sides, keep the TURN allocation open, and keep the agent's WS warm.

---

## 5. Security model

### 5.1 Media confidentiality through the relay

WebRTC media is DTLS-SRTP end-to-end between browser and host; the TURN server relays ciphertext.
Cloudflare states this plainly: *"Cloudflare cannot access the contents of the media being relayed…
Cloudflare only relays encrypted packets and cannot decrypt or inspect the media content… the only
information Cloudflare processes… is the metadata necessary for establishing and maintaining the
relay connection. This includes IP addresses of the TURN clients, port numbers, and session timing
information."* `[verified: TURN FAQ]`

So the relay sees: both peers' IPs, ports, timing and volume. It does not see pixels or keystrokes.
That is the right story for customers, and it is worth putting in the docs verbatim.

### 5.2 Binding the DTLS fingerprint to an authenticated channel

DTLS-SRTP's security **rests entirely on the integrity of the signaling channel**: each side
publishes a SHA-256 fingerprint of its DTLS certificate in the SDP (RFC 5763 / RFC 8122 — which
bans MD5 and SHA-1), and the WebRTC security architecture (RFC 8827) requires signaling to be
authenticated and confidential. A signaling relay that can rewrite SDP can MITM the media.
`[verified: RFC 8122/8827 framing via secondary sources; the mechanism is standard]`

Concretely for Swoop:

1. The **agent** reports its DTLS fingerprint over its *authenticated* control channel (the DO WS
   authenticated by a JWT our API minted for that specific machine), and our API records it
   against `(machineId, sessionId)`.
2. The **browser** receives the expected fingerprint from our API over HTTPS — a channel it already
   trusts — and **pins** it: if the fingerprint in the answer SDP does not match, abort.
3. Include `sessionId` inside whatever the host signs, and reject an SDP whose fingerprint was
   bound to a different session. This is the practical mitigation for the **unknown key-share**
   class of attacks described in **RFC 8844**, where an attacker re-uses a legitimate peer's
   fingerprint to be mistaken for it. `[verified: https://www.rfc-editor.org/rfc/rfc8844.html]`

This is cheap and it is what makes "the Durable Object is a dumb relay" defensible.

### 5.3 Credentials and tokens

- **TURN credentials:** TTL = expected session length + 15 min, never the 48 h max. One credential
  per session. `customIdentifier` = machine (or site) so abuse shows up in GraphQL analytics within
  30 s. **Revoke on session end** via the revoke endpoint — do not leave credentials alive for
  their whole TTL. `[verified: generate-credentials + FAQ + replacing-existing]`
- **Never ship the TURN key** (the 64-char bearer token) to a browser or to an agent. Mint
  server-side only. `[verified: generate-credentials docs]`
- **Session token:** a short-lived JWT bound to `(userId, machineId, sessionId)`, `exp ≤ 60 s` for
  the join step, single-use `jti` recorded in the DO's SQLite storage for replay protection, and
  `aud` = the DO/worker. Rotate for the session's lifetime with a separate refresh path.
- **Rate limits:** per-user and per-machine session-start limits, and a per-account cap on TURN
  credential issuance, to bound the blast radius of a stolen token (TURN credential theft is a
  direct bandwidth-theft vector — Cloudflare explicitly calls out monitoring for credential abuse).

### 5.4 What the incumbents do, and what has bitten them

- **TeamViewer, 2016:** a wave of account takeovers attributed to **credential stuffing** — reused
  passwords from other breaches — led to victims' machines being remotely controlled and, in
  several cases, ransomwared (Surprise ransomware). Not a product vulnerability; the *account* was
  the perimeter and it was made of reused passwords. TeamViewer subsequently added trusted-device
  verification and forced resets.
  `[sources: bankinfosecurity.com "TeamViewer Bolsters Security After Account Takeovers";
  bleepingcomputer.com "TeamViewer abused to breach networks in new ransomware attacks" —
  via search extracts]`
- **TeamViewer, June 2024:** APT29/Midnight Blizzard breached TeamViewer's **corporate** network
  via a compromised employee account; employee directory and encrypted passwords copied. Product
  environment reportedly unaffected — but it shows the vendor is itself a target.
  `[sources: cybersecuritydive.com, therecord.media — via search extracts]`
- **RustDesk:** unattended access uses a **permanent password** on the device. If set weakly or
  reused across a fleet, anyone who learns the device ID + password gets silent access; OSS
  deployments have no central console to govern unattended permissions fleet-wide. A HIGH-severity
  cleartext-transmission CVE (**CVE-2026-30795**, ≤1.4.5) was reported.
  `[sources: realvnc.com evaluation, rustdesk-server-pro issue #1013, openmsp.ai review,
  a CVE tracker — all via search extracts; I did not fetch the CVE record itself]`
- **Chrome Remote Desktop:** unattended access = a **PIN** plus the Google account. Its documented
  weak points are a guessable PIN, a compromised Google account, and social engineering; and it is
  actively used by red teams and intruders as a **persistence and C2 channel** because its traffic
  is encrypted and usually allow-listed.
  `[sources: TrustedSec "Abusing Chrome Remote Desktop on Red Team Operations"; helpwire/cloudzy
  analyses — via search extracts]`
- **Parsec:** defaults to UPnP P2P, with an on-prem **High Performance Relay** for enterprise; its
  enterprise story is about *network* posture (no UPnP, no inbound rules) rather than auth.
  `[sources: support.parsec.app — via search extracts; direct fetch 403'd]`

**The single consistent lesson: the SaaS account is the perimeter, and it fails by credential
reuse.** Every one of these products can be turned into fleet-wide remote control by one
compromised login.

### 5.5 Concrete safeguards to build into Swoop

1. **Per-machine enable switch, default off.** Remote control is opt-in per machine, set by an
   authenticated admin, and the agent persists it locally. A machine that has never been enabled
   must refuse a session even if the backend says otherwise.
2. **Step-up auth before every session.** Require a **passkey/WebAuthn re-verification** (the
   product already supports passkeys) within the last N minutes before a session token is minted.
   This is the direct counter to the TeamViewer-2016 failure mode: a stolen password alone must not
   yield remote control.
3. **Mandatory MFA for any account with remote-control rights**, enforced at the role level, not
   as a suggestion.
4. **Host-side session indicator that cannot be suppressed**: a persistent on-screen badge (always
   on top, non-clickthrough) plus tray state plus a system notification at session start and end.
   For signage this can be a corner watermark; for attended machines, a banner.
5. **Local kill switch**: a hotkey (and a tray item) that terminates the session immediately and
   disables further sessions until re-enabled from the dashboard. Also a **fleet-wide kill switch**
   — a single flag the backend can set that every agent honours within one control-loop tick.
6. **IP allow-lists per site** for *who may start a session*, plus optional time windows
   (maintenance hours) for signage fleets.
7. **Audit everything, immutably**: session requested / authorised / denied / started / ended, with
   user, source IP, machine, site, duration, whether it was relayed, and the bytes. Surface it in
   the existing logs UI. Denials matter as much as successes.
8. **Fingerprint pinning** as in §5.2, so a compromised signaling path cannot MITM.
9. **Short TURN credential TTLs + revoke on end + `customIdentifier` monitoring** for bandwidth
   theft.
10. **Rate limit and alert** on: sessions per user per hour, new-machine first sessions, sessions
    from a new country/ASN for that user, and any spike in relayed GB per machine.
11. **Do not let the agent elevate.** Per this repo's standing guardrail, nothing in the session
    path may raise a UAC prompt unattended. If the viewer needs to interact with an elevated
    window, that is a separate, explicitly-designed capability, not a side effect.

---

## 6. Top risks

1. **Cloudflare per-allocation shaping vs desktop bitrates.** >50–100 Mbps or >5–10 kpps per
   allocation triggers drops. A 4K60 relayed session will be shaped. **Cap relayed bitrate
   ~25–30 Mbps and prefer ~1,200-byte payloads.** `[verified limits; mitigation [inference]]`
2. **TLS-inspecting corporate proxies.** `turns:turn.cloudflare.com:443` looks like HTTPS but is
   not; a proxy that terminates TLS will break TURN/TLS rather than pass it. Mitigation: try
   TURN/TCP 3478 and 80 as well, and give customer IT the four documented IPs to allow-list.
   `[inference; the IP list is verified]`
3. **Head-of-line blocking on TCP/TLS relay legs** makes the "works anywhere" path feel much worse
   than the direct path. Must be handled with an explicit degraded mode, not ignored.
4. **The billing asymmetry bet.** The whole cost model rests on "server↔peer is not part of
   billing." Documented, but verify with a metered test before it becomes a pricing assumption.
5. **mDNS blocked on customer LANs** → same-LAN sessions fall back to relay, which is the most
   embarrassing possible outcome. Needs a firewall rule in the installer and a diagnostic.
6. **IPv6-only edges.** Cloudflare issues IPv4 relay addresses only. Two IPv6-only peers with no
   IPv4 path (or no NAT64) cannot use the relay. Rare today, growing.
7. **Warm-WebSocket fan-out at fleet scale.** One DO per machine across a large fleet is fine on
   cost, but a mass reconnect (deploy, Cloudflare incident) is a thundering herd — needs jittered
   exponential backoff inside `ConnectionManager`.
8. **A blocking WebSocket in the Python agent's 5-second loop** would stall all monitoring. Must be
   its own thread, and reconnection must live in `ConnectionManager` (repo guardrail).
9. **Account takeover → fleet-wide remote control**, the failure that has hit every incumbent.
   Mitigated by §5.5 items 1–3 and 5, or not mitigated at all.

---

## 7. What I could not verify

- Whether `/credentials/generate-ice-servers` accepts `customIdentifier` (documented only on
  `/credentials/generate`).
- Whether the TURN key's 64-char bearer token can be re-read after creation.
- Max concurrent WebSockets per Durable Object (not on the pages I read).
- Exact Firestore per-100k read/write/delete prices (the Google Cloud pricing page truncated);
  only the free-tier quotas are verified.
- Firestore's ~1 sustained write/second/document limit — known from Google's docs, not re-read
  this session.
- Parsec's connectivity-requirements page (HTTP 403 on fetch); all Parsec statements come from
  search extracts of `support.parsec.app`.
- End-to-end *practical* behaviour of relay→direct promotion in current Chrome (libwebrtc has
  `SwitchSelectedConnection()`; spec-level renomination is expired). Needs a lab test.
- Direct-connect success rates for a business-network population — all published figures are
  consumer-weighted.
- Real measured added latency of Cloudflare anycast TURN specifically (Cloudflare publishes
  proximity claims, not relay RTT deltas). Needs measurement.

---

## 8. Sources

Cloudflare (primary):
- https://developers.cloudflare.com/realtime/turn/ — "Last updated 2026-09-09"
- https://developers.cloudflare.com/realtime/turn/faq/ (source: `cloudflare-docs` repo, `turn/faq.mdx`)
- https://developers.cloudflare.com/realtime/turn/generate-credentials/
- https://developers.cloudflare.com/realtime/turn/analytics/
- https://developers.cloudflare.com/realtime/turn/replacing-existing/
- https://developers.cloudflare.com/realtime/turn/what-is-turn/
- https://developers.cloudflare.com/api/resources/calls/subresources/turn/methods/create/
- https://developers.cloudflare.com/api/terraform/resources/calls/
- https://developers.cloudflare.com/durable-objects/platform/pricing/ — "Last updated 2026-08-25"
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/ — "Last updated 2026-06-19"
- https://blog.cloudflare.com/webrtc-turn-using-anycast/ — 2024-09-25
- https://blog.cloudflare.com/cloudflare-calls-anycast-webrtc (same technical deep-dive, linked from docs)

IETF:
- RFC 8445 (ICE), July 2018 — https://www.rfc-editor.org/rfc/rfc8445.html
- RFC 8656 (TURN) — referenced by Cloudflare for the billing model (Figure 1)
- RFC 8838 (Trickle ICE), January 2021 — https://datatracker.ietf.org/doc/rfc8838/
- RFC 7675 (Consent Freshness), October 2015 — https://www.rfc-editor.org/rfc/rfc7675
- RFC 6544 (ICE-TCP), March 2012 — https://www.rfc-editor.org/rfc/rfc6544
- RFC 6887 (PCP), April 2013 — https://www.rfc-editor.org/info/rfc6887
- RFC 6156 (IPv6 relay for TURN) — referenced by Cloudflare as not implemented
- RFC 6062 (TCP relaying for TURN) — referenced by Cloudflare as not implemented
- RFC 8844 (Unknown Key-Share attacks on DTLS-SRTP/SDP) — https://www.rfc-editor.org/rfc/rfc8844.html
- RFC 9725 (WHIP), March 2025 — https://www.rfc-editor.org/info/rfc9725/
- draft-ietf-wish-whep-03 (WHEP), 2025-08-18 — https://datatracker.ietf.org/doc/draft-ietf-wish-whep/
- draft-thatcher-ice-renomination-01, 2016-09-19, expired — https://datatracker.ietf.org/doc/html/draft-thatcher-ice-renomination-01
- draft-ietf-mmusic-mdns-ice-candidates-03 — https://datatracker.ietf.org/doc/html/draft-ietf-mmusic-mdns-ice-candidates-03

W3C / MDN / implementations:
- https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/restartIce
- https://developer.mozilla.org/en-US/docs/Web/API/RTCIceTransport/selectedcandidatepairchange_event
- https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection (iceCandidatePoolSize)
- https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation
- https://blog.mozilla.org/webrtc/perfect-negotiation-in-webrtc/
- https://raw.githubusercontent.com/webrtc-mirror/webrtc/main/p2p/base/p2p_transport_channel.h
- https://docs.rs/webrtc/latest/webrtc/api/setting_engine/struct.SettingEngine.html
- https://github.com/pion/mdns
- https://bugzilla.mozilla.org/show_bug.cgi?id=1698141 (Firefox mDNS same-LAN regression)

Google / Firebase:
- https://firebase.google.com/docs/firestore/pricing
- https://firebase.google.com/docs/firestore/enterprise/real-time-queries-at-scale

Measurements and secondary analysis (treat as indicative, not authoritative):
- https://medium.com/the-making-of-whereby/webrtc-and-turn-latency-around-the-world-4d172dd59e8e
- https://tailscale.com/blog/how-nat-traversal-works and .../nat-traversal-improvements-pt-1
- https://bloggeek.me/webrtcglossary/turn/ , https://bloggeek.me/psa-mdns-and-local-ice-candidates-are-coming/

Incumbent products and incidents (search extracts; not individually fetched):
- support.parsec.app — "Components and Connection Sequence", "Parsec Connectivity Requirements",
  "Deployment Considerations and Options" (fetch returned HTTP 403)
- https://www.bankinfosecurity.com/teamviewer-bolsters-security-after-account-takeovers-a-9171
- https://www.bleepingcomputer.com/news/security/teamviewer-abused-to-breach-networks-in-new-ransomware-attacks/
- https://www.cybersecuritydive.com/news/teamviewers-breached-employee-credentials/720306/
- https://trustedsec.com/blog/abusing-chrome-remote-desktop-on-red-team-operations-a-practical-guide
- https://github.com/rustdesk/rustdesk-server-pro/issues/1013
- https://www.realvnc.com/en/blog/is-rustdesk-safe/
