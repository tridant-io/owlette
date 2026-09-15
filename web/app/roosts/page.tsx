import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'roost',
};

import { Suspense } from 'react';
import { connection } from 'next/server';
import RoostsPageClient from './RoostsPageClient';

// Server-component wrapper that opts the route into dynamic rendering
// (`connection()`) and keeps a Suspense boundary above the client subtree.
// Why both:
// - `connection()` makes Next.js skip prerender for this route, which
//   sidesteps the `useSearchParams` CSR-bailout that the client subtree
//   triggers via the `useSelectedRoost` hook (?roost=<id>).
// - The Suspense boundary is belt-and-suspenders: if anything below ever
//   suspends (a streaming child, a future server child), Next has a place
//   to land instead of erroring out. Matches the repo's pattern on
//   /login, /verify-2fa, /unsubscribe, /cli/authorize.
export default async function ProjectsPage() {
  await connection();
  return (
    <Suspense fallback={null}>
      <RoostsPageClient />
    </Suspense>
  );
}

