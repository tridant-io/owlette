import { Check, Copy } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { openExternalUrl } from '@/lib/agentCli'
import { copyText } from '@/lib/clipboard'
import { HOOT_MCP_DOCS_URL, claudeCodeCommand } from '@/lib/hootMcp'
import { hootMcpCommand } from '@/lib/ipc'

interface ConnectAgentDialogProps {
  open: boolean
  onClose: () => void
}

/**
 * How an AI agent on this machine reaches hoot (hoot mcp): the command for
 * Claude Code, ready to copy, and the same two paths for any other MCP client.
 *
 * It only shows the command. Whether this machine may act on others is a site
 * owner's or site admin's to say, in the dashboard, and the dialog says so:
 * the command works before that, and the tools it lists then explain why they
 * are few.
 */
export function ConnectAgentDialog({ open, onClose }: ConnectAgentDialogProps) {
  const [command, setCommand] = useState<string[] | null>(null)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!open) return
    let disposed = false
    void hootMcpCommand()
      .then((parts) => {
        if (!disposed) setCommand(parts)
      })
      .catch(() => {
        // no bridge (a browser dev run): nothing to show, and the dialog says so
      })
    return () => {
      disposed = true
    }
  }, [open])

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    },
    [],
  )

  const line = command ? claudeCodeCommand(command) : null

  const handleCopy = useCallback(() => {
    if (!line) return
    void copyText(line).then((ok) => {
      setCopied(ok)
      if (!ok) {
        toast.error('could not copy the command', { description: 'select it and copy it by hand.' })
        return
      }
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 2000)
    })
  }, [line])

  const openGuide = useCallback(() => {
    void openExternalUrl(HOOT_MCP_DOCS_URL).catch((cause: unknown) => {
      toast.error('could not open the guide', {
        description: cause instanceof Error ? cause.message : String(cause),
      })
    })
  }, [])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="sm:max-w-lg" data-testid="connect-agent-dialog">
        <DialogHeader>
          <DialogTitle>connect an ai agent</DialogTitle>
          <DialogDescription>
            an ai agent on this machine can use hoot&apos;s tools on the other machines of its site. a
            site owner or site admin turns this machine on first, in the dashboard&apos;s admin panel,
            under hoot.
          </DialogDescription>
        </DialogHeader>

        {command && line ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-muted-foreground">claude code: run this in a terminal</p>
              <button
                type="button"
                onClick={handleCopy}
                data-testid="connect-agent-command"
                className="btn-sweep flex items-start justify-between gap-3 rounded-md border bg-card-sunken px-3 py-2.5 text-left font-mono text-xs break-all text-foreground"
              >
                <span>{line}</span>
                {copied ? (
                  <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                ) : (
                  <Copy aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                )}
              </button>
              <p className="text-xs text-muted-foreground" data-testid="connect-agent-copy-state">
                {copied ? 'copied to clipboard' : 'click to copy'}
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-muted-foreground">
                any other mcp client: a stdio server with this command and this argument
              </p>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">command</dt>
                <dd className="font-mono break-all select-text" data-testid="connect-agent-python">
                  {command[0]}
                </dd>
                <dt className="text-muted-foreground">argument</dt>
                <dd className="font-mono break-all select-text" data-testid="connect-agent-script">
                  {command[1]}
                </dd>
              </dl>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="connect-agent-unavailable">
            this machine cannot connect an ai agent to hoot yet.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={openGuide} data-testid="connect-agent-guide">
            how it works
          </Button>
          <Button onClick={onClose}>done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
