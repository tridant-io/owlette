# owlette-host, our own Rust supervisor, replaced NSSM as the Windows service host

Through 2.x the agent ran under NSSM 2.24, and three of its behaviours each caused a production incident: stopping the service walked the process tree and killed the desktop app; its graceful stop depended on a console Control-C that failed silently, so a dead machine read as online for eleven minutes; and it ignored settings such as `AppKillProcessTree 0`. In 3.0.0 we replaced it with `owlette-host` (`agent/host`), which reports STOP_PENDING to the service manager and waits out a grace window, kills only the process it started, backs off a crash loop, and keeps its behaviour in the binary rather than in registry values.

## Consequences

- Agents older than 3.0.0 cannot run under this host. The installer migrates the service registration in place and removes `nssm.exe`.
- The host must depend on nothing beyond Windows itself: 3.2.1 made it statically linked after clean kiosk images lacked `VCRUNTIME140.dll`.
- macOS (launchd) and Linux (systemd) need no equivalent; this is a Windows-only component.
