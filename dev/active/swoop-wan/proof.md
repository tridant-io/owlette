# swoop across the internet — proof

## 1.3: the host's server-reflexive candidate on a real network (2026-10-04)

A real `RtcPeer` bound on TEC-A4D (192.168.88.10, behind the office router) with `stun_server` =
`stun.cloudflare.com:3478` (a throwaway ignored test, removed after the run). One request, one answer:

```
candidate ... 47.152.105.154 59395 typ srflx
```

`api.ipify.org` from the same box returned 47.152.105.154. B4A and the Mac sit on the same network and router, so
the reading stands for them; the code has no per-OS path and CI runs the new unit tests on macOS and Ubuntu.

Still owed: a session from another network (Task 4.2, the owner from a phone on cellular), since a viewer needs a
signed-in dashboard session.

## 3.2: the host's TURN client against a real server (2026-10-04)

coturn 4.6.1 on the kiosk VM (lab only: `turnserver --lt-cred-mech --realm owlette.lab`, one test user, UDP 3478,
started for an hour; the package's own service was disabled). From TEC-A4D:

```
SWOOP_TURN_LIVE="172.22.80.231:3478,<user>,<pass>" cargo test --features turn --lib -- --ignored live_allocation --nocapture
allocated: relayed 172.22.80.231:54117, mapped Some(172.22.80.1:57602)
after release: Released
```

The server took the 401 challenge, our MD5 long-term key and HMAC-SHA1 integrity, and answered with a relayed
address; the client checks the server's own integrity on that answer. Not yet exercised live: permissions, channels
and relayed media (the lab is all private addresses, which the client refuses to permit by design, as Cloudflare
does) and Cloudflare itself (needs the owner's TURN key).

## 3.1: relayed media on loopback through a fake TURN server (2026-10-09)

`cargo test --lib -- relay` in `agent/swoop` on TEC-A4D:

```
test transport::rtc::tests::a_relay_that_never_answers_leaves_the_peer_without_one ... ok
test transport::rtc::tests::the_fake_relays_allocation_becomes_one_trickled_relay_candidate ... ok
test transport::rtc::tests::two_peers_connect_only_through_the_fake_relay ... ok
```

The third test is the plan's "two real Rtc peers on loopback that connect only through a fake TURN server": the
viewer's only candidate is 198.51.100.7:50000, which nothing on the box can route to, and all it knows of the host
is the relay candidate 203.0.113.5:40000 the fake server granted. ICE and DTLS complete, the host reports the
nominated pair as relayed, the server holds a permission for the viewer's address and a channel bound to it.

Owed from a real network: a session to a 4.1.8 host from off-net, with the swoop log showing
`relay candidate gathered` and `media path is relay`.
