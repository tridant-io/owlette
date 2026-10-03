# review 2 — security of the macOS swoop trust boundaries (Task 4.8)

**Reviewer**: fresh agent, did not write Wave 2. **Date**: 2026-09-30. **Base**: `swoop/macos`
at `b6b0d8ea` (last ten commits read). **Status of file**: local, gitignored, never committed
until the release that carries any fix has shipped.

**Verdict: clean.** No confirmed finding at high or critical, and no confirmed exploitable
cross-boundary path at any severity. The trust boundaries Wave 2 built hold within their stated
model. No code was changed. The two low/defense-in-depth notes and the CodeQL/120 s rulings are
recorded below; none is a fix.

## Scope and trust model reviewed

The adversary the task names: a member of the POSIX group (`_owlette` on macOS), or the console
user, against the root daemon across the socket, the job file, the exit file and the sweep; a
job the app should refuse; the sidecar allow-list; what `selfcheck` tells whom; and the bundle's
path from the daemon to the streamer.

The model the code is judged against (settled: plan decisions 2, 3; postinstall mode table):
- **root** owns the daemon and the token store (`.tokens.enc`, 0600 root; data root 0750 not
  group-writable). This is the asset boundary.
- **the console user** runs the desktop app, which spawns the streamer as its own child. The
  streamer therefore runs **as the console user**, and the session bundle (with its short-lived
  `hostToken`) is delivered to a console-user process by design. The console user's uid is the
  inside of the bundle's trust boundary, not the outside.
- **the `_owlette` group** owns the seam directories (`ipc` 0770, `ipc/swoop` 0770, `logs/swoop`
  0770, `ipc/jobs` and `ipc/results` 0770 by the `ipc/` rule) so the app can read jobs and write
  results. By default only the console user is in the group (postinstall adds exactly them);
  other members exist only if an admin added them.

## What was checked, and why it holds

1. **Forged `launch` job (group member → root daemon's runner).** The runner
   (`jobrunner.rs:485-500,147-158,305-308`) treats a job as `trusted` only when
   `meta.uid() == 0` (`sweep`, `jobrunner.rs:526`) — i.e. the request file is root's. A group
   member can create files in `ipc/jobs` (0770), but only root can create a root-owned file, and
   `accept()` also refuses any job file group/other-writable (`jobrunner.rs:154`). A group
   member's job is `owner != root` → `untrusted_job`. **Closed.**

2. **Program / args / env injection into the app's launcher.** `check_launch`
   (`jobrunner.rs:322-367`) resolves the program as `program_dir.join(name)` with `name` from a
   one-entry allow-list, never a path in the job (tested `jobrunner.rs:744-762`, incl. a path to
   the sidecar itself and `../bin/owlette-swoop`). `args` and `env` are allow-lists;
   `OWLETTE_DATA_ROOT` and `DYLD_INSERT_LIBRARIES` in the job are refused (`:757-758`). **Closed.**

3. **Path confinement of socket / stderr / exit_file.** `resolve_in` (`jobrunner.rs:373-392`)
   canonicalizes (follows every link) and requires the resolved parent to equal the canonical
   target directory; a dangling link at the final component is refused outright (symlink_metadata
   Ok but canonicalize NotFound → outer error). `check_socket` (`:395-407`) requires a socket
   owned by `socket_uid` (0 in production) and not world-writable. stderr and exit_file are opened
   with `O_NOFOLLOW` (`:415,475`); a non-regular stderr (fifo) is refused (`:345`). The checked,
   canonicalized paths — not the job's originals — are what `start()` uses (`:418,441`), so there
   is no check/use symlink swap. Tests `:764-836` cover linked socket, socket under a linked dir,
   linked/dangling stderr, exit_file under a linked dir, wrong uid, one-directory-up. **Closed.**

4. **Daemon reading the launch result (group member can write `ipc/results/<id>/`).**
   `swoop_spawn_posix._launched_pid` (`swoop_spawn_posix.py:406-417`) type-checks the pid; the
   daemon then admits the socket peer only if its uid equals the console user's
   (`spawn`, `:308-312`; `_peer_uid` reads `LOCAL_PEERCRED`/`SO_PEERCRED`, `:448-457`) and pins
   the pid only if that process runs as the console user (`_pin`, `:460-469`). A fake result can
   name a pid, but the pin refuses any pid that is not a console-user process, and `close()`'s
   kill therefore only ever reaches a console-user process — which the console user may already
   signal. No escalation past the console-user boundary. **Within model.**

5. **Console-user gate is genuine.** `console_user` → `darwin._console_session`
   (`darwin.py:529-561`) reads WindowServer's `IOConsoleUsers` (a kernel-published source a
   semi-trusted process cannot forge) and excludes uid 0, the login window, Setup Assistant and
   `_`-prefixed service accounts. The uid the peer check compares against is trustworthy. **Closed.**

