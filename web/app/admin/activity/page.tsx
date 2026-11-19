'use client';

import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ACTIVITY_VIEWS, ActivityList, type ActivityFilters } from '@/components/admin/activity/ActivityList';
import { DATE_PRESETS } from '@/lib/dateRange';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (value: string | null) => (value && DAY.test(value) ? value : undefined);

// view, user, site and date range live in the url, so back from a shared link returns to the same
// feed. the range is kept as its preset, so a shared "last 7 days" means the 7 days before it opens
function ActivityPageContent() {
  const router = useRouter();
  const params = useSearchParams();
  const requested = params.get('view');
  const range = params.get('range');
  const filters: ActivityFilters = {
    view: ACTIVITY_VIEWS.find((v) => v === requested) ?? 'all',
    userId: params.get('user') || undefined,
    siteId: params.get('site') || undefined,
    datePreset: DATE_PRESETS.find((p) => p.value === range)?.value ?? 'all',
    dateFrom: day(params.get('from')),
    dateTo: day(params.get('to')),
  };

  const setFilters = (next: ActivityFilters) => {
    const query = new URLSearchParams();
    if (next.view !== 'all') query.set('view', next.view);
    if (next.userId) query.set('user', next.userId);
    if (next.siteId) query.set('site', next.siteId);
    if (next.datePreset !== 'all') query.set('range', next.datePreset);
    if (next.datePreset === 'custom') {
      if (next.dateFrom) query.set('from', next.dateFrom);
      if (next.dateTo) query.set('to', next.dateTo);
    }
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
