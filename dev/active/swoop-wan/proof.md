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
