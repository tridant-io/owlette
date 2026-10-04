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
