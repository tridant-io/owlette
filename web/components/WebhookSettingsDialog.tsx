'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  collection,
  query,
  onSnapshot,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Webhook,
  Plus,
  Trash2,
  Send,
  Copy,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Loader2,
  Pencil,
} from 'lucide-react';
import { toast } from '@/lib/toast';

interface WebhookData {
  id: string;
  url: string;
  name: string;
  events: string[];
  enabled: boolean;
  createdAt: Date | null;
  createdBy: string;
  lastTriggered: Date | null;
  lastStatus: number;
  failCount: number;
}

const SUPPORTED_EVENTS = [
  { id: 'machine.offline', label: 'machine offline', description: 'machine stops sending heartbeats' },
  { id: 'deployment.started', label: 'deployment started', description: 'software deployment starts' },
  { id: 'version.published', label: 'version published', description: 'a software version is published' },
  { id: 'machine.online', label: 'machine online', description: 'machine comes back online (future)' },
  { id: 'deployment.completed', label: 'deployment completed', description: 'software deployment succeeds (future)' },
  { id: 'deployment.failed', label: 'deployment failed', description: 'software deployment fails (future)' },
  // Keep this list aligned with the public webhook API's canonical event catalog.
  { id: 'version.rolled_back', label: 'version rolled back', description: 'a published version is rolled back' },
  { id: 'chunk.garbage_collected', label: 'chunk garbage collected', description: 'unused deployment chunks are removed' },
  { id: 'chunk.verify_failed', label: 'chunk verify failed', description: 'deployment chunk verification fails' },
  { id: 'quota.warning', label: 'quota warning', description: 'site usage approaches quota' },
  { id: 'quota.exceeded', label: 'quota exceeded', description: 'site usage exceeds quota' },
  { id: 'api_key.used', label: 'api key used', description: 'an API key is used' },
  { id: 'api_key.expired', label: 'api key expired', description: 'an API key expires' },
];

async function apiJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(body?.detail || body?.title || `Request failed with ${res.status}`);
  }
  return body as T;
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed) : null;
  }
  if (typeof value === 'object') {
    const timestamp = value as { toDate?: () => Date; seconds?: number; _seconds?: number };
    if (typeof timestamp.toDate === 'function') return timestamp.toDate();
    if (typeof timestamp.seconds === 'number') return new Date(timestamp.seconds * 1000);
    if (typeof timestamp._seconds === 'number') return new Date(timestamp._seconds * 1000);
  }
  return null;
}

function toStatusCode(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/* -------------------------------------------------------------------------- */
/*  Shared hook for webhook data                                               */
/* -------------------------------------------------------------------------- */

function useWebhooks(siteId: string) {
  const [webhooks, setWebhooks] = useState<WebhookData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!siteId) return;

    const q = query(collection(db!, `sites/${siteId}/webhooks`));
    const unsub = onSnapshot(q, (snapshot) => {
      const items: WebhookData[] = snapshot.docs.map((d) => {
        const data = d.data();
        if (data.deletedAt) return null;
        const description = typeof data.description === 'string' ? data.description : '';
        const legacyName = typeof data.name === 'string' ? data.name : '';

        return {
          id: d.id,
          url: data.url || '',
          name: legacyName || description || data.url || '',
          events: data.events || [],
          enabled: data.enabled ?? data.paused !== true,
          createdAt: toDate(data.createdAt),
          createdBy: data.createdBy || '',
          lastTriggered: toDate(data.lastTriggered) || toDate(data.lastDeliveryAt),
          lastStatus: toStatusCode(data.lastStatus ?? data.lastDeliveryStatus),
          failCount: data.failCount ?? data.failureCount ?? 0,
        };
      }).filter((item): item is WebhookData => item !== null);
      setWebhooks(items);
      setLoading(false);
    });

    return () => unsub();
  }, [siteId]);

  return { webhooks, loading };
}

/* -------------------------------------------------------------------------- */
/*  Webhook list (renders inline on the page)                                  */
/* -------------------------------------------------------------------------- */

