'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useSites } from '@/hooks/useFirestore';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2, Plus, Webhook, X } from 'lucide-react';
import { toast } from '@/lib/toast';
import { CopyButton } from '@/components/CopyButton';
import { CreateWebhookDialog } from './CreateWebhookDialog';
import { WebhookCard, type WebhookListItem } from './WebhookCard';

interface WebhooksResponse {
  webhooks: WebhookListItem[];
  nextPageToken: string;
}

export default function WebhooksSettingsPage() {
  const router = useRouter();
  const {
    user,
    loading: authLoading,
    userSites,
    lastSiteId,
    isSuperadmin,
    isSiteAdmin,
  } = useAuth();
  // User's explicit selection wins once made; otherwise fall back to
  // `lastSiteId` (if still accessible) or the first available site. Computed
  // inline rather than synced via a useEffect to avoid the cascading-render
  // lint and extra re-renders when auth data arrives.
  const [userPickedSite, setUserPickedSite] = useState<string>('');
  // Empty while access resolves, so nothing is selected until the real list is in.
  const siteIds = userSites ?? [];
  const selectedSite = userPickedSite
    ? userPickedSite
    : lastSiteId && siteIds.includes(lastSiteId)
      ? lastSiteId
      : (siteIds[0] ?? '');
  // Mutating `/api/webhooks/**` routes require WEBHOOK_MANAGE, which the server
  // grants to superadmins, site admins — and, via an explicit short-circuit, the
  // site's owner (self-serve owners carry global role `member`). `isSiteAdmin`
  // knows nothing about ownership, so the owner leg is resolved here from the
  // site docs. The picker above deliberately keeps listing raw site ids.
  const { sites, loading: sitesLoading } = useSites(user?.uid, userSites, isSuperadmin);
  const site = sites.find((s) => s.id === selectedSite);
  const canManage =
    !!selectedSite && (isSiteAdmin(selectedSite) || (!!user && site?.owner === user.uid));
  const [webhooks, setWebhooks] = useState<WebhookListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);

  const refresh = useCallback(
    async (siteId: string) => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/webhooks?siteId=${encodeURIComponent(siteId)}&limit=50`,
        );
        const data = (await res.json()) as
          | WebhooksResponse
          | { detail?: string; title?: string };
        if (res.ok && 'webhooks' in data) {
          setWebhooks(data.webhooks);
        } else {
          const msg =
            ('detail' in data && data.detail) ||
            ('title' in data && data.title) ||
            'failed to load webhooks';
          toast.error(msg);
          setWebhooks([]);
        }
      } catch {
        toast.error('failed to load webhooks');
        setWebhooks([]);
      }
      setLoading(false);
    },
    [],
  );

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.push('/login');
      return;
    }
    if (!selectedSite) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch + site-change fetch; state is managed in refresh().
    refresh(selectedSite).catch(() => {});
  }, [user, authLoading, router, refresh, selectedSite]);

  if (authLoading || (!user && loading)) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <PageHeader currentPage="webhooks" />
      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
          {/* Developer-preview banner. Subscription management, manual probes,
              delivery history, and retry are all live. Automatic dispatch of
              roost lifecycle events (`version.published`, `version.rolled_back`,
              `deployment.*`) is deferred — the routes carry explicit TODOs.
              We surface that gap here rather than letting users subscribe
              silently to events that won't fire. It stays up on a gated site
              that still has subscriptions: it is a caveat about delivery, which
              is exactly what those subscriptions are still doing. */}
          <div className="mb-6 rounded-md border border-accent-cyan/30 bg-accent-cyan/10 px-4 py-3">
            <div className="flex items-start gap-3">
              <span className="inline-flex items-center rounded-full border border-accent-cyan/30 bg-accent-cyan/20 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-cyan flex-shrink-0">
                developer preview
              </span>
              <div className="text-xs text-foreground/80 leading-relaxed">
                subscription management, the manual <code className="text-[11px] bg-card px-1 rounded">/api/webhooks/probe</code> endpoint,
                delivery history, and retry are live. <strong>automatic dispatch</strong> of roost lifecycle events
                (<code className="text-[11px]">version.published</code>, <code className="text-[11px]">version.rolled_back</code>,
                <code className="text-[11px]">deployment.*</code>) is not wired yet — subscriptions are accepted but those
                events will not fire until a future release.
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
            <div>
              <h1 className="text-2xl font-semibold text-white flex items-center gap-2">
                <Webhook className="h-5 w-5" />
                webhooks
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                subscribe to roost events — version publishes, deploy rollouts, quota warnings — with
                hmac-signed http callbacks.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {siteIds.length > 1 && (
                <Select value={selectedSite} onValueChange={setUserPickedSite}>
                  <SelectTrigger className="w-48 bg-card border-border text-white">
                    <SelectValue placeholder="pick a site" />
                  </SelectTrigger>
                  <SelectContent>
                    {siteIds.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {canManage && (
                <Button
                  type="button"
                  onClick={() => setCreateOpen(true)}
                  className="text-gray-900 cursor-pointer"
                >
                  <Plus className="h-4 w-4 mr-1" /> create webhook
                </Button>
              )}
            </div>
          </div>

          {revealedSecret && (
            <Card className="border-accent-cyan/50 bg-accent-cyan/5 p-4 mb-6 relative">
              <button
                type="button"
                onClick={() => setRevealedSecret(null)}
                className="absolute top-3 right-3 text-muted-foreground hover:text-white cursor-pointer"
                aria-label="dismiss"
              >
                <X className="h-4 w-4" />
              </button>
              <p className="text-sm text-accent-cyan font-medium pr-6 mb-2">
                signing secret issued — copy it now. it will not be shown again.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs bg-background border border-border rounded px-3 py-2 text-white font-mono break-all select-all">
                  {revealedSecret}
                </code>
                <CopyButton
                  value={revealedSecret}
                  className="h-9 border-border text-accent-cyan hover:bg-muted"
                />
              </div>
            </Card>
          )}

          {!selectedSite ? (
            <Card className="border-border bg-card/50 p-8 text-center">
              <p className="text-sm text-white">no sites available</p>
              <p className="text-xs text-muted-foreground mt-1">
                you need site access to manage webhooks. ask a site admin to add you.
              </p>
            </Card>
          ) : loading || sitesLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : webhooks.length === 0 ? (
            <Card className="border-border bg-card/50 p-8 text-center space-y-3">
              <Webhook className="h-8 w-8 text-muted-foreground mx-auto" />
              {canManage ? (
                <>
                  <div>
                    <p className="text-sm text-white">no webhooks yet</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      subscribe to events so your ci/cd, slack bot, or monitoring can react to
                      roost activity.
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => setCreateOpen(true)}
                    className="text-gray-900 cursor-pointer"
                  >
                    <Plus className="h-3.5 w-3.5 mr-1" /> create your first webhook
                  </Button>
                </>
              ) : (
                <div>
                  <p className="text-sm text-white">no webhooks configured for this site</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    a site admin can add webhooks.
                  </p>
                </div>
              )}
            </Card>
          ) : (
            <div className="space-y-3">
              {webhooks.map((w) => (
                <WebhookCard
                  key={w.id}
                  webhook={w}
                  siteId={selectedSite}
                  canManage={canManage}
                  onChanged={() => void refresh(selectedSite)}
                  onSecretRotated={setRevealedSecret}
                />
              ))}
            </div>
          )}
      </main>

      {selectedSite && canManage && (
        <CreateWebhookDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          siteId={selectedSite}
          onCreated={(secret) => {
            setRevealedSecret(secret);
            void refresh(selectedSite);
          }}
        />
      )}
    </div>
  );
}
