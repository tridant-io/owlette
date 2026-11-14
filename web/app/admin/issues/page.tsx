'use client';

import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ISSUE_FILTERS, IssueList, type IssueFilter } from '@/components/admin/issues/IssueList';

// the filter lives in the url, so back from an issue returns to the same list
function IssuesPageContent() {
  const router = useRouter();
  const requested = useSearchParams().get('status');
  const filter = ISSUE_FILTERS.find((f) => f === requested) ?? 'new';

  const setFilter = (next: IssueFilter) => {
    router.replace(next === 'new' ? '/admin/issues' : `/admin/issues?status=${next}`, { scroll: false });
  };

  return <IssueList filter={filter} onFilterChange={setFilter} />;
}

export default function IssuesPage() {
  return (
    <Suspense fallback={null}>
      <IssuesPageContent />
    </Suspense>
  );
}
