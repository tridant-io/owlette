# A video on submitted issues — Plan
**Created**: 2026-10-15 | **Branch**: `feat/issue-video` (worktree `../Owlette-4114-wt`, stacked on fix/issue-toast-screenshots, PR #391)

The owner asked to let users attach videos as well as screenshots, with a file size limit, and chose **1 video per issue, up to 100 MB**. This plan extends the screenshot design in dev/active/issue-screenshots/plan.md and keeps its security model: the app stages files under random ids, the request carries only ids, and the service reads only from the staging folder with the same checks.

## Contract (fixed)
- **Limits:** 1 video per issue, up to 100 MiB (`100 * 1024 * 1024`). Recognised by magic bytes:
  - **mp4 or mov:** an ISO-BMFF `ftyp` box at offset 4. Major brand `qt  ` means `.mov`; every other brand (isom, mp41, mp42, avc1, iso2..iso6, M4V, dash, …) means `.mp4`.
  - **webm:** EBML header `1A 45 DF A3`, with `webm` in the first 64 bytes.
  - Anything else is refused: "only mp4, mov or webm videos".
- **Picker only:** no paste for video.
- **Staged file names:** the screenshot regex widens to `^[0-9a-f]{32}\.(png|jpg|webp|mp4|mov|webm)$`, in the same folder, `<data root>/ipc/issue-attachments/`, mode 0600, create_new. The video is copied streaming, not read whole into memory.
- **Tauri:** `stage_issue_screenshot` stays images-only. A new `stage_issue_video { path }` returns `{ id, size, kind: 'mp4'|'mov'|'webm', name }` with no preview. `discard_issue_screenshots` accepts the widened regex (or a renamed `discard_issue_attachments`, with the old name kept as an alias if the UI already calls it).
- **TS (desktop/src/lib/issueScreenshots.ts):** add `MAX_VIDEOS = 1`, `MAX_VIDEO_BYTES = 100 * 1024 * 1024`, `stageVideoFromPath(path)` and a `StagedVideo` type.
- **Payload:** `videos: string[]`, 0 or 1 ids matching the video part of the regex (`.mp4`, `.mov` or `.webm` only). Screenshot ids stay image-only.
- **Agent:**
  - Validation: `videos` is absent or a list of 0–1 valid video ids. `_accept_request` accepts it on the seam and still fits under 8192 bytes.
  - Reading: same checks as screenshots (O_NOFOLLOW, regular file, nlink 1, owner = console uid on POSIX). It re-checks magic and the 100 MiB size limit, streaming.
  - Zip: the video goes in as `videos/1.<ext>`, ZIP_STORED, after the screenshots and before any logs.
  - Size cap: the zip cap rises from 50,000,000 to 150,000,000 bytes. The logs' uncompressed budget is unchanged.
  - Status line: "adding video".
  - Issue text: a line `video attached: 1`. Report body: `videos: 1`, under the same rule as `screenshots`.
  - Done event: `videosAttached` (0 or 1), present whenever a video was requested. The files are deleted after the issue is filed, as with screenshots.
  - Upload: the PUT read timeout must allow a 150 MB upload on a slow link. Use a connect timeout of 30 s and a generous per-read timeout (e.g. 300 s). requests' read timeout is per socket read, not a total, so a long upload that keeps moving is fine.
- **Seam budget:** `Verb::ReportIssue` goes from 600 s to 1800 s in desktop/src-tauri/src/seam.rs, so a 150 MB upload at about 1 Mbps can still finish. Nothing else waits on it.
- **Web:**
  - `ISSUE_LOGS_MAX_BYTES` goes to 150 MiB, which covers the 150,000,000-byte zip.
  - The upload-url route's size validation follows that constant; check the OpenAPI spec mentions of 50 MB.
  - The route trusts `videos` (integer, exactly 1) under the same agent-plus-accepted-logsKey rule. The email names "a video" alongside logs and screenshots.
- **Docs:** troubleshooting and the changelog under Unreleased.