export function WebhookList({ siteId }: { siteId: string }) {
  const { webhooks, loading } = useWebhooks(siteId);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [editingWebhook, setEditingWebhook] = useState<WebhookData | null>(null);
  const [editName, setEditName] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [editEvents, setEditEvents] = useState<string[]>([]);
  const [editSaving, setEditSaving] = useState(false);

  const openEdit = (webhook: WebhookData) => {
    setEditingWebhook(webhook);
    setEditName(webhook.name);
    setEditUrl(webhook.url);
    setEditEvents([...webhook.events]);
  };

  const handleEditSave = async () => {
    if (!editingWebhook || !editName.trim() || !editUrl.trim()) {
      toast.error('name and URL are required');
      return;
    }
    if (!editUrl.startsWith('https://')) {
      toast.error('URL must start with https://');
      return;
    }
    if (editEvents.length === 0) {
      toast.error('select at least one event');
      return;
    }
    setEditSaving(true);
    try {
      await apiJson(`/api/webhooks/${encodeURIComponent(editingWebhook.id)}?siteId=${encodeURIComponent(siteId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: editName.trim(),
          url: editUrl.trim(),
          events: editEvents,
        }),
      });
      toast.success('webhook updated');
      setEditingWebhook(null);
    } catch {
      toast.error('failed to update webhook');
    } finally {
      setEditSaving(false);
    }
  };

  const toggleEditEvent = (eventId: string) => {
    setEditEvents((prev) =>
      prev.includes(eventId) ? prev.filter((e) => e !== eventId) : [...prev, eventId]
    );
  };

  const handleToggle = async (webhook: WebhookData) => {
    try {
      await apiJson(`/api/webhooks/${encodeURIComponent(webhook.id)}?siteId=${encodeURIComponent(siteId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: webhook.enabled }),
      });
      toast.success(webhook.enabled ? 'webhook disabled' : 'webhook enabled');
    } catch {
      toast.error('failed to update webhook');
    }
  };

  const handleDelete = async (webhookId: string) => {
    setDeletingId(webhookId);
    try {
      await apiJson(`/api/webhooks/${encodeURIComponent(webhookId)}?siteId=${encodeURIComponent(siteId)}`, {
        method: 'DELETE',
      });
      toast.success('webhook deleted');
      setDeleteConfirmId(null);
    } catch {
      toast.error('failed to delete webhook');
    } finally {
      setDeletingId(null);
    }
  };

  const handleTest = async (webhook: WebhookData) => {
    setTestingId(webhook.id);
    try {
      const res = await fetch('/api/webhooks/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhookId: webhook.id, siteId }),
      });
      const data = await res.json();

      // `detail` covers the problem+json the route returns when authorization
      // fails; `error` is its own legacy shape for validation / not-found.
      const failure = data.error ?? data.detail;
      if (data.success) {
        toast.success(`test delivered (HTTP ${data.status})`);
      } else if (failure) {
        toast.error(`test failed: ${failure}`);
      } else {
        toast.error(`test failed with HTTP ${data.status}`);
      }
    } catch {
      toast.error('failed to send test');
    } finally {
      setTestingId(null);
    }
  };

  const getStatusBadge = (webhook: WebhookData) => {
    if (!webhook.lastTriggered) {
      return <Badge variant="outline" className="text-muted-foreground border-border">never triggered</Badge>;
    }
    if (webhook.failCount >= 10) {
      return <Badge className="bg-danger-surface text-danger border-danger-border">auto-disabled</Badge>;
    }
    if (webhook.lastStatus >= 200 && webhook.lastStatus < 300) {
      return <Badge className="bg-success-surface text-success border-success-border"><CheckCircle className="h-3 w-3 mr-1" />{webhook.lastStatus}</Badge>;
    }
    if (webhook.lastStatus === 0) {
      return <Badge className="bg-danger-surface text-danger border-danger-border"><XCircle className="h-3 w-3 mr-1" />network error</Badge>;
    }
    return <Badge className="bg-warning-surface text-warning border-warning-border"><AlertTriangle className="h-3 w-3 mr-1" />{webhook.lastStatus}</Badge>;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span>loading webhooks...</span>
      </div>
    );
  }

  if (webhooks.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <Webhook className="h-16 w-16 mx-auto mb-4 opacity-30" />
        <p className="text-lg">no webhooks configured</p>
        <p className="text-sm mt-1">add a webhook to receive event notifications via slack, discord, or any HTTPS endpoint</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {webhooks.map((webhook) => (
        <div
          key={webhook.id}
          // on a phone the switch and details take the first row and the status and
          // actions wrap under them, so nothing is pushed past the edge
          className={`flex flex-wrap sm:flex-nowrap items-center gap-x-4 gap-y-2 p-3 sm:p-4 rounded-lg border border-border bg-card ${!webhook.enabled ? 'opacity-80' : ''}`}
        >
          <Switch
            checked={webhook.enabled}
            onCheckedChange={() => handleToggle(webhook)}
            aria-label={`enable ${webhook.name}`}
          />

          {/* Left: name inline, url + pills stacked below */}
          <div className="flex-1 min-w-0 basis-[calc(100%-3.5rem)] sm:basis-0">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-foreground font-medium">{webhook.name}</span>
              {webhook.url.includes('hooks.slack.com') && (
                <Badge className="bg-[#4A154B]/20 text-[#E01E5A] border-[#4A154B]/40 text-[10px] flex-shrink-0">slack</Badge>
              )}
              {webhook.url.includes('discord.com/api/webhooks') && (
                <Badge className="bg-[#5865F2]/20 text-[#5865F2] border-[#5865F2]/40 text-[10px] flex-shrink-0">discord</Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground font-mono truncate mb-1.5">{webhook.url}</p>
            <div className="flex flex-wrap gap-1.5">
              {webhook.events.map((evt) => (
                <Badge key={evt} variant="outline" className="text-xs border-border">
                  {evt.replace('.', ' ')}
                </Badge>
              ))}
            </div>
          </div>

          {/* Center-right: status + date */}
          <div className="flex items-center gap-4 flex-shrink-0">
            <div className="text-right">
              <div>{getStatusBadge(webhook)}</div>
              {webhook.failCount > 0 && webhook.failCount < 10 && (
                <p className="text-[10px] text-warning mt-0.5">{webhook.failCount} failures</p>
              )}
            </div>
            <span className="text-xs text-muted-foreground sm:w-36 sm:text-right">
              {webhook.lastTriggered
                ? webhook.lastTriggered.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
                : '—'}
            </span>
          </div>

          {/* Right: actions */}
          <div className="flex items-center gap-1 flex-shrink-0 ml-auto sm:ml-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleTest(webhook)}
              disabled={testingId === webhook.id || !webhook.enabled}
              aria-label={`test ${webhook.name}`}
              className="text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
            >
              <span className="hidden sm:inline">test</span>
              {testingId === webhook.id ? (
                <Loader2 className="h-3.5 w-3.5 sm:ml-1 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5 sm:ml-1" />
              )}
            </Button>
            <IconButton
              label={`edit ${webhook.name}`}
              variant="ghost"
              onClick={() => openEdit(webhook)}
              className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
            >
              <Pencil className="h-3.5 w-3.5" />
            </IconButton>
            {deleteConfirmId === webhook.id ? (
              <div className="flex items-center gap-1">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => handleDelete(webhook.id)}
                  disabled={deletingId === webhook.id}
                  className="cursor-pointer"
                >
                  {deletingId === webhook.id ? 'deleting...' : 'confirm'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleteConfirmId(null)}
                  className="bg-secondary border border-border cursor-pointer"
                >
                  cancel
                </Button>
              </div>
            ) : (
              <IconButton
                label={`delete ${webhook.name}`}
                variant="ghost-destructive"
                onClick={() => setDeleteConfirmId(webhook.id)}
                className="h-8 w-8 cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </IconButton>
            )}
          </div>
        </div>
      ))}

      {/* Edit webhook dialog */}
      <Dialog open={!!editingWebhook} onOpenChange={(open) => { if (!open) setEditingWebhook(null); }}>
        <DialogContent className="border-border sm:max-w-2xl max-h-[calc(100vh-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5" />
              edit webhook
            </DialogTitle>
            <DialogDescription>
              update webhook configuration. the signing secret cannot be changed.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="webhook-edit-name">name</Label>
              <Input
                id="webhook-edit-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="bg-background border-border"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="webhook-edit-url">URL (https required)</Label>
              <Input
                id="webhook-edit-url"
                value={editUrl}
                onChange={(e) => setEditUrl(e.target.value)}
                className="bg-background border-border"
              />
            </div>

            <div className="space-y-2">
              <p id="webhook-edit-events-label" className="text-sm leading-none font-medium">events</p>
              <div role="group" aria-labelledby="webhook-edit-events-label" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {SUPPORTED_EVENTS.map((evt) => (
                  <label
                    key={evt.id}
                    className="flex items-start gap-2 p-2 rounded-md hover:bg-muted/50 cursor-pointer"
                  >
                    <Checkbox
                      checked={editEvents.includes(evt.id)}
                      onCheckedChange={() => toggleEditEvent(evt.id)}
                      className="mt-0.5"
                    />
                    <div>
                      <p className="text-sm font-medium text-foreground">{evt.label}</p>
                      <p className="text-xs text-muted-foreground">{evt.description}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setEditingWebhook(null)}
              className="bg-secondary border border-border cursor-pointer"
            >
              cancel
            </Button>
            <Button onClick={handleEditSave} disabled={editSaving} className="cursor-pointer">
              {editSaving ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Pencil className="h-4 w-4 mr-2" />
              )}
              save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Add webhook dialog (only for creating new webhooks)                        */
/* -------------------------------------------------------------------------- */

interface AddWebhookDialogProps {
  siteId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function AddWebhookDialog({ siteId, open, onOpenChange }: AddWebhookDialogProps) {
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newEvents, setNewEvents] = useState<string[]>(['machine.offline', 'deployment.failed']);
  const [saving, setSaving] = useState(false);
  const [generatedSecret, setGeneratedSecret] = useState<string | null>(null);

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setNewName('');
      setNewUrl('');
      setNewEvents(['machine.offline', 'deployment.failed']);
    }
  }, [open]);

  const handleAdd = useCallback(async () => {
    if (!newName.trim() || !newUrl.trim()) {
      toast.error('name and URL are required');
      return;
    }

    if (!newUrl.startsWith('https://')) {
      toast.error('URL must start with https://');
      return;
    }

    if (newEvents.length === 0) {
      toast.error('select at least one event');
      return;
    }

    setSaving(true);
    try {
      const response = await apiJson<{ signingSecret: string }>(`/api/webhooks?siteId=${encodeURIComponent(siteId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: newUrl.trim(),
          description: newName.trim(),
          events: newEvents,
        }),
      });

      setGeneratedSecret(response.signingSecret);
      onOpenChange(false);
      toast.success('webhook created');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to create webhook';
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }, [siteId, newName, newUrl, newEvents, onOpenChange]);

  const toggleEventSelection = (eventId: string) => {
    setNewEvents((prev) =>
      prev.includes(eventId) ? prev.filter((e) => e !== eventId) : [...prev, eventId]
    );
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="border-border sm:max-w-2xl max-h-[calc(100vh-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Webhook className="h-5 w-5" />
              add webhook
            </DialogTitle>
            <DialogDescription>
              configure a webhook URL to receive JSON event payloads with HMAC-SHA256 signatures.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="webhook-add-name">name</Label>
              <Input
                id="webhook-add-name"
                placeholder='e.g. "Slack #alerts"'
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="bg-background border-border"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="webhook-add-url">URL (https required)</Label>
              <Input
                id="webhook-add-url"
                placeholder="https://hooks.slack.com/services/..."
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                className="bg-background border-border"
              />
              {newUrl.includes('hooks.slack.com') && (
                <Badge className="bg-[#4A154B]/20 text-[#E01E5A] border-[#4A154B]/40 text-xs">
                  slack detected — payload will be auto-formatted
                </Badge>
              )}
              {newUrl.includes('discord.com/api/webhooks') && (
                <Badge className="bg-[#5865F2]/20 text-[#5865F2] border-[#5865F2]/40 text-xs">
                  discord detected — payload will be auto-formatted
                </Badge>
              )}
            </div>

            <div className="space-y-2">
              <p id="webhook-add-events-label" className="text-sm leading-none font-medium">events</p>
              <div role="group" aria-labelledby="webhook-add-events-label" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {SUPPORTED_EVENTS.map((evt) => (
                  <label
                    key={evt.id}
                    className="flex items-start gap-2 p-2 rounded-md hover:bg-muted/50 cursor-pointer"
                  >
                    <Checkbox
                      checked={newEvents.includes(evt.id)}
                      onCheckedChange={() => toggleEventSelection(evt.id)}
                      className="mt-0.5"
                    />
                    <div>
                      <p className="text-sm font-medium text-foreground">{evt.label}</p>
                      <p className="text-xs text-muted-foreground">{evt.description}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              className="bg-secondary border border-border cursor-pointer"
            >
              cancel
            </Button>
            <Button onClick={handleAdd} disabled={saving} className="cursor-pointer">
              {saving ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Plus className="h-4 w-4 mr-2" />
              )}
              create webhook
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Generated secret dialog */}
      <Dialog open={!!generatedSecret} onOpenChange={() => setGeneratedSecret(null)}>
        <DialogContent className="border-border">
          <DialogHeader>
            <DialogTitle>webhook created</DialogTitle>
            <DialogDescription>
              save this signing secret — it will not be shown again in full.
              use it to verify webhook signatures on the receiving end.
            </DialogDescription>
          </DialogHeader>
          <div className="p-3 bg-card-sunken rounded-lg">
            <code className="text-sm font-mono text-foreground break-all">{generatedSecret}</code>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                if (generatedSecret) navigator.clipboard.writeText(generatedSecret);
                toast.success('secret copied');
              }}
              className="border-border hover:bg-accent hover:text-foreground cursor-pointer"
            >
              <Copy className="h-4 w-4 mr-2" />
              copy secret
            </Button>
            <Button onClick={() => setGeneratedSecret(null)} className="cursor-pointer">done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
