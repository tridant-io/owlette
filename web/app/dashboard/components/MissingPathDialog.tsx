'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ArrowUp, File, Folder, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import type { PathWarning } from '@/hooks/usePathCheck';
import type { LaunchCopy } from '@/lib/launchCopy';
import { childPath, type PathAnswer, type PathField } from '@/lib/pathCheck';

interface MissingPathDialogProps {
  warning: PathWarning;
  /** the words for the launch target on the warned machine. */
  launch: LaunchCopy;
  onOk: () => void;
  /** saves the picked path. rejecting keeps the browser open. */
  onPick: (picked: string) => Promise<void>;
  listFolder: (machineId: string, path: string) => Promise<PathAnswer | null>;
}

function fieldLabel(field: PathField, launch: LaunchCopy): string {
  if (field === 'exe_path') return launch.label;
  return field === 'file_path' ? 'file path / command arguments' : 'working directory';
}

/** the words for a warning, matching the desktop app's: what is wrong, what it means, and where browse starts. */
function warningCopy({ kind, field, machineId }: PathWarning, launch: LaunchCopy): {
  title: string;
  detail: string;
  start: string;
} {
  const wanted = field === 'cwd' ? 'folder' : 'file';
  switch (kind) {
    case 'network':
      return {
        title: "owlette can't launch from a network path",
        detail: "owlette refuses network paths, so the process won't start. copy it to this machine and point owlette there.",
        start: '',
      };
    case 'refused':
      return {
        title: "owlette can't launch from this path",
        detail: "owlette refuses a path that starts with two slashes, so the process won't start.",
        start: '',
      };
    case 'not_absolute':
      return {
        title: "this isn't a full path",
        detail: `the ${launch.target} won't start from a relative path. enter the full path.`,
        start: '',
      };
    case 'folder':
      return {
        title: 'this is a folder, not a file',
        detail: "the process won't start until this names a file.",
        start: 'browse starts inside it:',
      };
    case 'file':
      return {
        title: 'this is a file, not a folder',
        detail: "the process won't start until this names a folder.",
        start: 'browse starts in its folder:',
      };
    case 'link':
      return {
        title: "owlette can't launch through a symbolic link",
        detail: `owlette refuses symbolic links, so the process won't start. point this at the real ${wanted}.`,
        start: 'browse starts in its folder:',
      };
    case 'missing':
      return {
        title: `can't find this ${wanted}`,
        detail: `it isn't on ${machineId} right now, and the process may not start until it exists.`,
        start: 'browse starts in the nearest folder that exists:',
      };
  }
}

