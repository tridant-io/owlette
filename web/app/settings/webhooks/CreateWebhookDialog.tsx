'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import { ROOST_WEBHOOK_EVENTS, type RoostWebhookEvent } from '@/lib/webhookEvents';

interface CreateWebhookDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siteId: string;
  onCreated: (signingSecret: string) => void;
}

interface CreateResponse {
  id: string;
  siteId: string;
  url: string;
  events: string[];
  signingSecret: string;
}

export function CreateWebhookDialog({
  open,
  onOpenChange,
  siteId,
  onCreated,
}: CreateWebhookDialogProps) {
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<Set<RoostWebhookEvent>>(new Set());
  const [busy, setBusy] = useState(false);

  function toggleEvent(evt: RoostWebhookEvent) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(evt)) next.delete(evt);
      else next.add(evt);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === ROOST_WEBHOOK_EVENTS.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(ROOST_WEBHOOK_EVENTS));
    }
  }

  function reset() {
    setUrl('');
    setDescription('');
    setSelected(new Set());
    setBusy(false);
  }

  async function handleSubmit() {
    if (!url.trim()) {
      toast.error('url is required');
      return;
    }
    if (selected.size === 0) {
      toast.error('select at least one event');
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        url: url.trim(),
        events: [...selected],
      };
      const desc = description.trim();
      if (desc) body.description = desc;

      const res = await fetch(
        `/api/webhooks?siteId=${encodeURIComponent(siteId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const data = (await res.json()) as
        | CreateResponse
        | { detail?: string; title?: string };
      if (!res.ok) {
        const msg =
          ('detail' in data && data.detail) ||
          ('title' in data && data.title) ||
          'failed to create webhook';
        toast.error(msg);
        setBusy(false);
        return;
      }
      const created = data as CreateResponse;
      onCreated(created.signingSecret);
      onOpenChange(false);
      reset();
    } catch {
      toast.error('failed to create webhook');
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="sm:max-w-xl bg-card border-border">
        <DialogHeader>
          <DialogTitle className="text-white">create webhook</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            roost signs every delivery with hmac-sha256. you&apos;ll receive the signing secret
            once after creation — store it now; it isn&apos;t shown again.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="webhook-url" className="text-white">
              endpoint url
            </Label>
            <Input
              id="webhook-url"
              type="url"
              placeholder="https://example.com/hooks/roost"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={busy}
              className="bg-background border-border text-white"
            />
            <p className="text-xs text-muted-foreground">
              must be https. private / loopback / link-local ips are blocked server-side.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="webhook-description" className="text-white">
              description <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="webhook-description"
              placeholder="ci/cd slack notifier"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={busy}
              className="bg-background border-border text-white"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p id="webhook-events-label" className="text-sm leading-none font-medium text-white">events</p>
              <button
                type="button"
                onClick={toggleAll}
                className="hl-link text-xs text-accent-cyan cursor-pointer"
              >
                {selected.size === ROOST_WEBHOOK_EVENTS.length
                  ? 'clear all'
                  : 'select all'}
              </button>
            </div>
            <div role="group" aria-labelledby="webhook-events-label" className="grid grid-cols-2 gap-2 max-h-56 overflow-y-auto border border-border rounded p-3">
              {ROOST_WEBHOOK_EVENTS.map((evt) => (
                <label
                  key={evt}
                  className="flex items-center gap-2 text-sm text-white cursor-pointer"
                >
                  <Checkbox
                    checked={selected.has(evt)}
                    onCheckedChange={() => toggleEvent(evt)}
                    disabled={busy}
                  />
                  <span className="font-mono text-xs">{evt}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="border-border cursor-pointer"
          >
            cancel
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={busy}
            className="text-gray-900 cursor-pointer"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'create webhook'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