6. **Bundle secrecy.** The bundle rides the socket as line 1 and never touches disk
   (`write_bundle`, `:150-157`, wipes the caller's buffer); `iter_lines`/`_remember_exit` never
   log payload; `spawn` logs only sid and pid (`:317`). The streamer zeroizes the line
   (`main.rs:111,121`) and never prints a bundle field (`:103-104`). The unit test asserts the
   secret and `sha256` never reach the log (`test_swoop_spawn_posix.py:225-233`). **Closed.**

7. **`selfcheck` disclosure.** `main.rs:62-76` prints one JSON line of grant booleans, a display
   count, a pid and a local-network result — no secret, no token. `--force` may call
   ScreenCaptureKit but only when preflight already said yes, so it raises no prompt unattended
   (`main.rs:60-61`, and the guardrail "no prompt without a click"). Over the launch job its
   stdout is the root socket; from an ssh shell it prints to that shell. Nothing sensitive
   crosses. **Closed.**

8. **Sweep safety.** `sweep_stale` (`swoop_spawn_posix.py:331-363`) opens `ipc/swoop` with
   `O_DIRECTORY | O_NOFOLLOW`, lists and unlinks via `dir_fd`, removes only `.sock`/`.exit.json`,
   never follows a link (tests `:367-393`, incl. a linked directory and a `.sock` symlink). **Closed.**

## Low / defense-in-depth (recorded, not fixed — no confirmed cross-boundary exploit)

- **L1 — the daemon does not bind the socket connection to the launched pid.**
  *Actor*: a process running as the console user (e.g. user-run malware), during the narrow
  window while a dashboard-initiated session is starting. *Mechanism*: race the sidecar's
  `connect()` to `ipc/swoop/<id>.sock`; the daemon accepts one connection, checks only peer **uid**
  (`swoop_spawn_posix.py:308-312`), not peer **pid** against the pid in `result.json`, then writes
  the bundle. *Outcome*: that process receives the `hostToken` — a capability the console user's
  uid is already trusted with (the streamer runs as that uid), so this does not cross the settled
  console-user boundary (decision 2). Not a reversal of that decision; recorded as hardening: the
  daemon could also read the peer pid (`LOCAL_PEERCRED`/`SO_PEERCRED` already carry it on the two
  arms) and require it to equal the pinned pid, closing the console-user-to-console-user race.
  A non-console group member cannot exploit it (fails the uid check → at most a DoS, see L2).
  **Recommended for a future hardening task; do not implement as part of 4.8.**

- **L2 — a second `_owlette` member can disrupt a session start.** *Actor*: a non-console account
  an admin added to `_owlette`. *Mechanism*: unlink/replace the root-owned job file in `ipc/jobs`
  (0770), connect-first to the socket (fails the uid check, killing the accept), or write a junk
  `result.json`. *Outcome*: the session start fails (DoS); no data crosses and nothing is
  elevated. Requires a second semi-trusted account that the default install never creates.
  **Backlog (low); inherent to the group-writable seam, which is settled tri-platform design.**

- **L3 — `.tmp` litter in `ipc/swoop` is not swept.** A failed `write_exit`
  (`jobrunner.rs:465-481`) can leave `<exit_file>.<pid>.tmp`, and `sweep_stale` matches only
  `.sock`/`.exit.json` (author-noted, Task 2.3 log). Non-security (the temp open is `O_NOFOLLOW`,
  so no write-through a planted link); pure housekeeping. **Backlog.**

- **stderr hardlink (author-noted, accepted, NOT a finding).** macOS has no protected hardlinks and
  the runner does not check the stderr file's link count, but the app opens it `O_NOFOLLOW` in
  append **as the console user**; a hardlink can only reach inodes the console user may already
  write, and the content is streamer log text. No escalation. **Accepted.**

## Rulings routed by the owner

### CodeQL 388 — `py/overly-permissive-file`, high, `os.chmod(socket_path, SOCKET_MODE)` (0660), `swoop_spawn_posix.py:378`

**Ruling: not a vulnerability. The boundary is correct. Recommend dismissal with the reason below.**

0660 `root:_owlette` on the socket is the intended and correct mode. `ipc/swoop` is 0770
`root:_owlette`, so no account outside the group can even traverse to the socket; within the
group, connecting requires write (0660 grants it to the group), and the daemon then admits the
peer **only if its uid is the console user's** (`spawn`, `:308-312`) and pins the pid **only if it
runs as the console user** (`_pin`, `:460-469`). The recipient by design is a console-user process
(the streamer runs as the console user), and the bundle carries a short-lived `hostToken`, not the
refresh token (which stays in `.tokens.enc`, 0600 root, unreachable by the group). So 0660 plus the
directory mode plus the peer-uid check is exactly the right boundary; a stricter socket mode
(e.g. 0600 root) would break the design, since the console-user app must connect. The group breadth
does not weaken it: the peer-uid check, not the group, is the gate, and the group is the console
user alone on a default install. The residual console-user-to-console-user race is L1 above —
within the settled boundary, hardening only. **Dismiss as "won't fix — by design": 0660
root:_owlette is required for the console-user app to connect; the real gate is the daemon's
peer-uid + create-time-pinned-process check, and the payload is a short-lived host token already
scoped to the console user's uid."** (Owner dismisses on GitHub; reviewer does not.)

### CodeQL 389, 390 — `py/overly-permissive-file`, high, `fake_runner.py:106` and `:146`

**Ruling: noise on a test double. Recommend dismissal; no code change.** Both sites open files at
`FILE_MODE = 0o640` (`fake_runner.py:34,106,146`), which is owner rw + group read, no write to
group or other. That is **already** the real runner's mode (`RESULT_FILE_MODE = 0o640`,
`jobrunner.rs:52`, used for the result, the exit file and the child's stderr), and the fake
deliberately mirrors it so the wiring test exercises production modes. There is nothing to tighten:
0640 is the target, not an over-permission. The file is a test-only double
(`agent/tests/integration/fake_runner.py`), not shipped. **Dismiss as "won't fix — test code; 0640
matches the production runner's result/exit/stderr mode by design."** Per the task, `fake_runner.py`
is Task 3.2's file and was not modified (no mode constant needed changing).

### The 120 s `osadapter.run_job` wait — finding or backlog?

**Ruling: backlog (robustness), not a security finding.** `swoop_spawn_posix.spawn` calls
`osadapter.run_job(...)` (`swoop_spawn_posix.py:295`), which waits `JOB_TIMEOUT_SECONDS = 120`
(`osadapter/posix.py:107,235-255`), not the job's `timeout_s = 10`. A desktop app that is alive
(so `_desktop_pid()` is not None) but wedged (never writes `result.json`) holds the **manager's
worker thread** for up to 120 s. It never touches the 5-second service loop (confirmed: `run_job`
runs on the worker; the capture path already bounds itself with `timeout_s + handover`,
`posix.py:307-311`, but the launch path does not). Impact: a single swoop session start hangs up
to 120 s before failing; monitoring is unaffected; no attacker gains anything a wedged
console-user app does not already cause. The clean fix (bound the launch wait like capture does)
lives in `osadapter.posix`/`run_job`, outside Task 4.8's two fix files, so it is a recorded
recommendation, not a change here. **Recommended for a follow-up task (e.g. bound the launch
`run_job` to `LAUNCH_TIMEOUT_S + handover`).**

## Verification

- `agent/.venv/Scripts/python -m pytest agent/tests/` on this Windows box:
  **2122 passed, 363 skipped** (the POSIX swoop tests are among the skips here; they run on the
  Mac and on CI's macos-15/ubuntu legs — Task 2.2/3.2 logs: green). No code changed, so no new
  test was added (clean review).
- `cargo test --locked` in `desktop/src-tauri` on this box: **119 passed, 1 ignored**. The runner
  is `cfg(unix)`, so on Windows this proves only that the crate builds; the runner tests run on
  the Mac/CI (Task 2.3 log: 128/128 on the Mac).
- `git status` does not show this memo (it is gitignored, unlike the force-added `review-1.md`),
  so it cannot be accidentally staged — the untracked/uncommitted state the task requires.

## Review 3 — the seam verbs, the client and the .app launch (2026-09-30)

**Reviewer**: fresh agent, did not write these changes. **Base**: `swoop/macos` at `395e7a7c`
(last 25 commits read; diffs of `0f55497f`, `395e7a7c`, `6eb91ddf` read in full). Line numbers
below are at `395e7a7c` unless a fix commit is named. The owner's 2026-09-30 decision (the app
may leave its site on the console user's click) is settled and not relitigated. L1-L3 above are
not refiled.

**Verdict: one medium finding, fixed in `576638ab`. Nothing else at medium or above.** The
new verbs, the client and the `.app` launch hold within the settled model. The medium is older
than these three commits (it came in with the seam, `fc330739`) but every new verb reaches it.

### F1 — medium — the seam's files were given to the group by name after the daemon closed them

- **Evidence**: `configure_site.py:1501` (`_issue_request_nonce`), `:1699` (`_spawn_into_reply`)
  and `:1741` (`_write_reply`) call `shared_utils.grant_data_group(path)` after `os.close(fd)`;
  that ends in `posix._chgrp` (`osadapter/posix.py:527-533`), an `lstat` + `lchown` on the
  **name**. Both names live in `ipc/` and `ipc/requests/`, 0770 root:`_owlette`.
- **Actor**: a process running as the console user, or any other `_owlette` member.
- **Mechanism**: `lchown` does not follow a symlink, but it does change whatever inode a hard
  link names. macOS has no protected hard links: as uid 501 on the Mac, `ln` of
  `/private/etc/sudoers` (0440 root:wheel) into another directory succeeds, and the data root is
  on the same Data volume as `/private/etc` (`df`). A link put under the name in the window
  between the daemon's close and its handover receives the group change. The nonce is
  re-issued on any tick it is missing, and refused requests are answered too, so the window
  recurs without limit.
- **Outcome**: root re-groups a root-owned file of the attacker's choosing on the Data volume
  to `_owlette`, which opens that file's group bits to the attacker (e.g. a 0440 root:wheel file
  becomes readable). An integrity violation outside the tree, done by root.
- **Why not high**: no secret or code-execution path was found. macOS keeps its secrets 0600,
  and a group change opens nothing on those. No root-trusted, group-writable file was found
  either. On Linux, distributions ship `fs.protected_hardlinks=1`, which refuses the link
  outright.
- **Fix**: `576638ab`. The group handover happens on the open descriptor (`fchown`), before
  the close: `_open_reply` hands over every answer it opens, which covers the pairing child's
  inherited descriptor too, and `_issue_request_nonce` hands over the nonce. The three
  name-based calls are gone. `posix.adopt_into_group` and `shared_utils.grant_data_group` now
  take a descriptor as well as a path. Test:
  `test_the_group_goes_to_the_file_the_daemon_wrote_not_its_name[answer|nonce]` swaps the name
  for a hard link the moment the daemon closes the file. On the old code, the handover lands
  on the link (red on the Mac). On the fix, it lands only on the written inode.

### Checked and clean (with the evidence)

- **Admission of the new verbs.** `leave`, `cancel_pair` and `dismiss_reboot` pass the same three
  gates as the old verbs (`_accept_request`, `configure_site.py:1324-1380`): console uid, no
  group or world write bit, current nonce. Each rotates the nonce on acceptance (`:1319`).
  `test_the_new_verbs_answer_to_the_same_three_rules` covers it. A request cannot be replayed
  once its nonce is spent.
- **`server`.** Vetted on the app (`agent_cli.rs` `vetted_server`) and again on the daemon
  (`:1369-1375`, exactly `dev|prod`, refused on any other verb). It becomes one argv element of
  a list `Popen`, with no shell, and argparse checks it a third time (`choices=['dev','prod']`).
  It reaches no path and no Firestore write, only which owlette server the pairing asks. Both
  are owlette's.
- **`cancel_pair` signals only the seam's pairing child.** `_cancel_pairing` (`:1667-1685`)
  signals `_pairing_child`, the `Popen` that `_start_pairing` created, and nothing else. No
  `waitpid(-1)` or SIGCHLD reaper exists in `agent/src`, so the pid stays the daemon's own
  unreaped child until `Popen` polls it, and `send_signal` re-polls first.
- **The leave's writes.**
  - `retire_machine_id` (`shared_utils.py` `retire_machine_id`) renames inside `config/`, and
    `rename(2)` follows neither name. A directory planted at `machine_id.left-<epoch>` only
    fails the last step, after the credentials are already cleared, so the machine is left
    coherent and detached. That is DoS by the asker or by an L2 actor, not escalation.
  - The cache delete is in `cache/`, 0750 and not group-writable.
  - The token clear is in the data root, 0750.
  - The Firestore delete is built from console-writable `config.json`, but the API base is
    allow-listed (`get_configured_api_base`) and the Firestore host is fixed (emulator only
    from the daemon's environment). The rules also bind an agent token to its own
    `site_id`/`machine_id` claims (`firestore.rules:148,296-297`), so no other machine's
    document can be reached.
  - Step order: the delete runs only after this process's cloud client is gone
    (`owlette_service.py:9370-9373` sets it to None on the disable transition).
- **Client (`seam.rs`).**
  - Requests are created `create_new` + `O_NOFOLLOW`, 0600, then renamed into place (`:245-260`).
  - The answer is read only from a regular file owned by uid 0, opened `O_NOFOLLOW|O_NONBLOCK`
    (`:203-226`).
  - `ASKING` serialises nonce use (`:84,127`).
  - The answer is removed only after a terminal event (`:166-171`).
  - Nothing from an answer becomes an argument, a path or a URL. Lines are forwarded to the
    frontend as events.
- **`.app` launch.**
  - `resolve_exec_target` (`shared_utils.py:3014-3040`) refuses an executable outside the
    bundle's own `Contents/MacOS` and a linked `Contents`/`MacOS` (realpath comparison).
  - `_validated` refuses a linked `exe_path`/`cwd`/`file_path` (`posix.py:1037-1049`).
  - Root only reads `Info.plist`, through `read_plist`: `O_NOFOLLOW`, size-bounded, and
    plistlib refuses entity declarations.
  - `open` and the application run as the console user in its GUI domain.
  - Adoption (`darwin._await_application`) takes only a process whose real uid is the console
    user and whose image is the bundle's binary. That is the console user's own process
    running the configured program. Root's later kill goes through the (pid, create_time)
    identity gate recorded at bind time (`owlette_service.py:3805-3816`). No escalation.
- **kqueue exit read.** The knote is attached to the process, not the number, and is
  `EV_ONESHOT` (`darwin.py:593-595`). `_watch_opened` drops any code a predecessor left under
  a reused pid, and codes are consumed once. The residual is the pre-existing pid-number
  supervision (`is_pid_running` is pid-only, `owlette_service.py:986-1003`), and it affects
  only crash-versus-clean booking, not a security property.

### Accepted / backlog (not findings)

- **Accepted (settled model).** Any process running as the console user, not only the app,
  can ask for a `leave`. The seam authenticates the uid, not the click (decision 2: the
  console user's uid is inside the boundary), and that console user can already switch cloud
  sync off by writing `config.json` (0660). What a leave adds is the dashboard row's removal
  and the cleared credentials. Each leave is audited with the uid (`_audit`, `:1744-1773`).
- **Backlog, low (extends L2).** A second `_owlette` member can move the console user's request
  out of `ipc/requests/` before the drain. The app then reports "did not answer", and the
  request stays valid until the nonce next rotates, so it can be returned later. It runs only
  the verb the console user asked for. Hardening: bound a nonce's age, or refuse a request
  older than the nonce it quotes.
- **Backlog, low (extends L2).**
  - The client reads `ipc/request_nonce` with `fs::read_to_string` (`seam.rs:185-198`), which
    follows a link and blocks on a fifo. A second group member can wedge the app's seam
    calls (`ASKING` is held).
  - `await_answer` does not check the link count (`seam.rs:212`), so a link to an older
    root-owned answer could show the app a stale outcome. The daemon still runs the real
    request.
  - Both are UI or DoS only. Hardening: open the nonce `O_NOFOLLOW|O_NONBLOCK`, require
    uid 0, a regular file and `nlink == 1`; also require `nlink == 1` on the answer.

### Verification (review 3)

- Mac, `~/src/owlette-swoop-mac-22`, the macos-15 row of `agent-tests.yml`
  (`OWLETTE_DATA_ROOT=/tmp/owlette-data-rev2`, its five `--ignore`s, `-x`, nothing deselected):
  **1870 passed, 251 skipped**. The new test is red on the `395e7a7c` sources (2 failed) and
  green on the fix; `test_configure_site_headless.py` gives 130 passed, 1 skipped.
- This box: `agent/.venv/Scripts/python -m pytest agent/tests/`: **2124 passed, 405 skipped** (the new test
  is POSIX-only and skips here).
- Desktop crate not touched, so no cargo run is needed for the fix.
