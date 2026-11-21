'use client';

/**
 * Native HTML5 folder-drop for roost upload, producing `NamedBlob[]` for the
 * chunking + upload pipeline. Two modalities: drag-drop (recursive enumeration
 * via `DataTransferItem.webkitGetAsEntry()`) and click-to-browse
 * (`<input type="file" webkitdirectory>` → `.webkitRelativePath`).
 *
 * Dependency-free on purpose: the IndexedDB upload queue already covers resume,
 * so Uppy/tus would only add polish.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Files, FolderUp, Loader2, X } from 'lucide-react';
import { sanitizeFilename } from '@/lib/sanitize';
import type { NamedBlob } from '@/lib/chunking';

interface FolderDropzoneProps {
  /** Called with the enumerated files once the user finishes dropping or selecting. */
  onFilesReady: (files: NamedBlob[], rootFolderName: string) => void;
  /**
   * Additional files picked after the initial selection. The parent merges
   * (typically by path, later wins). Omit to disable append mode.
   */
  onFilesAppend?: (newFiles: NamedBlob[]) => void;
  /** Called when the user clears the selection. */
  onClear?: () => void;
  /** Total byte / file-count display for the currently-selected folder. */
  summary?: { fileCount: number; totalBytes: number };
  /** Enumerated files for the queued-preview; undefined/empty collapses it. */
  files?: readonly NamedBlob[];
  /** Disable interaction (e.g. during upload). */
  disabled?: boolean;
}

