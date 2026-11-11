'use client';

import { useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useSites } from '@/hooks/useFirestore';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AdminPageHeader } from '@/components/admin/AdminPageHeader';
import { HootSiteSettings } from '@/components/admin/HootSiteSettings';

export default function HootSettingsPage() {
  const { user, isSuperadmin, userSites, lastSiteId, updateLastSite, isSiteAdmin } = useAuth();
  const { sites: allSites, loading } = useSites(user?.uid, userSites, isSuperadmin);
  // these settings need the whole site, so a site the person only belongs to,
  // or reaches some machines of, is not on offer
  const sites = useMemo(() => allSites.filter((site) => isSiteAdmin(site.id)), [allSites, isSiteAdmin]);
  const [userSelectedSiteId, setUserSelectedSiteId] = useState<string>('');

  // the person's pick, else the site they last worked on, else the first: derived,
  // so nothing has to sync once the sites arrive
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
          title="hoot"
          description="what hoot may do on a site beyond its chat"
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
        />

        {/* keyed on the site, so a write in flight never lands on the next one picked */}
        {selectedSiteId && <HootSiteSettings key={selectedSiteId} siteId={selectedSiteId} />}
        {!loading && sites.length === 0 && (
          <p className="text-sm text-muted-foreground">
            these settings need a site you own or administer whole.
          </p>
        )}
      </div>
    </div>
  );
}
