'use client';

import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ACTIVITY_VIEWS, ActivityList, type ActivityFilters } from '@/components/admin/activity/ActivityList';

// view, user and site live in the url, so back from a shared link returns to the same feed
function ActivityPageContent() {
  const router = useRouter();
  const params = useSearchParams();
  const requested = params.get('view');
  const filters: ActivityFilters = {
    view: ACTIVITY_VIEWS.find((v) => v === requested) ?? 'all',
    userId: params.get('user') || undefined,
    siteId: params.get('site') || undefined,
  };

  const setFilters = (next: ActivityFilters) => {
    const query = new URLSearchParams();
    if (next.view !== 'all') query.set('view', next.view);
    if (next.userId) query.set('user', next.userId);
    if (next.siteId) query.set('site', next.siteId);
    const search = query.toString();
    router.replace(search ? `/admin/activity?${search}` : '/admin/activity', { scroll: false });
  };

  return <ActivityList filters={filters} onFiltersChange={setFilters} />;
}

export default function ActivityPage() {
  return (
    <Suspense fallback={null}>
      <ActivityPageContent />
    </Suspense>
  );
}
