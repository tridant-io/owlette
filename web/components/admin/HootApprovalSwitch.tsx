'use client';

import { useState } from 'react';
import ConfirmDialog from '@/components/ConfirmDialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useHootApprovalSetting } from '@/hooks/useHootApprovalSetting';
import { toast } from '@/lib/toast';

/**
 * the site's tier 3 approval gate. on, which is the default, a privileged tool
 * call waits in the chat for an approve or deny. turning it off drops that for
 * everyone on the site, so it asks first; turning it on is one click. off also
 * re-opens the local hoot path on the public conversations api
 * (`lib/hootStream.server.ts`); the dashboard chat runs on the server either way.
 */
export function HootApprovalSwitch({ siteId }: { siteId: string }) {
  const { requireApproval } = useHootApprovalSetting(siteId);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const id = `hoot-approval-${siteId}`;

  const save = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/sites/${encodeURIComponent(siteId)}/hoot-settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requireTier3Approval: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail || body?.title || 'try again in a moment.');
      }
    } catch (err) {
      console.error('Failed to update hoot approval setting:', err);
      toast.error('could not change the approval setting', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-0.5">
          <Label htmlFor={id} className="text-foreground">
            require approval for privileged tools
          </Label>
          <p className="text-xs text-muted-foreground">
            hoot stops before a privileged (tier 3) tool, such as a shell command, a script or a restart, and waits
            for an approve or deny in the chat. on unless you turn it off.
          </p>
        </div>
        <Switch
          id={id}
          checked={requireApproval}
          onCheckedChange={(next) => {
            if (next) void save(true);
            else setConfirmOpen(true);
          }}
          disabled={busy}
        />
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="disable tier-3 approval site-wide?"
        description={
          'privileged tool calls (run_powershell, execute_script, restart, etc.) will run immediately without in-chat approval for everyone on this site. the lower-latency local hoot path also becomes available again on the public conversations API; the dashboard chat is unaffected. only turn this off if the approval prompts are getting in the way.'
        }
        confirmText="disable approval"
        cancelText="cancel"
        onConfirm={() => save(false)}
        variant="destructive"
      />
    </>
  );
}
