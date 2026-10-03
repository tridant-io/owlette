'use client';

/**
 * The one-time "whose clock runs your schedules?" prompt for a site that has
 * never answered (dev/completed/site-time-schedules, wave 3a task 3.1).
 *
 * `sites/{siteId}.schedulesFollowSiteTime` is three-state and the absence of the
 * field is a real state: it means the site predates the setting and its process
 * windows are still evaluated on each machine's own clock. Answering is
 * terminal — `true` (site time) or `false` (keep machine clocks) — and either
 * answer makes this banner disappear for good, because the flag is then no
 * longer `undefined`.
 *
 * TWO THINGS ARE LOAD-BEARING HERE:
 *
 * 1. The flag MUST come from the Firestore snapshot (`useSites` /
 *    `useCurrentSite`), never from `GET /api/sites/{siteId}`. The REST
 *    representation is deliberately two-state (`=== true`), which collapses
 *    "absent" into "false" and would make this banner unreachable.
 * 2. When it does not apply the component renders `null` — no wrapper, no
 *    spacer, nothing. An empty element here would reserve a gap above the
 *    machines heading on every unaffected site, which is the recurring
 *    reserved-empty-slide regression.
 *
 * The agent-version line is ADVISORY ONLY (plan decision D3). Site time is never
 * version-blocked: one offline machine on an old build must not be able to strand
 * a whole fleet on machine clocks.
 */

