'use client';

import { useCallback, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { IconButton } from '@/components/ui/icon-button';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Trash2,
  XCircle,
} from 'lucide-react';
import { toast } from '@/lib/toast';

export interface WebhookListItem {
  id: string;
  url: string;
  events: string[];
  description?: string;
  createdAt: string | null;
  updatedAt: string | null;
  paused: boolean;
  lastDeliveryAt: string | null;
  lastDeliveryStatus: string | null;
  failureCount: number;
}

interface DeliverySummary {
  id: string;
  event: string | null;
  state: 'pending' | 'succeeded' | 'failed';
  attempt: number;
  lastStatus: number | null;
  lastError: string | null;
  createdAt: string | null;
  completedAt: string | null;
  nextAttemptAt: string | null;
}

interface WebhookCardProps {
  webhook: WebhookListItem;
  siteId: string;
  /**
   * Whether the viewer holds WEBHOOK_MANAGE on this site (site admin, superadmin,
   * or site owner). Pause/resume, rotate-secret and delete all 403 without it, so
   * the actions column is not rendered at all. Reads — the delivery log and its
   * retry, which the server leaves at member level — stay available.
   */
  canManage: boolean;
  onChanged: () => void;
  onSecretRotated: (secret: string) => void;
}

function formatRelative(ts: string | null): string {
  if (!ts) return 'never';
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return ts;
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

function stateIcon(state: DeliverySummary['state']) {
  switch (state) {
    case 'succeeded':
      return <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />;
    case 'failed':
      return <XCircle className="h-3.5 w-3.5 text-red-500" />;
    case 'pending':
      return <Clock className="h-3.5 w-3.5 text-yellow-500" />;
  }
}

export function WebhookCard({
  webhook,
  siteId,
  canManage,
  onChanged,
  onSecretRotated,
}: WebhookCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [deliveries, setDeliveries] = useState<DeliverySummary[]>([]);
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const loadDeliveries = useCallback(async () => {
    setDeliveriesLoading(true);
    try {
      const res = await fetch(
        `/api/webhooks/${encodeURIComponent(webhook.id)}/deliveries?siteId=${encodeURIComponent(siteId)}&limit=20`,
      );
      const data = (await res.json()) as
        | { deliveries: DeliverySummary[]; nextPageToken: string }
        | { detail?: string };
      if (res.ok && 'deliveries' in data) {
        setDeliveries(data.deliveries);
      } else {
        const msg = ('detail' in data && data.detail) || 'failed to load deliveries';
        toast.error(msg);
      }
    } catch {
      toast.error('failed to load deliveries');
    }
    setDeliveriesLoading(false);
  }, [webhook.id, siteId]);

  async function handleToggleExpand() {
    const next = !expanded;
    setExpanded(next);
    if (next && deliveries.length === 0) await loadDeliveries();
  }

  async function handleTogglePaused() {
    setBusyAction('paused');
    try {
      const res = await fetch(
        `/api/webhooks/${encodeURIComponent(webhook.id)}?siteId=${encodeURIComponent(siteId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paused: !webhook.paused }),
        },
      );
      if (res.ok) {
        toast.success(webhook.paused ? 'webhook resumed' : 'webhook paused');
        onChanged();
      } else {
        const data = (await res.json().catch(() => ({}))) as { detail?: string };
        toast.error(data.detail ?? 'failed to toggle pause');
      }
    } catch {
      toast.error('failed to toggle pause');
    }
    setBusyAction(null);
  }

  async function handleRotateSecret() {
    if (!confirm('rotate signing secret? old secret stays valid for 24h grace.')) return;
    setBusyAction('rotate');
    try {
      const res = await fetch(
        `/api/webhooks/${encodeURIComponent(webhook.id)}/rotate-secret?siteId=${encodeURIComponent(siteId)}`,
        { method: 'POST' },
      );
      const data = (await res.json()) as
        | { signingSecret: string; previousSecretValidUntil: string }
        | { detail?: string };
      if (res.ok && 'signingSecret' in data) {
        onSecretRotated(data.signingSecret);
        onChanged();
      } else {
        const msg = ('detail' in data && data.detail) || 'failed to rotate secret';
        toast.error(msg);
      }
    } catch {
      toast.error('failed to rotate secret');
    }
    setBusyAction(null);
  }

  async function handleDelete() {
    if (!confirm('delete this webhook? deliveries are preserved 30 days for audit.')) return;
    setBusyAction('delete');
    try {
      const res = await fetch(
        `/api/webhooks/${encodeURIComponent(webhook.id)}?siteId=${encodeURIComponent(siteId)}`,
        { method: 'DELETE' },
      );
      if (res.ok) {
        toast.success('webhook deleted');
        onChanged();
      } else {
        const data = (await res.json().catch(() => ({}))) as { detail?: string };
        toast.error(data.detail ?? 'failed to delete');
      }
    } catch {
      toast.error('failed to delete');
    }
    setBusyAction(null);
  }

  async function handleRetryDelivery(deliveryId: string) {
    setRetryingId(deliveryId);
    try {
      const res = await fetch(
        `/api/webhooks/${encodeURIComponent(webhook.id)}/deliveries/${encodeURIComponent(deliveryId)}/retry?siteId=${encodeURIComponent(siteId)}`,
        { method: 'POST' },
      );
      if (res.ok || res.status === 202) {
        toast.success('retry queued');
        await loadDeliveries();
      } else {
        const data = (await res.json().catch(() => ({}))) as { detail?: string };
        toast.error(data.detail ?? 'retry failed');
      }
    } catch {
      toast.error('retry failed');
    }
    setRetryingId(null);
  }

  return (
    <Card className="border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={handleToggleExpand}
          className="mt-1 text-muted-foreground hover:text-white cursor-pointer"
          aria-label={expanded ? 'collapse' : 'expand'}
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            {webhook.paused ? (
              <Badge variant="outline" className="border-yellow-600 text-yellow-400">
                paused
              </Badge>
            ) : (
              <Badge variant="outline" className="border-green-700 text-green-400">
                active
              </Badge>
            )}
            {webhook.failureCount > 0 && (
              <Badge variant="outline" className="border-red-800 text-red-400">
                <AlertTriangle className="h-3 w-3 mr-1" />
                {webhook.failureCount} failure{webhook.failureCount === 1 ? '' : 's'}
              </Badge>
            )}
          </div>
          <code className="block text-sm text-white font-mono truncate">{webhook.url}</code>
          {webhook.description && (
            <p className="text-xs text-muted-foreground mt-1">{webhook.description}</p>
          )}
          <div className="flex flex-wrap gap-1 mt-2">
            {webhook.events.map((evt) => (
              <Badge key={evt} variant="secondary" className="font-mono text-[10px]">
                {evt}
              </Badge>
            ))}
          </div>
          <div className="flex gap-4 mt-2 text-xs text-muted-foreground">
            <span>created {formatRelative(webhook.createdAt)}</span>
            <span>last delivery {formatRelative(webhook.lastDeliveryAt)}</span>
          </div>
        </div>

        {canManage && (
          <div className="flex items-center gap-1">
            <IconButton
              label={webhook.paused ? 'resume webhook' : 'pause webhook'}
              type="button"
              size="sm"
              variant="outline"
              onClick={handleTogglePaused}
              disabled={busyAction !== null}
              className="h-8 w-8 p-0 border-border cursor-pointer"
            >
              {busyAction === 'paused' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : webhook.paused ? (
                <Play className="h-3.5 w-3.5" />
              ) : (
                <Pause className="h-3.5 w-3.5" />
              )}
            </IconButton>

            <IconButton
              label="rotate signing secret"
              type="button"
              size="sm"
              variant="outline"
              onClick={handleRotateSecret}
              disabled={busyAction !== null}
              className="h-8 w-8 p-0 border-border cursor-pointer"
            >
              {busyAction === 'rotate' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </IconButton>

            <IconButton
              label="delete webhook"
              type="button"
              size="sm"
              variant="outline"
              onClick={handleDelete}
              disabled={busyAction !== null}
              className="h-8 w-8 p-0 border-border text-red-400 hover:bg-red-950 cursor-pointer"
            >
              {busyAction === 'delete' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
            </IconButton>
          </div>
        )}
      </div>

      {expanded && (
        <div className="mt-4 pt-4 border-t border-border">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs font-semibold text-white uppercase tracking-wide">
              recent deliveries
            </h2>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={loadDeliveries}
              disabled={deliveriesLoading}
              className="h-7 text-xs border-border cursor-pointer"
            >
              {deliveriesLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                'refresh'
              )}
            </Button>
          </div>
          {deliveriesLoading && deliveries.length === 0 ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : deliveries.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">
              no deliveries yet. webhook deliveries are retained for 30 days.
            </p>
          ) : (
            <div className="space-y-1">
              {deliveries.map((d) => (
                <div
                  key={d.id}
                  className="flex items-center gap-2 text-xs py-1 px-2 rounded hover:bg-muted/30"
                >
                  {stateIcon(d.state)}
                  <span className="font-mono text-white flex-1 truncate">{d.event ?? '—'}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {d.lastStatus ?? (d.state === 'pending' ? 'pending' : '—')}
                  </span>
                  <span className="text-muted-foreground tabular-nums w-16 text-right">
                    att {d.attempt}
                  </span>
                  <span className="text-muted-foreground w-24 text-right">
                    {formatRelative(d.createdAt)}
                  </span>
                  <IconButton
                    label="retry this delivery"
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => handleRetryDelivery(d.id)}
                    disabled={retryingId !== null}
                    className="h-6 w-6 p-0 cursor-pointer"
                  >
                    {retryingId === d.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3 w-3" />
                    )}
                  </IconButton>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
