'use client';

import { Suspense, use } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { BackLink } from '@/components/admin/BackLink';
import { SiteSettings } from '@/components/admin/sites/SiteSettings';
import { parseSiteSection, siteSettingsPath } from '@/lib/siteSettingsPath';

// the section lives in the url, so a link can open one and a reload keeps it
function SiteSettingsContent({ siteId }: { siteId: string }) {
  const router = useRouter();
  const section = parseSiteSection(useSearchParams().get('section'));

  return (
    <SiteSettings
      siteId={siteId}
      section={section}
      onSectionChange={(next) => router.replace(siteSettingsPath(siteId, next), { scroll: false })}
      // with no site left to administer, /admin/sites would bounce with "access denied"
      onDeleted={(another) => router.replace(another ? '/admin/sites' : '/dashboard')}
    />
  );
}

export default function SiteSettingsPage({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = use(params);

  return (
    <div className="p-4 sm:p-6 md:p-8">
      <div className="max-w-screen-2xl mx-auto">
        <BackLink href="/admin/sites" label="sites" />
        <Suspense fallback={null}>
          <SiteSettingsContent siteId={siteId} />
        </Suspense>
      </div>
    </div>
  );
}
