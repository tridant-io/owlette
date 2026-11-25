# hoot mcp: two-machine proof on dev (task 5.1)

**Run**: 2026-11-11, 18:17 to 19:01 PST, with the owner at TEC-A4D.
**Verdict**: passed against the deployed server, first from an MCP client script and then, at 20:39, from a real Claude Code session; the refusal for a machine with hoot off, a Mac as the machine acted on and the desktop app's dialog followed between 21:20 and 22:10. What is still not verified is listed at the end.

## Setup

- **Sender**: TEC-A4D (this dev box), installed agent 4.1.27 with its `agent\src` replaced by dev's source at `40be4df9` (from `Owlette-audit-wt`). One elevated run of `hoot-mcp-proof-swap.ps1`, one UAC prompt, owner present: started 18:17:57, `RESULT: ok. the agent is back on the new source` at 18:18:10. The swap added `fleet_mcp.py` and `fleet_session.py`. The installed source is kept at `C:\ProgramData\Owlette\agent\src-backup-proof-20261111-181757`.
- **Machine acted on**: owlette-kiosk (Linux VM, released agent 4.1.27, untouched), same dev site `default_site`.
- **Server**: dev.owlette.app at `4e80a640` (PR #495).
- **Client**: `proof_client.py`, an MCP stdio client that starts `C:\ProgramData\Owlette\python\python.exe C:\ProgramData\Owlette\agent\src\fleet_mcp.py` exactly as `claude mcp add hoot` would. It holds no credential: the script reads the session the agent keeps.
- **Grant**: set by the owner at dev.owlette.app, admin panel > hoot > settings. Row TEC-A4D, "chosen machines" = owlette-kiosk, first at "read", then "bounded changes", then off.

The same swap served owlette-3e's proof of #496 on this box (18:18 to 18:31); it reported four cases passed and no traceback in `service.log`.

## What was run

| # | step | result |
| --- | --- | --- |
| 1 | no grant | agent log 18:18:19 `fleet session: none (this machine holds no grant to act on its site)`; the script offers `fleet_status` only, which says "no session" |
| 2 | owner turns the row on (18:50:29.622) | session minted 18:50:35.931, 6.3 s later; agent log 18:50:37 `this machine holds a grant; session written` |
| 3 | tools at "read" | 15 tools, all tier 1 |
| 4 | `fleet_status` | `session: yes`, site `default_site`, machine `TEC-A4D`, server `dev.owlette.app` |
| 5 | `list_machines` | one machine, owlette-kiosk (the site has more): narrowed to the grant. 2.1 s |
| 6 | `get_system_info` on owlette-kiosk | real data (Linux 6.8.0-147, uptime 445 h, agent 4.1.27). 6.4 s |
| 7 | `get_process_list` on owlette-kiosk | `lab-xterm` and `lab-sleep` RUNNING. 3.9 s |
| 8 | `get_system_info` on TEC-MBA | refused: `machine_not_granted: this machine's grant does not reach TEC-MBA` |
| 9 | `restart_process` at "read" | refused: `tool_not_allowed: this machine's grant offers no tool by that name` |
| 10 | owner sets "bounded changes" (18:54:22.840) | 38 tools at the next listing, with `ask_hoot`, `update_process`, `add_process`, `delete_process`, `restart_process` |
| 11 | `restart_process` `lab-sleep` on owlette-kiosk | kiosk log `restart_process: terminated PID 1455210`, `Process launched with PID 1476437`; a second run answered `Process lab-sleep restarted (PID 1476437 → 1476746)` in 5.5 s; `ps` on the kiosk shows 1476746 |
| 12 | `ask_hoot` ("what is the uptime of owlette-kiosk, and is its lab-sleep process running?") | a real hoot turn on the site owner's key, answered in 8.6 s; the kiosk log shows the turn's two tool calls (`get_process_list`, `get_system_info`) |
| 13 | `run_command`, `reboot_machine` on owlette-kiosk (tier 3) | both refused: `tool_not_allowed` |
| 14 | `restart_process` on TEC-MBA | refused: `machine_not_granted` |
| 15 | owner turns the row off, a client connected and calling `list_machines` every 2 s | save at 18:58:39.004; last allowed call 18:58:38.078; next call, 18:58:40.396, refused `fleet_session_invalid`: **1.4 s after the save** (the task allows 10 s) |
| 16 | after the cut | the script offers `fleet_status` only; every call is refused. The agent dropped its own session file at its next refresh, 19:00:39, and `fleet_status` then says "no session" |

## From a Claude Code session

20:39:50 to 20:40:30 PST, after the owner turned the row on again ("bounded changes", owlette-kiosk). In a scratch folder: `claude mcp add hoot -- "C:\ProgramData\Owlette\python\python.exe" "C:\ProgramData\Owlette\agent\src\fleet_mcp.py"` (local scope, that folder only), one headless session (`claude -p`, Claude Code 2.1.322, Sonnet, `--allowedTools mcp__hoot`), then `claude mcp remove hoot`. The session's own tool calls, from its stream-json record (`cc-proof/session3.jsonl` in the session scratchpad):

| call | result |
| --- | --- |
| `fleet_status` | `session: yes`, site `default_site`, machine `TEC-A4D`, server `dev.owlette.app` |
| `list_machines` | owlette-kiosk, online, agent 4.1.27 |
| `get_system_info` on owlette-kiosk | real data (Linux 6.8.0-147, uptime 446 h 59 m) |
| `restart_process` `lab-sleep` on owlette-kiosk | `Process lab-sleep restarted (PID 1499349 → 1516390)` |
| `get_process_list` on owlette-kiosk | `lab-sleep`: `running: false, pid: null, status: KILLED`, which is finding 1 below, live |
| `get_system_info` on TEC-MBA | refused: `machine_not_granted: this machine's grant does not reach TEC-MBA` |

An earlier session at 19:45 ran while the row was on with no machines picked (my watcher fired on the tier alone): `list_machines` answered `[]` and every call on owlette-kiosk was refused with `machine_not_granted`. That is the rule "a sender with no machines reaches nothing", seen from Claude Code.

## Later the same evening

The owner set the TEC-A4D row to "bounded changes" reaching owlette-kiosk, TEC-A4D and TEC-MBA (22:02).

- **A machine with hoot off** (22:03): hoot switched off on owlette-kiosk through the dev API (`PATCH /api/sites/default_site/machines/owlette-kiosk/hoot-enabled`), for 37 seconds. `get_system_info` and `restart_process` on it were both refused: `hoot_disabled: hoot is turned off on machine owlette-kiosk`. `list_machines` showed `hootEnabled: false`. Switched back on, and a call went through again.
- **A Mac as the machine acted on** (22:04 to 22:09, TEC-MBA, macOS 26.6, agent 4.1.27): `get_system_info` (Darwin 25.6.0); `add_process` added a throwaway `proof-48-sleep` (`/bin/sleep 3600`, launch mode always) and the Mac's agent had it running within about ten seconds; `restart_process`, `get_process_list`, `kill_process` and `delete_process` all worked. A numeric field sent as a number was refused in plain words (`invalid_field: Field time_to_init must be a string`), which is what the tool's schema says.
- **PR #498 on the Mac**, the same before and after as on the kiosk: `KILLED` after a restart on the released files, `RUNNING` with the new pid with the fix installed, the old row still in `app_states.json` both times. In the PR's second comment. The Mac's original files are back, byte-identical, and the throwaway process is deleted.
- **The desktop app's dialog** (21:21): dev's build of the desktop app (`desktop/src-tauri/target/release/owlette-desktop.exe`, the same desktop code as dev) run on TEC-A4D against the installed agent, driven over WebView2's debugging port. The menu has **connect an ai agent**; the dialog shows `claude mcp add hoot -- "C:\ProgramData\Owlette\python\python.exe" "C:\ProgramData\Owlette\agent\src\fleet_mcp.py"`, built by the real host from this box's install root; a click copies exactly that line (read back from the clipboard) and shows "copied to clipboard". Dark theme, the owner's. Screenshots: `dev/scratch/fleet-ui-shots/real-app-*.png`. The installed copy in `C:\ProgramData\Owlette\app` is still 4.1.27 and was closed for about a minute; the service started it again.

## Audit rows

From `GET /api/sites/default_site/audit-log` on dev. Times are PST.

| time | actor | target | what | hash |
| --- | --- | --- | --- | --- |
| 18:50:26.462 | user (owner) | default_site | set_fleet_settings, no senders | 1364961206ca |
| 18:50:29.622 | user (owner) | default_site | set_fleet_settings, senders TEC-A4D, refreshed TEC-A4D | 23a42a523389 |
| 18:50:35.931 | machine:TEC-A4D | TEC-A4D | fleet_session_minted | eb82d9c4a283 |
| 18:50:44.606 | user (owner) | default_site | set_fleet_settings | 27ab61029c3c |
| 18:50:53.280 | user (owner) | default_site | set_fleet_settings | df1d1f3346b3 |
| 18:51:28.639 | machine:TEC-A4D | cmd_mwcybmko_c8oxp3yd | get_system_info on owlette-kiosk | e99afa30a95e |
| 18:51:38.149 | machine:TEC-A4D | cmd_mwcybtzc_cvszs5cx | get_process_list on owlette-kiosk | c052715ee2f7 |
| 18:54:22.840 | user (owner) | default_site | set_fleet_settings | 2639da5af3a4 |
| 18:54:56.933 | machine:TEC-A4D | cmd_mwcyg3dd_8w08xtbc | restart_process on owlette-kiosk | 8ea59247ff1e |
| 18:55:07.582 | machine:TEC-A4D | cmd_mwcygbli_r4h1ph0q | get_process_list on owlette-kiosk | f30fea06d75f |
| 18:55:46.339 | machine:TEC-A4D | cmd_mwcyh5g5_703253x9 | restart_process on owlette-kiosk | 8e1f50a8cfe2 |
| 18:56:14.006 | machine:TEC-A4D | cmd_mwcyhquv_jm7iopyu | get_process_list on owlette-kiosk | c9716d0c8bc2 |
| 18:57:08.096 | machine:TEC-A4D | cmd_mwcyiwl4_qfyzxfqj | get_process_list on owlette-kiosk | 8737bcf378aa |
| 18:58:39.004 | user (owner) | default_site | set_fleet_settings, revoked TEC-A4D | 526b7081e276 |

### Authorization decisions (the refusals)

Read 2026-11-11 22:20 PST from `sites/default_site/audit_log` in the dev database, on the owner's word. gcloud's login on this box had expired, so the read went through the firebase CLI's own login (the same Google account) and its read tool, on the dev project only. The 300 newest decisions, 18:28 to 22:09 PST: 220 by `machine:TEC-A4D`, 209 allowed and 11 denied. **Every refusal made that evening has its row**, naming the tool and the machine:

| time | reason | tool | on | row |
| --- | --- | --- | --- | --- |
| 18:51:45 | machine_not_granted | get_system_info | TEC-MBA | gteu7FNO |
| 18:51:49 | tool_not_allowed | restart_process | | hkxcqz2F |
| 18:55:14 | tool_not_allowed | run_command | | MLpensmH |
| 18:55:20 | tool_not_allowed | reboot_machine | | 1nzYjUwI |
| 18:55:26 | machine_not_granted | restart_process | TEC-MBA | a2JPYFvT |
| 19:45:15 | machine_not_granted | get_system_info | owlette-kiosk | QBxUnyNW |
| 19:45:18 | machine_not_granted | restart_process | owlette-kiosk | nxiLAg12 |
| 19:45:20 | machine_not_granted | get_system_info | TEC-MBA | MvpZCbUK |
| 20:40:18 | machine_not_granted | get_system_info | TEC-MBA | kyBSxFBt |
| 22:03:25 | hoot_disabled | get_system_info | owlette-kiosk | lRPjkrk8 |
| 22:03:32 | hoot_disabled | restart_process | owlette-kiosk | U8JOOfmQ |

Every changing call has an allowed row too, with capability `MACHINE_EXEC_COMMAND`: six `restart_process`, `ask_hoot` (18:55:55, row WvC5LO6O), two `add_process`, `kill_process`, `delete_process`. A denied row records the entry capability (`MACHINE_VIEW`) whatever the tool.

## Found on the way

1. **Agent bug, released 4.1.27, not in hoot mcp: `get_process_list` reports a running process as KILLED.** After the second restart of `lab-sleep` the tool answered `status: KILLED, pid: null, running: false` for at least 70 s, while `ps` on the kiosk showed pid 1476746 alive and the dev API (`/machines/owlette-kiosk/processes`) showed it RUNNING. The kiosk's `tmp/app_states.json` held two entries for `lab-sleep`: the terminated pid 1476437 as KILLED and the live pid 1476746 as RUNNING; the tool reports the old one. The first restart logged `Cleaned up 1 stale PID entries`; the second, which logged `was launched by another thread while this launch waited for the lock`, did not. hoot repeated the wrong fact: its `ask_hoot` answer said `lab-sleep` is not running. The stale row stays until the five-minute `cleanup_stale_tracking_data`, so this follows any restart, not only a second one. **Fixed the same evening: PR #498, merged into dev at `c2f34bdc`** (`shared_utils.state_rows_by_process`, asked by the tool and by the dashboard's metrics). Before and after on the kiosk are in the PR's first comment: `KILLED` on the released files, `RUNNING` with the new pid with the fix installed, while the old row was still in the file.
2. **`list_machines` answers `"os": null`** for owlette-kiosk.
3. **The audit row of a grant change does not say what changed**: it lists the senders, not the tier nor the machines a sender reaches. Rows 27ab…, df1d… and 2639… look identical though one of them raised the tier.
4. **Authorization decisions are stored but shown nowhere.** `ask_hoot` and every refusal have their rows in `sites/{siteId}/audit_log` (above), but those documents carry no `recordedAt`, so `GET /api/sites/{siteId}/audit-log` never lists them, and no dashboard page reads them. This is the platform's audit design, not hoot mcp's; a site admin cannot see who was refused what without the database.
5. **A cut sender is not told.** The server refuses at once, but the agent keeps its session file until its next refresh (2 min here, up to 10), so `fleet_status` says "session: yes" for that long.
6. **The page hides whom a sender acts on.** Three times the owner turned rows on and set "how far" without finding "on which machines", so the row reached nothing; the last time he turned on a second row thinking it adds a machine to act on. owlette-f8 is changing the row (it opens on "pick machines", and a row that reaches nothing says so) and, on the owner's ruling, the sidebar: hoot is one item under fleet, not a section with a "settings" item.
7. **macOS, seen once, not looked into:** when the Mac's agent restarted, it refused the pid of a process started by `restart_process` a minute earlier as "pid recycled (recorded create_time ... does not match the live process)", dropped the row, and adopted the same pid again 0.3 s later by its executable. At the next restart another such pid was "re-adopted by identity".
8. In the proof client only: the installed `mcp` package names its fields in snake case (`is_error`, `input_schema`), and an answer with `→` cannot be printed to a cp1252 console. Both handled in the client; `fleet_mcp.py` itself was not affected.

## Not verified

- **macOS or Linux as the sender** (waves 7 and 8), and the fix of PR #498 installed on a Windows machine (its unit tests pass on Windows, macOS and Ubuntu).

## State left behind

- TEC-A4D's installed agent runs dev's source at `40be4df9`, not the released 4.1.27, until the next install or an elevated restore from the backup folder above.
- On dev's `default_site`: "let machines act on other machines" is on, and since 20:39 the TEC-A4D row is on again ("bounded changes", owlette-kiosk) until the owner turns it off; one hoot chat "task from TEC-A4D".
- owlette-kiosk: on its released 4.1.27 files again (the fix was installed for two minutes and taken out, originals byte-identical; its agent restarted twice). `lab-sleep` was restarted four times in all. Scratch left there: `/opt/owlette.bak-proclist-1794458445` (the two original files) and `~/proclist-proof`.
- Claude Code's config is as it was: hoot was registered for one scratch folder and removed.
- TEC-MBA: on its released files again (the fix was installed for under two minutes; its agent restarted twice); the throwaway process is deleted. Scratch left there: `~/proclist-proof`.
- At 22:10 the TEC-A4D row was still on, reaching three machines, and the owlette-kiosk row may be on as a sender; both are the owner's to turn off.
