'use client';

import { useState, useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useSites } from '@/hooks/useFirestore';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import AddWebhookDialog, { WebhookList } from '@/components/WebhookSettingsDialog';

export default function WebhooksPage() {
  const { user, isSuperadmin, userSites, lastSiteId, updateLastSite } = useAuth();
  const { sites } = useSites(user?.uid, userSites, isSuperadmin);
  // User-chosen site (empty until the user picks). The effective selection is
  // derived below so we don't need a post-mount setState when sites resolve.
  const [userSelectedSiteId, setUserSelectedSiteId] = useState<string>('');
  const [dialogOpen, setDialogOpen] = useState(false);

  // Derive the effective site: user's explicit choice if any, otherwise the
  // saved site (from auth context or localStorage) if it still exists in the
  // list, otherwise the first site. Recomputes whenever sites or lastSiteId
  // change without needing an effect to sync state.
  const selectedSiteId = useMemo(() => {
    if (userSelectedSiteId) return userSelectedSiteId;
    if (sites.length === 0) return '';
    const savedSite =
      lastSiteId ||
      (typeof window !== 'undefined' ? localStorage.getItem('owlette_current_site') : null);
    if (savedSite && sites.find((s) => s.id === savedSite)) return savedSite;
    return sites[0].id;
  }, [userSelectedSiteId, sites, lastSiteId]);

  const handleSiteChange = (siteId: string) => {
    setUserSelectedSiteId(siteId);
    updateLastSite(siteId);
  };

  return (
    <div className="p-8">
      <div className="max-w-screen-2xl mx-auto">
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-3xl font-bold text-foreground mb-2">webhooks</h1>
              <p className="text-muted-foreground">
                configure webhook URLs to receive JSON payloads when events occur
              </p>
            </div>
            <div className="flex items-center gap-3">
              {sites.length > 1 && (
                <Select value={selectedSiteId} onValueChange={handleSiteChange}>
                  <SelectTrigger aria-label="site" className="w-[180px] bg-card border-border text-foreground">
                    <SelectValue placeholder="select site" />
                  </SelectTrigger>
                  <SelectContent className="bg-card border-border">
                    {sites.map((site) => (
                      <SelectItem key={site.id} value={site.id} className="text-foreground hover:bg-muted">
                        {site.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Button
                onClick={() => setDialogOpen(true)}
                disabled={!selectedSiteId}
                className="cursor-pointer"
              >
                <Plus className="h-4 w-4 mr-2" />
                add webhook
              </Button>
            </div>
          </div>
        </div>

        {selectedSiteId && <WebhookList siteId={selectedSiteId} />}

        {selectedSiteId && (
          <AddWebhookDialog
            siteId={selectedSiteId}
            open={dialogOpen}
            onOpenChange={setDialogOpen}
          />
        )}
      </div>
    </div>
  );
}
