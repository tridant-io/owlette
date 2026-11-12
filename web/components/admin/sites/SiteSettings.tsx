'use client';

import { useState } from 'react';
import { SearchX } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useSites, type Site } from '@/hooks/useFirestore';
import { usePlan } from '@/hooks/usePlan';
import { useSitePlan } from '@/hooks/useSitePlan';
import { SITE_SECTIONS, SITE_SECTION_LABELS, type SiteSection } from '@/lib/siteSettingsPath';
import { DetailSkeleton } from '@/components/admin/DetailSkeleton';
import { Panel } from '@/components/admin/Panel';
import { SegmentedControl } from '@/components/admin/SegmentedControl';
import { CopySiteIdButton } from '@/components/admin/sites/CopySiteIdButton';
import { SiteBillingSection } from '@/components/admin/sites/SiteBillingSection';
import { SiteDangerZone } from '@/components/admin/sites/SiteDangerZone';
import { SiteGeneralSection } from '@/components/admin/sites/SiteGeneralSection';
import { SiteMembersSection } from '@/components/admin/sites/SiteMembersSection';
import { KeepScreensAwakeSwitch } from '@/components/admin/sites/SiteSwitches';
import { SiteMachinesList } from '@/components/SiteMachinesList';
import { Badge } from '@/components/ui/badge';

/**
 * one site's settings, a section at a time. it holds no router: the caller owns
 * the section and where a deleted site sends you.
 */
export function SiteSettings({
  siteId,
  section,
  onSectionChange,
  onDeleted,
}: {
  siteId: string;
  section: SiteSection;
  onSectionChange: (next: SiteSection) => void;
  onDeleted: (administersAnotherSite: boolean) => void;
}) {
  const { user, userSites, isSuperadmin, isSiteAdmin, isSiteOwner, machineScope } = useAuth();
  const { sites, loading, updateSite, deleteSite } = useSites(user?.uid, userSites, isSuperadmin);
  const { plan, loading: planLoading } = usePlan();
  // only an owner is billed for a site, so nobody else's view asks for its plan
  const { plan: sitePlan, loading: sitePlanLoading } = useSitePlan(isSiteOwner(siteId) ? siteId : null);
  const [now] = useState(() => Date.now());
  // a delete's cascade drops the site from `sites`, and the caller's row on it,
  // before the request answers: the site is held till then, so its confirm dialog stays up
  const [deleting, setDeleting] = useState<Site | null>(null);
  // nothing renders once it is gone, so no "site not found" shows while the caller navigates
  const [deletedId, setDeletedId] = useState<string | null>(null);

  if (deletedId === siteId) return null;
  const held = deleting?.id === siteId ? deleting : null;

  if (loading && !held) {
    return (
      <>
        <span className="sr-only">loading site</span>
        <DetailSkeleton />
      </>
    );
  }

  const site = held ?? sites.find((s) => s.id === siteId);
  if (!site) {
    return (
      <div className="flex flex-col items-center rounded-xl border border-border bg-card px-4 py-12 text-center">
        <SearchX className="mb-3 size-8 text-muted-foreground" aria-hidden="true" />
        <h1 className="text-lg font-semibold text-foreground">site not found</h1>
        <p className="mt-1 text-sm text-muted-foreground wrap-anywhere">
          nothing you can reach answers to <span className="font-mono">{siteId}</span>.
        </p>
      </div>
    );
  }

  const title = <h1 className="text-2xl md:text-3xl font-bold text-foreground wrap-anywhere">{site.name}</h1>;

  if (!held && !isSiteAdmin(site.id)) {
    return (
      <div>
        {title}
        <p className="mt-2 text-sm text-muted-foreground wrap-anywhere">
          {/* "you're a member" would be wrong for a scoped admin: the scope keeps them out, not the role */}
          {machineScope(site.id) !== null
            ? `your access to ${site.name} is limited to some machines, and its settings need the whole site. ask its owner or an admin.`
            : `you're a member of ${site.name}. ask its owner or an admin to change its settings.`}
        </p>
      </div>
    );
  }

  // only an owner reaches the delete that holds a site, and a superadmin's isSiteOwner is true everywhere
  const owner = held !== null || isSiteOwner(site.id);
  // billing is the owner's too, and only where plans are enforced or the site is billed: tridant id
  // bills it whatever the switch says, so with plans off the owner can still stop it. the plans load
  // after the page, so a link to billing (the return from checkout) waits for them instead of opening general
  const pointer = sitePlan?.isOwner ? sitePlan.billing : null;
  const billed = !!pointer && (pointer.endsAt === null || pointer.endsAt > now);
  const billing = owner && (plan?.enforced || billed || ((planLoading || sitePlanLoading) && section === 'billing'));
  const visible = SITE_SECTIONS.filter((s) => (s !== 'danger' || owner) && (s !== 'billing' || billing));
  const effective = visible.includes(section) ? section : 'general';

  return (
    <>
      <header className="mb-4 md:mb-6">
        {title}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <CopySiteIdButton siteId={site.id} className="text-sm wrap-anywhere" />
          {!isSuperadmin && <Badge variant="outline">{owner ? 'owner' : 'admin'}</Badge>}
        </div>
      </header>

      {/* flex, so the control is as wide as its buttons and still wraps on a phone */}
      <div className="mb-4 flex">
        <SegmentedControl
          label="site settings sections"
          options={visible.map((s) => ({ value: s, label: SITE_SECTION_LABELS[s] }))}
          value={effective}
          onChange={onSectionChange}
        />
      </div>

      {effective === 'general' && (
        <SiteGeneralSection key={`${site.id}:${site.name}:${site.timezone ?? ''}`} site={site} onSave={updateSite} />
      )}
      {/* the sections with dialogs are keyed on the site, so one left open never acts on the next site */}
      {effective === 'members' && <SiteMembersSection key={site.id} siteId={site.id} />}
      {effective === 'machines' && (
        <Panel id="site-section-machines" title="machines" description="add one from the dashboard's + button.">
          <div className="space-y-4">
            <KeepScreensAwakeSwitch siteId={site.id} />
            <SiteMachinesList key={site.id} siteId={site.id} />
          </div>
        </Panel>
      )}
      {effective === 'billing' && <SiteBillingSection key={site.id} site={site} />}
      {effective === 'danger' && (
        <SiteDangerZone
          key={site.id}
          site={site}
          onDelete={async (id) => {
            setDeleting(site);
            try {
              await deleteSite(id);
            } catch (error) {
              setDeleting(null);
              throw error;
            }
          }}
          onDeleted={() => {
            setDeletedId(site.id);
            onDeleted(isSuperadmin || sites.some((s) => s.id !== site.id && isSiteAdmin(s.id)));
          }}
        />
      )}
    </>
  );
}