export function FolderDropzone({
  onFilesReady,
  onFilesAppend,
  onClear,
  summary,
  files,
  disabled = false,
}: FolderDropzoneProps) {
  // Route to onFilesAppend when the summary is visible and the parent opted into
  // append mode; otherwise take the replace path.
  const deliver = useCallback(
    (newFiles: NamedBlob[], rootName: string) => {
      if (summary && onFilesAppend) {
        onFilesAppend(newFiles);
      } else {
        onFilesReady(newFiles, rootName);
      }
    },
    [summary, onFilesAppend, onFilesReady],
  );
  const [isDragOver, setIsDragOver] = useState(false);
  const [enumerating, setEnumerating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);

  // File System Access API check (Firefox/Safari fall back to webkitdirectory).
  // Set in an effect so SSR and first hydration render both start false.
  const [supportsFSA, setSupportsFSA] = useState(false);
  useEffect(() => {
    setSupportsFSA(
      typeof window !== 'undefined' &&
        typeof (window as unknown as { showDirectoryPicker?: unknown })
          .showDirectoryPicker === 'function',
    );
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragOver(false);
      if (disabled) return;
      setEnumerating(true);
      try {
        const files = await enumerateDataTransfer(e.dataTransfer);
        if (files.length === 0) return;
        const rootName = deriveRootName(files);
        deliver(files, rootName);
      } finally {
        setEnumerating(false);
      }
    },
    [disabled, deliver],
  );

  const handleFilePick = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const fileList = e.target.files;
      if (!fileList || fileList.length === 0) return;
      setEnumerating(true);
      try {
        const files = enumerateInputFiles(fileList);
        if (files.length === 0) return;
        const rootName = deriveRootName(files);
        deliver(files, rootName);
      } finally {
        setEnumerating(false);
        // allow the same folder to be re-dropped if the user clears + picks again
        if (inputRef.current) inputRef.current.value = '';
      }
    },
    [deliver],
  );

  const handleLooseFilesPick = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const fileList = e.target.files;
      if (!fileList || fileList.length === 0) return;
      setEnumerating(true);
      try {
        // Loose-file picker → no folder structure; each file's name is its
        // version path (enumerateInputFiles handles the missing relativePath).
        const files = enumerateInputFiles(fileList);
        if (files.length === 0) return;
        const rootName = deriveRootName(files);
        deliver(files, rootName);
      } finally {
        setEnumerating(false);
        if (filesInputRef.current) filesInputRef.current.value = '';
      }
    },
    [deliver],
  );

  // FSA multi-file path (Chrome/Edge only, same per-origin permission
  // persistence as showDirectoryPicker); others fall through to `<input>`.
  const handleFsaFilesPick = useCallback(async () => {
    if (disabled || enumerating) return;
    setEnumerating(true);
    try {
      const picker = (
        window as unknown as {
          showOpenFilePicker: (opts?: {
            multiple?: boolean;
          }) => Promise<FileSystemFileHandle[]>;
        }
      ).showOpenFilePicker;
      const handles = await picker({ multiple: true });
      const out: NamedBlob[] = [];
      for (const h of handles) {
        const file = await h.getFile();
        if (file.size === 0) continue;
        const cleaned = toVersionPath(file.name);
        if (cleaned === null) continue;
        out.push({ path: cleaned, blob: file });
      }
      if (out.length === 0) return;
      const rootName = deriveRootName(out);
      deliver(out, rootName);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      throw err;
    } finally {
      setEnumerating(false);
    }
  }, [disabled, enumerating, deliver]);

  // Preferred on Chrome/Edge: FSA prompts once per origin and persists the
  // grant, unlike webkitdirectory's per-upload "Upload all files from X?".
  const handleFsaPick = useCallback(async () => {
    if (disabled || enumerating) return;
    setEnumerating(true);
    try {
      const picker = (window as unknown as {
        showDirectoryPicker: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
      }).showDirectoryPicker;
      const handle = await picker({ mode: 'read' });
      const out: NamedBlob[] = [];
      for await (const entry of walkDirectoryHandle(handle, '')) {
        out.push(entry);
      }
      if (out.length === 0) return;
      const rootName = handle.name || deriveRootName(out);
      deliver(out, rootName);
    } catch (err) {
      // user cancelled the picker.
      if ((err as Error).name === 'AbortError') return;
      throw err;
    } finally {
      setEnumerating(false);
    }
  }, [disabled, enumerating, deliver]);

  if (summary) {
    const previewFiles = files ?? [];
    const PREVIEW_CAP = 200;
    const overflow = previewFiles.length - PREVIEW_CAP;
    const canAppend = !!onFilesAppend;
    return (
      <div
        className={`rounded-md border bg-muted/30 text-sm transition-colors ${
          isDragOver && canAppend
            ? 'border-accent-cyan bg-accent-cyan/5'
            : 'border-border'
        }`}
        onDragOver={
          canAppend
            ? (e) => {
                e.preventDefault();
                if (!disabled) setIsDragOver(true);
              }
            : undefined
        }
        onDragLeave={
          canAppend
            ? (e) => {
                e.preventDefault();
                setIsDragOver(false);
              }
            : undefined
        }
        onDrop={canAppend ? handleDrop : undefined}
      >
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <FolderUp className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-foreground">
              {summary.fileCount.toLocaleString()} file{summary.fileCount !== 1 ? 's' : ''}
            </span>
            <span className="text-xs text-muted-foreground shrink-0">
              · {formatBytes(summary.totalBytes)}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            disabled={disabled}
            aria-label="clear selection"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
        {previewFiles.length > 0 && (
          <div className="border-t border-border max-h-48 overflow-y-auto px-4 py-2 font-mono text-[11px] text-muted-foreground">
            <ul className="space-y-0.5">
              {previewFiles.slice(0, PREVIEW_CAP).map((f, idx) => (
                <li key={`${f.path}-${idx}`} className="flex items-baseline gap-2 min-w-0">
                  <span className="truncate text-foreground/90 min-w-0 flex-1">{f.path}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                    {formatBytes((f.blob as { size?: number }).size ?? 0)}
                  </span>
                </li>
              ))}
              {overflow > 0 && (
                <li className="pt-1 text-muted-foreground italic">
                  … and {overflow.toLocaleString()} more file{overflow !== 1 ? 's' : ''}
                </li>
              )}
            </ul>
          </div>
        )}
        {canAppend && (
          <div className="border-t border-border px-4 py-2.5 flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex-1">
              drop more here, or add a{' '}
              {supportsFSA ? (
                <>
                  <button
                    type="button"
                    onClick={handleFsaPick}
                    disabled={disabled || enumerating}
                    className="hl-link disabled:opacity-50 disabled:pointer-events-none cursor-pointer"
                  >
                    folder
                  </button>
                  {' or '}
                  <button
                    type="button"
                    onClick={handleFsaFilesPick}
                    disabled={disabled || enumerating}
                    className="hl-link disabled:opacity-50 disabled:pointer-events-none cursor-pointer"
                  >
                    more files
                  </button>
                </>
              ) : (
                <>
                  <label className={`${disabled || enumerating ? 'opacity-50 cursor-not-allowed' : 'hl-link cursor-pointer'}`}>
                    folder
                    <input
                      type="file"
                      {...({ webkitdirectory: '', directory: '' } as React.HTMLAttributes<HTMLInputElement>)}
                      multiple
                      hidden
                      disabled={disabled || enumerating}
                      onChange={handleFilePick}
                    />
                  </label>
                  {' or '}
                  <label className={`${disabled || enumerating ? 'opacity-50 cursor-not-allowed' : 'hl-link cursor-pointer'}`}>
                    more files
                    <input
                      type="file"
                      multiple
                      hidden
                      disabled={disabled || enumerating}
                      onChange={handleLooseFilesPick}
                    />
                  </label>
                </>
              )}
              .
            </span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setIsDragOver(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setIsDragOver(false);
      }}
      onDrop={handleDrop}
      className={`space-y-3 rounded-md border border-dashed px-4 py-8 text-center text-sm transition-colors ${
        isDragOver
          ? 'border-accent-cyan bg-accent-cyan/5'
          : 'border-border bg-muted/20'
      } ${disabled ? 'opacity-50' : ''}`}
      role="region"
      aria-label="folder drop zone"
    >
      <FolderUp className="mx-auto h-6 w-6 text-muted-foreground" />
      <div className="font-medium text-foreground">
        {enumerating ? 'reading…' : 'drag a folder or files here to upload'}
      </div>
      <p className="text-xs text-muted-foreground">
        chunked + hashed locally. only new bytes get uploaded.
      </p>
      <div className="pt-1 flex items-center justify-center gap-2">
        {/*
          Two browse modes — folder preserves tree structure, files is a
          flat multi-select. Drag-drop handles both automatically via
          webkitGetAsEntry so the buttons are only needed for click-to-
          browse paths.

          Chrome/Edge: prefer showDirectoryPicker / showOpenFilePicker —
          they ask for permission ONCE per origin and persist, vs.
          webkitdirectory's per-upload "Upload all files from X?" prompt.
          Firefox/Safari: fall back to <label>-wrapped inputs. Wrapping
          keeps the click a native user gesture so the scripted-click
          guard is skipped.
        */}
        {supportsFSA ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleFsaPick}
              disabled={disabled || enumerating}
              className="border-border bg-background/50 text-foreground transition-colors cursor-pointer hover:bg-accent-cyan/10 hover:border-accent-cyan/40"
            >
              {enumerating ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                  working…
                </>
              ) : (
                <>
                  <FolderUp className="h-3.5 w-3.5 mr-1" />
                  browse folder
                </>
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleFsaFilesPick}
              disabled={disabled || enumerating}
              className="border-border bg-background/50 text-foreground transition-colors cursor-pointer hover:bg-accent-cyan/10 hover:border-accent-cyan/40"
            >
              <Files className="h-3.5 w-3.5 mr-1" />
              browse files
            </Button>
          </>
        ) : (
          <>
            <label
              className={`inline-flex items-center justify-center gap-1 h-8 px-3 py-1.5 rounded-md text-sm font-medium border border-border bg-background/50 text-foreground transition-colors select-none ${
                disabled || enumerating
                  ? 'opacity-50 cursor-not-allowed'
                  : 'cursor-pointer hover:bg-accent-cyan/10 hover:border-accent-cyan/40'
              }`}
            >
              {enumerating ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                  working…
                </>
              ) : (
                <>
                  <FolderUp className="h-3.5 w-3.5 mr-1" />
                  browse folder
                </>
              )}
              <input
                ref={inputRef}
                type="file"
                {...({ webkitdirectory: '', directory: '' } as React.HTMLAttributes<HTMLInputElement>)}
                multiple
                hidden
                disabled={disabled || enumerating}
                onChange={handleFilePick}
              />
            </label>
            <label
              className={`inline-flex items-center justify-center gap-1 h-8 px-3 py-1.5 rounded-md text-sm font-medium border border-border bg-background/50 text-foreground transition-colors select-none ${
                disabled || enumerating
                  ? 'opacity-50 cursor-not-allowed'
                  : 'cursor-pointer hover:bg-accent-cyan/10 hover:border-accent-cyan/40'
              }`}
            >
              <Files className="h-3.5 w-3.5 mr-1" />
              browse files
              <input
                ref={filesInputRef}
                type="file"
                multiple
                hidden
                disabled={disabled || enumerating}
                onChange={handleLooseFilesPick}
              />
            </label>
          </>
        )}
      </div>
    </div>
  );
}