import { useMemo, useState } from 'react';
import { Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { TimezoneSelect } from '@/components/TimezoneSelect';
import { tzAbbreviation } from '@/components/TimezoneChip';
import { toast } from '@/lib/toast';
import { compareVersions, SITE_TIME_MIN_AGENT_VERSION } from '@/lib/versionUtils';
import type { Machine, Process } from '@/hooks/useFirestore';

export interface SiteTimeConfirmBannerProps {
  siteId: string;
  /** The site's stored IANA timezone, when it has one. Pre-fills the select. */
  siteTimezone?: string;
  /**
   * Three-state flag straight off the site snapshot. `undefined` — never asked —
   * is the ONLY value that shows this banner.
   */
  schedulesFollowSiteTime: boolean | undefined;
  /** Machines on the site; drives the scheduled-process gate and both advisories. */
  machines: Machine[];
  /** Whether the viewer may change site settings (admin of this site, or superadmin). */
  isSiteAdmin: boolean;
  onUpdateSite: (
    siteId: string,
    updates: { timezone?: string; schedulesFollowSiteTime?: boolean },
  ) => Promise<void>;
}

/** Same precedence the dashboard uses when it opens the schedule editor. */
function isScheduled(process: Process): boolean {
  const mode =
    process._optimisticLaunchMode ??
    process.launch_mode ??
    (process.autolaunch ? 'always' : 'off');
  return mode === 'scheduled';
}

export function SiteTimeConfirmBanner({
  siteId,
  siteTimezone,
  schedulesFollowSiteTime,
  machines,
  isSiteAdmin,
  onUpdateSite,
}: SiteTimeConfirmBannerProps) {
  // '' means "not picked yet", so a site timezone that arrives on a later
  // snapshot still pre-fills the select. Derived during render rather than
  // synced through an effect (`react-hooks/set-state-in-effect`).
  const [pickedTimezone, setPickedTimezone] = useState('');
  const [pending, setPending] = useState<'site' | 'machine' | null>(null);
  const timezone = pickedTimezone || siteTimezone || '';

  const scheduledProcessCount = useMemo(
    () =>
      machines.reduce(
        (total, machine) => total + (machine.processes ?? []).filter(isScheduled).length,
        0,
      ),
    [machines],
  );

  // R1d: machines whose own clock disagrees with the timezone about to be
  // adopted — the ones whose windows actually move. A machine that never
  // reported a timezone (pre-IANA agent) can't be compared, so it is left out
  // rather than guessed at.
  const disagreeing = useMemo(() => {
    if (!timezone) return [];
    return machines
      .filter((machine) => !!machine.machineTimezone && machine.machineTimezone !== timezone)
      .map((machine) => ({
        machineId: machine.machineId,
        timezone: machine.machineTimezone as string,
      }));
  }, [machines, timezone]);

  // Strictly older only. An unparseable or missing `agent_version` yields null
  // from compareVersions and is not reported: a spurious "needs a newer agent"
  // on a machine that already supports the feature is worse than a missed one.
  const outdated = useMemo(
    () =>
      machines
        .filter(
          (machine) =>
            compareVersions(machine.agent_version, SITE_TIME_MIN_AGENT_VERSION) === -1,
        )
        .map((machine) => machine.machineId),
    [machines],
  );

  // Every hook above runs unconditionally; the gates come after.
  if (!isSiteAdmin) return null;
  if (schedulesFollowSiteTime !== undefined) return null;
  if (scheduledProcessCount === 0) return null;

  const answer = async (choice: 'site' | 'machine') => {
    if (pending) return;
    setPending(choice);
    try {
      if (choice === 'site') {
        // Timezone and flag in ONE patch: updateSite evaluates the timezone the
        // document would have AFTER the write, so a site with no timezone yet
        // can opt in without a second round trip.
        await onUpdateSite(siteId, { timezone, schedulesFollowSiteTime: true });
        toast.success('schedules now follow this site’s clock');
      } else {
        await onUpdateSite(siteId, { schedulesFollowSiteTime: false });
        toast.success('schedules stay on each machine’s clock');
      }
      // Deliberately no `setPending(null)` on success: the answer is terminal,
      // and the site snapshot unmounts this banner a moment later.
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message || 'could not save the schedule timezone setting');
      setPending(null);
    }
  };

  return (
    <div
      data-testid="site-time-banner"
      className="rounded-lg border border-border bg-card-sunken p-4"
    >
      <div className="flex items-start gap-3">
        <div className="rounded-md bg-muted p-1.5 text-muted-foreground">
          <Clock className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="space-y-1">
            <h4 className="text-sm font-semibold text-foreground">
              which clock runs this site&rsquo;s schedules?
            </h4>
            <p className="text-sm text-muted-foreground">
              {scheduledProcessCount === 1
                ? 'one scheduled process on this site runs'
                : `${scheduledProcessCount} scheduled processes on this site run`}{' '}
              on whichever clock each machine is set to. you can move them onto one site
              clock instead, or keep machine clocks as they are. either answer is final.
            </p>
          </div>

          <div className="max-w-xs space-y-1.5">
            <Label htmlFor="site-time-banner-timezone" className="text-sm text-muted-foreground">
              site timezone
            </Label>
            <TimezoneSelect
              id="site-time-banner-timezone"
              value={timezone}
              onValueChange={setPickedTimezone}
              disabled={pending !== null}
              className="border-border bg-accent text-accent-foreground"
            />
          </div>

          {disagreeing.length > 0 && (
            <p
              data-testid="site-time-banner-disagreement"
              className="text-xs text-muted-foreground"
            >
              these machines report a different clock, so their windows will shift on site
              time:{' '}
              {disagreeing
                .map((machine) => `${machine.machineId} (${tzAbbreviation(machine.timezone)})`)
                .join(', ')}
            </p>
          )}

          {outdated.length > 0 && (
            <p
              data-testid="site-time-banner-version-advisory"
              className="text-xs text-warning dark:text-warning/90"
            >
              these machines run an agent older than {SITE_TIME_MIN_AGENT_VERSION} and keep
              using their own clock until they update: {outdated.join(', ')}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              data-testid="site-time-banner-use-site-time"
              disabled={!timezone || pending !== null}
              onClick={() => answer('site')}
            >
              use site time
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="site-time-banner-keep-machine-clocks"
              disabled={pending !== null}
              onClick={() => answer('machine')}
            >
              keep machine clocks
            </Button>
            {!timezone && (
              <span className="text-xs text-muted-foreground">
                pick a timezone to use site time
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
