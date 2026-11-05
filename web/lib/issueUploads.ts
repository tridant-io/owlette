/**
 * The dashboard's submit issue attachments: which files an issue takes, held to
 * the desktop app's limits, and the upload that sends each one straight to the
 * issue bucket through a presigned PUT before the issue is filed.
 */

import {
  ISSUE_FILE_TYPES,
  type IssueFileKind,
  issueFileExt,
  issueFileKind,
  issueFileLimitRefusal,
  issueFileTypeRefusal,
} from '@/lib/issues';

/** What the file input offers: the types `ISSUE_FILE_TYPES` takes. */
export const ISSUE_FILE_ACCEPT = Object.values(ISSUE_FILE_TYPES).join(',');

export const ISSUE_UPLOAD_FAILED = 'could not upload the attachments — try again';

/** One file the dialog holds; `preview` is an object url for a screenshot, revoked on removal. */
export interface IssueAttachment {
  id: number;
  file: File;
  preview: string | null;
}

/** A file to add, named for the notice if it is refused. */
export interface IssueFileSource {
  file: File;
  label: string;
}

export function isVideoFile(file: File): boolean {
  const ext = issueFileExt(file.type);
  return ext !== null && issueFileKind(ext) === 'video';
}

// a held file always has a type issues take
function limitEntry(file: File): { kind: IssueFileKind; size: number } {
  return { kind: isVideoFile(file) ? 'video' : 'screenshot', size: file.size };
}

export function attachmentBytes(files: File[]): number {
  return files.reduce((sum, file) => sum + file.size, 0);
}

/** The sources `held` has room for, in order, and why each other one was refused. */
export function admitIssueFiles(
  held: File[],
  sources: IssueFileSource[],
): { admitted: File[]; refused: string[] } {
  const kept = held.map(limitEntry);
  const admitted: File[] = [];
  const refused = new Set<string>();
  for (const { file, label } of sources) {
    const ext = issueFileExt(file.type);
    if (!ext) {
      refused.add(`${label}: ${issueFileTypeRefusal(file.type)}`);
      continue;
    }
    const next = [...kept, { kind: issueFileKind(ext), size: file.size }];
    // a count refusal is about the list; a size one names the file
    const tooMany = issueFileLimitRefusal(next.map(({ kind }) => ({ kind, size: 0 })));
    const tooBig = tooMany ? null : issueFileLimitRefusal(next);
    if (tooMany || tooBig) {
      refused.add(tooMany ?? `${label}: ${tooBig}`);
      continue;
    }
    kept.push(next[next.length - 1]);
    admitted.push(file);
  }
  return { admitted, refused: [...refused] };
}

function put(url: string, file: File, onProgress: (loaded: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    // signed into the url: any other type is refused
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(ISSUE_UPLOAD_FAILED));
    // a network failure, or a bucket with no cors rule for this origin
    xhr.onerror = () => reject(new Error(ISSUE_UPLOAD_FAILED));
    xhr.send(file);
  });
}

/**
 * Uploads `files` one at a time and returns their keys, in order, for
 * `POST /api/bug-report`. Reports whole percent across all files. Throws on any
 * failure, so the issue is never filed with part of its attachments.
 */
export async function uploadIssueFiles(files: File[], onProgress: (percent: number) => void): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch('/api/issue-attachments/upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: files.map((file) => ({ size: file.size, contentType: file.type })) }),
    });
  } catch {
    throw new Error(ISSUE_UPLOAD_FAILED);
  }
  if (!res.ok) {
    // a 400 carries the same refusal the dialog would have shown
    const body = res.status === 400 ? await res.json().catch(() => ({})) : {};
    throw new Error(typeof body.detail === 'string' ? body.detail : ISSUE_UPLOAD_FAILED);
  }
  const data = await res.json().catch(() => ({}));
  const signed: unknown = data.files;
  if (
    !Array.isArray(signed) ||
    signed.length !== files.length ||
    !signed.every((entry) => typeof entry?.key === 'string' && typeof entry?.uploadUrl === 'string')
  ) {
    throw new Error(ISSUE_UPLOAD_FAILED);
  }

  const total = attachmentBytes(files);
  let done = 0;
  onProgress(0);
  for (const [i, file] of files.entries()) {
    await put(signed[i].uploadUrl, file, (loaded) =>
      onProgress(Math.min(100, Math.floor(((done + loaded) / total) * 100))),
    );
    done += file.size;
    onProgress(Math.floor((done / total) * 100));
  }
  return signed.map((entry: { key: string }) => entry.key);
}
