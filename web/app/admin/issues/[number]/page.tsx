'use client';

import { use } from 'react';
import { IssueDetail } from '@/components/admin/issues/IssueDetail';

/** `/admin/issues/42`, or the doc id for an issue filed before numbering */
export default function IssuePage({ params }: { params: Promise<{ number: string }> }) {
  const { number } = use(params);
  return <IssueDetail idOrNumber={number} />;
}
