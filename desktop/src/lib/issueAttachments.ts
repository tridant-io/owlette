/**
 * Screenshots and videos attached to an issue report. The host copies each
 * file into the data tree's `ipc/issue-attachments` under a random id and the
 * report carries only the ids (see `src-tauri/src/issue_attachments.rs`).
 */

import { invoke } from '@tauri-apps/api/core'

export const MAX_SCREENSHOTS = 10
/** The byte limit is what holds videos back; this only bounds the list. */
export const MAX_VIDEOS = 20
/** What one issue's screenshots and videos may take together. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp']
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm']

export interface StagedScreenshot {
  id: string
  size: number
  kind: 'png' | 'jpeg' | 'webp'
  /** A `data:` URL for the thumbnail. */
  preview: string
}

export interface StagedVideo {
  id: string
  size: number
  kind: 'mp4' | 'mov' | 'webm'
  /** The picked file's own name, for display. */
  name: string
}

export type StagedAttachment = StagedScreenshot | StagedVideo

export function isVideo(attachment: StagedAttachment): attachment is StagedVideo {
  return 'name' in attachment
}

/** What the attachments take together, against MAX_ATTACHMENT_BYTES. */
export function usedBytes(attachments: StagedAttachment[]): number {
  return attachments.reduce((sum, attachment) => sum + attachment.size, 0)
}

/** Stage an image file the operator picked. */
export function stageScreenshotFromPath(path: string): Promise<StagedScreenshot> {
  return invoke<StagedScreenshot>('stage_issue_screenshot', { path })
}

/** Stage pasted image bytes; they travel as the raw request body. */
export function stageScreenshotFromBytes(bytes: Uint8Array): Promise<StagedScreenshot> {
  return invoke<StagedScreenshot>('stage_issue_screenshot', bytes)
}

/**
 * Stage a video the operator picked when it fits the `room` in bytes the other
 * attachments leave; it is copied, never read into the page.
 */
export function stageVideoFromPath(path: string, room: number): Promise<StagedVideo> {
  return invoke<StagedVideo>('stage_issue_video', { path, room })
}

/** Delete staged attachments; resolves to how many were removed. */
export function discardAttachments(ids: string[]): Promise<number> {
  return invoke<number>('discard_issue_screenshots', { ids })
}
