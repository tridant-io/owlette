'use client';

import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useSites } from '@/hooks/useFirestore';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AdminPageHeader } from '@/components/admin/AdminPageHeader';
import { Panel } from '@/components/admin/Panel';
import { SwoopSwitch } from '@/components/admin/sites/SiteSwitches';
import { swoopSettingsPath } from '@/lib/siteSettingsPath';

// the site lives in the url, so a site's settings page and the swoop viewer can link to its switch
function SwoopSettingsContent() {
  const router = useRouter();
  const requested = useSearchParams().get('site');
  const { user, isSuperadmin, userSites, lastSiteId, updateLastSite, isSiteAdmin } = useAuth();
  const { sites } = useSites(user?.uid, userSites, isSuperadmin);
  // the switch's route takes a whole-site owner or admin, so only their sites are offered
  const eligible = sites.filter((site) => isSiteAdmin(site.id));
  const selected =
    eligible.find((site) => site.id === requested) ??
    eligible.find((site) => site.id === lastSiteId) ??
    eligible[0];

  const handleSiteChange = (siteId: string) => {
    router.replace(swoopSettingsPath(siteId), { scroll: false });
    updateLastSite(siteId);
  };

  return (
    <div className="p-4 sm:p-6 md:p-8">
      <div className="max-w-screen-2xl mx-auto">
        <AdminPageHeader
          className="mb-6 md:mb-8"
          title="swoop settings"
          description="turn swoop on or off for each of your sites"
          toolbar={
            eligible.length > 1 && (
              <Select value={selected?.id ?? ''} onValueChange={handleSiteChange}>
                <SelectTrigger
                  aria-label="site"
                  className="min-w-32 flex-1 sm:w-[180px] sm:flex-none bg-card border-border text-foreground"
                >
                  <SelectValue placeholder="select site" />
                </SelectTrigger>
                <SelectContent className="bg-card border-border">
                  {eligible.map((site) => (
                    <SelectItem key={site.id} value={site.id} className="text-foreground hover:bg-muted">
                      {site.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )
          }
        />

        {selected && (
          <Panel id="swoop-settings-site" title={selected.name} description="this switch acts the moment it moves.">
            {/* keyed, so a write still in flight on one site never holds the next site's switch */}
            <SwoopSwitch key={selected.id} siteId={selected.id} />
          </Panel>
        )}
      </div>
    </div>
  );
}

export default function SwoopSettingsPage() {
  return (
    <Suspense fallback={null}>
      <SwoopSettingsContent />
    </Suspense>
  );
}
