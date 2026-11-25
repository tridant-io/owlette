'use client';

import { useState } from 'react';
import { Panel } from '@/components/admin/Panel';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/lib/toast';

export function SiteDangerZone({
  site,
  onDelete,
  onDeleted,
}: {
  site: { id: string; name: string };
  onDelete: (siteId: string) => Promise<void>;
  onDeleted: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      await onDelete(site.id);
    } catch (error: unknown) {
      toast.error('could not delete the site', {
        description: error instanceof Error ? error.message : String(error),
      });
      setDeleting(false);
      return;
    }
    toast.success('site deleted', { description: `${site.name} and everything on it are gone.` });
    setDeleting(false);
    setConfirmOpen(false);
    onDeleted();
  };

  return (
    <>
      <Panel id="site-section-danger" title="danger zone" tone="danger">
        <div className="rounded-lg border border-danger-border bg-danger-surface p-4">
          <p className="text-sm font-medium text-danger">delete this site</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {"removes its machines and their history, its roosts, talons and webhooks, and everyone's access to it."}
          </p>
          <Button variant="destructive" className="mt-3" onClick={() => setConfirmOpen(true)}>
            delete site
          </Button>
        </div>
      </Panel>

      {/* its own dialog, not ConfirmDialog, which closes before the delete answers: a failure has to leave it open */}
      <Dialog
        open={confirmOpen}
        onOpenChange={(next) => {
          if (!deleting) setConfirmOpen(next);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>delete site</DialogTitle>
            {/* a site name or ID can be one unbroken word wider than a phone */}
            <DialogDescription className="wrap-anywhere">
              {`delete ${site.name}? this can't be undone.`}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground wrap-anywhere">
            {`its machines lose their agent tokens and stop reporting until someone pairs them to another site. the site ID ${site.id} is retired and can't be used again.`}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={deleting}>
              cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? 'deleting…' : 'delete site'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
