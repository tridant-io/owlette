'use client';

/**
 * Terminal state for a site-scoped page when the caller has no sites. Render it
 * whenever `hasNoSites` from `useCurrentSite` is true: /deployments, /logs and
 * /roosts used to fold "no site selected" into their loading condition, so a
 * zero-site account sat on a spinner forever with no error and no next step.
 */

import { Card } from '@/components/ui/card';

interface NoSitesEmptyStateProps {
  /** Completes "you need site access to …", e.g. "manage roosts". */
  action: string;
  /**
   * the caller has sites, but is limited to some machines on each
   * (`limitedOnly` from `useCurrentSite`), and this page spans the site.
   */
  limited?: boolean;
}

export function NoSitesEmptyState({ action, limited = false }: NoSitesEmptyStateProps) {
  return (
    <Card className="border-border bg-card/50 p-8 text-center">
      <p className="text-sm text-foreground">
        {limited ? 'this page needs whole-site access' : 'no sites available'}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {limited
          ? `you reach only some machines on your sites. ask a site admin if you need to ${action}.`
          : `you need site access to ${action}. create a site from the dashboard, or ask a site admin to add you.`}
      </p>
    </Card>
  );
}
