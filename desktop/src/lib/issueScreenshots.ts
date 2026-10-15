/**
 * Screenshots attached to an issue report. The host copies each image into
 * the data tree's `ipc/issue-attachments` under a random id and the report
 * carries only the ids (see `src-tauri/src/issue_attachments.rs`).
 */

import { invoke } from '@tauri-apps/api/core'

export const MAX_SCREENSHOTS = 5
export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024
/** A staged screenshot's id, which is also its file name. */
export const SCREENSHOT_ID_RE = /^[0-9a-f]{32}\.(png|jpg|webp)$/

export interface StagedScreenshot {
  id: string
  size: number
  kind: 'png' | 'jpeg' | 'webp'
  /** A `data:` URL for the thumbnail. */
  preview: string
}

/** Stage a file the operator picked. */
export function stageScreenshotFromPath(path: string): Promise<StagedScreenshot> {
  return invoke<StagedScreenshot>('stage_issue_screenshot', { path })
}

/** Stage pasted image bytes; they travel as the raw request body. */
export function stageScreenshotFromBytes(bytes: Uint8Array): Promise<StagedScreenshot> {
  return invoke<StagedScreenshot>('stage_issue_screenshot', bytes)
}

/** Delete staged screenshots; resolves to how many were removed. */
export function discardScreenshots(ids: string[]): Promise<number> {
  return invoke<number>('discard_issue_screenshots', { ids })
}
