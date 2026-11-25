# hoot mcp: a Mac as the acting machine, proven on dev (task 8.1, macOS half)

**Run**: 2026-11-11, 23:15 to 23:57 PST. **Verdict**: passed. Linux as the acting machine is not built (the owner's ruling: it waits), so this file has no Linux half.

## Setup

- **Acting machine**: TEC-MBA (MacBook, macOS 26.6), its installed 4.1.27 agent source replaced by dev's plus PR #502 (`feat/hoot-mcp-mac`, `f0caf00a`): copied over ssh, the released tree kept at `/Library/Application Support/Owlette/runtime/agent/src-backup-proof-20261111-231547`, the agent restarted with `launchctl kickstart`. The interpreter and its packages are the released ones.
- **Machines acted on**: owlette-kiosk (Linux) and TEC-A4D (Windows), same dev site.
- **Server**: dev.owlette.app, with PR #500 already on it.
- **Client**: the same MCP stdio client as in `proof-wave5.md`, run on the Mac over ssh **as the console user** (`rosco`, not root), starting `"/Library/Application Support/Owlette/runtime/python/bin/python3" "/Library/Application Support/Owlette/runtime/agent/src/fleet_mcp.py"`.
- **Grant**: the owner turned the TEC-MBA row on at 23:55:08 ("bounded changes").

## What was run

| # | step | result |
| --- | --- | --- |
| 1 | no grant | agent log `fleet session: none (this machine holds no grant to act on its site)`: the keeper runs on macOS and reads the server's answer. As the console user the script offers `fleet_status` only and says "no session". No `ipc/fleet` folder exists |
| 2 | the owner turns the row on (23:55:08) | the Mac gets `site_settings_refresh` at 23:55:10 and logs `fleet session: this machine holds a grant; session written` at 23:55:11, three seconds after the save |
| 3 | the folder and the file, made by the service as root | `drwxrwx--- root _owlette ipc/fleet`; `-rw-r----- root _owlette session.json` (177 bytes). This is the real group handover, which the unit tests only record |
| 4 | who can read it | the console user: yes. An account outside the group (`sudo -u nobody cat`): `Permission denied` |
| 5 | `fleet_status`, as the console user | `session: yes`, site `default_site`, machine `TEC-MBA`, server `dev.owlette.app` |
| 6 | tools | 38, the list of a "bounded changes" grant |
| 7 | `list_machines` | owlette-kiosk (`os: linux`), TEC-A4D (`windows`), TEC-MBA (`macos`): PR #500's fix, live |
| 8 | `get_system_info` on owlette-kiosk | real data (Linux 6.8.0-147, uptime 450 h 15 m), 6.9 s |
| 9 | `get_process_list` on owlette-kiosk | `lab-xterm` and `lab-sleep` RUNNING, 3.2 s |
| 10 | `restart_process` `lab-sleep` on owlette-kiosk | `Process lab-sleep restarted (PID 1591384 → 1596408)`, 5.0 s; the kiosk's log has `restart_process: terminated PID 1591384` and `ps` shows 1596408 |
| 11 | `get_system_info` on TEC-A4D, a Windows machine | `hostname: TEC-A4D`, `os: Windows 11`, 7.9 s |
| 12 | `run_command` on owlette-kiosk (privileged) | refused: `tool_not_allowed: this machine's grant offers no tool by that name` |
| 13 | a machine that does not exist | refused: `not_found: machine no-such-machine is not in this site` |
| 14 | the owner turns the row off (00:02:29.715) | the audit row says `revokedSenderIds: [TEC-MBA]` and `refreshedSenderIds: [TEC-MBA]`: the cut machine is told (PR #500, live). The Mac gets `site_settings_refresh` at 00:02:34 and logs `fleet session: none` at 00:02:38; `ipc/fleet/` is empty and `fleet_status` says "no session". **Eight seconds from the save to the file being gone**; before #500 it stayed until the next ten-minute refresh |
| 15 | the audit row of turning it on (23:55:13) | `changedSenders: { TEC-MBA: { maxTier: 2, wholeSite: true } }`: the row now says what changed (PR #500, live) |

## Tests on the real Mac

`agent/tests/unit/test_fleet_session.py` and `test_fleet_mcp.py`, run on TEC-MBA as the console user in a scratch venv: `120 passed, 1 skipped` (the Windows DACL test). The first run there failed three tests, all test faults, fixed in #502. What really executes on macOS there: a link planted at `ipc/fleet` after a first write gets no write through it; a folder owned by another uid is refused; `withdraw` does not follow a planted link; the group handover comes before the first byte.

## Not verified

- **The session file going away on a Mac when the machine is unpaired or the service stops.** The cut is proven (step 14); those two share its code.
- **The desktop app's dialog in a built macOS app** (the paths and the quoting are unit-tested; no macOS build was made tonight), and pasting its line into Claude Code on a Mac.
- **A second account on the same Mac**: only the user at the console during the install is in `_owlette`.

## State left behind

- TEC-MBA is back on its released 4.1.27 agent files since 00:03 (`diff -rq` against the copy taken first shows no difference; the two files the proof added, `fleet_session.py` and `fleet_mcp.py`, were moved to `~/hoot-mac-proof/added-by-proof`), its agent restarted and connected. The copy of the released tree is still beside it (`runtime/agent/src-backup-proof-20261111-231547`), and an empty `ipc/fleet` folder remains. Scratch there: `~/hoot-mac-proof` (staging, a scratch venv, the test copy), `~/proclist-proof`, `/tmp/owlette-hoot-mac-data`.
- owlette-kiosk: `lab-sleep` restarted once more (pid 1596408).