/** a warning, not a gate: the save already happened, and "ok" leaves it as typed. */
export function MissingPathDialog({ warning, launch, onOk, onPick, listFolder }: MissingPathDialogProps) {
  const [browsing, setBrowsing] = useState(false);
  const { title, detail, start } = warningCopy(warning, launch);

  return (
    <Dialog open onOpenChange={(open) => !open && onOk()}>
      <DialogContent className="border-border text-foreground sm:max-w-lg" showCloseButton={false}>
        {browsing && warning.nearest ? (
          <FolderBrowser
            warning={warning}
            start={warning.nearest}
            onCancel={onOk}
            onPick={onPick}
            listFolder={listFolder}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-foreground">{title}</DialogTitle>
              <DialogDescription className="text-muted-foreground">
                saved as you typed it, but {detail}
              </DialogDescription>
            </DialogHeader>
            <p className="min-w-0 text-sm break-words text-foreground" data-testid="path-warning-process">
              <span className="font-medium">{warning.processName}</span>
              <span className="text-muted-foreground"> · {fieldLabel(warning.field, launch)}</span>
            </p>
            <p className="font-mono text-xs break-all text-foreground">{warning.path}</p>
            {warning.nearest && (
              <p className="text-xs text-muted-foreground">
                {start} <span className="font-mono break-all">{warning.nearest}</span>
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={onOk}>
                ok
              </Button>
              {warning.nearest && (
                <Button onClick={() => setBrowsing(true)}>
                  browse
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface EntryRowProps {
  icon: ReactNode;
  name: string;
  disabled: boolean;
  onClick: () => void;
}

function EntryRow({ icon, name, disabled, onClick }: EntryRowProps) {
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-muted/50 disabled:cursor-default disabled:opacity-60"
      >
        {icon}
        <span className="min-w-0 break-all">{name}</span>
      </button>
    </li>
  );
}

interface FolderBrowserProps {
  warning: PathWarning;
  start: string;
  onCancel: () => void;
  onPick: (picked: string) => Promise<void>;
  listFolder: (machineId: string, path: string) => Promise<PathAnswer | null>;
}

function FolderBrowser({ warning, start, onCancel, onPick, listFolder }: FolderBrowserProps) {
  const pickingFolder = warning.field === 'cwd';
  // a new object each time, so opening a folder that just failed asks again.
  const [opening, setOpening] = useState({ path: start });
  const [settled, setSettled] = useState<{ opening: { path: string }; failed: boolean } | null>(null);
  // the last folder read: a folder that fails to open leaves it on screen, up button included.
  const [listing, setListing] = useState<PathAnswer | null>(null);
  const [saving, setSaving] = useState(false);
  const loading = settled?.opening !== opening;
  const failed = !loading && settled.failed;
  const openFolder = (path: string) => setOpening({ path });

  useEffect(() => {
    // only the folder opened last may fill the list, and never after the browser closes.
    let current = true;
    void listFolder(warning.machineId, opening.path).then((answer) => {
      if (!current) return;
      const read = answer?.status === 'folder' && Boolean(answer.folders && answer.files);
      if (read) setListing(answer);
      setSettled({ opening, failed: !read });
    });
    return () => {
      current = false;
    };
  }, [listFolder, warning.machineId, opening]);

  const pick = async (picked: string) => {
    setSaving(true);
    try {
      await onPick(picked);
    } catch {
      setSaving(false);
    }
  };

  const folder = listing?.path ?? start;
  const folders = listing?.folders ?? [];
  const files = listing?.files ?? [];

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-foreground">browse {warning.machineId}</DialogTitle>
        <DialogDescription className="text-muted-foreground">
          {pickingFolder ? 'open a folder, then use it.' : 'open a folder, then pick a file.'}
        </DialogDescription>
      </DialogHeader>
      <div className="flex items-center gap-2">
        <IconButton
          label="up"
          variant="outline"
          disabled={loading || !listing?.parent}
          onClick={() => listing?.parent && openFolder(listing.parent)}
        >
          <ArrowUp className="h-4 w-4" />
        </IconButton>
        <p className="min-w-0 flex-1 font-mono text-xs break-all text-foreground" data-testid="folder-browser-path">
          {folder}
        </p>
        {loading && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-label="loading" />}
      </div>
      <ul
        aria-label="folder entries"
        className="max-h-[40vh] min-h-24 overflow-y-auto rounded-md border border-border"
      >
        {folders.map((name) => (
          <EntryRow
            key={`folder:${name}`}
            icon={<Folder className="h-4 w-4 shrink-0 text-muted-foreground" />}
            name={name}
            disabled={loading || saving}
            onClick={() => openFolder(childPath(folder, name))}
          />
        ))}
        {files.map((name) => (
          <EntryRow
            key={`file:${name}`}
            icon={<File className="h-4 w-4 shrink-0 text-muted-foreground" />}
            name={name}
            disabled={pickingFolder || loading || saving}
            onClick={() => void pick(childPath(folder, name))}
          />
        ))}
        {listing && !failed && folders.length === 0 && files.length === 0 && (
          <li className="px-3 py-2 text-sm text-muted-foreground">this folder is empty</li>
        )}
      </ul>
      {failed && <p className="text-xs text-muted-foreground">can&apos;t read that folder right now</p>}
      {listing?.truncated && !failed && (
        <p className="text-xs text-muted-foreground">showing the first {folders.length + files.length} entries</p>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          cancel
        </Button>
        {pickingFolder && (
          <Button disabled={!listing || loading || saving} onClick={() => void pick(folder)}>
            use this folder
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
