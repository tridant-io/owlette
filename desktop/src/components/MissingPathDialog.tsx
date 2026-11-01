import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { MissingPathWarning } from '@/hooks/useMissingPath'
import { launchCopy } from '@/lib/launchCopy'
import type { PathField } from '@/lib/missingPath'

interface MissingPathDialogProps {
  missing: MissingPathWarning | null
  /** the process it is about, which may no longer be the one on screen. */
  processName: string
  onClose: () => void
  onBrowse: (warning: MissingPathWarning) => void
}

function fieldLabel(field: PathField): string {
  if (field === 'exe_path') return launchCopy().label
  return field === 'file_path' ? 'path / args' : 'cwd'
}

/** the words for a warning: what is wrong, what it means, and where browse starts. */
function copyFor({ problem, field }: MissingPathWarning): { title: string; detail: string; start: string | null } {
  const kind = field === 'cwd' ? 'folder' : 'file'
  switch (problem) {
    case 'missing':
      return {
        title: `can't find this ${kind}`,
        detail: 'the process may not start until it exists.',
        start: 'browse starts in the nearest folder that exists:',
      }
    case 'folder':
      return {
        title: 'this is a folder, not a file',
        detail: "the process won't start until this names a file.",
        start: 'browse starts inside it:',
      }
    case 'file':
      return {
        title: 'this is a file, not a folder',
        detail: "the process won't start until this names a folder.",
        start: 'browse starts in its folder:',
      }
    case 'network':
      return {
        title: "owlette can't launch from a network path",
        detail: "owlette refuses network paths, so the process won't start. copy it to this machine and point owlette there.",
        start: null,
      }
    case 'refused':
      return {
        title: "owlette can't launch from this path",
        detail: "owlette refuses a path that starts with two slashes, so the process won't start.",
        start: null,
      }
    case 'link':
      return {
        title: "owlette can't launch through a symbolic link",
        detail: `owlette refuses symbolic links, so the process won't start. point this at the real ${kind}.`,
        start: 'browse starts in its folder:',
      }
  }
}

/** a warning, not a gate: what was typed stays as typed, whichever button is pressed. */
export function MissingPathDialog({ missing, processName, onClose, onBrowse }: MissingPathDialogProps) {
  // it fades out after being told to close, and keeps its words until it has gone.
  const [held, setHeld] = useState({ missing, processName })
  if (missing && (missing !== held.missing || processName !== held.processName)) {
    setHeld({ missing, processName })
  }
  const shown = held.missing
  const copy = shown && copyFor(shown)

  return (
    <Dialog open={missing !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md" showCloseButton={false} data-testid="missing-path">
        <DialogHeader>
          <DialogTitle className="leading-snug">{copy?.title}</DialogTitle>
          <DialogDescription>your entry stays as you typed it, but {copy?.detail}</DialogDescription>
        </DialogHeader>
        <p className="min-w-0 text-sm break-words" data-testid="missing-path-process">
          <span className="font-medium">{held.processName || 'this process'}</span>
          {shown && <span className="text-muted-foreground"> · {fieldLabel(shown.field)}</span>}
        </p>
        <p className="font-mono text-xs break-all" data-testid="missing-path-value">
          {shown?.path}
        </p>
        {copy?.start && shown?.folder && (
          <p className="text-xs text-muted-foreground" data-testid="missing-path-folder">
            {copy.start} <span className="font-mono break-all">{shown.folder}</span>
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            ok
          </Button>
          <Button onClick={() => missing && onBrowse(missing)}>browse</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