// Enumeration helpers

/**
 * Read a `DataTransfer` from a drop event: `items` API for folder enumeration,
 * falling back to the `files` list for single-file drops.
 */
export async function enumerateDataTransfer(
  dt: DataTransfer,
): Promise<NamedBlob[]> {
  const items = dt.items;
  if (items && items.length > 0 && typeof items[0].webkitGetAsEntry === 'function') {
    const entries: FileSystemEntry[] = [];
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry();
      if (entry) entries.push(entry);
    }
    const out: NamedBlob[] = [];
    for (const entry of entries) {
      await walkEntry(entry, '', out);
    }
    return out;
  }
  // Fallback: loose file drops with no folder structure.
  return enumerateInputFiles(dt.files);
}

/** Convert an input element's FileList (with webkitdirectory) into NamedBlobs. */
export function enumerateInputFiles(files: FileList): NamedBlob[] {
  const out: NamedBlob[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    // webkitdirectory gives `<rootFolder>/<subpath>/<filename>`; loose files have
    // no relativePath, so use the filename.
    const relPath =
      (f as File & { webkitRelativePath?: string }).webkitRelativePath ||
      f.name;
    const cleaned = toVersionPath(relPath);
    if (cleaned === null) continue;
    if (f.size === 0) continue; // version requires non-zero chunks
    out.push({ path: cleaned, blob: f });
  }
  return out;
}

