'use client';

import { useState, useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useSites } from '@/hooks/useFirestore';
import { SitePicker } from '@/components/SitePicker';
import { Plus } from 'lucide-react';
import AddWebhookDialog, { WebhookList } from '@/components/WebhookSettingsDialog';
import { AdminPageHeader } from '@/components/admin/AdminPageHeader';
import { MemberLockSection } from '@/components/MemberLock';
import { useMemberLock } from '@/hooks/useMemberLock';
import { CompactButton } from '@/components/admin/CompactButton';
import { UpgradeGate, usePlanGated } from '@/components/plan/UpgradeGate';

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
  const webhooksGated = usePlanGated('webhooks', selectedSiteId);
  // a superadmin without a member row lists the webhooks and changes none (adr 0021)
  const memberLocked = useMemberLock(selectedSiteId);

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
            (sites.length > 1 || webhooksGated) && (
              <>
                {sites.length > 1 && (
                  <SitePicker
                    sites={sites}
                    value={selectedSiteId}
                    onChange={handleSiteChange}
                    className="min-w-32 flex-1 sm:w-[180px] sm:flex-none"
                  />
                )}
                {/* in the toolbar, not the actions: on a phone the actions share the title's row */}
                <UpgradeGate flag="webhooks" siteId={selectedSiteId} variant="inline" />
              </>
            )
          }
          actions={
            !webhooksGated && !memberLocked && (
              <CompactButton
                icon={Plus}
                label="add webhook"
                onClick={() => setDialogOpen(true)}
                disabled={!selectedSiteId}
              />
            )
          }
        />

        {selectedSiteId && (
          <MemberLockSection siteId={selectedSiteId}>
            <WebhookList siteId={selectedSiteId} />
          </MemberLockSection>
        )}

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
