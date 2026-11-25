# hoot mcp: one tool per area, proven on dev (task 13.1, proof half)

**Run**: 2026-11-12, 00:18 to 00:23 PST, five minutes after PR #501 was deployed.
**Verdict**: every area answers on the deployed server with real data. The privileged tools were shown refused at "bounded changes", not run: see "Not verified".

## Setup

- **Server**: dev.owlette.app at `00548c8c` (PR #501 merged; `/api/health` names the commit).
- **Acting machine**: TEC-A4D (this dev box), installed agent on dev's source at `40be4df9`. No agent change was needed: these tools are answered by the server.
- **Grant**: TEC-A4D at "bounded changes", "chosen machines": owlette-kiosk, TEC-A4D, TEC-MBA. So it names its machines, which matters for the whole-site reads below.
- **Client**: the MCP stdio client of `proof-wave5.md`, through the installed `fleet_mcp.py`.

The tool list went from 38 to **52** at this tier: the fourteen read and bounded tools of the areas. The six privileged ones are offered at "privileged" only.

## What was run

| area | call | result |
| --- | --- | --- |
| reads | `get_metrics_history` owlette-kiosk, 1 hour, 3 points | real samples (cpu 2.3 %, memory 24.1 %, disk 78.4 %), `sampling: "downsampled: 3 of 59 samples, evenly spaced in time"`. 2.1 s |
| reads | `list_installed_software` TEC-A4D, limit 3 | 7-Zip 24.08, Adobe Acrobat, Adobe After Effects 2025, with version and publisher. 2.1 s |
| reads | `list_alert_rules` | refused: `this belongs to the whole site, and this machine may act on only some of its machines` |
| reads | `get_audit_log` | refused, the same words |
| screenshots | `capture_screenshot` TEC-MBA | **an image** came back to the client (`<image>` content), 12.6 s. Audit row `machine_command_dispatched`, command type `capture_screenshot`, `machine:TEC-A4D` → TEC-MBA (23bd8fee7fb1): it travels as its own command type now |
| screenshots | `list_recent_screenshots` TEC-MBA | one entry (`takenAt 2026-11-12T08:22:27Z`, 585 KB, monitor 0) with a signed link, and the newest attached as an image |
| screenshots | `capture_screenshot` owlette-kiosk | failed, from the kiosk's own agent: `capture: user-session execution failed: unsupported_job`. The released Linux agent cannot take a screenshot; that is the product gap already known from the docs audit, not this change. `list_recent_screenshots` there: `[]` |
| displays | `get_saved_display_layout` owlette-kiosk | `assigned: null`, auto-restore off, `note: "no display layout is saved for this machine"` |
| displays | `get_site_display_settings` | refused: belongs to the whole site |
| reboot schedules | `get_reboot_schedule` owlette-kiosk | `schedule: null` |
| deployments | `list_deployments` limit 2 | two real deployments (TouchDesigner 2025.31550 completed, 2025.32280 failed) with each machine's status |
| deployments | `get_deployment` `deploy-1774949953016` | that deployment |
| deployments | `list_software_presets` "touch" | the TouchDesigner preset with its installer and flags |
| deployments | `cancel_deployment` on the completed one | refused: `deployment deploy-1774949953016 has no install left to cancel` |
| deployments | `cancel_deployment` on an id that does not exist | refused: `deployment deploy-0000000000000 not found` |
| roost | `list_roosts` limit 3 | real roosts whose machines are inside the grant (`sdafewdf`, `tbl-2-7-mp4`), with current version |
| roost | `list_roost_versions` `tbl-2-7-mp4` | version 1, 274 MB, one file |
| privileged, at "bounded changes" | `set_reboot_schedule`, `create_deployment`, `deploy_roost_version`, `rollback_roost`, `update_owlette_agent` | each refused: `tool_not_allowed: this machine's grant offers no tool by that name` |

The whole-site rule is seen from both sides in this record and `proof-wave8.md`: TEC-A4D, whose grant names its machines, is refused the three site-wide reads here; a grant on the whole site was not used for them on dev (unit-tested).

## Not verified

- **The privileged tools doing their work on a machine**: `set_reboot_schedule`, `create_deployment`, `update_owlette_agent`, `deploy_roost_version`, `rollback_roost`. They are unit-tested, and the roost cores' 195 route tests pass unedited; on dev they were only shown refused below their tier. Running them means setting a machine to "privileged" and, for three of them, installing or deploying something real on a machine. The owner was offered a harmless pass (a switched-off reboot schedule set and cleared on the kiosk, and deploy calls that are refused before anything installs).
- **The three site-wide reads being answered** to a machine allowed on the whole site.
- **A screenshot from Linux** (the kiosk's agent cannot take one) and from Windows (TEC-A4D is the owner's own screen and was left alone).
- **`ask_hoot` and a second pass of the process tools**: proven in `proof-wave5.md`, not repeated.

## State left behind

- One screenshot of the MacBook's screen in dev storage (its history keeps the last 20).
- Nothing else: every other call was a read or was refused.