/**
 * Recursively walk a FileSystemDirectoryHandle (`showDirectoryPicker`), yielding
 * NamedBlobs with forward-slash version-relative paths. Same shape as
 * `walkEntry`, but on the FSA API with its per-origin permission grants.
 */
async function* walkDirectoryHandle(
  handle: FileSystemDirectoryHandle,
  prefix: string,
): AsyncGenerator<NamedBlob> {
  const iter = (
    handle as unknown as {
      entries: () => AsyncIterable<
        [string, FileSystemFileHandle | FileSystemDirectoryHandle]
      >;
    }
  ).entries();
  for await (const [name, child] of iter) {
    const nextPath = prefix ? `${prefix}/${name}` : name;
    if (child.kind === 'file') {
      const file = await (child as FileSystemFileHandle).getFile();
      if (file.size === 0) continue;
      const cleaned = toVersionPath(nextPath);
      if (cleaned === null) continue;
      yield { path: cleaned, blob: file };
    } else if (child.kind === 'directory') {
      yield* walkDirectoryHandle(child as FileSystemDirectoryHandle, nextPath);
    }
  }
}

/** Recursively walk a `webkitGetAsEntry` tree, collecting folder-relative paths. */
async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: NamedBlob[],
): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      (entry as FileSystemFileEntry).file(resolve, reject);
    });
    if (file.size === 0) return;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const cleaned = toVersionPath(path);
    if (cleaned === null) return;
    out.push({ path: cleaned, blob: file });
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns in batches; loop until empty.
    while (true) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
        reader.readEntries(resolve, reject);
      });
      if (batch.length === 0) break;
      for (const child of batch) {
        const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
        await walkEntry(child, nextPrefix, out);
      }
    }
  }
}

/**
 * Normalise each segment through `sanitizeFilename`; if ANY segment is
 * unsalvageable, drop the file rather than silently renaming a hostile name.
 */
function toVersionPath(input: string): string | null {
  // Version paths are POSIX; inputs may use either separator depending on OS.
  const segments = input.replace(/\\/g, '/').split('/').filter(Boolean);
  const cleaned: string[] = [];
  for (const seg of segments) {
    const r = sanitizeFilename(seg);
    if (!r.ok) return null;
    cleaned.push(r.value);
  }
  if (cleaned.length === 0) return null;
  return cleaned.join('/');
}

function deriveRootName(files: NamedBlob[]): string {
  // First segment of the first file's path is usually the dropped folder name.
  const first = files[0]?.path ?? '';
  const head = first.split('/')[0];
  return head || 'upload';
}

function formatBytes(n: number): string {
  if (!isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  if (n < 1024 ** 4) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${(n / 1024 ** 4).toFixed(2)} TB`;
}

export default FolderDropzone;
