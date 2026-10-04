# keep screens awake — hardware proof (task 3.2)

Build: 4.1.1. Machines: TEC-A4D (Windows 11 Pro), TEC-MBA (macOS 26, Apple silicon), owlette-kiosk (Ubuntu 24.04
VM, GNOME 46 on Xorg). Each test sets a short idle timeout, records the old value, and puts it back afterwards.

## How each machine is read

- **kiosk** (`ksa-proof-kiosk.sh`, as the console user): `org.gnome.ScreenSaver.GetActive` (blanked),
  `loginctl show-session -p LockedHint` (locked), `org.gnome.SessionManager.IsInhibited 8` (the session's idle
  inhibit), Mutter's idle time (no input), and owlette's rows in `systemd-inhibit --list`.
- **MBA** (`ksa-proof-mac.sh`): `HIDIdleTime` (no input), `CGSSessionScreenIsLocked` in `ioreg -n Root`, owlette's
  rows in `pmset -g assertions`, and the `Display is turned on/off` lines in `pmset -g log`.
- **A4D** (`display-watch.ps1`, in the console session, unelevated): the console display state from
  `GUID_CONSOLE_DISPLAY_STATE` notifications, the screensaver flags, and seconds since the last input.
  `powercfg /requests` needs elevation, so the service's request is read from `displayAwake` instead.

## Control: the kiosk on 4.1.0, no keep screens awake

2026-10-04 02:13 UTC, idle-delay 60 s with lock on blank, nobody at the VM (idle 56 min):

```
02:13:37 t+1m blanked=true locked=yes gnome_idle_inhibited=false idle_s=3383 logind_owlette=[]
02:14:37 t+2m blanked=true locked=yes gnome_idle_inhibited=false idle_s=3443 logind_owlette=[]
```

The reading sees a blank and a lock within the first minute.

## Control: A4D on 4.1.0, no keep screens awake

2026-10-03 19:41 local, the AC display timeout set from never to 1 minute and back afterwards, nobody at the box
(idle 100 min). The display went off as soon as the timeout was set:

```
19:41:46 watch start
19:41:46 tick idle_s=6023 screensaver_active=0 screensaver_running=0
19:41:46 display off
19:45:46 tick idle_s=6263 screensaver_active=0 screensaver_running=0
```

## kiosk on 4.1.1 (local build of 4f3dfcc4)

Right after the install, both parts held: the service's logind inhibitor (`owlette`, `sleep:idle:handle-lid-switch`,
logged `keep awake: held (systemd_inhibit)`) and the app's GNOME idle inhibit (`ipc/keep_awake.json`:
`{"held":true,"how":"gnome_session"}`). `capabilities.keepAwake: 1` reached the machine record.

**On, 15 minutes** (02:40 to 02:55 UTC), idle-delay 60 s with lock on blank, idle 84 to 98 min: no blank, no lock.

```
02:40:55 t+1m  blanked=false locked=no gnome_idle_inhibited=true idle_s=5020 logind_owlette=[owlette:sleep:idle:handle-lid-switch]
02:47:55 t+8m  blanked=false locked=no gnome_idle_inhibited=true idle_s=5441 logind_owlette=[owlette:sleep:idle:handle-lid-switch]
02:54:56 t+15m blanked=false locked=no gnome_idle_inhibited=true idle_s=5861 logind_owlette=[owlette:sleep:idle:handle-lid-switch]
```

**Release on stop** (03:02 UTC). Both parts let go at once; GNOME restarts its idle clock when an inhibitor goes, so
the blank and the lock came one idle-delay later. Starting the service took both back.

```
03:02:02 agent stopped: inactive
03:02:32 stopped+30s  blanked=false locked=no  gnome_idle_inhibited=false idle_s=26  logind_owlette=[]
03:03:32 stopped+90s  blanked=true  locked=yes gnome_idle_inhibited=false idle_s=87  logind_owlette=[]
03:06:02 agent started: active
03:06:32 now          blanked=true  locked=yes gnome_idle_inhibited=true  idle_s=267 logind_owlette=[owlette:sleep:idle:handle-lid-switch]
```

**Found on the way: the app undid a stop.** The first try (02:55) printed `Job for owlette-agent.service canceled`:
the app's window started the service a quarter second into the stop, the first time after each app start. Reproduced
at will by restarting the app first; with the app closed the stop held. Fixed in 5e320550 (start only when found
stopped at launch). This was the unexplained "2 of 6 stops cancelled" seen on the kiosk on 2026-10-03.

Fix checked on the kiosk with a build of 5e320550: the reinstall restarted the app, and the first stop after it held
(`agent after the stop, fresh app running: inactive`).
