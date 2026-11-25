'use client';

/**
 * what stops an owner putting a site on core or pro, said before anything is
 * sent (adr 0018): an unverified email, or an email whose tridant account must
 * be linked first. the create dialog and the upgrade dialog both show them,
 * worded by what the owner was about to do.
 */

import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';

interface UpgradeNoticeProps {
  testId: string;
  /** what the owner was about to do, e.g. "upgrading a site". */
  doing: string;
}

export function EmailUnverifiedNotice({ testId, doing }: UpgradeNoticeProps) {
  return (
    <InlineNotice data-testid={testId}>
      <p className="text-sm text-foreground">
        verify your email before {doing}. the banner at the top of the page sends the verification email again.
      </p>
    </InlineNotice>
  );
}

/** `linkHref` is null where linking is not set up on this deployment. */
export function LinkRequiredNotice({ testId, doing, linkHref }: UpgradeNoticeProps & { linkHref: string | null }) {
  return (
    <InlineNotice data-testid={testId}>
      <p className="text-sm text-foreground">this email already has a tridant account. link it before {doing}.</p>
      {linkHref ? (
        <Button asChild size="sm">
          {/* an api route that redirects to tridant id: a plain anchor, never a prefetched Link */}
          <a href={linkHref}>link it</a>
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">contact support to link it.</p>
      )}
    </InlineNotice>
  );
}
