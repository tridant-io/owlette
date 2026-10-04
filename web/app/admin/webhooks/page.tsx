'use client';

import { useState, useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useSites } from '@/hooks/useFirestore';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus } from 'lucide-react';
import AddWebhookDialog, { WebhookList } from '@/components/WebhookSettingsDialog';
import { AdminPageHeader } from '@/components/admin/AdminPageHeader';
import { CompactButton } from '@/components/admin/CompactButton';

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
    <div className="p-4 sm:p-6 md:p-8">
      <div className="max-w-screen-2xl mx-auto">
        <AdminPageHeader
          className="mb-6 md:mb-8"
          title="webhooks"
          description="configure webhook URLs to receive JSON payloads when events occur"
          toolbar={
            sites.length > 1 && (
              <Select value={selectedSiteId} onValueChange={handleSiteChange}>
                <SelectTrigger aria-label="site" className="min-w-32 flex-1 sm:w-[180px] sm:flex-none bg-card border-border text-foreground">
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
            )
          }
          actions={
            <CompactButton
              icon={Plus}
              label="add webhook"
              onClick={() => setDialogOpen(true)}
              disabled={!selectedSiteId}
            />
          }
        />

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
