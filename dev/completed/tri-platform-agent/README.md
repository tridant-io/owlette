# tri-platform-agent — reconstructed plan folder

**This is a reconstruction, written 2026-09-17.** The original `dev/active/tri-platform-agent/` (gitignored, main checkout `C:\Users\admin\Documents\Git\Owlette`) was destroyed by a stray `rm -rf /c/` at 11:12 PM on 2026-09-16, while Wave 4 was running. Nothing here is the original text unless a line is tagged `[verbatim]`.

The plan made the Owlette agent (Python daemon) and the Tauri desktop app run on macOS and Linux as well as Windows.

## Files

| file | what it holds | original? |
|---|---|---|
| `plan.md` | goal, scope, architecture, numbered decisions, cross-plan rules C2/C3, wire names, lanes and branches | decisions 1–8, 12, 17, 22, 23 and C2/C3 are verbatim copies; the rest is reconstructed |
| `tasks.md` | waves and tasks, status per task, the Wave 3b log, the Wave 4 status at 11:12 PM | 16 task blocks verbatim (0.2, 0.4, 0.6, 3.1, 3.2, 3.4, 3.7, 4.1–4.7, 5.1, 5.3); every other block is reconstructed |
| `decisions.md` | owner questions Q1–Q24 and Q-M1–Q-M3 | Q23/Q24 closely paraphrased from their bookkeeper reports; most of Q1–Q22 is lost |
| `spikes/user-session.md` | spike 0.4 | original text lost; substitute evidence only |
| `spikes/linux-capture.md` | spike 0.3 | original text lost; substitute evidence only |
| `spikes/macos-tcc.md` | spike 0.2 | a stub in the original too (no Mac on the Windows box); substitute evidence from the Mac |

The original folder also held these files, which are **not** reconstructed here: `context.md` (C2 and C3 survive in `plan.md`), `lab.md`, `spikes/fleet-floor.md`, `spikes/pytest-matrix.md`, `spikes/notarize.md`, `patches/task-1.3-route-deletion.patch`, and the VM reports `vm-verify-2026-09-16.md`, `vm-verify-2026-09-16-rerun.md` and `vm-verify-2026-09-16-rerun2.md` [verbatim: T#2, T#113, T#166, T#199].

## Read this first: work that exists only on disk

- **`C:\Users\admin\Documents\Git\Owlette-wt-tri-w4a`**: Tasks 4.1 and 4.3, including the new `desktop/src-tauri/src/jobrunner.rs` (1,472 lines). None of it is on GitHub.
- **`C:\Users\admin\Documents\Git\Owlette-wt-tri-w4b`**: the 4.1 port plus Task 4.2 (`service_ctl.rs`, `process_ctl.rs`, `startup_link.rs`, `tray.rs` and others). None of it is on GitHub.
- Both folders lost their git metadata. Copies were made to `C:\Users\admin\Documents\rm-rescue\worktrees\` at 00:09 on 2026-09-17 [verbatim: I, the robocopy call; each worktree's robocopy exit was 1, which means files were copied].
- `tasks.md` → "Wave 4 status at 11:12 PM" has the file-level detail.

## Sources (cited by tag)

| tag | source |
|---|---|
| `H` | `dev/handoff/tri-platform-macos.md` at `8732260d` (origin/feat/tri-platform-macos). §§12–15 are verbatim copies of the plan's wire names, decisions, context.md C2/C3 and task blocks; §16 holds the Mac's amendments. |
| `H1` | the first version of the same file, at `3cc6e8cc` (2026-09-15) |
| `HL` | `dev/handoff/tri-platform-macos-log.md` at `8732260d` |
| `C:<sha>` | commit message and diff on origin (`feat/tri-platform-agent`, `-linux`, `-macos`) |
| `W4:4.2r2` | `…/f9c829c6…/subagents/workflows/wf_f23dac91-3bd/agent-a1f30853fe16b3970.jsonl`: the Task 4.2 round-2 review prompt, which embeds the 4.2 implementer's full report |
| `W4:4.5`, `W4:4.7` | `agent-a3478db7695eab9fb.jsonl` and `agent-abef5454a88413014.jsonl`: the implementer prompts for 4.5 and 4.7 |
| `W4:J` | `wf_f23dac91-3bd/journal.jsonl` (entries from 23:17 only, after the deletion) |
| `T#n` | `…/f9c829c6…/auto-mode-classifier-error.txt`: a copy of the Wave 4 session transcript (user messages and tool calls). `n` is the entry's line number in the transcript section, counting the `=== USER PROMPT (transcript) ===` marker as line 1. |
| `I` | `…/644f3cfe-d006-4060-86c2-6e9cb34be312.jsonl`: the incident-response session (process list and repo damage scan) |
| `D` | this reconstruction's own read-only comparison of the on-disk worktrees against origin commits (`diff -r --strip-trailing-cr`), 2026-09-17 |

## Confidence legend

- `[verbatim: SRC]`: quoted or copied from a surviving source. Where the source is itself a copy of the plan (H §§12–15), the text is the plan's own.
- `[inferred: SRC]`: derived from code, commits, file diffs or indirect references. The claim is likely but was not written this way in the plan.
- `[unknown]`: no surviving evidence. A placeholder, not a guess.

Unmarked lines in a section take the tag on that section's heading.
