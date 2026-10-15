# Screenshots on submitted issues — Plan
**Created**: 2026-10-14 | **Branch**: `feat/issue-screenshots` (worktree `../Owlette-4114-wt`, from origin/dev 5cf47595)

The owner asked that a user can add screenshots to an issue from the desktop app, up to a reasonable limit, and that they ride in the zip support downloads.

## Contract (fixed; every task builds to it)
- **Limits:** 5 images per issue. PNG, JPEG or WebP only, recognised by magic bytes, never by extension. At most 8 MB each (8 MiB), so five plus the logs stay under the 50,000,000-byte zip cap.
- **Staging folder:** `<data root>/ipc/issue-attachments/`.
  - On POSIX, `ipc/` is 0770 root:owlette, the console user is in the group, and the app writes files there as itself.
  - On Windows the data root is users-modify.
- **Staged file names:** `<32 lowercase hex>.<png|jpg|webp>`, matching the regex `^[0-9a-f]{32}\.(png|jpg|webp)$`.
- **Tauri commands (desktop/src-tauri):**
  - `stage_issue_screenshot`. Input is either `{ path: string }` (a file the user picked) or a raw request body of pasted bytes (Tauri 2 `tauri::ipc::Request` / `InvokeBody::Raw`, from a `Uint8Array`). It reads the source as the user, checks the magic bytes and the 8 MB limit, and writes the file 0600 (POSIX; root reads it regardless, and on macOS a group bit would let other owlette-group accounts read it) under a fresh random id with create-new semantics. It returns `{ id, size, kind: 'png'|'jpeg'|'webp', preview }`, where `preview` is a `data:` URL for the thumbnail.
  - `discard_issue_screenshots { ids: string[] }` deletes staged files by id. Each id must match the regex, and nothing outside the folder is ever deleted.
- **Report payload** (desktop → agent, through the seam on POSIX or the staged payload on Windows): `screenshots: string[]`, holding 0 to 5 ids that each match the regex. The payload never carries a path.
- **Agent:**
  - It accepts `screenshots` only as a list of 0 to 5 strings matching the regex, and collapses repeats, keeping the first order.
  - On POSIX it opens each file from the staging folder with O_NOFOLLOW, and requires a regular file, nlink 1, and owner == console uid. It re-checks magic and size, and adds the image to the zip as `screenshots/<n>.<ext>` before any logs.
  - If any screenshots are present, it builds and uploads a zip even when attachLogs is false; that zip holds the screenshots and the manifest.
  - It deletes the staged files only once the issue POST itself succeeded, whether or not the attachment upload did. A run that could not file the issue (it ends in an error event) leaves them, and the dialog keeps them for a retry; cancel or close still discards them.
  - It adds `screenshots attached: N` to the issue text, and sends `screenshots: N` (an integer) in the request body, both only while the zip's key goes with the issue. Under the same rule it sends `logs: true` when the zip holds any log file (build_log_zip's `files` beyond its `screenshots`).
  - The done event gains `screenshotsAttached: number`, present (possibly 0) whenever screenshots were requested. The dialog warns on 0, and on fewer than it sent ("only N of M screenshots could be attached").
- **Web:** the route reads `screenshots` only from an agent token with an accepted logsKey, as an integer 1 to 5 (anything else counts as none), and `logs` under the same rule, as strict `true`; it never parses the description. It stores `logs.screenshots` but not the logs flag (an agent before 4.1.14 sends neither field, so an absent flag cannot mean "no logs" on the record). The email says "logs are attached to this issue", "N screenshot(s) are attached to this issue" or "logs and N screenshot(s) are attached to this issue", then the download link (superadmin only, kept 30 days); no screenshots count means logs, whatever the flag says.
- **Download:** the admin route names the file `owlette-issue-<host>-<YYYY-MM-DD>.zip` (was `owlette-logs-…`), since it may hold screenshots.
- **Paste:** the dialog takes a paste as screenshots only when the clipboard has an image item and no `text/plain` item; anything else goes to the text box.
